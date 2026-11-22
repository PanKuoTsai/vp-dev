/*
 * sim_agent: a SystemC module that lets VP Studio control a running QBox
 * simulation over JSON-RPC 2.0 on TCP.
 *
 * Built out of tree as a module library (sim_agent.so) and loaded by the
 * QBox module factory through dylib_path. It links to QBox's vp_probes
 * component (the tracers and the trace store they share with the agent):
 *
 *   platform.sim_agent = {
 *       moduletype = "sim_agent";
 *       dylib_path = "/path/to/sim_agent";   -- ".so" is appended
 *       port = 51000;
 *   };
 *
 * Wire format: one JSON-RPC message per line (UTF-8, '\n' terminated).
 * See README.md for the methods.
 *
 * Threads: a server thread owns every socket. Anything that touches the
 * simulation (time, suspend, CCI broker) is posted as a job to an SC_THREAD
 * of this module and the server thread waits for its result. Jobs keep only
 * shared state, so a job abandoned at shutdown never writes to a dead stack.
 */

#include <systemc>
#include <cci_configuration>
#include <scp/report.h>
#include <async_event.h>
#include <module_factory_registery.h>
#include <qemu-instance.h>
#include <tlm_utils/simple_initiator_socket.h>
#include <tlm_utils/simple_target_socket.h>
#include <tlm_sockets_buswidth.h>
#include <tlm-extensions/qemu-mr-hint.h>
#include <tlm-extensions/pathid_extension.h>
#include <tlm_utils/multi_socket_bases.h>
#include <ports/target-signal-socket.h>
#include <ports/initiator-signal-socket.h>

// RapidJSON (header only, shipped with CCI) in a private namespace, so it
// cannot clash with the copy compiled into libcci-config.
#define RAPIDJSON_NAMESPACE vp_rapidjson
#define RAPIDJSON_NAMESPACE_BEGIN namespace vp_rapidjson {
#define RAPIDJSON_NAMESPACE_END }
#define RAPIDJSON_HAS_STDSTRING 1
#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>
#include <rapidjson/error/en.h>
#include <rapidjson/filereadstream.h>
#include <rapidjson/prettywriter.h>

#include <arpa/inet.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <cxxabi.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cmath>
#include <chrono>
#include <cstring>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <tuple>
#include <thread>
#include <unordered_map>
#include <vector>

namespace json = vp_rapidjson;

namespace {

const char* const AGENT_NAME = "sim-agent";
const char* const AGENT_VERSION = "0.14.0";
const int PROTOCOL_VERSION = 1;
const size_t MAX_LINE = 1 << 20; // a request longer than this closes the connection

// JSON-RPC error codes
enum {
    E_PARSE = -32700,
    E_INVALID_REQUEST = -32600,
    E_METHOD = -32601,
    E_PARAMS = -32602,
    E_INTERNAL = -32603,
    E_NOT_FOUND = -32001,   // no such CCI parameter
    E_SIM_ENDED = -32002,   // the simulation is no longer running jobs
    E_LOCKED = -32003,      // the parameter is locked or immutable
    E_REJECTED = -32004,    // the value does not convert, or the parameter refused it
    E_STATE = -32005,       // not possible in the current state (a debugger has the target stopped)
};

struct rpc_error {
    int code;
    std::string message;
};

using Writer = json::Writer<json::StringBuffer>;

std::string demangle(const char* n)
{
    int status = 0;
    char* d = abi::__cxa_demangle(n, nullptr, nullptr, &status);
    std::string s = (status == 0 && d) ? d : n;
    free(d);
    return s;
}

/** Short C++ type name of a parameter, e.g. "uint32_t" rather than "unsigned int". */
std::string type_name(const std::type_info& ti)
{
    if (ti == typeid(bool)) return "bool";
    if (ti == typeid(std::string)) return "string";
    if (ti == typeid(int8_t)) return "int8_t";
    if (ti == typeid(uint8_t)) return "uint8_t";
    if (ti == typeid(int16_t)) return "int16_t";
    if (ti == typeid(uint16_t)) return "uint16_t";
    if (ti == typeid(int32_t)) return "int32_t";
    if (ti == typeid(uint32_t)) return "uint32_t";
    if (ti == typeid(int64_t) || ti == typeid(long long)) return "int64_t";
    if (ti == typeid(uint64_t) || ti == typeid(unsigned long long)) return "uint64_t";
    if (ti == typeid(float)) return "float";
    if (ti == typeid(double)) return "double";
    if (ti == typeid(sc_core::sc_time)) return "sc_time";
    return demangle(ti.name());
}

const char* category_name(cci::cci_param_data_category c)
{
    switch (c) {
    case cci::CCI_BOOL_PARAM: return "bool";
    case cci::CCI_INTEGRAL_PARAM: return "integer";
    case cci::CCI_REAL_PARAM: return "real";
    case cci::CCI_STRING_PARAM: return "string";
    case cci::CCI_LIST_PARAM: return "list";
    default: return "other";
    }
}

/** Run f with SC_ERROR reports turned into exceptions, so a CCI conversion
 *  failure cannot abort the simulator. */
template <typename F>
void with_throwing_errors(F&& f)
{
    auto old = sc_core::sc_report_handler::set_actions(sc_core::SC_ERROR, sc_core::SC_THROW);
    try {
        f();
    } catch (...) {
        sc_core::sc_report_handler::set_actions(sc_core::SC_ERROR, old);
        throw;
    }
    sc_core::sc_report_handler::set_actions(sc_core::SC_ERROR, old);
}

} // namespace


/* Transaction trace: the store, the records and the initiator names are in QBox's vp_probes component. */
#include <probes.h>

/**
 * Sampling profiler (G-05). QEMU plugin callbacks registered through libqemu's
 * plugin API table, as QBox's own McipsPlugin does: the launcher loads
 * libidlinker, which writes the plugin id QEMU assigns into the agent's
 * profile_id parameter.
 *
 * Each translated block adds its instruction count to a per-vCPU counter
 * (inline, no call); when the counter reaches the period, a callback records
 * the block's start address and resets it. One sample is therefore about
 * `period` instructions of the vCPU, attributed to the block running then.
 *
 * Callbacks run on vCPU threads, possibly after the agent is gone, so the
 * state lives in a leaked object and checks `alive`.
 */
struct Profiler {
    static constexpr unsigned MAX_CPUS = 256;
    struct Cpu {
        std::mutex mu;
        std::unordered_map<uint64_t, uint64_t> counts; // block address -> samples
        uint64_t samples = 0;
    };
    std::atomic<bool> alive{ true };
    std::atomic<bool> enabled{ true };
    std::atomic<bool> active{ false }; // sampling callbacks registered
    bool sampling = false;             // instrument for sampling (profile = true)
    uint64_t period = 10000;
    const LibQemuExports* api = nullptr;
    qemu_plugin_u64 counter{};
    std::atomic<uint64_t> since_ns{ 0 }; // host time of the last reset
    Cpu cpus[MAX_CPUS];

    static Profiler& get()
    {
        static Profiler* p = new Profiler(); // leaked: callbacks may outlive the agent
        return *p;
    }

    static void on_tb_trans(qemu_plugin_tb* tb, void*);

    static void on_sample(unsigned int cpu, void* udata)
    {
        Profiler& p = get();
        if (!p.alive.load(std::memory_order_relaxed)) return;
        p.api->qemu_plugin_u64_set(p.counter, cpu, 0);
        if (!p.enabled.load(std::memory_order_relaxed) || cpu >= MAX_CPUS) return;
        Cpu& c = p.cpus[cpu];
        std::lock_guard<std::mutex> l(c.mu);
        c.counts[uint64_t(reinterpret_cast<uintptr_t>(udata))]++;
        c.samples++;
    }

    void reset()
    {
        for (auto& c : cpus) {
            std::lock_guard<std::mutex> l(c.mu);
            c.counts.clear();
            c.samples = 0;
        }
        since_ns = uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                std::chrono::steady_clock::now().time_since_epoch())
                                .count());
    }
};

/**
 * Function trace (G-05, second layer): every call and return of the guest
 * software, per vCPU, with host time and the vCPU's instruction count.
 *
 * At translation, each AArch64 call (BL, BLR, BLRAA...) and return (RET,
 * RETAA...) gets an inline store of "its address | kind" into a per-vCPU
 * scoreboard slot (no call). Every block starts with a conditional callback
 * that runs only when that slot is set: a branch ends its block, so the block
 * that runs next is where the call or return went. The callback records
 * {from | kind, to, host ns, instructions} into the vCPU's ring (the newest
 * `capacity` records are kept) and clears the slot. Blocks also add their
 * instruction count to a per-vCPU counter, inline.
 *
 * An exception taken right after a call shows as a call to the vector; tail
 * calls (plain B) are not seen. The reader (lib/analysis/ftrace.js) matches returns to
 * calls by return address and copes with both.
 */
struct FTracer {
    static constexpr unsigned MAX_CPUS = Profiler::MAX_CPUS;
    enum : uint64_t { CALL = 1, RET = 2 };
    enum Space : int { ALL = 0, KERNEL = 1, USER = 2 };
    struct Rec {
        uint64_t from; // address of the branch | kind
        uint64_t to;   // where it went
        uint64_t ns;   // host time since the last clear
        uint64_t insns; // instructions this vCPU had executed
    };
    struct Cpu {
        std::mutex mu;
        std::vector<Rec> ring;
        uint64_t total = 0; // records written since the last clear
    };
    std::atomic<bool> alive{ true };
    std::atomic<bool> active{ false }; // instrumented
    std::atomic<bool> enabled{ false }; // recording
    std::atomic<int> space{ ALL };
    size_t capacity = 262144;
    const LibQemuExports* api = nullptr;
    qemu_plugin_u64 pending{};
    qemu_plugin_u64 icount{};
    std::atomic<uint64_t> origin_ns{ 0 };
    Cpu cpus[MAX_CPUS];

    static FTracer& get()
    {
        static FTracer* f = new FTracer(); // leaked: callbacks may outlive the agent
        return *f;
    }

    static uint64_t now_ns()
    {
        return uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(
                            std::chrono::steady_clock::now().time_since_epoch())
                            .count());
    }

    /** CALL, RET or 0 for an A64 instruction word. */
    static uint64_t kind_of(uint32_t i)
    {
        if ((i & 0xFC000000u) == 0x94000000u) return CALL; // BL imm
        if ((i & 0xFFFFFC1Fu) == 0xD63F0000u) return CALL; // BLR Xn
        if ((i & 0xFFFFF81Fu) == 0xD63F081Fu) return CALL; // BLRAAZ, BLRABZ
        if ((i & 0xFFFFF800u) == 0xD73F0800u) return CALL; // BLRAA, BLRAB
        if ((i & 0xFFFFFC1Fu) == 0xD65F0000u) return RET;  // RET Xn
        if (i == 0xD65F0BFFu || i == 0xD65F0FFFu) return RET; // RETAA, RETAB
        return 0;
    }

    void instrument(qemu_plugin_tb* tb)
    {
        const uint64_t pc = api->qemu_plugin_tb_vaddr(tb);
        const size_t n = api->qemu_plugin_tb_n_insns(tb);
        api->qemu_plugin_register_vcpu_tb_exec_cond_cb(tb, &FTracer::on_target, QEMU_PLUGIN_CB_NO_REGS,
                                                      QEMU_PLUGIN_COND_NE, pending, 0,
                                                      reinterpret_cast<void*>(uintptr_t(pc)));
        api->qemu_plugin_register_vcpu_tb_exec_inline_per_vcpu(tb, QEMU_PLUGIN_INLINE_ADD_U64, icount, n);
        for (size_t k = 0; k < n; k++) {
            qemu_plugin_insn* insn = api->qemu_plugin_tb_get_insn(tb, k);
            uint8_t b[4];
            if (api->qemu_plugin_insn_data(insn, b, 4) != 4) continue;
            const uint64_t kind = kind_of(uint32_t(b[0]) | uint32_t(b[1]) << 8 | uint32_t(b[2]) << 16 |
                                          uint32_t(b[3]) << 24);
            if (!kind) continue;
            api->qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(insn, QEMU_PLUGIN_INLINE_STORE_U64, pending,
                                                                     api->qemu_plugin_insn_vaddr(insn) | kind);
        }
    }

    static void on_target(unsigned int cpu, void* udata)
    {
        FTracer& f = get();
        if (!f.alive.load(std::memory_order_relaxed)) return;
        const uint64_t from = f.api->qemu_plugin_u64_get(f.pending, cpu);
        f.api->qemu_plugin_u64_set(f.pending, cpu, 0);
        if (!f.enabled.load(std::memory_order_relaxed) || cpu >= MAX_CPUS) return;
        const int sp = f.space.load(std::memory_order_relaxed);
        const bool kernel = (from >> 63) != 0; // arm64: the kernel runs in the upper half
        if ((sp == KERNEL && !kernel) || (sp == USER && kernel)) return;
        Rec r{ from, uint64_t(reinterpret_cast<uintptr_t>(udata)), now_ns() - f.origin_ns.load(),
               f.api->qemu_plugin_u64_get(f.icount, cpu) };
        Cpu& c = f.cpus[cpu];
        std::lock_guard<std::mutex> l(c.mu);
        if (c.ring.size() != f.capacity) c.ring.assign(f.capacity, Rec{});
        c.ring[c.total % f.capacity] = r;
        c.total++;
    }

    void clear()
    {
        for (auto& c : cpus) {
            std::lock_guard<std::mutex> l(c.mu);
            c.total = 0;
        }
        origin_ns = now_ns();
    }

    /**
     * Write the records to a file: "VPFTRC01", u32 version (1), u32 number of
     * CPUs; per CPU: u32 cpu, u32 0, u64 total, u64 stored, then `stored`
     * records of four u64 (from|kind, to, ns, insns), oldest first. Little-endian.
     * Returns {cpus, events}.
     */
    std::pair<unsigned, uint64_t> save(const std::string& path)
    {
        std::FILE* fp = std::fopen((path + ".part").c_str(), "wb");
        if (!fp) throw std::runtime_error("cannot write " + path + ": " + std::strerror(errno));
        std::vector<std::pair<unsigned, std::pair<uint64_t, std::vector<Rec>>>> out;
        for (unsigned i = 0; i < MAX_CPUS; i++) {
            Cpu& c = cpus[i];
            std::lock_guard<std::mutex> l(c.mu);
            if (!c.total) continue;
            const uint64_t stored = std::min<uint64_t>(c.total, c.ring.size());
            std::vector<Rec> v;
            v.reserve(stored);
            for (uint64_t k = c.total - stored; k < c.total; k++) v.push_back(c.ring[k % c.ring.size()]);
            out.push_back({ i, { c.total, std::move(v) } });
        }
        bool ok = std::fwrite("VPFTRC01", 1, 8, fp) == 8;
        const uint32_t head[2] = { 1, uint32_t(out.size()) };
        ok = ok && std::fwrite(head, sizeof head, 1, fp) == 1;
        uint64_t events = 0;
        for (auto& e : out) {
            const uint32_t id[2] = { e.first, 0 };
            const uint64_t counts[2] = { e.second.first, uint64_t(e.second.second.size()) };
            ok = ok && std::fwrite(id, sizeof id, 1, fp) == 1 && std::fwrite(counts, sizeof counts, 1, fp) == 1;
            if (!e.second.second.empty())
                ok = ok && std::fwrite(e.second.second.data(), sizeof(Rec), e.second.second.size(), fp) ==
                               e.second.second.size();
            events += e.second.second.size();
        }
        ok = (std::fclose(fp) == 0) && ok;
        if (!ok || std::rename((path + ".part").c_str(), path.c_str()) != 0) {
            std::remove((path + ".part").c_str());
            throw std::runtime_error("cannot write " + path + ": " + std::strerror(errno));
        }
        return { unsigned(out.size()), events };
    }
};

void Profiler::on_tb_trans(qemu_plugin_tb* tb, void*)
{
    Profiler& p = get();
    if (!p.alive.load(std::memory_order_relaxed)) return;
    if (p.sampling) {
        const uint64_t pc = p.api->qemu_plugin_tb_vaddr(tb);
        p.api->qemu_plugin_register_vcpu_tb_exec_inline_per_vcpu(tb, QEMU_PLUGIN_INLINE_ADD_U64, p.counter,
                                                                 p.api->qemu_plugin_tb_n_insns(tb));
        p.api->qemu_plugin_register_vcpu_tb_exec_cond_cb(tb, &Profiler::on_sample, QEMU_PLUGIN_CB_NO_REGS,
                                                        QEMU_PLUGIN_COND_GE, p.counter, p.period,
                                                        reinterpret_cast<void*>(uintptr_t(pc)));
    }
    FTracer& f = FTracer::get();
    if (f.active.load(std::memory_order_relaxed)) f.instrument(tb);
}



class sim_agent : public sc_core::sc_module
{
    SCP_LOGGER();

public:
    cci::cci_param<uint32_t> p_port;
    cci::cci_param<std::string> p_host;
    cci::cci_param<bool> p_watch_debugger;
    cci::cci_param<uint32_t> p_buses;
    cci::cci_param<bool> p_profile;
    cci::cci_param<uint64_t> p_profile_period;
    cci::cci_param<uint64_t> p_profile_id;
    cci::cci_param<bool> p_ftrace;
    cci::cci_param<uint64_t> p_ftrace_buffer;
    cci::cci_param<std::string> p_restore_from;
    cci::cci_param<bool> p_restore_paused;
    // One initiator per bus (router) for mem.read / mem.write: bus_0, bus_1, ...
    sc_core::sc_vector<tlm_utils::simple_initiator_socket<sim_agent, DEFAULT_TLM_BUSWIDTH>> bus;

    explicit sim_agent(const sc_core::sc_module_name& n)
        : sc_core::sc_module(n)
        , p_port("port", 0, "TCP port to listen on; 0 picks a free port (printed at start)")
        , p_host("host", "127.0.0.1", "Address to listen on")
        , p_watch_debugger("watch_debugger", true,
                           "Stop SystemC time while a debugger has the QEMU VM stopped (state \"halted\")")
        , p_buses("buses", 0, "Number of bus_N initiator sockets, each bound to a router, for mem.read and mem.write")
        , p_profile("profile", false, "Sample the guest software's program counter (needs the libidlinker plugin, see profile_id)")
        , p_profile_period("profile_period", 10000, "Instructions per vCPU between two samples")
        , p_profile_id("profile_id", 0, "QEMU plugin id, written by libidlinker (-plugin libidlinker.so,key=<this parameter>)")
        , p_ftrace("ftrace", false,
                   "Instrument guest calls and returns for the function trace (ftrace.*; needs the libidlinker plugin, see profile_id)")
        , p_ftrace_buffer("ftrace_buffer", 262144, "Function trace records kept per vCPU (32 bytes each; the newest are kept)")
        , p_restore_from("restore_from", "", "Checkpoint folder (ckpt.save) to load right after the simulation starts")
        , p_restore_paused("restore_paused", false, "Stay paused after restoring a checkpoint")
        , bus("bus")
        , m_job_event(false) // not attached: the agent never keeps the simulation alive
    {
        bus.init(p_buses.get_value());
        SC_THREAD(job_loop);
    }

    ~sim_agent() override
    {
        close_jobs();
        stop_server();
    }

private:
    /* ------------------------------------------------------------ jobs */

    struct Job {
        std::function<void(Writer&)> fn; // writes the JSON-RPC "result" value
        json::StringBuffer out;
        bool ok = false;
        rpc_error err{ E_INTERNAL, "" };
        std::promise<void> done;
    };

    std::mutex m_jobs_mu;
    std::deque<std::shared_ptr<Job>> m_jobs;
    bool m_jobs_closed = false;
    gs::async_event m_job_event;

    void job_loop()
    {
        for (;;) {
            std::shared_ptr<Job> job;
            {
                std::lock_guard<std::mutex> l(m_jobs_mu);
                if (m_jobs_closed) return;
                if (!m_jobs.empty()) {
                    job = m_jobs.front();
                    m_jobs.pop_front();
                }
            }
            if (!job) {
                wait(m_job_event);
                continue;
            }
            // Same pattern as gs::runonsysc: jobs also run while suspended.
            sc_core::sc_unsuspendable();
            try {
                Writer w(job->out);
                job->fn(w);
                job->ok = true;
            } catch (const rpc_error& e) {
                job->err = e;
            } catch (const sc_core::sc_report& e) {
                job->err = { E_INTERNAL, e.what() };
            } catch (const std::exception& e) {
                job->err = { E_INTERNAL, e.what() };
            } catch (...) {
                job->err = { E_INTERNAL, "unknown exception" };
            }
            job->done.set_value();
            wait(sc_core::SC_ZERO_TIME);
            sc_core::sc_suspendable();
        }
    }

    /** Run fn on the SystemC thread. Returns false (with err set) when the
     *  simulation is gone or the agent is shutting down. */
    bool run_on_sim(std::function<void(Writer&)> fn, std::string& result, rpc_error& err)
    {
        auto job = std::make_shared<Job>();
        job->fn = std::move(fn);
        auto fut = job->done.get_future();
        {
            std::lock_guard<std::mutex> l(m_jobs_mu);
            if (m_jobs_closed) {
                err = { E_SIM_ENDED, "simulation has ended" };
                return false;
            }
            m_jobs.push_back(job);
        }
        m_job_event.async_notify();
        while (fut.wait_for(std::chrono::milliseconds(100)) != std::future_status::ready) {
            if (m_stop.load()) {
                err = { E_SIM_ENDED, "simulation has ended" };
                return false;
            }
        }
        if (!job->ok) {
            err = job->err;
            return false;
        }
        result.assign(job->out.GetString(), job->out.GetSize());
        return true;
    }

    void close_jobs()
    {
        std::deque<std::shared_ptr<Job>> pending;
        {
            std::lock_guard<std::mutex> l(m_jobs_mu);
            m_jobs_closed = true;
            pending.swap(m_jobs);
        }
        for (auto& j : pending) {
            j->err = { E_SIM_ENDED, "simulation has ended" };
            j->done.set_value();
        }
    }

    /* ------------------------------------------------------------ simulation state */

    std::atomic<bool> m_paused{ false };  // paused by a client (sim.pause)
    std::atomic<bool> m_halted{ false };  // VM stopped by someone else, a debugger usually
    bool m_vm_ours = false;               // sim.pause stopped the VM itself (server thread only)
    bool m_sc_suspended = false;          // SystemC thread only
    std::vector<QemuInstance*> m_qemu;    // found at start of simulation

    /** On the SystemC thread: SystemC time stops while paused or halted. */
    void apply_suspend()
    {
        const bool want = m_paused.load() || m_halted.load();
        if (want == m_sc_suspended) return;
        if (want)
            sc_core::sc_suspend_all();
        else
            sc_core::sc_unsuspend_all();
        m_sc_suspended = want;
    }

    /*
     * Debugger halts. When gdb stops the target, QEMU stops the VM: every vCPU
     * pauses and the virtual clock freezes. SystemC models with their own
     * timed events would still move simulated time on, so the agent watches
     * the virtual clock (it advances whenever the VM runs, idle CPUs
     * included) and suspends SystemC while it stands still. Off in icount
     * mode, where an idle VM also freezes the clock.
     */
    bool m_watch_clock = false;
    bool m_clock_seen_running = false;
    int64_t m_last_clock = -1;
    std::chrono::steady_clock::time_point m_last_change;
    static constexpr auto HALT_AFTER = std::chrono::milliseconds(150);

    /** Server thread, every poll tick. Appends a notification when the state changes. */
    void watch_clock(std::vector<std::string>& broadcasts)
    {
        if (!m_watch_clock || m_qemu.empty() || !m_qemu[0]->is_inited()) return;
        const auto host = std::chrono::steady_clock::now();
        if (m_paused.load()) { // our own pause froze it; start over afterwards
            m_last_clock = -1;
            return;
        }
        const int64_t now = m_qemu[0]->get().get_virtual_clock();
        if (m_last_clock < 0) { // a new baseline (first sample, or after our own pause): not a change
            m_last_clock = now;
            m_last_change = host;
            return;
        }
        if (now != m_last_clock) {
            m_clock_seen_running = true;
            m_last_clock = now;
            m_last_change = host;
            if (m_halted.load()) set_halted(false, broadcasts);
            return;
        }
        // Only after the VM has been seen running, so start-up is never taken for a halt.
        if (m_clock_seen_running && !m_halted.load() && host - m_last_change >= HALT_AFTER) set_halted(true, broadcasts);
    }

    void set_halted(bool halted, std::vector<std::string>& broadcasts)
    {
        m_halted = halted;
        std::string result;
        rpc_error err{ E_INTERNAL, "" };
        if (run_on_sim(
                [this](Writer& w) {
                    apply_suspend();
                    write_status(w);
                },
                result, err))
            broadcasts.push_back(notification("sim.stateChanged", result));
    }

    struct Request;

    /*
     * Timed stops (sim.runFor, sim.runUntil). The agent must not add an event
     * of its own at the stop time: when every vCPU sleeps (WFI) or the VM is
     * being stopped, nothing holds SystemC time back, and time would jump
     * straight to that event (seen: "run until 99999 s" jumped there at
     * once). So it only watches: a pre-timestep callback sees the time
     * SystemC is about to advance to, and once that reaches the stop time it
     * wakes the server thread, which pauses exactly as sim.pause does
     * (stopping the VM from the SystemC thread would deadlock, see qemu_vm).
     * The pause therefore lands at the first event at or after the stop time,
     * plus whatever runs while the vCPUs acknowledge the stop; the status
     * reports both times. While the guest idles, SystemC time hardly moves,
     * and neither does the run towards the stop.
     */
    struct TimestepWatch : sc_core::sc_stage_callback_if {
        sim_agent* agent = nullptr;
        void stage_callback(const sc_core::sc_stage&) override { agent->on_timestep(); }
    } m_timestep_watch;
    bool m_watching_timesteps = false;
    bool m_deadline_armed = false;          // SystemC thread only
    sc_core::sc_time m_deadline_at;         // SystemC thread only
    sc_core::sc_time m_last_requested;      // SystemC thread only: the stop that fired last
    std::atomic<bool> m_deadline_hit{ false };
    std::atomic<bool> m_break_hit{ false }; // a bus breakpoint matched (set from any thread)

    /** From a tracer, on whatever thread made the access: ask the server thread to pause. */
    void on_break()
    {
        m_break_hit = true;
        if (m_wake[1] >= 0) {
            char c = 'b';
            (void)!::write(m_wake[1], &c, 1);
        }
    }

    /** SystemC kernel, just before time advances. */
    void on_timestep()
    {
        if (!m_deadline_armed) return;
        const sc_core::sc_time next = sc_core::sc_time_stamp() + sc_core::sc_time_to_pending_activity();
        if (next < m_deadline_at) return;
        m_deadline_armed = false;
        m_last_requested = m_deadline_at;
        m_deadline_hit = true;
        if (m_wake[1] >= 0) {
            char c = 'd';
            (void)!::write(m_wake[1], &c, 1);
        }
    }

    /** On the SystemC thread. */
    void arm_deadline(const sc_core::sc_time& at)
    {
        m_deadline_at = at;
        m_deadline_armed = true;
    }

    void disarm_deadline() { m_deadline_armed = false; }

    /** Server thread. Pause or continue; returns whether the state changed.
     *  reason goes into the status ("time" for a timed stop). Throws rpc_error. */
    bool set_paused(bool pause, const char* reason, std::string& result)
    {
        // Only this server thread changes m_paused, so no race between the steps.
        const bool change = pause != m_paused.load();
        // A VM a debugger has stopped stays the debugger's: pausing does not
        // stop it again, and continuing does not restart it.
        if (change && pause) {
            m_vm_ours = !m_halted.load();
            if (m_vm_ours) qemu_vm(true);
        }
        rpc_error err{ E_INTERNAL, "" };
        const bool ok = run_on_sim(
            [this, pause, reason](Writer& w) {
                m_paused = pause;
                // Any pause ends a pending timed stop; a timed stop has already disarmed itself.
                if (pause) disarm_deadline();
                // Running again: the next matching access is a new breakpoint hit.
                if (!pause) TraceStore::get().clear_hit();
                apply_suspend();
                write_status(w, reason);
            },
            result, err);
        if (!ok) throw err;
        if (change && !pause && m_vm_ours) qemu_vm(false);
        return change;
    }

    /** Server thread, after a wake-up: carry out a timed stop or a breakpoint that fired. */
    void handle_deadline(std::vector<std::string>& broadcasts)
    {
        const bool brk = m_break_hit.exchange(false);
        const bool time = m_deadline_hit.exchange(false);
        if (!brk && !time) return;
        std::string result;
        try {
            if (set_paused(true, brk ? "breakpoint" : "time", result))
                broadcasts.push_back(notification("sim.stateChanged", result));
        } catch (const rpc_error&) {
            // The simulation ended meanwhile: nothing to pause.
        }
    }

    static std::string hex(uint64_t v)
    {
        char b[19];
        std::snprintf(b, sizeof b, "0x%llx", (unsigned long long)v);
        return b;
    }

    /** A trace record as an object (breakpoint hits). */
    static void write_record(Writer& w, const TraceRecord& rec, const std::vector<std::string>& points)
    {
        static const char* hexd = "0123456789abcdef";
        char data[2 * sizeof rec.data + 1];
        const size_t n = std::min<size_t>(sizeof rec.data, rec.length);
        for (size_t i = 0; i < n; i++) {
            data[2 * i] = hexd[rec.data[i] >> 4];
            data[2 * i + 1] = hexd[rec.data[i] & 15];
        }
        w.StartObject();
        w.Key("seq");
        w.Uint64(rec.seq);
        w.Key("time");
        w.Double(rec.time_s);
        w.Key("point");
        w.String(rec.point < points.size() ? points[rec.point] : std::to_string(rec.point));
        w.Key("rw");
        w.String(rec.signal ? "S" : rec.write ? "W" : "R");
        w.Key("address");
        w.String(hex(rec.address));
        w.Key("length");
        w.Uint(rec.length);
        w.Key("data");
        w.String(data, json::SizeType(2 * n));
        w.Key("status");
        w.Int(rec.status);
        w.Key("initiator");
        w.String(InitiatorNames::get().resolve(rec.router, rec.npath, rec.path));
        w.EndObject();
    }

    static void write_breakpoint(Writer& w, const TraceStore::Breakpoint& b, const std::vector<std::string>& points)
    {
        w.StartObject();
        w.Key("id");
        w.Uint(b.id);
        w.Key("point");
        if (b.point < 0)
            w.Null();
        else
            w.String(size_t(b.point) < points.size() ? points[b.point] : std::to_string(b.point));
        w.Key("from");
        w.String(hex(b.lo));
        w.Key("to");
        w.String(hex(b.hi));
        w.Key("access");
        w.String(b.on_read && b.on_write ? "rw" : b.on_write ? "w" : "r");
        if (b.mask) {
            w.Key("mask");
            w.String(hex(b.mask));
            w.Key("value");
            w.String(hex(b.value));
        }
        w.EndObject();
    }

    /** A number, or a string in C notation ("0x1c0d0000", "4096"). */
    static uint64_t u64_of(const json::Value& v, const std::string& what)
    {
        if (v.IsUint64()) return v.GetUint64();
        if (v.IsString()) {
            const char* s = v.GetString();
            char* end = nullptr;
            errno = 0;
            const unsigned long long x = std::strtoull(s, &end, 0);
            if (end != s && *end == 0 && errno == 0 && s[0] != '-') return x;
        }
        throw rpc_error{ E_PARAMS, what + " must be a non-negative integer or a string such as \"0x1000\"" };
    }

    /** "10 ms", "1.5 s", "250us", or a number of seconds. */
    static sc_core::sc_time time_param(const Request& r, const char* key)
    {
        if (!(r.params && r.params->HasMember(key))) throw rpc_error{ E_PARAMS, std::string("missing \"") + key + "\"" };
        const json::Value& v = (*r.params)[key];
        const std::string bad = std::string("\"") + key + "\" must be a time such as \"10 ms\" or a number of seconds";
        double value;
        std::string unit = "s";
        if (v.IsNumber()) {
            value = v.GetDouble();
        } else if (v.IsString()) {
            const char* s = v.GetString();
            char* end = nullptr;
            value = std::strtod(s, &end);
            if (end == s) throw rpc_error{ E_PARAMS, bad };
            while (*end == ' ') end++;
            unit = end;
            while (!unit.empty() && unit.back() == ' ') unit.pop_back();
            if (unit.empty()) unit = "s";
        } else {
            throw rpc_error{ E_PARAMS, bad };
        }
        if (!std::isfinite(value) || value < 0) throw rpc_error{ E_PARAMS, bad };
        if (unit == "s") return sc_core::sc_time(value, sc_core::SC_SEC);
        if (unit == "ms") return sc_core::sc_time(value, sc_core::SC_MS);
        if (unit == "us" || unit == "\xc2\xb5s") return sc_core::sc_time(value, sc_core::SC_US);
        if (unit == "ns") return sc_core::sc_time(value, sc_core::SC_NS);
        if (unit == "ps") return sc_core::sc_time(value, sc_core::SC_PS);
        throw rpc_error{ E_PARAMS, bad + " (units: s, ms, us, ns, ps)" };
    }

    static void write_time(Writer& w, const sc_core::sc_time& t)
    {
        w.StartObject();
        w.Key("seconds");
        w.Double(t.to_seconds());
        w.Key("text");
        w.String(t.to_string());
        w.EndObject();
    }

    static void find_qemu_instances(sc_core::sc_object* o, std::vector<QemuInstance*>& out)
    {
        if (auto* q = dynamic_cast<QemuInstance*>(o)) out.push_back(q);
        for (auto* c : o->get_child_objects()) find_qemu_instances(c, out);
    }

    /*
     * Pausing must stop the QEMU vCPUs, not only SystemC time: sc_suspend_all
     * alone freezes time, but a vCPU woken by an interrupt (a key typed on
     * the console, for instance) restarts its quantum keeper and gets a new
     * budget ahead of the frozen time, so the guest keeps running.
     *
     * Order matters. vm_stop waits until every vCPU has acknowledged the
     * stop; a vCPU blocked in its quantum keeper waiting for run budget only
     * gets there if SystemC time can still advance. So: stop the VM first
     * (from this server thread, never from the SystemC thread), then suspend
     * SystemC. Continue does the reverse.
     */
    void qemu_vm(bool stop)
    {
        for (auto* q : m_qemu) {
            if (!q->is_inited()) continue;
            auto& lib = q->get();
            lib.lock_iothread();
            if (stop)
                lib.vm_stop_paused();
            else
                lib.vm_start();
            lib.unlock_iothread();
        }
    }

    const char* state_name() const
    {
        if (m_stop.load()) return "ended";
        if (m_paused.load()) return "paused";
        return m_halted.load() ? "halted" : "running";
    }

    /** Called on the SystemC thread. */
    void write_status(Writer& w, const char* reason = nullptr)
    {
        w.StartObject();
        w.Key("state");
        w.String(state_name());
        w.Key("time");
        write_time(w, sc_core::sc_time_stamp());
        w.Key("deltaCycles");
        w.Uint64(sc_core::sc_delta_count());
        if (m_deadline_armed) { // a timed stop is pending
            w.Key("stopAt");
            write_time(w, m_deadline_at);
        }
        const TraceStore::Hit hit = TraceStore::get().hit();
        if (hit.valid) { // stays until the simulation runs again
            std::vector<TraceRecord> none;
            uint64_t last, dropped;
            std::vector<std::string> points;
            TraceStore::get().read(~uint64_t(0), 0, none, last, dropped, points);
            w.Key("breakpointHit");
            w.StartObject();
            w.Key("breakpoint");
            w.Uint(hit.breakpoint);
            w.Key("record");
            write_record(w, hit.record, points);
            w.Key("accessesAfter"); // traced accesses between the hit and the pause
            w.Uint64(hit.accesses_after);
            w.Key("matchesAfter"); // of those, accesses that matched too (they will not stop it)
            w.Uint64(hit.matches_after);
            w.EndObject();
        }
        if (!p_restore_from.get_value().empty()) {
            std::lock_guard<std::mutex> g(m_restore_mu);
            w.Key("restore");
            w.StartObject();
            w.Key("dir");
            w.String(p_restore_from.get_value());
            w.Key("state"); // "pending", "restored" or "failed"
            w.String(m_restore_state);
            if (!m_restore_error.empty()) {
                w.Key("error");
                w.String(m_restore_error);
            }
            w.EndObject();
        }
        if (reason) {
            w.Key("reason");
            w.String(reason);
            if (std::strcmp(reason, "time") == 0) { // the time that was asked for; "time" is where it stopped
                w.Key("requestedTime");
                write_time(w, m_last_requested);
            }
        }
        w.EndObject();
    }

    void write_param(Writer& w, const cci::cci_param_untyped_handle& h)
    {
        w.StartObject();
        w.Key("name");
        w.String(h.name());
        w.Key("type");
        w.String(type_name(h.get_type_info()));
        w.Key("category");
        w.String(category_name(h.get_data_category()));
        w.Key("value");
        try {
            std::string v;
            with_throwing_errors([&] { v = h.get_cci_value().to_json(); });
            w.RawValue(v.c_str(), v.size(), json::kObjectType);
        } catch (...) {
            w.Null(); // value of a type without a cci_value converter
        }
        w.Key("isDefault");
        w.Bool(h.is_default_value());
        w.Key("isPreset");
        w.Bool(h.is_preset_value());
        w.Key("locked");
        w.Bool(h.is_locked());
        w.Key("mutability");
        switch (h.get_mutable_type()) {
        case cci::CCI_MUTABLE_PARAM: w.String("mutable"); break;
        case cci::CCI_IMMUTABLE_PARAM: w.String("immutable"); break;
        default: w.String("other"); break;
        }
        w.Key("description");
        w.String(h.get_description());
        w.EndObject();
    }

    /* ------------------------------------------------------------ methods */

    struct Request {
        std::string method;
        const json::Value* params; // object or nullptr
    };

    static std::string str_param(const Request& r, const char* key, bool required)
    {
        if (r.params && r.params->HasMember(key)) {
            const json::Value& v = (*r.params)[key];
            if (v.IsString()) return std::string(v.GetString(), v.GetStringLength());
            throw rpc_error{ E_PARAMS, std::string("\"") + key + "\" must be a string" };
        }
        if (required) throw rpc_error{ E_PARAMS, std::string("missing \"") + key + "\"" };
        return "";
    }

    static bool bool_param(const Request& r, const char* key)
    {
        if (r.params && r.params->HasMember(key)) {
            const json::Value& v = (*r.params)[key];
            if (v.IsBool()) return v.GetBool();
            throw rpc_error{ E_PARAMS, std::string("\"") + key + "\" must be a boolean" };
        }
        return false;
    }

    /* ------------------------------------------------------------ checkpoints (G-08)
     *
     * QEMU saves the state of its devices and CPUs with the function it has
     * for Xen (qmp_xen_save_devices_state: no RAM). QBox's RAM is SystemC
     * memory (gs_memory) that QEMU reaches through DMI, so the agent saves
     * it itself, through DMI on its bus sockets. SystemC peripherals with no
     * other way in (QBox's Pl011) are saved as register values, read through
     * the bus and written back after the load.
     *
     * libqemu does not register device state unless it has VP Studio's
     * patch (patches/libqemu/0001-register-device-vmstate.patch), which
     * exports libqemu_device_vmstate: without it only the CPUs and timers
     * would be saved and the guest would hang after a load.
     *
     * A load happens only at start (parameter restore_from): the QEMU
     * virtual clock comes back with the device state, and SystemC time,
     * which cannot go back, catches up with it by itself (QBox's CPUs keep
     * their quantum keepers at "virtual clock - SystemC time").
     */
    struct CkptMemory {
        std::string name;
        uint64_t address = 0, size = 0, bus = 0;
        uint64_t data = 0; // bytes that were not zero
    };
    struct CkptRegister {
        std::string name;
        uint64_t address = 0, bus = 0;
        unsigned size = 4;
        std::string value; // hex, memory order
    };
    struct QemuCkpt {
        void (*save)(const char*, bool, bool, void**) = nullptr;
        void (*load)(const char*, void**) = nullptr;
        const char* (*pretty)(void*) = nullptr;
        void (*efree)(void*) = nullptr;
        bool (*yank_register)(const void*, void**) = nullptr;
        void* (*migrate_current)() = nullptr;
        bool (*set_bool)(void*, const char*, bool, void**) = nullptr;
        bool patched = false;
    };
    /** QEMU's YankInstance { .type = YANK_INSTANCE_TYPE_MIGRATION }. */
    struct YankMigration {
        int type = 2;
        void* u = nullptr;
    };

    static std::string safe_name(const std::string& n)
    {
        std::string o;
        for (char c : n) o.push_back(std::isalnum((unsigned char)c) || c == '.' || c == '_' || c == '-' ? c : '_');
        return o.empty() ? std::string("memory") : o;
    }

    CkptMemory memory_of(const json::Value& v)
    {
        if (!v.IsObject() || !v.HasMember("name") || !v["name"].IsString() || !v.HasMember("address") || !v.HasMember("size"))
            throw rpc_error{ E_PARAMS, "a memory needs \"name\", \"address\" and \"size\"" };
        CkptMemory m;
        m.name = v["name"].GetString();
        m.address = u64_of(v["address"], "\"address\"");
        m.size = u64_of(v["size"], "\"size\"");
        if (v.HasMember("bus")) m.bus = u64_of(v["bus"], "\"bus\"");
        if (v.HasMember("data")) m.data = u64_of(v["data"], "\"data\"");
        if (!m.size) throw rpc_error{ E_PARAMS, "memory " + m.name + " has size 0" };
        return m;
    }

    CkptRegister register_of(const json::Value& v)
    {
        if (!v.IsObject() || !v.HasMember("name") || !v["name"].IsString() || !v.HasMember("address"))
            throw rpc_error{ E_PARAMS, "a register needs \"name\" and \"address\"" };
        CkptRegister x;
        x.name = v["name"].GetString();
        x.address = u64_of(v["address"], "\"address\"");
        if (v.HasMember("bus")) x.bus = u64_of(v["bus"], "\"bus\"");
        if (v.HasMember("size")) x.size = unsigned(u64_of(v["size"], "\"size\""));
        if (x.size < 1 || x.size > 8) throw rpc_error{ E_PARAMS, "register " + x.name + ": size must be 1 to 8" };
        if (v.HasMember("value") && v["value"].IsString()) x.value = v["value"].GetString();
        return x;
    }

    /** Whether libqemu has the device-state patch; why not, otherwise. */
    bool checkpoint_support(std::string& why)
    {
        try {
            QemuCkpt q = qemu_ckpt();
            if (!q.patched) {
                why = "this QBox's libqemu does not save device state (GIC, virtio, ...): apply VP Studio's "
                      "patches/libqemu/0001-register-device-vmstate.patch to build/_deps/libqemu-src and rebuild QBox";
                return false;
            }
            return true;
        } catch (const rpc_error& e) {
            why = e.message;
            return false;
        }
    }

    QemuCkpt qemu_ckpt()
    {
        if (m_qemu.empty() || !m_qemu[0]->is_inited()) throw rpc_error{ E_STATE, "no QEMU instance" };
        if (m_qemu.size() > 1) throw rpc_error{ E_STATE, "checkpoints support one QEMU instance only" };
        Dl_info info{};
        if (!dladdr((void*)m_qemu[0]->get().plugin_api().qemu_plugin_scoreboard_new, &info) || !info.dli_fname)
            throw rpc_error{ E_INTERNAL, "cannot find the libqemu library" };
        void* h = dlopen(info.dli_fname, RTLD_NOLOAD | RTLD_NOW);
        if (!h) throw rpc_error{ E_INTERNAL, std::string("dlopen libqemu: ") + dlerror() };
        QemuCkpt q;
        q.save = (decltype(q.save))dlsym(h, "qmp_xen_save_devices_state");
        q.load = (decltype(q.load))dlsym(h, "qmp_xen_load_devices_state");
        q.pretty = (decltype(q.pretty))dlsym(h, "error_get_pretty");
        q.efree = (decltype(q.efree))dlsym(h, "error_free");
        q.yank_register = (decltype(q.yank_register))dlsym(h, "yank_register_instance");
        q.migrate_current = (decltype(q.migrate_current))dlsym(h, "migrate_get_current");
        q.set_bool = (decltype(q.set_bool))dlsym(h, "object_property_set_bool");
        q.patched = dlsym(h, "libqemu_device_vmstate") != nullptr;
        dlclose(h); // RTLD_NOLOAD took a reference
        if (!q.save || !q.load || !q.pretty || !q.efree || !q.yank_register || !q.migrate_current || !q.set_bool)
            throw rpc_error{ E_INTERNAL, "this libqemu lacks the device-state functions" };
        return q;
    }

    /** Server thread, VM stopped: QEMU device state to or from a file. */
    void qemu_device_state(bool save, const std::string& file)
    {
        QemuCkpt q = qemu_ckpt();
        std::string why;
        if (!q.patched) {
            checkpoint_support(why);
            throw rpc_error{ E_STATE, why };
        }
        auto& lib = m_qemu[0]->get();
        void* err = nullptr;
        lib.lock_iothread();
        if (save) {
            q.save(file.c_str(), true, false, &err); // live=false: keep the disks active
        } else {
            // The Xen-style stream has no configuration section; the load
            // ends with migration_incoming_state_destroy, which unregisters
            // the migration yank instance that an incoming migration has.
            q.set_bool(q.migrate_current(), "send-configuration", false, &err);
            static YankMigration yi;
            if (!err) q.yank_register(&yi, &err);
            if (!err) q.load(file.c_str(), &err);
        }
        lib.unlock_iothread();
        if (err) {
            std::string m = q.pretty(err);
            q.efree(err);
            throw rpc_error{ E_REJECTED, std::string(save ? "saving" : "loading") + " the QEMU device state: " + m };
        }
    }

    /** SystemC thread: a memory range to or from a sparse file, through DMI (else debug transport). */
    void memory_file(bool save, const std::string& file, CkptMemory& m)
    {
        if (m.bus >= bus.size()) throw rpc_error{ E_NOT_FOUND, "memory " + m.name + ": no bus " + std::to_string(m.bus) };
        tlm::tlm_generic_payload t;
        tlm::tlm_dmi dmi;
        unsigned char probe[4];
        t.set_command(save ? tlm::TLM_READ_COMMAND : tlm::TLM_WRITE_COMMAND);
        t.set_address(m.address);
        t.set_data_ptr(probe);
        t.set_data_length(4);
        t.set_streaming_width(4);
        unsigned char* base = nullptr;
        if (bus[m.bus]->get_direct_mem_ptr(t, dmi) && dmi.get_start_address() <= m.address &&
            dmi.get_end_address() >= m.address + m.size - 1 && (save ? dmi.is_read_allowed() : dmi.is_write_allowed()))
            base = dmi.get_dmi_ptr() + (m.address - dmi.get_start_address());
        const size_t PG = 4096;
        static const unsigned char zero[4096] = {};
        std::vector<unsigned char> buf(PG);
        // One page through the bus when there is no DMI (slow: for small memories).
        auto page = [&](uint64_t off, size_t n, unsigned char* data, bool write) {
            if (base) {
                if (write) std::memcpy(base + off, data, n);
                else std::memcpy(data, base + off, n);
                return;
            }
            tlm::tlm_generic_payload p;
            p.set_command(write ? tlm::TLM_WRITE_COMMAND : tlm::TLM_READ_COMMAND);
            p.set_address(m.address + off);
            p.set_data_ptr(data);
            p.set_data_length(unsigned(n));
            p.set_streaming_width(unsigned(n));
            p.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
            if (bus[m.bus]->transport_dbg(p) != n)
                throw rpc_error{ E_REJECTED, "memory " + m.name + ": no DMI and no debug access at " + hex(m.address + off) };
        };
        const int fd = save ? ::open(file.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644)
                            : ::open(file.c_str(), O_RDONLY | O_CLOEXEC);
        if (fd < 0) throw rpc_error{ E_REJECTED, file + ": " + std::strerror(errno) };
        struct Closer {
            int fd;
            ~Closer() { ::close(fd); }
        } closer{ fd };
        m.data = 0;
        if (save) {
            for (uint64_t off = 0; off < m.size; off += PG) {
                const size_t n = size_t(std::min<uint64_t>(PG, m.size - off));
                unsigned char* p = base ? base + off : buf.data();
                if (!base) page(off, n, buf.data(), false);
                if (std::memcmp(p, zero, n) == 0) continue; // a hole in the file
                if (::pwrite(fd, p, n, off_t(off)) != ssize_t(n)) throw rpc_error{ E_REJECTED, file + ": write failed" };
                m.data += n;
            }
            if (::ftruncate(fd, off_t(m.size)) != 0) throw rpc_error{ E_REJECTED, file + ": " + std::strerror(errno) };
            return;
        }
        struct stat st {};
        if (::fstat(fd, &st) != 0 || uint64_t(st.st_size) != m.size)
            throw rpc_error{ E_REJECTED, file + ": not the size of memory " + m.name };
        for (uint64_t off = 0; off < m.size;) {
            const off_t d = ::lseek(fd, off_t(off), SEEK_DATA);
            const uint64_t data_at = d < 0 ? m.size : std::min<uint64_t>(uint64_t(d), m.size);
            for (uint64_t z = off; z < data_at; z += PG) { // a hole: the memory must read zero
                const size_t n = size_t(std::min<uint64_t>(PG, data_at - z));
                if (base) {
                    if (std::memcmp(base + z, zero, n) != 0) std::memset(base + z, 0, n);
                } else {
                    std::memset(buf.data(), 0, n);
                    page(z, n, buf.data(), true);
                }
            }
            if (data_at >= m.size) break;
            const off_t h = ::lseek(fd, off_t(data_at), SEEK_HOLE);
            const uint64_t end = h < 0 ? m.size : std::min<uint64_t>(uint64_t(h), m.size);
            for (uint64_t o = data_at; o < end;) {
                const size_t want = size_t(std::min<uint64_t>(base ? (1u << 20) : PG, end - o));
                unsigned char* p = base ? base + o : buf.data();
                const ssize_t n = ::pread(fd, p, want, off_t(o));
                if (n <= 0) throw rpc_error{ E_REJECTED, file + ": read failed" };
                if (!base) page(o, size_t(n), buf.data(), true);
                o += uint64_t(n);
                m.data += uint64_t(n);
            }
            off = end;
        }
    }

    /** SystemC thread: one register through the bus (debug transport, else a zero-delay access). */
    void register_access(CkptRegister& x, bool write)
    {
        if (x.bus >= bus.size()) throw rpc_error{ E_NOT_FOUND, "register " + x.name + ": no bus " + std::to_string(x.bus) };
        std::vector<unsigned char> data(x.size, 0);
        if (write) {
            if (x.value.size() != 2 * x.size) throw rpc_error{ E_PARAMS, "register " + x.name + ": bad saved value" };
            for (unsigned i = 0; i < x.size; i++) data[i] = uint8_t(std::stoul(x.value.substr(2 * i, 2), nullptr, 16));
        }
        tlm::tlm_generic_payload t;
        t.set_command(write ? tlm::TLM_WRITE_COMMAND : tlm::TLM_READ_COMMAND);
        t.set_address(x.address);
        t.set_data_ptr(data.data());
        t.set_data_length(x.size);
        t.set_streaming_width(x.size);
        t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
        struct Mark {
            Mark() { TraceStore::agent_access() = true; }
            ~Mark() { TraceStore::agent_access() = false; }
        } mark;
        unsigned n = bus[x.bus]->transport_dbg(t);
        if (n == 0 && t.get_response_status() == tlm::TLM_INCOMPLETE_RESPONSE) {
            sc_core::sc_time delay = sc_core::SC_ZERO_TIME;
            t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
            bus[x.bus]->b_transport(t, delay);
            n = t.get_response_status() == tlm::TLM_OK_RESPONSE ? x.size : 0;
        }
        if (n == 0) throw rpc_error{ E_REJECTED, "register " + x.name + " at " + hex(x.address) + ": the bus did not complete the access" };
        if (!write) {
            static const char* hexd = "0123456789abcdef";
            x.value.clear();
            for (unsigned char c : data) {
                x.value.push_back(hexd[c >> 4]);
                x.value.push_back(hexd[c & 15]);
            }
        }
    }

    static std::string join(const std::string& dir, const std::string& f) { return dir + "/" + f; }

    void write_ckpt_json(Writer& w, const sc_core::sc_time& t, const std::vector<CkptMemory>& mems,
                         const std::vector<CkptRegister>& regs, uint64_t device_bytes)
    {
        w.StartObject();
        w.Key("agent");
        w.String(AGENT_VERSION);
        w.Key("time");
        write_time(w, t);
        w.Key("devices");
        w.StartObject();
        w.Key("file");
        w.String("devices.qemu");
        w.Key("bytes");
        w.Uint64(device_bytes);
        w.EndObject();
        w.Key("memories");
        w.StartArray();
        for (auto& m : mems) {
            w.StartObject();
            w.Key("name"); w.String(m.name);
            w.Key("address"); w.String(hex(m.address));
            w.Key("size"); w.String(hex(m.size));
            w.Key("bus"); w.Uint64(m.bus);
            w.Key("file"); w.String("mem-" + safe_name(m.name) + ".bin");
            w.Key("data"); w.Uint64(m.data);
            w.EndObject();
        }
        w.EndArray();
        w.Key("registers");
        w.StartArray();
        for (auto& x : regs) {
            w.StartObject();
            w.Key("name"); w.String(x.name);
            w.Key("address"); w.String(hex(x.address));
            w.Key("bus"); w.Uint64(x.bus);
            w.Key("size"); w.Uint(x.size);
            w.Key("value"); w.String(x.value);
            w.EndObject();
        }
        w.EndArray();
        w.EndObject();
    }

    /** Server thread: save a checkpoint into dir (made if missing). The simulation must be paused. */
    std::string ckpt_save(const std::string& dir, std::vector<CkptMemory> mems, std::vector<CkptRegister> regs)
    {
        if (!m_paused.load() && !m_halted.load()) throw rpc_error{ E_STATE, "pause the simulation first (sim.pause)" };
        std::string why;
        if (!checkpoint_support(why)) throw rpc_error{ E_STATE, why };
        if (::mkdir(dir.c_str(), 0755) != 0 && errno != EEXIST) throw rpc_error{ E_REJECTED, dir + ": " + std::strerror(errno) };
        const auto t0 = std::chrono::steady_clock::now();
        const std::string devfile = join(dir, "devices.qemu");
        qemu_device_state(true, devfile);
        struct stat st {};
        ::stat(devfile.c_str(), &st);
        const uint64_t dev_bytes = uint64_t(st.st_size);
        std::string result;
        rpc_error err{ E_INTERNAL, "" };
        const bool ok = run_on_sim(
            [&](Writer& w) {
                for (auto& m : mems) memory_file(true, join(dir, "mem-" + safe_name(m.name) + ".bin"), m);
                for (auto& x : regs) register_access(x, false);
                const sc_core::sc_time now = sc_core::sc_time_stamp();
                json::StringBuffer sb;
                json::PrettyWriter<json::StringBuffer> pw(sb);
                {
                    // the same object for the file and the answer
                    json::StringBuffer tmp;
                    Writer tw(tmp);
                    write_ckpt_json(tw, now, mems, regs, dev_bytes);
                    json::Document d;
                    d.Parse(tmp.GetString());
                    d.Accept(pw);
                }
                const std::string file = join(dir, "agent.json");
                FILE* f = std::fopen(file.c_str(), "w");
                if (!f) throw rpc_error{ E_REJECTED, file + ": " + std::strerror(errno) };
                std::fwrite(sb.GetString(), 1, sb.GetSize(), f);
                std::fputc('\n', f);
                std::fclose(f);
                write_ckpt_json(w, now, mems, regs, dev_bytes);
            },
            result, err);
        if (!ok) throw err;
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        SCP_INFO(()) << "checkpoint saved to " << dir << " in " << ms << " ms";
        return result;
    }

    /** Server thread, at start: load the checkpoint in restore_from, then run unless restore_paused. */
    void restore_at_start()
    {
        const std::string dir = p_restore_from.get_value();
        const auto t0 = std::chrono::steady_clock::now();
        std::string result;
        try {
            // Wait until the simulation runs: every start_of_simulation has
            // returned, so QEMU has finished its initialisation.
            rpc_error first{ E_INTERNAL, "" };
            if (!run_on_sim([](Writer& w) { w.Null(); }, result, first)) throw first;
            set_paused(true, "restore", result);
            FILE* f = std::fopen(join(dir, "agent.json").c_str(), "r");
            if (!f) throw rpc_error{ E_REJECTED, join(dir, "agent.json") + ": " + std::strerror(errno) };
            char rb[65536];
            json::FileReadStream is(f, rb, sizeof rb);
            json::Document d;
            d.ParseStream(is);
            std::fclose(f);
            if (d.HasParseError() || !d.IsObject()) throw rpc_error{ E_REJECTED, join(dir, "agent.json") + " is not valid JSON" };
            std::vector<CkptMemory> mems;
            std::vector<CkptRegister> regs;
            if (d.HasMember("memories") && d["memories"].IsArray())
                for (auto& m : d["memories"].GetArray()) mems.push_back(memory_of(m));
            if (d.HasMember("registers") && d["registers"].IsArray())
                for (auto& x : d["registers"].GetArray()) regs.push_back(register_of(x));
            rpc_error err{ E_INTERNAL, "" };
            if (!run_on_sim([&](Writer& w) {
                    for (auto& m : mems) memory_file(false, join(dir, "mem-" + safe_name(m.name) + ".bin"), m);
                    w.Null();
                }, result, err))
                throw err;
            qemu_device_state(false, join(dir, "devices.qemu"));
            if (!run_on_sim([&](Writer& w) {
                    for (auto& x : regs) register_access(x, true);
                    w.Null();
                }, result, err))
                throw err;
            {
                std::lock_guard<std::mutex> g(m_restore_mu);
                m_restore_state = "restored";
            }
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
            std::printf("sim-agent: restored checkpoint %s in %.0f ms\n", dir.c_str(), ms);
            std::fflush(stdout);
            if (!p_restore_paused.get_value()) set_paused(false, nullptr, result);
        } catch (const rpc_error& e) {
            {
                std::lock_guard<std::mutex> g(m_restore_mu);
                m_restore_state = "failed";
                m_restore_error = e.message;
            }
            // Stays paused: running on would boot the guest as if nothing had been asked.
            std::fprintf(stderr, "sim-agent: restoring %s failed: %s (the simulation stays paused)\n", dir.c_str(), e.message.c_str());
            std::fflush(stderr);
        }
    }

    std::mutex m_restore_mu;
    std::string m_restore_state = "pending";
    std::string m_restore_error;

    /** Returns the "result" JSON text, or throws rpc_error. */
    std::string dispatch(const Request& r, bool& state_changed)
    {
        std::string result;
        rpc_error err{ E_INTERNAL, "" };
        auto on_sim = [&](std::function<void(Writer&)> fn) {
            if (!run_on_sim(std::move(fn), result, err)) throw err;
            return result;
        };

        if (r.method == "agent.getInfo") {
            json::StringBuffer sb;
            Writer w(sb);
            w.StartObject();
            w.Key("name");
            w.String(AGENT_NAME);
            w.Key("version");
            w.String(AGENT_VERSION);
            w.Key("protocol");
            w.Int(PROTOCOL_VERSION);
            w.Key("module");
            w.String(name());
            w.Key("systemc");
            w.String(sc_core::sc_release());
            w.Key("qemuInstances");
            w.Uint(unsigned(m_qemu.size()));
            w.Key("buses");
            w.Uint(unsigned(bus.size()));
            w.Key("checkpoints"); // whether this QBox's libqemu saves device state
            {
                std::string why;
                w.Bool(checkpoint_support(why));
            }
            w.Key("methods");
            w.StartArray();
            for (const char* m : { "agent.getInfo", "sim.getStatus", "sim.pause", "sim.continue", "sim.runFor",
                                   "sim.runUntil", "cci.listParams",
                                   "cci.getParam", "cci.setParam", "trace.getStatus", "trace.setEnabled", "trace.setPoints", "trace.read", "trace.clear",
                                   "break.set", "break.list", "break.clear", "mem.read", "mem.write",
                                   "profile.getStatus", "profile.setEnabled", "profile.reset", "profile.read", "ftrace.getStatus",
                                   "ftrace.setEnabled", "ftrace.clear", "ftrace.save", "ckpt.save" })
                w.String(m);
            w.EndArray();
            w.EndObject();
            return std::string(sb.GetString(), sb.GetSize());
        }

        if (r.method == "ckpt.save") {
            const std::string dir = str_param(r, "dir", true);
            std::vector<CkptMemory> mems;
            std::vector<CkptRegister> regs;
            if (r.params && r.params->HasMember("memories")) {
                const json::Value& a = (*r.params)["memories"];
                if (!a.IsArray()) throw rpc_error{ E_PARAMS, "\"memories\" must be a list" };
                for (auto& m : a.GetArray()) mems.push_back(memory_of(m));
            }
            if (r.params && r.params->HasMember("registers")) {
                const json::Value& a = (*r.params)["registers"];
                if (!a.IsArray()) throw rpc_error{ E_PARAMS, "\"registers\" must be a list" };
                for (auto& x : a.GetArray()) regs.push_back(register_of(x));
            }
            return ckpt_save(dir, mems, regs);
        }

        if (r.method == "sim.getStatus") {
            return on_sim([this](Writer& w) { write_status(w); });
        }

        if (r.method == "sim.pause" || r.method == "sim.continue") {
            state_changed = set_paused(r.method == "sim.pause", nullptr, result);
            return result;
        }

        if (r.method == "sim.runFor" || r.method == "sim.runUntil") {
            const bool relative = r.method == "sim.runFor";
            const sc_core::sc_time amount = time_param(r, relative ? "duration" : "time");
            if (m_halted.load())
                throw rpc_error{ E_STATE, "a debugger has the target stopped; continue in the debugger first" };
            on_sim([this, relative, amount](Writer& w) {
                const sc_core::sc_time now = sc_core::sc_time_stamp();
                const sc_core::sc_time at = relative ? now + amount : amount;
                if (at <= now)
                    throw rpc_error{ E_PARAMS, "the stop time " + at.to_string() + " is not after the current time " +
                                                   now.to_string() };
                arm_deadline(at);
                write_status(w);
            });
            // Then run, if paused. Continuing does not touch the deadline.
            if (m_paused.load()) state_changed = set_paused(false, nullptr, result);
            return result;
        }

        if (r.method == "cci.listParams") {
            const std::string prefix = str_param(r, "prefix", false);
            const bool internal = bool_param(r, "includeInternal");
            return on_sim([this, prefix, internal](Writer& w) {
                auto broker = cci::cci_get_broker();
                std::vector<cci::cci_param_untyped_handle> handles;
                with_throwing_errors([&] { handles = broker.get_param_handles(); });
                w.StartObject();
                w.Key("params");
                w.StartArray();
                for (auto& h : handles) {
                    if (!h.is_valid()) continue;
                    const char* n = h.name();
                    if (!internal && n[0] == '_' && n[1] == '_') continue; // "__GS.ModuleFactory..." etc.
                    if (!prefix.empty() && std::strncmp(n, prefix.c_str(), prefix.size()) != 0) continue;
                    write_param(w, h);
                }
                w.EndArray();
                w.EndObject();
            });
        }

        if (r.method == "trace.setPoints") {
            // { points?: [label], recording: bool }: no points means every probe.
            if (!(r.params && r.params->HasMember("recording") && (*r.params)["recording"].IsBool()))
                throw rpc_error{ E_PARAMS, "\"recording\" must be a boolean" };
            const bool on = (*r.params)["recording"].GetBool();
            std::vector<std::string> labels;
            if (r.params->HasMember("points")) {
                const auto& a = (*r.params)["points"];
                if (!a.IsArray()) throw rpc_error{ E_PARAMS, "\"points\" must be an array of probe names" };
                for (const auto& e : a.GetArray()) {
                    if (!e.IsString()) throw rpc_error{ E_PARAMS, "\"points\" must be an array of probe names" };
                    labels.emplace_back(e.GetString(), e.GetStringLength());
                }
            } else {
                for (auto& pi : TraceStore::get().point_info()) labels.push_back(pi.label);
            }
            const auto known = TraceStore::get().point_info();
            for (auto& l : labels)
                if (std::none_of(known.begin(), known.end(), [&](const TraceStore::PointInfo& pi) { return pi.label == l; }))
                    throw rpc_error{ E_PARAMS, "no probe named " + l };
            // On the SystemC thread: a memory probe takes back DMI pointers through the router.
            on_sim([labels, on](Writer& w) {
                for (auto& l : labels) TraceStore::get().set_point(l, on);
                w.Null();
            });
        }

        if (r.method == "trace.getStatus" || r.method == "trace.setEnabled" || r.method == "trace.clear" ||
            r.method == "trace.setPoints") {
            auto& store = TraceStore::get();
            if (r.method == "trace.setEnabled") {
                if (!(r.params && r.params->HasMember("enabled") && (*r.params)["enabled"].IsBool()))
                    throw rpc_error{ E_PARAMS, "\"enabled\" must be a boolean" };
                store.set_enabled((*r.params)["enabled"].GetBool());
            }
            if (r.method == "trace.clear") store.clear();
            size_t count;
            uint64_t last, dropped;
            std::vector<std::string> points;
            store.status(count, last, dropped, points);
            json::StringBuffer sb;
            Writer w(sb);
            w.StartObject();
            w.Key("enabled");
            w.Bool(store.enabled());
            w.Key("points");
            w.StartArray();
            for (auto& p : points) w.String(p);
            w.EndArray();
            w.Key("probes");
            w.StartArray();
            for (auto& pi : store.point_info()) {
                w.StartObject();
                w.Key("name");
                w.String(pi.label);
                w.Key("kind");
                w.String(pi.kind);
                w.Key("recording");
                w.Bool(pi.recording);
                w.EndObject();
            }
            w.EndArray();
            w.Key("count");
            w.Uint64(count);
            w.Key("lastSeq");
            w.Uint64(last);
            w.Key("dropped");
            w.Uint64(dropped);
            w.Key("capacity");
            w.Uint64(TraceStore::CAPACITY);
            w.EndObject();
            return std::string(sb.GetString(), sb.GetSize());
        }

        if (r.method == "break.set" || r.method == "break.list" || r.method == "break.clear") {
            auto& store = TraceStore::get();
            if (r.method == "break.clear") store.set_breakpoints({});
            if (r.method == "break.set") {
                if (!(r.params && r.params->HasMember("breakpoints") && (*r.params)["breakpoints"].IsArray()))
                    throw rpc_error{ E_PARAMS, "\"breakpoints\" must be an array" };
                std::vector<TraceStore::Breakpoint> list;
                uint32_t next_id = 1;
                for (const auto& e : (*r.params)["breakpoints"].GetArray()) {
                    if (!e.IsObject()) throw rpc_error{ E_PARAMS, "each breakpoint must be an object" };
                    TraceStore::Breakpoint b;
                    b.id = e.HasMember("id") ? uint32_t(u64_of(e["id"], "\"id\"")) : next_id;
                    next_id = std::max(next_id, b.id + 1);
                    if (e.HasMember("point") && !e["point"].IsNull()) {
                        if (!e["point"].IsString()) throw rpc_error{ E_PARAMS, "\"point\" must be a trace point label" };
                        const std::string label = e["point"].GetString();
                        b.point = store.point_index(label);
                        if (b.point < 0)
                            throw rpc_error{ E_NOT_FOUND, "no trace point " + label + " (breakpoints need the device to be traced)" };
                    }
                    if (e.HasMember("from")) b.lo = u64_of(e["from"], "\"from\"");
                    if (e.HasMember("to")) b.hi = u64_of(e["to"], "\"to\"");
                    else if (e.HasMember("size")) {
                        const uint64_t size = u64_of(e["size"], "\"size\"");
                        if (!size) throw rpc_error{ E_PARAMS, "\"size\" must be greater than 0" };
                        b.hi = b.lo + size - 1;
                    } else if (e.HasMember("from")) {
                        b.hi = b.lo; // one address
                    }
                    if (b.hi < b.lo) throw rpc_error{ E_PARAMS, "\"to\" is below \"from\"" };
                    if (e.HasMember("access")) {
                        const std::string a = e["access"].IsString() ? e["access"].GetString() : "";
                        if (a != "r" && a != "w" && a != "rw") throw rpc_error{ E_PARAMS, "\"access\" must be \"r\", \"w\" or \"rw\"" };
                        b.on_read = a != "w";
                        b.on_write = a != "r";
                    }
                    if (e.HasMember("value")) {
                        b.value = u64_of(e["value"], "\"value\"");
                        b.mask = e.HasMember("mask") ? u64_of(e["mask"], "\"mask\"") : ~uint64_t(0);
                        if (!b.mask) throw rpc_error{ E_PARAMS, "\"mask\" must not be 0" };
                    } else if (e.HasMember("mask")) {
                        throw rpc_error{ E_PARAMS, "\"mask\" needs a \"value\"" };
                    }
                    list.push_back(b);
                }
                store.set_breakpoints(std::move(list));
            }
            std::vector<TraceRecord> none;
            uint64_t last, dropped;
            std::vector<std::string> points;
            store.read(~uint64_t(0), 0, none, last, dropped, points);
            json::StringBuffer sb;
            Writer w(sb);
            w.StartObject();
            w.Key("breakpoints");
            w.StartArray();
            for (const auto& b : store.breakpoints()) write_breakpoint(w, b, points);
            w.EndArray();
            w.Key("points");
            w.StartArray();
            for (auto& p : points) w.String(p);
            w.EndArray();
            w.EndObject();
            return std::string(sb.GetString(), sb.GetSize());
        }

        if (r.method == "mem.read" || r.method == "mem.write") {
            // Debug transport: no simulated time passes. The target decides what
            // it does: QBox's QEMU devices run the normal access, side effects
            // included (reading the PL011 data register takes a character).
            const bool write = r.method == "mem.write";
            if (!(r.params && r.params->HasMember("address"))) throw rpc_error{ E_PARAMS, "missing \"address\"" };
            const uint64_t address = u64_of((*r.params)["address"], "\"address\"");
            uint64_t busi = 0;
            if (r.params->HasMember("bus")) busi = u64_of((*r.params)["bus"], "\"bus\"");
            if (busi >= bus.size())
                throw rpc_error{ E_NOT_FOUND, bus.size() ? "no bus " + std::to_string(busi) + " (the agent has " + std::to_string(bus.size()) + ")"
                                                         : std::string("the agent has no bus: the launcher did not connect it to the routers") };
            std::vector<unsigned char> data;
            if (write) {
                const std::string hexs = str_param(r, "data", true);
                if (hexs.empty() || hexs.size() % 2 || hexs.size() > 2 * 4096)
                    throw rpc_error{ E_PARAMS, "\"data\" must be 1 to 4096 bytes as hex, in memory order" };
                for (size_t i = 0; i < hexs.size(); i += 2) {
                    auto nib = [&](char c) -> int {
                        if (c >= '0' && c <= '9') return c - '0';
                        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                        throw rpc_error{ E_PARAMS, "\"data\" must be hex" };
                    };
                    data.push_back(uint8_t(nib(hexs[i]) << 4 | nib(hexs[i + 1])));
                }
            } else {
                const uint64_t size = r.params->HasMember("size") ? u64_of((*r.params)["size"], "\"size\"") : 4;
                if (size < 1 || size > 4096) throw rpc_error{ E_PARAMS, "\"size\" must be 1 to 4096" };
                data.resize(size);
            }
            return on_sim([this, write, address, busi, data](Writer& w) mutable {
                tlm::tlm_generic_payload t;
                t.set_command(write ? tlm::TLM_WRITE_COMMAND : tlm::TLM_READ_COMMAND);
                t.set_address(address);
                t.set_data_ptr(data.data());
                t.set_data_length(unsigned(data.size()));
                t.set_streaming_width(unsigned(data.size()));
                t.set_byte_enable_ptr(nullptr);
                t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
                struct Mark { // the tracers ignore the agent's own accesses
                    Mark() { TraceStore::agent_access() = true; }
                    ~Mark() { TraceStore::agent_access() = false; }
                } mark;
                unsigned n = bus[busi]->transport_dbg(t);
                bool normal = false;
                if (n == 0 && t.get_response_status() == tlm::TLM_INCOMPLETE_RESPONSE) {
                    // The target has no debug transport (QBox's SystemC Pl011, for
                    // one): make a normal access instead, with no delay. It runs on
                    // this SystemC thread, so it is as safe as any model's access.
                    sc_core::sc_time delay = sc_core::SC_ZERO_TIME;
                    t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
                    bus[busi]->b_transport(t, delay);
                    normal = true;
                    n = t.get_response_status() == tlm::TLM_OK_RESPONSE ? unsigned(data.size()) : 0;
                }
                if (t.get_response_status() != tlm::TLM_OK_RESPONSE || n == 0)
                    throw rpc_error{ E_REJECTED, "the bus did not complete the access at " + hex(address) + " (" +
                                                     t.get_response_string() + ")" };
                static const char* hexd = "0123456789abcdef";
                std::string out;
                for (size_t i = 0; i < data.size(); i++) {
                    out.push_back(hexd[data[i] >> 4]);
                    out.push_back(hexd[data[i] & 15]);
                }
                w.StartObject();
                w.Key("address");
                w.String(hex(address));
                w.Key("data");
                w.String(out);
                w.Key("length");
                w.Uint(n);
                w.Key("via"); // "debug": debug transport; "b_transport": the target has none
                w.String(normal ? "b_transport" : "debug");
                w.EndObject();
            });
        }

        if (r.method == "ftrace.getStatus" || r.method == "ftrace.setEnabled" || r.method == "ftrace.clear" ||
            r.method == "ftrace.save") {
            FTracer& f = FTracer::get();
            if (r.method != "ftrace.getStatus" && !f.active)
                throw rpc_error{ E_STATE, m_profile_problem.empty() ? "the simulation was not started with the function trace (ftrace)"
                                                                    : m_profile_problem };
            if (r.method == "ftrace.setEnabled") {
                if (!(r.params && r.params->HasMember("enabled") && (*r.params)["enabled"].IsBool()))
                    throw rpc_error{ E_PARAMS, "\"enabled\" must be a boolean" };
                if (r.params->HasMember("space")) {
                    const auto& v = (*r.params)["space"];
                    const std::string sp = v.IsString() ? v.GetString() : "";
                    if (sp == "all") f.space = FTracer::ALL;
                    else if (sp == "kernel") f.space = FTracer::KERNEL;
                    else if (sp == "user") f.space = FTracer::USER;
                    else throw rpc_error{ E_PARAMS, "\"space\" must be \"all\", \"kernel\" or \"user\"" };
                }
                f.enabled = (*r.params)["enabled"].GetBool();
            }
            if (r.method == "ftrace.clear") f.clear();
            json::StringBuffer sb;
            Writer w(sb);
            w.StartObject();
            if (r.method == "ftrace.save") {
                if (!(r.params && r.params->HasMember("path") && (*r.params)["path"].IsString() &&
                      (*r.params)["path"].GetString()[0] == '/'))
                    throw rpc_error{ E_PARAMS, "\"path\" must be an absolute file path" };
                std::pair<unsigned, uint64_t> res;
                try {
                    res = f.save((*r.params)["path"].GetString());
                } catch (const std::exception& e) {
                    throw rpc_error{ E_INTERNAL, e.what() };
                }
                w.Key("path");
                w.String((*r.params)["path"].GetString());
                w.Key("cpus");
                w.Uint(res.first);
                w.Key("events");
                w.Uint64(res.second);
                w.EndObject();
                return std::string(sb.GetString(), sb.GetSize());
            }
            w.Key("active");
            w.Bool(f.active.load());
            if (!m_profile_problem.empty()) {
                w.Key("problem");
                w.String(m_profile_problem);
            }
            w.Key("enabled");
            w.Bool(f.enabled.load());
            w.Key("space");
            w.String(f.space == FTracer::KERNEL ? "kernel" : f.space == FTracer::USER ? "user" : "all");
            w.Key("capacity");
            w.Uint64(f.capacity);
            w.Key("seconds"); // host time since the last clear
            w.Double(f.active ? double(FTracer::now_ns() - f.origin_ns.load()) / 1e9 : 0.0);
            w.Key("cpus");
            w.StartArray();
            for (unsigned i = 0; i < FTracer::MAX_CPUS; i++) {
                auto& c = f.cpus[i];
                std::lock_guard<std::mutex> l(c.mu);
                if (!c.total) continue;
                w.StartObject();
                w.Key("cpu");
                w.Uint(i);
                w.Key("events");
                w.Uint64(c.total);
                w.Key("stored");
                w.Uint64(std::min<uint64_t>(c.total, f.capacity));
                w.EndObject();
            }
            w.EndArray();
            w.EndObject();
            return std::string(sb.GetString(), sb.GetSize());
        }

        if (r.method == "profile.getStatus" || r.method == "profile.setEnabled" || r.method == "profile.reset" ||
            r.method == "profile.read") {
            Profiler& p = Profiler::get();
            if (r.method == "profile.setEnabled") {
                if (!(r.params && r.params->HasMember("enabled") && (*r.params)["enabled"].IsBool()))
                    throw rpc_error{ E_PARAMS, "\"enabled\" must be a boolean" };
                p.enabled = (*r.params)["enabled"].GetBool();
            }
            if (r.method == "profile.reset") p.reset();
            int64_t only = -1; // profile.read: one CPU, or all
            if (r.method == "profile.read" && r.params && r.params->HasMember("cpu")) {
                only = int64_t(u64_of((*r.params)["cpu"], "\"cpu\""));
                if (only >= Profiler::MAX_CPUS) throw rpc_error{ E_PARAMS, "no such CPU" };
            }
            json::StringBuffer sb;
            Writer w(sb);
            w.StartObject();
            w.Key("active");
            w.Bool(p.active.load());
            if (!m_profile_problem.empty()) {
                w.Key("problem");
                w.String(m_profile_problem);
            }
            w.Key("enabled");
            w.Bool(p.enabled.load());
            w.Key("period");
            w.Uint64(p.period);
            const uint64_t now = uint64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(
                                              std::chrono::steady_clock::now().time_since_epoch())
                                              .count());
            w.Key("seconds"); // host time since the last reset
            w.Double(p.active ? double(now - p.since_ns.load()) / 1e9 : 0.0);
            w.Key("cpus");
            w.StartArray();
            std::unordered_map<uint64_t, uint64_t> merged;
            for (unsigned i = 0; i < Profiler::MAX_CPUS; i++) {
                auto& c = p.cpus[i];
                std::lock_guard<std::mutex> l(c.mu);
                if (!c.samples && c.counts.empty()) continue;
                w.StartObject();
                w.Key("cpu");
                w.Uint(i);
                w.Key("samples");
                w.Uint64(c.samples);
                w.EndObject();
                if (r.method == "profile.read" && (only < 0 || only == int64_t(i)))
                    for (auto& kv : c.counts) merged[kv.first] += kv.second;
            }
            w.EndArray();
            if (r.method == "profile.read") {
                w.Key("blocks"); // [address, samples], most samples first
                std::vector<std::pair<uint64_t, uint64_t>> v(merged.begin(), merged.end());
                std::sort(v.begin(), v.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
                w.StartArray();
                for (auto& kv : v) {
                    w.StartArray();
                    w.String(hex(kv.first));
                    w.Uint64(kv.second);
                    w.EndArray();
                }
                w.EndArray();
            }
            w.EndObject();
            return std::string(sb.GetString(), sb.GetSize());
        }

        if (r.method == "trace.read") {
            uint64_t since = 0;
            size_t max = 2000;
            if (r.params && r.params->HasMember("since")) {
                const json::Value& v = (*r.params)["since"];
                if (!v.IsUint64()) throw rpc_error{ E_PARAMS, "\"since\" must be a non-negative integer" };
                since = v.GetUint64();
            }
            if (r.params && r.params->HasMember("max")) {
                const json::Value& v = (*r.params)["max"];
                if (!v.IsUint64() || v.GetUint64() == 0) throw rpc_error{ E_PARAMS, "\"max\" must be a positive integer" };
                max = std::min<uint64_t>(v.GetUint64(), 20000);
            }
            std::vector<TraceRecord> recs;
            uint64_t last, dropped;
            std::vector<std::string> points;
            TraceStore::get().read(since, max, recs, last, dropped, points);
            json::StringBuffer sb;
            Writer w(sb);
            static const char* hexd = "0123456789abcdef";
            std::map<std::tuple<uint16_t, uint8_t, int16_t, int16_t, int16_t, int16_t>, std::string> names; // initiator of each (router, path) seen in this reply
            w.StartObject();
            w.Key("records");
            w.StartArray();
            for (auto& rec : recs) {
                char data[2 * sizeof rec.data + 1];
                size_t n = std::min<size_t>(sizeof rec.data, rec.length);
                for (size_t i = 0; i < n; i++) {
                    data[2 * i] = hexd[rec.data[i] >> 4];
                    data[2 * i + 1] = hexd[rec.data[i] & 15];
                }
                char addr[19];
                std::snprintf(addr, sizeof addr, "0x%llx", (unsigned long long)rec.address);
                w.StartArray(); // compact: [seq, time_s, point, "R"|"W", address, length, data_hex, status, initiator]
                w.Uint64(rec.seq);
                w.Double(rec.time_s);
                w.Uint(rec.point);
                w.String(rec.signal ? "S" : rec.write ? "W" : "R");
                w.String(addr);
                w.Uint(rec.length);
                w.String(data, json::SizeType(2 * n));
                w.Int(rec.status);
                // Resolved here, not when recorded: the access path stays cheap.
                const auto key = std::make_tuple(rec.router, rec.npath, rec.path[0], rec.path[1], rec.path[2], rec.path[3]);
                auto c = names.find(key);
                if (c == names.end()) c = names.emplace(key, InitiatorNames::get().resolve(rec.router, rec.npath, rec.path)).first;
                w.String(c->second);
                w.EndArray();
            }
            w.EndArray();
            w.Key("points");
            w.StartArray();
            for (auto& p : points) w.String(p);
            w.EndArray();
            w.Key("lastSeq");
            w.Uint64(last);
            w.Key("dropped");
            w.Uint64(dropped);
            w.EndObject();
            return std::string(sb.GetString(), sb.GetSize());
        }

        if (r.method == "cci.getParam") {
            const std::string pname = str_param(r, "name", true);
            return on_sim([this, pname](Writer& w) {
                auto broker = cci::cci_get_broker();
                cci::cci_param_untyped_handle h = broker.get_param_handle(pname);
                if (!h.is_valid()) throw rpc_error{ E_NOT_FOUND, "no parameter named " + pname };
                write_param(w, h);
            });
        }

        if (r.method == "cci.setParam") {
            const std::string pname = str_param(r, "name", true);
            // The value as JSON: "value" (any JSON), or "valueJson" (its text,
            // so integers beyond 2^53 keep every digit).
            std::string text;
            if (r.params && r.params->HasMember("valueJson")) {
                text = str_param(r, "valueJson", true);
            } else if (r.params && r.params->HasMember("value")) {
                json::StringBuffer vb;
                Writer vw(vb);
                (*r.params)["value"].Accept(vw);
                text.assign(vb.GetString(), vb.GetSize());
            } else {
                throw rpc_error{ E_PARAMS, "missing \"value\" or \"valueJson\"" };
            }
            return on_sim([this, pname, text](Writer& w) {
                auto broker = cci::cci_get_broker();
                cci::cci_param_untyped_handle h = broker.get_param_handle(pname);
                if (!h.is_valid()) throw rpc_error{ E_NOT_FOUND, "no parameter named " + pname };
                if (h.is_locked()) throw rpc_error{ E_LOCKED, pname + " is locked" };
                if (h.get_mutable_type() == cci::CCI_IMMUTABLE_PARAM)
                    throw rpc_error{ E_LOCKED, pname + " is immutable: it can only be set before the simulation starts" };
                try {
                    with_throwing_errors([&] { h.set_cci_value(cci::cci_value::from_json(text)); });
                } catch (const sc_core::sc_report& e) {
                    throw rpc_error{ E_REJECTED, std::string(e.get_msg()) };
                } catch (const std::exception& e) {
                    throw rpc_error{ E_REJECTED, e.what() };
                }
                write_param(w, h);
            });
        }

        throw rpc_error{ E_METHOD, "method not found: " + r.method };
    }

    /* ------------------------------------------------------------ JSON-RPC framing */

    static void write_id(Writer& w, const json::Value* id)
    {
        if (!id)
            w.Null();
        else if (id->IsString())
            w.String(id->GetString(), id->GetStringLength());
        else if (id->IsInt64())
            w.Int64(id->GetInt64());
        else if (id->IsUint64())
            w.Uint64(id->GetUint64());
        else if (id->IsDouble())
            w.Double(id->GetDouble());
        else
            w.Null();
    }

    static std::string notification(const char* method, const std::string& params)
    {
        json::StringBuffer sb;
        Writer w(sb);
        w.StartObject();
        w.Key("jsonrpc");
        w.String("2.0");
        w.Key("method");
        w.String(method);
        w.Key("params");
        w.RawValue(params.c_str(), params.size(), json::kObjectType);
        w.EndObject();
        return std::string(sb.GetString(), sb.GetSize());
    }

    static std::string error_response(const json::Value* id, const rpc_error& e)
    {
        json::StringBuffer sb;
        Writer w(sb);
        w.StartObject();
        w.Key("jsonrpc");
        w.String("2.0");
        w.Key("id");
        write_id(w, id);
        w.Key("error");
        w.StartObject();
        w.Key("code");
        w.Int(e.code);
        w.Key("message");
        w.String(e.message);
        w.EndObject();
        w.EndObject();
        return std::string(sb.GetString(), sb.GetSize());
    }

    static std::string result_response(const json::Value* id, const std::string& result)
    {
        json::StringBuffer sb;
        Writer w(sb);
        w.StartObject();
        w.Key("jsonrpc");
        w.String("2.0");
        w.Key("id");
        write_id(w, id);
        w.Key("result");
        w.RawValue(result.c_str(), result.size(), json::kObjectType);
        w.EndObject();
        return std::string(sb.GetString(), sb.GetSize());
    }

    /** Handle one line. Returns the response line ("" for notifications);
     *  sets broadcast to a notification for every client, if any. */
    std::string handle_line(const std::string& line, std::string& broadcast)
    {
        json::Document doc;
        doc.Parse(line.c_str(), line.size());
        if (doc.HasParseError()) {
            return error_response(nullptr, { E_PARSE, std::string("parse error: ") +
                                                          json::GetParseError_En(doc.GetParseError()) });
        }
        if (!doc.IsObject()) return error_response(nullptr, { E_INVALID_REQUEST, "request must be an object" });

        const json::Value* id = nullptr;
        if (doc.HasMember("id")) {
            const json::Value& v = doc["id"];
            if (!(v.IsString() || v.IsNumber() || v.IsNull()))
                return error_response(nullptr, { E_INVALID_REQUEST, "id must be a string or number" });
            id = &v;
        }
        if (!doc.HasMember("jsonrpc") || !doc["jsonrpc"].IsString() || std::string(doc["jsonrpc"].GetString()) != "2.0")
            return error_response(id, { E_INVALID_REQUEST, "jsonrpc must be \"2.0\"" });
        if (!doc.HasMember("method") || !doc["method"].IsString())
            return error_response(id, { E_INVALID_REQUEST, "method must be a string" });

        Request r{ doc["method"].GetString(), nullptr };
        if (doc.HasMember("params")) {
            if (!doc["params"].IsObject())
                return error_response(id, { E_PARAMS, "params must be an object" });
            r.params = &doc["params"];
        }

        std::string response;
        bool changed = false;
        try {
            std::string result = dispatch(r, changed);
            response = result_response(id, result);
            if (changed) broadcast = notification("sim.stateChanged", result);
        } catch (const rpc_error& e) {
            response = error_response(id, e);
        }
        return id ? response : std::string();
    }

    /* ------------------------------------------------------------ server */

    struct Client {
        int fd;
        std::string in;
    };

    std::thread m_server;
    std::atomic<bool> m_stop{ false };
    int m_listen = -1;
    int m_wake[2] = { -1, -1 };

    static bool send_line(int fd, const std::string& s)
    {
        std::string msg = s + "\n";
        const char* p = msg.data();
        size_t left = msg.size();
        while (left) {
            ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
            if (n < 0) {
                if (errno == EINTR) continue;
                return false;
            }
            p += n;
            left -= size_t(n);
        }
        return true;
    }

    /** A failure only disables the agent: the simulation itself goes on. */
    void start_server()
    {
        auto fail = [this](const std::string& what) {
            std::fprintf(stderr, "sim-agent: %s; simulation continues without the agent\n", what.c_str());
            if (m_listen >= 0) ::close(m_listen);
            m_listen = -1;
        };
        m_listen = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (m_listen < 0) return fail(std::string("socket: ") + std::strerror(errno));
        int one = 1;
        ::setsockopt(m_listen, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_port = htons(uint16_t(p_port.get_value()));
        if (::inet_pton(AF_INET, p_host.get_value().c_str(), &a.sin_addr) != 1)
            return fail("invalid host address " + p_host.get_value());
        if (::bind(m_listen, reinterpret_cast<sockaddr*>(&a), sizeof a) < 0)
            return fail("cannot listen on " + p_host.get_value() + ":" + std::to_string(p_port.get_value()) + ": " +
                        std::strerror(errno));
        if (::listen(m_listen, 4) < 0) return fail(std::string("listen: ") + std::strerror(errno));
        socklen_t len = sizeof a;
        ::getsockname(m_listen, reinterpret_cast<sockaddr*>(&a), &len);
        if (::pipe2(m_wake, O_CLOEXEC) < 0) return fail(std::string("pipe: ") + std::strerror(errno));

        // Printed (not only logged) so a launcher can find a port picked with port = 0.
        std::printf("sim-agent: listening on %s:%u\n", p_host.get_value().c_str(), unsigned(ntohs(a.sin_port)));
        std::fflush(stdout);

        m_server = std::thread([this] { serve(); });
    }

    void stop_server()
    {
        if (m_stop.exchange(true)) return;
        if (m_wake[1] >= 0) {
            char c = 0;
            (void)!::write(m_wake[1], &c, 1);
        }
        if (m_server.joinable()) m_server.join();
        for (int* fd : { &m_listen, &m_wake[0], &m_wake[1] }) {
            if (*fd >= 0) ::close(*fd);
            *fd = -1;
        }
    }

    void serve()
    {
        if (!p_restore_from.get_value().empty()) restore_at_start();
        std::vector<Client> clients;
        while (!m_stop.load()) {
            std::vector<pollfd> fds;
            fds.push_back({ m_wake[0], POLLIN, 0 });
            fds.push_back({ m_listen, POLLIN, 0 });
            for (auto& c : clients) fds.push_back({ c.fd, POLLIN, 0 });
            if (::poll(fds.data(), fds.size(), m_watch_clock ? 50 : -1) < 0) {
                if (errno == EINTR) continue;
                break;
            }
            if (fds[0].revents) { // shutdown, or a timed stop fired
                char buf[64];
                (void)!::read(m_wake[0], buf, sizeof buf);
                if (m_stop.load()) break;
            }
            if (fds[1].revents & POLLIN) {
                int fd = ::accept4(m_listen, nullptr, nullptr, SOCK_CLOEXEC);
                if (fd >= 0) {
                    int one = 1;
                    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
                    clients.push_back({ fd, {} });
                }
            }
            std::vector<std::string> broadcasts;
            handle_deadline(broadcasts);
            watch_clock(broadcasts);
            for (size_t i = 0; i < clients.size(); i++) {
                const short ev = fds[i + 2].revents;
                if (!ev) continue;
                Client& c = clients[i];
                bool alive = true;
                char buf[4096];
                ssize_t n = ::recv(c.fd, buf, sizeof buf, 0);
                if (n <= 0) {
                    alive = (n < 0 && errno == EINTR);
                } else {
                    c.in.append(buf, size_t(n));
                    size_t nl;
                    while (alive && (nl = c.in.find('\n')) != std::string::npos) {
                        std::string line = c.in.substr(0, nl);
                        c.in.erase(0, nl + 1);
                        if (!line.empty() && line.back() == '\r') line.pop_back();
                        if (line.find_first_not_of(" \t") == std::string::npos) continue;
                        std::string bc;
                        std::string resp = handle_line(line, bc);
                        if (!resp.empty()) alive = send_line(c.fd, resp);
                        if (!bc.empty()) broadcasts.push_back(bc);
                        if (m_stop.load()) break;
                    }
                    if (c.in.size() > MAX_LINE) {
                        send_line(c.fd, error_response(nullptr, { E_INVALID_REQUEST, "message too long" }));
                        alive = false;
                    }
                }
                if (!alive) c.fd = (::close(c.fd), -1);
            }
            for (auto& bc : broadcasts)
                for (auto& c : clients)
                    if (c.fd >= 0 && !send_line(c.fd, bc)) c.fd = (::close(c.fd), -1);
            clients.erase(std::remove_if(clients.begin(), clients.end(), [](const Client& c) { return c.fd < 0; }),
                          clients.end());
        }
        for (auto& c : clients) ::close(c.fd);
    }

    /* ------------------------------------------------------------ SystemC callbacks */

    // Listen only once the simulation can run jobs: a client never waits
    // on elaboration, and the port is closed again when the simulation ends.
    void start_of_simulation() override
    {
        for (auto* o : sc_core::sc_get_top_level_objects()) find_qemu_instances(o, m_qemu);
        InitiatorNames::get().build();
        m_watch_clock = p_watch_debugger.get_value() && !m_qemu.empty();
        start_profiler();
        m_timestep_watch.agent = this;
        TraceStore::get().set_on_break([this] { on_break(); });
        sc_core::sc_register_stage_callback(m_timestep_watch, sc_core::SC_PRE_TIMESTEP);
        m_watching_timesteps = true;
        auto broker = cci::cci_get_broker();
        for (auto* q : m_qemu) {
            auto h = broker.get_param_handle(std::string(q->name()) + ".icount");
            if (h.is_valid() && h.get_cci_value().is_bool() && h.get_cci_value().get_bool()) m_watch_clock = false;
        }
        start_server();
    }

    std::string m_profile_problem; // why profiling is off, when it was asked for

    void start_profiler()
    {
        if (!p_profile.get_value() && !p_ftrace.get_value()) return;
        Profiler& p = Profiler::get();
        if (m_qemu.empty() || !m_qemu[0]->is_inited()) {
            m_profile_problem = "no QEMU instance";
        } else if (p_profile_id.get_value() == 0) {
            m_profile_problem = std::string("no plugin id: load libidlinker with key=") + p_profile_id.name();
        } else if (p_profile.get_value() && p_profile_period.get_value() == 0) {
            m_profile_problem = "profile_period must be greater than 0";
        } else if (p_ftrace.get_value() && p_ftrace_buffer.get_value() == 0) {
            m_profile_problem = "ftrace_buffer must be greater than 0";
        } else {
            p.api = &m_qemu[0]->get().plugin_api();
            if (p_profile.get_value()) {
                p.period = p_profile_period.get_value();
                auto* sb = p.api->qemu_plugin_scoreboard_new(sizeof(uint64_t));
                p.counter = qemu_plugin_u64{ sb, 0 };
                p.reset();
                p.sampling = true;
                p.active = true;
            }
            if (p_ftrace.get_value()) {
                FTracer& f = FTracer::get();
                f.api = p.api;
                f.capacity = size_t(p_ftrace_buffer.get_value());
                f.pending = qemu_plugin_u64{ p.api->qemu_plugin_scoreboard_new(sizeof(uint64_t)), 0 };
                f.icount = qemu_plugin_u64{ p.api->qemu_plugin_scoreboard_new(sizeof(uint64_t)), 0 };
                f.clear();
                f.active = true;
            }
            p.api->qemu_plugin_register_vcpu_tb_trans_cb(p_profile_id.get_value(), &Profiler::on_tb_trans, nullptr);
            if (m_qemu.size() > 1) m_profile_problem = "only the first QEMU instance is profiled or traced";
        }
        if (!m_profile_problem.empty())
            std::fprintf(stderr, "sim-agent: profiling: %s\n", m_profile_problem.c_str());
    }

    void end_of_simulation() override
    {
        Profiler::get().alive = false;
        FTracer::get().alive = false;
        TraceStore::get().set_on_break(nullptr);
        if (m_watching_timesteps) sc_core::sc_unregister_stage_callback(m_timestep_watch, sc_core::SC_PRE_TIMESTEP);
        m_watching_timesteps = false;
        close_jobs();
        stop_server();
    }
};

extern "C" void module_register();
void module_register()
{
    // Each factory is registered once, even if QBox calls this again.
    // Called while QBox builds the platform, inside the module hierarchy: use
    // the current broker (a named originator is not allowed here).
    auto broker = cci::cci_get_broker();
    if (!broker.get_param_handle(CCI_GS_MF_NAME "sim_agent").is_valid()) GSC_MODULE_REGISTER_C(sim_agent);
}
