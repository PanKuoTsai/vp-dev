/*
 * debug_dap: a JTAG-reachable Arm debug port for a QBox platform, so that
 * OpenOCD can connect to the simulation (G-13).
 *
 * OpenOCD talks to it with its remote_bitbang adapter over TCP. Behind the
 * JTAG TAP is an ADIv5 JTAG-DP with two access ports:
 *   AP0  AXI MEM-AP on the system bus (the `mem` socket, bound to a router):
 *        reads and writes anywhere the CPUs can, 64-bit addresses.
 *   AP1  APB-AP on a debug bus inside this model: a ROM table and, for each
 *        core, Armv8 external debug registers and a CTI.
 * A debug request from a CTI (trigger out 0) halts the core; a restart request
 * (trigger out 1) resumes it. EDSCR.STATUS and EDPRSR.HALTED follow.
 *
 * Core debug (second stage): when the model finds the QEMU instance of the
 * cores (parameter `qemu`, or the only one), it works on QEMU's CPUs directly:
 * a halted core's thread waits in a QEMU work item (parked), so neither
 * QBox's CPU loop nor a VM restart lets it run; instructions written to EDITR are
 * interpreted (the ones OpenOCD's aarch64 target uses: the DCC transfers,
 * MRS/MSR, loads and stores, DCPS/DRPS, barriers and cache maintenance),
 * with EDSCR.MA memory access, halting step (EDECR.SS), hardware breakpoints
 * (DBGBVR/DBGBCR) and software breakpoints (HLT #11 written through the core)
 * as QEMU breakpoints. System registers are read-only, except that clearing
 * SCTLR.M makes the core's memory accesses physical (as OpenOCD expects).
 * Without the QEMU instance, the first stage's behaviour remains: halts go
 * through the cores' QBox `halt` signals and EDITR reports an error.
 * Only MTTCG has been tried. Watchpoints are not implemented.
 *
 * Debug bus map (AP1): ROM table at DBG_BASE, core n's debug registers at
 * DBG_BASE + 0x10000 + n * 0x20000, its CTI 0x10000 above that.
 */
#ifndef DEBUG_DAP_H
#define DEBUG_DAP_H

#include <systemc>
#include <tlm>
#include <cci_configuration>
#include <scp/report.h>
#include <async_event.h>
#include <module_factory_registery.h>
#include <tlm_utils/simple_initiator_socket.h>
#include <tlm_sockets_buswidth.h>
#include <ports/initiator-signal-socket.h>

#include <qemu-instance.h>

#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <future>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>


/** A system register's encoding (op0, op1, CRn, CRm, op2), as in the MRS and MSR instructions. */
constexpr uint32_t debug_dap_sr(unsigned op0, unsigned op1, unsigned crn, unsigned crm, unsigned op2)
{
    return (op0 << 14) | (op1 << 11) | (crn << 7) | (crm << 3) | op2;
}

class debug_dap : public sc_core::sc_module
{
    SCP_LOGGER();

public:
    static constexpr uint32_t DBG_BASE = 0x80000000u;
    static uint32_t core_base(unsigned n) { return DBG_BASE + 0x10000u + n * 0x20000u; }
    static uint32_t cti_base(unsigned n) { return core_base(n) + 0x10000u; }

    cci::cci_param<unsigned> p_port;
    cci::cci_param<unsigned> p_cpus;
    cci::cci_param<std::string> p_host;
    cci::cci_param<uint64_t> p_midr;
    cci::cci_param<std::string> p_qemu;
    tlm_utils::simple_initiator_socket<debug_dap, DEFAULT_TLM_BUSWIDTH> mem;
    sc_core::sc_vector<InitiatorSignalSocket<bool>> halt;

    SC_HAS_PROCESS(debug_dap);
    explicit debug_dap(const sc_core::sc_module_name& n)
        : sc_core::sc_module(n)
        , p_port("port", 0, "TCP port for OpenOCD's remote_bitbang adapter (0: none)")
        , p_cpus("cpus", 1, "Number of cores: halt_0 .. halt_<cpus-1>, each bound to a CPU's halt signal")
        , p_host("host", "127.0.0.1", "Address to listen on")
        , p_midr("midr", 0x414FD0B1, "MIDR_EL1 shown in each core's external debug registers")
        , p_qemu("qemu", "", "QEMU instance of the cores, for core debug (empty: the only one); core n is QEMU's CPU n")
        , mem("mem")
        , halt("halt", p_cpus.get_value())
        , m_job_event(false)
    {
        m_cores.resize(p_cpus.get_value());
        SC_THREAD(job_loop);
    }

    ~debug_dap() override { stop_server(); }

    void start_of_simulation() override
    {
        if (!p_port.get_value()) return;
        m_qok = load_qemu();
        start_server();
    }

    void end_of_simulation() override
    {
        stop_server();
        close_jobs();
    }

private:
    /* ------------------------------------------------------------ jobs on the SystemC thread */

    struct Job {
        std::function<void()> fn;
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
            // Bus accesses and halts also go through while the agent has paused the simulation.
            sc_core::sc_unsuspendable();
            try {
                job->fn();
            } catch (...) {
            }
            job->done.set_value();
            wait(sc_core::SC_ZERO_TIME);
            sc_core::sc_suspendable();
        }
    }

    /** Run fn on the SystemC thread and wait; false when the simulation is ending. */
    bool on_sim(std::function<void()> fn)
    {
        auto job = std::make_shared<Job>();
        job->fn = std::move(fn);
        auto fut = job->done.get_future();
        {
            std::lock_guard<std::mutex> l(m_jobs_mu);
            if (m_jobs_closed) return false;
            m_jobs.push_back(job);
        }
        m_job_event.async_notify();
        while (fut.wait_for(std::chrono::milliseconds(100)) != std::future_status::ready) {
            if (m_stop.load()) return false;
        }
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
        for (auto& j : pending) j->done.set_value();
    }

    /* ------------------------------------------------------------ remote_bitbang server */

    std::thread m_thread;
    std::atomic<bool> m_stop{ false };
    int m_listen = -1;

    void start_server()
    {
        m_listen = ::socket(AF_INET, SOCK_STREAM, 0);
        int one = 1;
        setsockopt(m_listen, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_port = htons(uint16_t(p_port.get_value()));
        if (inet_pton(AF_INET, p_host.get_value().c_str(), &a.sin_addr) != 1 || bind(m_listen, (sockaddr*)&a, sizeof a) != 0 ||
            listen(m_listen, 1) != 0) {
            SCP_WARN(())("debug-dap: cannot listen on {}:{}: {}", p_host.get_value(), p_port.get_value(), std::strerror(errno));
            ::close(m_listen);
            m_listen = -1;
            return;
        }
        std::fprintf(stderr, "debug-dap: remote_bitbang listening on %s:%u\n", p_host.get_value().c_str(), p_port.get_value());
        m_thread = std::thread([this] { serve(); });
    }

    void stop_server()
    {
        m_stop.store(true);
        m_evt_cv.notify_all();
        m_park_cv.notify_all(); // parked cores run again
        if (m_thread.joinable()) m_thread.join();
        if (m_evt_thread.joinable()) m_evt_thread.join();
        if (m_listen >= 0) {
            ::close(m_listen);
            m_listen = -1;
        }
    }

    void serve()
    {
        while (!m_stop.load()) {
            pollfd p{ m_listen, POLLIN, 0 };
            if (poll(&p, 1, 200) <= 0) continue;
            int c = accept(m_listen, nullptr, nullptr);
            if (c < 0) continue;
            int one = 1;
            setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
            reset_tap();
            client(c);
            ::close(c);
        }
    }

    /** One OpenOCD connection: each byte is a remote_bitbang command. */
    void client(int fd)
    {
        char in[4096];
        std::string out;
        while (!m_stop.load()) {
            pollfd p{ fd, POLLIN, 0 };
            int r = poll(&p, 1, 200);
            if (r < 0) return;
            if (r == 0) continue;
            ssize_t n = ::read(fd, in, sizeof in);
            if (n <= 0) return;
            out.clear();
            for (ssize_t i = 0; i < n; i++) {
                const char ch = in[i];
                if (ch >= '0' && ch <= '7') {
                    const int v = ch - '0';
                    pins((v >> 2) & 1, (v >> 1) & 1, v & 1);
                } else if (ch == 'R') {
                    out.push_back(m_tdo ? '1' : '0');
                } else if (ch == 'r' || ch == 's') {
                    reset_tap(); // TRST asserted
                } else if (ch == 'Q') {
                    flush(fd, out);
                    return;
                }
                // 'B'/'b' (LED), 't'/'u' (no TRST) and anything else: nothing to do.
            }
            if (!flush(fd, out)) return;
        }
    }

    static bool flush(int fd, const std::string& s)
    {
        size_t off = 0;
        while (off < s.size()) {
            ssize_t w = ::write(fd, s.data() + off, s.size() - off);
            if (w <= 0) return false;
            off += size_t(w);
        }
        return true;
    }

    /* ------------------------------------------------------------ JTAG TAP (IEEE 1149.1) */

    enum Tap { TLR, RTI, SELDR, CAPDR, SHDR, EX1DR, PADR, EX2DR, UPDDR, SELIR, CAPIR, SHIR, EX1IR, PAIR, EX2IR, UPDIR };
    static Tap next(Tap s, bool tms)
    {
        static const Tap t[16][2] = {
            { RTI, TLR }, { RTI, SELDR }, { CAPDR, SELIR }, { SHDR, EX1DR }, { SHDR, EX1DR }, { PADR, UPDDR },
            { PADR, EX2DR }, { SHDR, UPDDR }, { RTI, SELDR }, { CAPIR, TLR }, { SHIR, EX1IR }, { SHIR, EX1IR },
            { PAIR, UPDIR }, { PAIR, EX2IR }, { SHIR, UPDIR }, { RTI, SELDR },
        };
        return t[s][tms ? 1 : 0];
    }

    enum Ir : uint32_t { IR_ABORT = 0x8, IR_DPACC = 0xA, IR_APACC = 0xB, IR_IDCODE = 0xE, IR_BYPASS = 0xF };
    static constexpr uint32_t IDCODE = 0x4BA00477; // as Arm JTAG-DPs report it
    Tap m_state = TLR;
    bool m_tck = false, m_tdo = false;
    uint32_t m_ir = IR_IDCODE, m_ir_shift = 0;
    uint64_t m_dr = 0;
    unsigned m_dr_len = 32;

    void reset_tap()
    {
        m_state = TLR;
        m_ir = IR_IDCODE;
    }

    unsigned dr_length() const
    {
        switch (m_ir) {
        case IR_ABORT:
        case IR_DPACC:
        case IR_APACC:
            return 35;
        case IR_IDCODE:
            return 32;
        default:
            return 1;
        }
    }

    /** TMS and TDI are sampled on the rising edge of TCK; TDO and the register actions follow on the falling edge. */
    void pins(bool tck, bool tms, bool tdi)
    {
        if (!m_tck && tck) {
            if (m_state == SHDR) m_dr = (m_dr >> 1) | (uint64_t(tdi) << (m_dr_len - 1));
            if (m_state == SHIR) m_ir_shift = (m_ir_shift >> 1) | (uint32_t(tdi) << 3);
            m_state = next(m_state, tms);
        } else if (m_tck && !tck) {
            switch (m_state) {
            case TLR:
                m_ir = IR_IDCODE;
                break;
            case CAPDR:
                m_dr_len = dr_length();
                m_dr = capture_dr();
                break;
            case SHDR:
                m_tdo = m_dr & 1;
                break;
            case UPDDR:
                update_dr(m_dr & ((uint64_t(1) << m_dr_len) - 1));
                break;
            case CAPIR:
                m_ir_shift = 0x1;
                break;
            case SHIR:
                m_tdo = m_ir_shift & 1;
                break;
            case UPDIR:
                m_ir = m_ir_shift & 0xF;
                break;
            default:
                break;
            }
        }
        m_tck = tck;
    }

    /* ------------------------------------------------------------ ADIv5 JTAG-DP */

    static constexpr uint32_t DPIDR = 0x4BA01477; // DPv1, designer Arm
    static constexpr uint8_t ACK_OK = 0x2, ACK_WAIT = 0x1;
    uint32_t m_ctrlstat = 0, m_select = 0, m_rdbuff = 0, m_pending = 0;

    uint64_t capture_dr()
    {
        switch (m_ir) {
        case IR_IDCODE:
            return IDCODE;
        case IR_DPACC:
        case IR_APACC:
        case IR_ABORT:
            return (uint64_t(m_pending) << 3) | ACK_OK;
        default:
            return 0;
        }
    }

    void update_dr(uint64_t v)
    {
        const bool read = v & 1;
        const uint32_t a = uint32_t((v >> 1) & 3) << 2;
        const uint32_t data = uint32_t(v >> 3);
        if (m_ir == IR_ABORT) {
            // STKCMPCLR, STKERRCLR, WDERRCLR, ORUNERRCLR
            if (data & (1u << 1)) m_ctrlstat &= ~(1u << 4);
            if (data & (1u << 2)) m_ctrlstat &= ~(1u << 5);
            if (data & (1u << 3)) m_ctrlstat &= ~(1u << 7);
            if (data & (1u << 4)) m_ctrlstat &= ~(1u << 1);
        } else if (m_ir == IR_DPACC) {
            dp_access(read, a, data);
        } else if (m_ir == IR_APACC) {
            const unsigned apsel = m_select >> 24;
            const uint32_t reg = (m_select & 0xF0) | a;
            uint32_t r = 0;
            const bool ok = ap_access(apsel, read, reg, data, r);
            if (!ok) m_ctrlstat |= 1u << 5; // STICKYERR
            if (read) {
                m_rdbuff = r;
                m_pending = r;
            }
        }
    }

    void dp_access(bool read, uint32_t a, uint32_t data)
    {
        if (read) {
            switch (a) {
            case 0x0:
                m_pending = DPIDR;
                break;
            case 0x4: {
                // Power-up and reset acknowledges follow their requests.
                uint32_t v = m_ctrlstat & ~((1u << 31) | (1u << 29) | (1u << 27));
                if (m_ctrlstat & (1u << 30)) v |= 1u << 31;
                if (m_ctrlstat & (1u << 28)) v |= 1u << 29;
                if (m_ctrlstat & (1u << 26)) v |= 1u << 27;
                m_pending = v;
                break;
            }
            case 0x8:
                m_pending = m_select;
                break;
            default:
                m_pending = m_rdbuff;
                break;
            }
            return;
        }
        switch (a) {
        case 0x4: {
            // Sticky flags are cleared by writing 1 on a JTAG-DP; the request bits and TRNMODE hold.
            const uint32_t w1c = (1u << 1) | (1u << 4) | (1u << 5) | (1u << 7);
            m_ctrlstat &= ~(data & w1c);
            const uint32_t rw = (1u << 30) | (1u << 28) | (1u << 26) | (0xFu << 8) | (3u << 2) | 1u;
            m_ctrlstat = (m_ctrlstat & ~rw) | (data & rw);
            break;
        }
        case 0x8:
            m_select = data;
            break;
        default:
            break;
        }
    }

    /* ------------------------------------------------------------ MEM-APs */

    struct MemAp {
        uint32_t csw = 0x2; // 32-bit, no increment
        uint64_t tar = 0;
    };
    MemAp m_ap[2];

    bool ap_access(unsigned apsel, bool read, uint32_t reg, uint32_t data, uint32_t& r)
    {
        if (apsel > 1) {
            r = 0; // no such AP: IDR reads as 0
            return true;
        }
        MemAp& ap = m_ap[apsel];
        const bool sys = apsel == 0;
        switch (reg) {
        case 0x00: // CSW
            if (read) {
                r = ap.csw | (1u << 6); // DeviceEn
            } else {
                uint32_t v = data;
                if (((v >> 4) & 3) > 1) v &= ~(3u << 4); // packed increment: not supported
                if (!sys) v = (v & ~7u) | 2u;            // the APB-AP is 32-bit only
                ap.csw = v & ~((1u << 6) | (1u << 7));
            }
            return true;
        case 0x04: // TAR (low)
            if (read)
                r = uint32_t(ap.tar);
            else
                ap.tar = (ap.tar & ~uint64_t(0xFFFFFFFFu)) | data;
            return true;
        case 0x08: // TAR (high), with large addresses
            if (read)
                r = sys ? uint32_t(ap.tar >> 32) : 0;
            else if (sys)
                ap.tar = (ap.tar & 0xFFFFFFFFu) | (uint64_t(data) << 32);
            return true;
        case 0x0C: { // DRW
            const unsigned size = ap.csw & 7;
            const unsigned bytes = size == 0 ? 1 : size == 1 ? 2 : 4;
            if (size > 2) return false;
            const bool ok = sys ? sys_access(read, ap.tar, bytes, data, r) : dbg_access(read, uint32_t(ap.tar), data, r);
            if (((ap.csw >> 4) & 3) == 1) ap.tar += bytes;
            return ok;
        }
        case 0x10:
        case 0x14:
        case 0x18:
        case 0x1C: { // BD0..BD3
            const uint64_t addr = (ap.tar & ~uint64_t(0xF)) | (reg & 0xC);
            return sys ? sys_access(read, addr, 4, data, r) : dbg_access(read, uint32_t(addr), data, r);
        }
        case 0xF0: // BASE (high)
            r = 0;
            return true;
        case 0xF4: // CFG: large addresses on the system AP
            r = sys ? 0x2 : 0x0;
            return true;
        case 0xF8: // BASE: the ROM table on the debug AP
            r = sys ? 0x2 : (DBG_BASE | 0x3);
            return true;
        case 0xFC: // IDR
            r = sys ? 0x44770004 : 0x44770002; // AXI-AP, APB-AP
            return true;
        default:
            r = 0;
            return true;
        }
    }

    /** A system bus access on the SystemC thread: debug transport, else a zero-delay normal access. */
    bool sys_access(bool read, uint64_t addr, unsigned bytes, uint32_t data, uint32_t& r)
    {
        const unsigned lane = unsigned(addr & 3);
        if (lane + bytes > 4) return false; // unaligned across the 32-bit data bus
        unsigned char buf[4] = { 0, 0, 0, 0 };
        if (!read)
            for (unsigned i = 0; i < bytes; i++) buf[i] = uint8_t(data >> (8 * (lane + i)));
        bool ok = false;
        if (!on_sim([&] {
                tlm::tlm_generic_payload t;
                t.set_command(read ? tlm::TLM_READ_COMMAND : tlm::TLM_WRITE_COMMAND);
                t.set_address(addr);
                t.set_data_ptr(buf);
                t.set_data_length(bytes);
                t.set_streaming_width(bytes);
                t.set_byte_enable_ptr(nullptr);
                t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
                unsigned n = mem->transport_dbg(t);
                if (n == 0 && t.get_response_status() == tlm::TLM_INCOMPLETE_RESPONSE) {
                    sc_core::sc_time delay = sc_core::SC_ZERO_TIME;
                    t.set_response_status(tlm::TLM_INCOMPLETE_RESPONSE);
                    mem->b_transport(t, delay);
                    n = t.get_response_status() == tlm::TLM_OK_RESPONSE ? bytes : 0;
                }
                ok = t.get_response_status() == tlm::TLM_OK_RESPONSE && n > 0;
            }))
            return false;
        if (read) {
            r = 0;
            for (unsigned i = 0; i < bytes; i++) r |= uint32_t(buf[i]) << (8 * (lane + i));
        }
        return ok;
    }

    /* ------------------------------------------------------------ debug bus: ROM table, core debug, CTI */

    struct Core {
        uint32_t edscr = 0;      // writable bits only
        bool halted = false;
        bool sdr = false;        // EDPRSR.SDR, sticky debug restart
        bool oslk = true;        // the OS lock is set at reset
        uint32_t edprcr = 0;
        uint32_t bvr[12] = {}, bcr[6] = {}, wvr[8] = {}, wcr[4] = {};
        // CTI
        bool cti_en = false;
        uint32_t inen[8] = {}, outen[8] = {};
        uint32_t gate = 0xF;
        uint32_t appset = 0;     // channels held by CTIAPPSET
        uint32_t trigout = 0;    // latched trigger outputs, cleared by CTIINTACK
        // Core debug (with the QEMU instance)
        void* cpu = nullptr;     // QEMU's CPUState
        uint32_t status = 0x13;  // EDSCR.STATUS while halted
        unsigned el = 1;         // EDSCR.EL while halted: the core's EL, moved by DCPS and DRPS
        unsigned real_el = 1;    // the EL the core halted in
        uint32_t dtrrx = 0, dtrtx = 0;
        bool rxfull = false, txfull = false;
        bool err = false;        // EDSCR.ERR, cleared by EDRCR.CSE
        uint32_t edecr = 0;
        bool step = false;       // a halting step is under way
        uint64_t hw_addr[6] = {};
        bool hw_on[6] = {};      // a QEMU breakpoint stands for DBGBCR<n>
        bool mmu_off = false;    // SCTLR.M cleared by the debugger: memory accesses are physical
        bool par_fault = false;  // an AT instruction ran: PAR_EL1 reads as a failed translation
        uint32_t csselr = 0;
        bool parked = false;      // its thread waits in park() (under m_park_mu)
        bool park_wanted = false; // halted: stay parked (under m_park_mu)
        debug_dap* owner = nullptr;
        unsigned index = 0;
    };
    std::mutex m_dbg_mu;
    std::vector<Core> m_cores;

    static constexpr uint32_t EDSCR_HDE = 1u << 14;
    static constexpr uint32_t EDSCR_MA = 1u << 20;
    static constexpr uint32_t EDSCR_WRITABLE = (3u << 22) | (1u << 21) | EDSCR_MA | EDSCR_HDE; // INTdis, TDA, MA, HDE

    /** CoreSight identification registers at 0xFD0..0xFFC. */
    static bool id_regs(uint32_t off, unsigned cls, uint32_t part, uint32_t& r)
    {
        switch (off) {
        case 0xFD0: r = 0x04; return true;                         // PIDR4: JEP106 continuation 4 (Arm)
        case 0xFE0: r = part & 0xFF; return true;                   // PIDR0
        case 0xFE4: r = 0xB0 | ((part >> 8) & 0xF); return true;    // PIDR1: JEP106 0x3B, low bits
        case 0xFE8: r = 0x0B; return true;                          // PIDR2: JEP106 high bits, JEDEC
        case 0xFEC: r = 0x00; return true;                          // PIDR3
        case 0xFF0: r = 0x0D; return true;                          // CIDR0..3
        case 0xFF4: r = cls << 4; return true;
        case 0xFF8: r = 0x05; return true;
        case 0xFFC: r = 0xB1; return true;
        default: return false;
        }
    }

    bool dbg_access(bool read, uint32_t addr, uint32_t data, uint32_t& r)
    {
        std::vector<std::pair<unsigned, bool>> halts; // core, halt (true) or resume
        bool ok = true;
        {
            std::lock_guard<std::mutex> l(m_dbg_mu);
            r = 0;
            if (addr >= DBG_BASE && addr < DBG_BASE + 0x1000) {
                ok = rom_access(read, addr - DBG_BASE, r);
            } else if (addr >= core_base(0) && addr < core_base(unsigned(m_cores.size()))) {
                const unsigned n = (addr - core_base(0)) / 0x20000;
                const uint32_t off = (addr - core_base(0)) % 0x20000;
                if (off < 0x1000)
                    ok = core_access(n, read, off, data, r);
                else if (off >= 0x10000 && off < 0x11000)
                    ok = cti_access(n, read, off - 0x10000, data, r, halts);
                else
                    r = 0;
            } else {
                ok = false; // nothing there: the access errs
            }
            if (m_qok) apply(halts); // QEMU's soft stop: safe under m_dbg_mu (lock order m_dbg_mu, then BQL)
        }
        if (!m_qok)
            for (auto& h : halts) signal_halt(h.first, h.second);
        return ok;
    }

    bool rom_access(bool read, uint32_t off, uint32_t& r)
    {
        if (!read) return true;
        const unsigned entries = 2 * unsigned(m_cores.size());
        if (off < 4 * entries) {
            const unsigned k = off / 4;
            const uint32_t target = (k % 2 == 0) ? core_base(k / 2) : cti_base(k / 2);
            r = (target - DBG_BASE) | 0x3; // offset, 32-bit format, present
            return true;
        }
        if (off == 0xFCC) {
            r = 0; // MEMTYPE: no system memory on this bus
            return true;
        }
        if (id_regs(off, 0x1, 0x4C0, r)) return true;
        r = 0; // end of the table and reserved
        return true;
    }

    uint32_t edscr(const Core& c) const
    {
        uint32_t v = c.edscr & EDSCR_WRITABLE;
        v |= c.halted ? c.status : 0x02; // STATUS: why the core halted, or not in Debug state
        v |= 1u << 24;                   // ITE: instructions complete at once
        if (c.halted) v |= (c.el & 3) << 8;
        v |= 0xFu << 10;                 // RW: AArch64 at every EL
        if (c.err) v |= 1u << 6;
        if (c.txfull) v |= 1u << 29;
        if (c.rxfull) v |= 1u << 30;
        return v;
    }

    bool core_access(unsigned n, bool read, uint32_t off, uint32_t data, uint32_t& r)
    {
        Core& c = m_cores[n];
        if (id_regs(off, 0x9, 0xD0B, r)) return true;
        if (read) {
            switch (off) {
            case 0x088: r = edscr(c); return true;
            case 0x080: r = c.dtrrx; c.rxfull = false; return true; // DBGDTRRX
            case 0x08C: // DBGDTRTX; in memory access mode the read also loads the next word at X0
                r = c.dtrtx;
                c.txfull = false;
                if ((c.edscr & EDSCR_MA) && c.halted && m_qok && !c.err) ma_load(c);
                return true;
            case 0x024: r = c.edecr; return true;
            case 0x314: { // EDPRSR
                r = 1u; // PU: powered up
                if (c.halted) r |= 1u << 4;
                if (c.oslk) r |= 1u << 5;
                if (c.sdr) r |= 1u << 11;
                c.sdr = false; // cleared by the read
                return true;
            }
            case 0x310: r = c.edprcr; return true;
            case 0x0A0: case 0x0AC: r = 0xFFFFFFFF; return true; // EDPCSR: no PC sampling
            case 0xD00: r = uint32_t(p_midr.get_value()); return true;
            case 0xD20: r = 0x01000011; return true; // ID_AA64PFR0_EL1 (low): GIC, EL0/EL1 AArch64
            case 0xD28: r = 0x10305408; return true; // ID_AA64DFR0_EL1 (low): debug v8.2, 6 breakpoints, 4 watchpoints
            case 0xFB4: r = 0; return true;          // EDLSR: no software lock
            case 0xFB8: r = 0xAA; return true;       // EDAUTHSTATUS: debug enabled
            case 0xFBC: r = 0x47706A15; return true; // EDDEVARCH: Armv8-A debug
            case 0xFCC: r = 0x15; return true;       // EDDEVTYPE: debug logic, processor
            default: break;
            }
            if (off >= 0x400 && off < 0x400 + 16 * 6) { r = (off & 0xF) == 0 ? c.bvr[(off - 0x400) / 16 * 2] : (off & 0xF) == 4 ? c.bvr[(off - 0x400) / 16 * 2 + 1] : (off & 0xF) == 8 ? c.bcr[(off - 0x400) / 16] : 0; return true; }
            if (off >= 0x800 && off < 0x800 + 16 * 4) { r = (off & 0xF) == 0 ? c.wvr[(off - 0x800) / 16 * 2] : (off & 0xF) == 4 ? c.wvr[(off - 0x800) / 16 * 2 + 1] : (off & 0xF) == 8 ? c.wcr[(off - 0x800) / 16] : 0; return true; }
            r = 0;
            return true;
        }
        switch (off) {
        case 0x088: c.edscr = data & EDSCR_WRITABLE; return true;
        case 0x080: // DBGDTRRX; in memory access mode the write stores the word at X0
            if ((c.edscr & EDSCR_MA) && c.halted && m_qok) {
                if (!c.err) ma_store(c, data);
            } else {
                c.dtrrx = data;
                c.rxfull = true;
            }
            return true;
        case 0x08C: c.dtrtx = data; return true; // the high half of a 64-bit DCC write
        case 0x084: // EDITR
            if (c.err) return true; // ignored until EDRCR.CSE
            if (!c.halted || !m_qok || !exec(n, data)) c.err = true;
            return true;
        case 0x024: c.edecr = data & 0x7; return true;
        case 0x090: // EDRCR
            if (data & (1u << 2)) c.err = false; // CSE
            return true;
        case 0x300: c.oslk = data & 1; return true; // OSLAR_EL1
        case 0x310: c.edprcr = data & 0xF; return true;
        case 0xFB0: return true; // EDLAR
        default: break;
        }
        if (off >= 0x400 && off < 0x400 + 16 * 6) { const unsigned i = (off - 0x400) / 16; if ((off & 0xF) == 0) c.bvr[2 * i] = data; else if ((off & 0xF) == 4) c.bvr[2 * i + 1] = data; else if ((off & 0xF) == 8) c.bcr[i] = data; if (m_qok) hw_update(n, i); return true; }
        if (off >= 0x800 && off < 0x800 + 16 * 4) { const unsigned i = (off - 0x800) / 16; if ((off & 0xF) == 0) c.wvr[2 * i] = data; else if ((off & 0xF) == 4) c.wvr[2 * i + 1] = data; else if ((off & 0xF) == 8) c.wcr[i] = data; return true; }
        return true; // other registers ignore writes
    }

    /*
     * CTI: channel events reach every CTI whose gate lets the channel through
     * (the cross-trigger matrix). Trigger out 0 is the core's debug request,
     * trigger out 1 its restart request. Entering Debug state raises trigger
     * in 0 (cross-halt).
     */
    bool cti_access(unsigned n, bool read, uint32_t off, uint32_t data, uint32_t& r, std::vector<std::pair<unsigned, bool>>& halts)
    {
        Core& c = m_cores[n];
        if (id_regs(off, 0x9, 0x9ED, r)) return true;
        if (read) {
            if (off == 0x000) r = c.cti_en ? 1 : 0;
            else if (off >= 0x020 && off < 0x040) r = c.inen[(off - 0x020) / 4];
            else if (off >= 0x0A0 && off < 0x0C0) r = c.outen[(off - 0x0A0) / 4];
            else if (off == 0x130) r = c.halted ? 1 : 0;        // CTITRIGINSTATUS
            else if (off == 0x134) r = c.trigout;                // CTITRIGOUTSTATUS
            else if (off == 0x138) r = 0;                        // CTICHINSTATUS
            else if (off == 0x13C) r = c.appset;                 // CTICHOUTSTATUS
            else if (off == 0x140) r = c.gate;
            else if (off == 0xFB4) r = 0;                        // CTILSR
            else if (off == 0xFBC) r = 0x47701A14;               // CTIDEVARCH
            else if (off == 0xFC8) r = (4u << 16) | (8u << 8);   // CTIDEVID: 4 channels, 8 triggers
            else if (off == 0xFCC) r = 0x14;                     // CTIDEVTYPE
            else r = 0;
            return true;
        }
        if (off == 0x000) c.cti_en = data & 1;
        else if (off == 0x010) c.trigout &= ~data;               // CTIINTACK
        else if (off == 0x014) { c.appset |= data & 0xF; channels(n, data & 0xF, halts); }
        else if (off == 0x018) c.appset &= ~data;
        else if (off == 0x01C) channels(n, data & 0xF, halts);  // CTIAPPPULSE
        else if (off >= 0x020 && off < 0x040) c.inen[(off - 0x020) / 4] = data & 0xF;
        else if (off >= 0x0A0 && off < 0x0C0) c.outen[(off - 0x0A0) / 4] = data & 0xF;
        else if (off == 0x140) c.gate = data & 0xF;
        return true;
    }

    /** Channel events from CTI src: through the matrix to the CTIs, then to their trigger outputs. */
    void channels(unsigned src, uint32_t ch, std::vector<std::pair<unsigned, bool>>& halts)
    {
        if (!m_cores[src].cti_en || !ch) return;
        // CTIGATE gates both ways: out of a CTI to the cross-trigger matrix and into a CTI from
        // it (OpenOCD closes the stepping core's channel 1 while it restarts the others). An
        // event always reaches its own CTI's triggers.
        for (unsigned k = 0; k < m_cores.size(); k++) {
            const uint32_t got = k == src ? ch : (ch & m_cores[src].gate & m_cores[k].gate);
            if (!got || !m_cores[k].cti_en) continue;
            for (unsigned t = 0; t < 2; t++) {
                if (!(m_cores[k].outen[t] & got)) continue;
                m_cores[k].trigout |= 1u << t;
                trigger(k, t, halts);
            }
        }
    }

    void trigger(unsigned k, unsigned t, std::vector<std::pair<unsigned, bool>>& halts)
    {
        Core& c = m_cores[k];
        if (t == 0 && !c.halted && (c.edscr & EDSCR_HDE)) {
            c.halted = true;
            c.status = 0x13; // external debug request
            halts.emplace_back(k, true);
            // Cross-halt: entering Debug state is trigger in 0.
            channels_from_trigin(k, halts);
        } else if (t == 1 && c.halted && !(c.trigout & 1)) {
            c.halted = false;
            c.sdr = true;
            halts.emplace_back(k, false);
        }
        if (t == 1) c.trigout &= ~2u; // a restart is a pulse
    }

    void channels_from_trigin(unsigned k, std::vector<std::pair<unsigned, bool>>& halts)
    {
        const uint32_t ch = m_cores[k].inen[0];
        if (ch) channels(k, ch, halts);
    }

    /* ------------------------------------------------------------ core debug on QEMU's CPUs */

    /*
     * Locks: m_dbg_mu, then the BQL; never the other way round. QEMU's
     * run_on_cpu releases the BQL while it waits (with m_dbg_mu still held),
     * so no thread may hold the BQL while it waits for m_dbg_mu: the VM state
     * handler (main loop, BQL held) only wakes the event thread. The BQL is
     * never held around a SystemC job (on_sim) or while waiting for a core to
     * park. m_park_mu is innermost: nothing else is taken while it is held.
     *
     * Halting: QBox's CPU loop sets and clears QEMU's soft_stopped on every
     * pass in MTTCG, and vm_start clears cpu->stop, so neither can hold a core.
     * Instead a work item on the core's own thread waits (BQL released, with
     * soft_stopped set so that vm_stop sees the core as paused) until the
     * core is restarted.
     */
    union RunData {
        void* p;
        uint64_t u;
    };
    using RunFn = void (*)(void* cpu, RunData);
    struct GArrayView {
        char* data;
        unsigned len;
    };
    struct GByteArrayView {
        uint8_t* data;
        unsigned len;
    };
    struct GdbRegDesc {
        int gdb_reg;
        const char* name;
        const char* feature;
    };
    static constexpr int BP_GDB = 0x10;
    static constexpr unsigned SSTEP = 0x1 | 0x2 | 0x4; // enable, no interrupts, no timers
    static constexpr int RUN_STATE_DEBUG = 0;
    static constexpr uint32_t HLT_11 = 0xD4400160u; // OpenOCD's software breakpoint

    struct Qemu {
        void* (*get_cpu)(int);
        void (*kick)(void*);
        void (*set_soft_stopped)(void*, bool);
        void (*run_on_cpu)(void*, RunFn, RunData);
        void (*async_run)(void*, void (*)(void*), void*); // libqemu_async_run_on_cpu
        void (*lock)(const char*, int);
        void (*unlock)();
        bool (*locked)();
        int (*read_reg)(void*, void*, int);
        int (*write_reg)(void*, uint8_t*, int);
        void* (*reg_list)(void*);
        int (*mem_rw)(void*, uint64_t, void*, size_t, bool);
        void (*single_step)(void*, unsigned);
        int (*bp_insert)(void*, uint64_t, int, void**);
        int (*bp_remove)(void*, uint64_t, int);
        void* (*add_vm_handler)(void (*)(void*, bool, int), void*);
        void (*vm_start)();
        bool (*runstate_check)(int);
        bool (*gdb_start)(const char*, void**);
        const bool* gdb_init; // gdbserver_state.init, its first member
        uint64_t (*get_uint)(void*, const char*, void**);
        void* (*ba_new)();
        void* (*ba_set_size)(void*, unsigned);
        char* (*array_free)(void*, int);
    };
    Qemu m_q{};
    bool m_qok = false;
    void* m_ba = nullptr; // GByteArray for register reads
    std::map<std::string, int> m_reg;
    int m_x[31] = {}, m_sp = 31, m_pc = 32, m_cpsr = 33, m_v[32] = {}, m_fpsr = -1, m_fpcr = -1;
    unsigned m_max_el = 1;
    std::set<uint64_t> m_soft;    // software breakpoints (virtual addresses)
    std::set<std::string> m_said; // warnings given once

    struct Bql {
        const Qemu& q;
        bool took;
        explicit Bql(const Qemu& q_): q(q_), took(!q_.locked())
        {
            if (took) q.lock("debug_dap", 0);
        }
        ~Bql()
        {
            if (took) q.unlock();
        }
    };

    void once(const std::string& what)
    {
        if (m_said.insert(what).second) std::fprintf(stderr, "debug-dap: %s\n", what.c_str());
    }

    static void find_instances(sc_core::sc_object* o, std::vector<QemuInstance*>& out)
    {
        if (auto* q = dynamic_cast<QemuInstance*>(o)) out.push_back(q);
        for (auto* c : o->get_child_objects()) find_instances(c, out);
    }

    /** Find the QEMU functions; false (first stage only) when something is missing. */
    bool load_qemu()
    {
        QemuInstance* inst = nullptr;
        if (!p_qemu.get_value().empty()) {
            inst = dynamic_cast<QemuInstance*>(sc_core::sc_find_object(p_qemu.get_value().c_str()));
            if (!inst) std::fprintf(stderr, "debug-dap: no QEMU instance %s: no core debug\n", p_qemu.get_value().c_str());
        } else {
            std::vector<QemuInstance*> all;
            for (auto* o : sc_core::sc_get_top_level_objects()) find_instances(o, all);
            if (all.size() == 1) inst = all[0];
            else
                std::fprintf(stderr, "debug-dap: %zu QEMU instances and no `qemu` parameter: no core debug\n", all.size());
        }
        if (!inst || !inst->is_inited()) return false;
        Dl_info info{};
        if (!dladdr((void*)inst->get().plugin_api().qemu_plugin_scoreboard_new, &info) || !info.dli_fname) return false;
        void* h = dlopen(info.dli_fname, RTLD_NOLOAD | RTLD_NOW);
        void* g = dlopen("libglib-2.0.so.0", RTLD_NOLOAD | RTLD_NOW);
        if (!h || !g) {
            std::fprintf(stderr, "debug-dap: cannot open libqemu or glib: no core debug\n");
            return false;
        }
        bool all = true;
        auto sym = [&](void* lib, const char* name) {
            void* p = dlsym(lib, name);
            if (!p) {
                std::fprintf(stderr, "debug-dap: libqemu lacks %s: no core debug\n", name);
                all = false;
            }
            return p;
        };
        Qemu& q = m_q;
        q.get_cpu = (decltype(q.get_cpu))sym(h, "qemu_get_cpu");
        q.kick = (decltype(q.kick))sym(h, "qemu_cpu_kick");
        q.set_soft_stopped = (decltype(q.set_soft_stopped))sym(h, "libqemu_cpu_set_soft_stopped");
        q.run_on_cpu = (decltype(q.run_on_cpu))sym(h, "run_on_cpu");
        q.async_run = (decltype(q.async_run))sym(h, "libqemu_async_run_on_cpu");
        q.lock = (decltype(q.lock))sym(h, "bql_lock_impl");
        q.unlock = (decltype(q.unlock))sym(h, "bql_unlock");
        q.locked = (decltype(q.locked))sym(h, "bql_locked");
        q.read_reg = (decltype(q.read_reg))sym(h, "gdb_read_register");
        q.write_reg = (decltype(q.write_reg))sym(h, "gdb_write_register");
        q.reg_list = (decltype(q.reg_list))sym(h, "gdb_get_register_list");
        q.mem_rw = (decltype(q.mem_rw))sym(h, "cpu_memory_rw_debug");
        q.single_step = (decltype(q.single_step))sym(h, "cpu_single_step");
        q.bp_insert = (decltype(q.bp_insert))sym(h, "cpu_breakpoint_insert");
        q.bp_remove = (decltype(q.bp_remove))sym(h, "cpu_breakpoint_remove");
        q.add_vm_handler = (decltype(q.add_vm_handler))sym(h, "qemu_add_vm_change_state_handler");
        q.vm_start = (decltype(q.vm_start))sym(h, "vm_start");
        q.runstate_check = (decltype(q.runstate_check))sym(h, "runstate_check");
        q.gdb_start = (decltype(q.gdb_start))sym(h, "gdbserver_start");
        q.gdb_init = (const bool*)sym(h, "gdbserver_state");
        q.get_uint = (decltype(q.get_uint))sym(h, "object_property_get_uint");
        q.ba_new = (decltype(q.ba_new))sym(g, "g_byte_array_new");
        q.ba_set_size = (decltype(q.ba_set_size))sym(g, "g_byte_array_set_size");
        q.array_free = (decltype(q.array_free))sym(g, "g_array_free");
        dlclose(h); // RTLD_NOLOAD took a reference
        dlclose(g);
        if (!all) return false;

        Bql lock(q);
        unsigned found = 0;
        for (unsigned n = 0; n < m_cores.size(); n++) {
            m_cores[n].cpu = q.get_cpu(int(n));
            m_cores[n].owner = this;
            m_cores[n].index = n;
            if (m_cores[n].cpu) found++;
        }
        if (!found) {
            std::fprintf(stderr, "debug-dap: the QEMU instance has no CPUs: no core debug\n");
            return false;
        }
        if (found < m_cores.size())
            std::fprintf(stderr, "debug-dap: only %u of %zu cores are QEMU CPUs\n", found, m_cores.size());
        // Register numbers, from QEMU's gdbstub
        void* cpu0 = nullptr;
        for (auto& c : m_cores)
            if (c.cpu) {
                cpu0 = c.cpu;
                break;
            }
        auto* list = (GArrayView*)q.reg_list(cpu0);
        for (unsigned i = 0; list && i < list->len; i++) {
            const GdbRegDesc& d = ((const GdbRegDesc*)list->data)[i];
            if (d.name) m_reg[d.name] = d.gdb_reg;
        }
        if (list) q.array_free(list, 1);
        auto idx = [&](const std::string& name, int dflt) {
            auto it = m_reg.find(name);
            return it == m_reg.end() ? dflt : it->second;
        };
        for (int i = 0; i < 31; i++) m_x[i] = idx("x" + std::to_string(i), i);
        m_sp = idx("sp", 31);
        m_pc = idx("pc", 32);
        m_cpsr = idx("cpsr", 33);
        for (int i = 0; i < 32; i++) m_v[i] = idx("v" + std::to_string(i), -1);
        m_fpsr = idx("fpsr", -1);
        m_fpcr = idx("fpcr", -1);
        if (m_reg.count("SCTLR_EL2")) m_max_el = 2;
        if (m_reg.count("SCTLR_EL3")) m_max_el = 3;
        m_ba = q.ba_new();
        // A QEMU breakpoint or step stops the VM through cpu_handle_guest_debug, which needs
        // the gdbstub's state: start it without a connection unless a CPU's gdb_port did.
        if (!*q.gdb_init && !q.gdb_start("none", nullptr)) {
            std::fprintf(stderr, "debug-dap: cannot set up QEMU's debug stops: no core debug\n");
            return false;
        }
        q.add_vm_handler(&debug_dap::vm_state, this);
        m_evt_thread = std::thread([this] { event_loop(); });
        std::fprintf(stderr, "debug-dap: core debug on %u QEMU CPUs (%zu registers)\n", found, m_reg.size());
        return true;
    }

    /* Registers; the caller holds the BQL and the core is stopped. */
    bool read_reg(Core& c, int idx, uint8_t* out, unsigned& len)
    {
        len = 0;
        if (idx < 0 || !c.cpu) return false;
        m_q.ba_set_size(m_ba, 0);
        const int n = m_q.read_reg(c.cpu, m_ba, idx);
        auto* v = (GByteArrayView*)m_ba;
        if (n <= 0 || v->len < unsigned(n) || n > 64) return false;
        std::memcpy(out, v->data, size_t(n));
        len = unsigned(n);
        return true;
    }
    uint64_t reg64(Core& c, int idx)
    {
        uint8_t b[64];
        unsigned n = 0;
        uint64_t v = 0;
        if (read_reg(c, idx, b, n)) std::memcpy(&v, b, n < 8 ? n : 8); // the host is little-endian
        return v;
    }
    bool set_reg64(Core& c, int idx, uint64_t v)
    {
        if (idx < 0 || !c.cpu) return false;
        uint8_t b[16] = {};
        std::memcpy(b, &v, 8);
        return m_q.write_reg(c.cpu, b, idx) > 0;
    }
    uint64_t X(Core& c, unsigned t)
    {
        if (t == 31) return 0; // XZR
        Bql g(m_q);
        return reg64(c, m_x[t]);
    }
    void set_X(Core& c, unsigned t, uint64_t v)
    {
        if (t == 31) return;
        Bql g(m_q);
        set_reg64(c, m_x[t], v);
    }
    uint64_t named(Core& c, int idx)
    {
        Bql g(m_q);
        return reg64(c, idx);
    }
    bool set_named(Core& c, int idx, uint64_t v)
    {
        Bql g(m_q);
        return set_reg64(c, idx, v);
    }

    /** Run fn on the CPU's own thread at a safe point and wait (QEMU's run_on_cpu). */
    static void run_fn(void* cpu, RunData d) { (*static_cast<std::function<void(void*)>*>(d.p))(cpu); }
    void on_cpu(void* cpu, std::function<void(void*)> fn)
    {
        RunData d;
        d.p = &fn;
        Bql g(m_q);
        m_q.run_on_cpu(cpu, &debug_dap::run_fn, d);
    }

    /** Apply halts and restarts decided by the CTIs. */
    void apply(const std::vector<std::pair<unsigned, bool>>& halts)
    {
        for (auto& h : halts) {
            if (h.second)
                q_halt(h.first);
            else
                q_resume(h.first);
        }
    }

    std::mutex m_park_mu;
    std::condition_variable m_park_cv;

    /** The work item a halted core's thread runs: wait until restarted (BQL held on entry and exit). */
    static void park_entry(void* arg)
    {
        Core& c = *static_cast<Core*>(arg);
        debug_dap& d = *c.owner;
        d.m_q.set_soft_stopped(c.cpu, true);
        std::unique_lock<std::mutex> l(d.m_park_mu);
        c.parked = true;
        d.m_park_cv.notify_all();
        if (c.park_wanted && !d.m_stop.load()) {
            d.m_q.unlock();
            d.m_park_cv.wait(l, [&] { return !c.park_wanted || d.m_stop.load(); });
            c.parked = false;
            l.unlock();
            d.m_q.lock("debug_dap", 0);
        } else {
            c.parked = false;
            l.unlock();
        }
        d.m_q.set_soft_stopped(c.cpu, false);
    }

    void q_halt(unsigned n)
    {
        Core& c = m_cores[n];
        if (!c.cpu) return;
        {
            std::unique_lock<std::mutex> l(m_park_mu);
            const bool queue = !c.parked; // a core still parked (restart not yet seen) simply stays
            c.park_wanted = true;
            l.unlock();
            if (queue) {
                Bql g(m_q);
                m_q.async_run(c.cpu, &debug_dap::park_entry, &c); // kicks the CPU
            }
            l.lock();
            if (!m_park_cv.wait_for(l, std::chrono::seconds(10), [&] { return c.parked || m_stop.load(); }))
                std::fprintf(stderr, "debug-dap: core %u did not stop within 10 s\n", n);
        }
        Bql g(m_q);
        c.real_el = c.el = unsigned(reg64(c, m_cpsr) >> 2) & 3;
        c.par_fault = false;
        c.mmu_off = false;
        std::fprintf(stderr, "debug-dap: core %u halted (%s) at 0x%llx\n", n,
                     c.status == 0x1B ? "step" : c.status == 0x07 ? "breakpoint" : c.status == 0x2F ? "software breakpoint" : "debug request",
                     (unsigned long long)reg64(c, m_pc));
    }

    void q_resume(unsigned n)
    {
        Core& c = m_cores[n];
        if (!c.cpu) return;
        {
            Bql g(m_q);
            c.mmu_off = false;
            if (c.edecr & 0x4) { // EDECR.SS: halting step
                c.step = true;
                m_q.single_step(c.cpu, SSTEP);
            }
        }
        {
            std::lock_guard<std::mutex> l(m_park_mu);
            c.park_wanted = false;
        }
        m_park_cv.notify_all();
        if (!c.step) {
            std::fprintf(stderr, "debug-dap: core %u restarted\n", n);
            return;
        }
        // A step ends at once on hardware: OpenOCD reads EDPRSR for SDR and HALTED together,
        // and that read clears SDR. So wait here (m_dbg_mu held) for the step's debug stop.
        std::unique_lock<std::mutex> l(m_evt_mu);
        if (!m_evt_cv.wait_for(l, std::chrono::seconds(2), [this] { return m_evt || m_stop.load(); })) {
            std::fprintf(stderr, "debug-dap: core %u has not finished its step (WFI?)\n", n);
            return;
        }
        if (!m_evt) return;
        m_evt = false;
        l.unlock();
        debug_stop_locked();
    }

    /** Change a QEMU breakpoint: directly on a parked core, else on its own thread. */
    void bp_change(Core& c, uint64_t addr, bool insert)
    {
        bool parked;
        {
            std::lock_guard<std::mutex> l(m_park_mu);
            parked = c.parked && c.park_wanted;
        }
        auto op = [&](void* cpu) {
            if (insert)
                m_q.bp_insert(cpu, addr, BP_GDB, nullptr);
            else
                m_q.bp_remove(cpu, addr, BP_GDB);
        };
        if (parked) {
            Bql g(m_q);
            op(c.cpu);
        } else {
            on_cpu(c.cpu, op);
        }
    }

    /* A QEMU breakpoint or a finished step stops the whole VM (RUN_STATE_DEBUG). */
    std::thread m_evt_thread;
    std::mutex m_evt_mu;
    std::condition_variable m_evt_cv;
    bool m_evt = false;

    static void vm_state(void* opaque, bool running, int state)
    {
        auto* self = static_cast<debug_dap*>(opaque);
        if (running || state != RUN_STATE_DEBUG) return;
        {
            std::lock_guard<std::mutex> l(self->m_evt_mu);
            self->m_evt = true;
        }
        self->m_evt_cv.notify_all(); // the event thread and a step waiting in q_resume
    }

    void event_loop()
    {
        while (!m_stop.load()) {
            {
                std::unique_lock<std::mutex> l(m_evt_mu);
                m_evt_cv.wait_for(l, std::chrono::milliseconds(200), [this] { return m_evt || m_stop.load(); });
                if (!m_evt) continue;
            }
            // The event is taken only with m_dbg_mu held: a step's restart may be waiting for it (q_resume).
            std::lock_guard<std::mutex> l(m_dbg_mu);
            {
                std::lock_guard<std::mutex> e(m_evt_mu);
                if (!m_evt) continue;
                m_evt = false;
            }
            debug_stop_locked();
        }
    }

    /** The cores that caused the debug stop halt (and cross-halt the others); the VM runs again. m_dbg_mu held. */
    void debug_stop_locked()
    {
        {
            Bql g(m_q);
            if (!m_q.runstate_check(RUN_STATE_DEBUG)) return;
        }
        std::vector<std::pair<unsigned, bool>> halts;
        bool ours = false;
        for (unsigned n = 0; n < m_cores.size(); n++) {
            Core& c = m_cores[n];
            if (!c.cpu || c.halted) continue;
            uint32_t status = 0;
            {
                Bql g(m_q);
                const uint64_t pc = reg64(c, m_pc);
                if (c.step) {
                    c.step = false;
                    m_q.single_step(c.cpu, 0);
                    status = 0x1B; // halting step, normal
                } else {
                    for (unsigned i = 0; i < 6 && !status; i++)
                        if (c.hw_on[i] && c.hw_addr[i] == pc) status = 0x07; // breakpoint
                    if (!status && m_soft.count(pc)) status = 0x2F;          // HLT instruction
                }
            }
            if (!status) continue;
            ours = true;
            c.halted = true;
            c.status = status;
            q_halt(n);
            channels_from_trigin(n, halts); // cross-halt
        }
        apply(halts);
        if (!ours) return; // someone else's stop (QEMU's own gdb connection): leave it
        Bql g(m_q);
        if (m_q.runstate_check(RUN_STATE_DEBUG)) m_q.vm_start(); // the halted cores stay soft-stopped
    }

    /* Breakpoints: QEMU breakpoints on the core's CPU, changed on its own thread. */
    void hw_update(unsigned n, unsigned i)
    {
        Core& c = m_cores[n];
        if (!c.cpu) return;
        const uint32_t bcr = c.bcr[i];
        const uint64_t addr = ((uint64_t(c.bvr[2 * i + 1]) << 32) | c.bvr[2 * i]) & ~uint64_t(3);
        const bool on = (bcr & 1) && ((bcr >> 20) & 0xF) == 0; // enabled, unlinked address match
        if (on == c.hw_on[i] && (!on || addr == c.hw_addr[i])) return;
        const bool was = c.hw_on[i];
        const uint64_t old = c.hw_addr[i];
        if (was) bp_change(c, old, false);
        if (on) bp_change(c, addr, true);
        c.hw_on[i] = on;
        c.hw_addr[i] = addr;
    }

    void soft_set(uint64_t addr, bool on)
    {
        if (on == (m_soft.count(addr) != 0)) return;
        for (auto& c : m_cores) {
            if (!c.cpu) continue;
            bp_change(c, addr, on);
        }
        if (on)
            m_soft.insert(addr);
        else
            m_soft.erase(addr);
    }

    /* Memory through the core: its virtual addresses, or physical ones while SCTLR.M is cleared. */
    bool phys(uint64_t addr, uint8_t* buf, unsigned len, bool write)
    {
        while (len) {
            const unsigned k = (len >= 4 && !(addr & 3)) ? 4 : (len >= 2 && !(addr & 1)) ? 2 : 1;
            uint32_t d = 0, r = 0;
            for (unsigned i = 0; i < k; i++) d |= uint32_t(buf[i]) << (8 * ((addr & 3) + i));
            if (!sys_access(!write, addr, k, d, r)) return false;
            if (!write)
                for (unsigned i = 0; i < k; i++) buf[i] = uint8_t(r >> (8 * ((addr & 3) + i)));
            addr += k;
            buf += k;
            len -= k;
        }
        return true;
    }
    bool load(Core& c, uint64_t addr, unsigned bytes, uint64_t& v)
    {
        uint8_t b[8] = {};
        bool ok;
        if (c.mmu_off) {
            ok = phys(addr, b, bytes, false);
        } else {
            Bql g(m_q);
            ok = m_q.mem_rw(c.cpu, addr, b, bytes, false) == 0;
        }
        v = 0;
        std::memcpy(&v, b, bytes);
        return ok;
    }
    bool store(Core& c, uint64_t addr, uint64_t v, unsigned bytes)
    {
        if (bytes == 4 && uint32_t(v) == HLT_11 && !c.mmu_off) { // a software breakpoint
            soft_set(addr, true);
            return true;
        }
        if (bytes == 4 && m_soft.count(addr)) soft_set(addr, false); // the original instruction goes back
        uint8_t b[8];
        std::memcpy(b, &v, 8);
        if (c.mmu_off) return phys(addr, b, bytes, true);
        Bql g(m_q);
        return m_q.mem_rw(c.cpu, addr, b, bytes, true) == 0;
    }
    void ma_load(Core& c)
    {
        const uint64_t a = X(c, 0);
        uint64_t v = 0;
        if (!load(c, a, 4, v)) {
            c.err = true;
            return;
        }
        c.dtrtx = uint32_t(v);
        c.txfull = true;
        set_X(c, 0, a + 4);
    }
    void ma_store(Core& c, uint32_t data)
    {
        const uint64_t a = X(c, 0);
        if (!store(c, a, data, 4)) {
            c.err = true;
            return;
        }
        set_X(c, 0, a + 4);
    }

    /* System registers by encoding (debug_dap_sr). */
    static const char* sysreg_name(uint32_t sys)
    {
        static const std::map<uint32_t, const char*> names = {
            { debug_dap_sr(3, 0, 0, 0, 0), "MIDR_EL1" },       { debug_dap_sr(3, 0, 0, 0, 6), "REVIDR_EL1" },
            { debug_dap_sr(3, 0, 0, 4, 0), "ID_AA64PFR0_EL1" }, { debug_dap_sr(3, 0, 0, 4, 1), "ID_AA64PFR1_EL1" },
            { debug_dap_sr(3, 0, 0, 5, 0), "ID_AA64DFR0_EL1" }, { debug_dap_sr(3, 0, 0, 6, 0), "ID_AA64ISAR0_EL1" },
            { debug_dap_sr(3, 0, 0, 6, 1), "ID_AA64ISAR1_EL1" }, { debug_dap_sr(3, 0, 0, 7, 0), "ID_AA64MMFR0_EL1" },
            { debug_dap_sr(3, 0, 0, 7, 1), "ID_AA64MMFR1_EL1" }, { debug_dap_sr(3, 0, 0, 7, 2), "ID_AA64MMFR2_EL1" },
            { debug_dap_sr(3, 1, 0, 0, 1), "CLIDR_EL1" },      { debug_dap_sr(3, 3, 0, 0, 1), "CTR_EL0" },
            { debug_dap_sr(3, 3, 0, 0, 7), "DCZID_EL0" },
            { debug_dap_sr(3, 0, 1, 0, 0), "SCTLR_EL1" },      { debug_dap_sr(3, 0, 1, 0, 1), "ACTLR_EL1" },
            { debug_dap_sr(3, 0, 1, 0, 2), "CPACR_EL1" },      { debug_dap_sr(3, 0, 2, 0, 0), "TTBR0_EL1" },
            { debug_dap_sr(3, 0, 2, 0, 1), "TTBR1_EL1" },      { debug_dap_sr(3, 0, 2, 0, 2), "TCR_EL1" },
            { debug_dap_sr(3, 0, 4, 0, 0), "SPSR_EL1" },       { debug_dap_sr(3, 0, 4, 0, 1), "ELR_EL1" },
            { debug_dap_sr(3, 0, 4, 1, 0), "SP_EL0" },         { debug_dap_sr(3, 0, 5, 1, 0), "AFSR0_EL1" },
            { debug_dap_sr(3, 0, 5, 1, 1), "AFSR1_EL1" },      { debug_dap_sr(3, 0, 5, 2, 0), "ESR_EL1" },
            { debug_dap_sr(3, 0, 6, 0, 0), "FAR_EL1" },        { debug_dap_sr(3, 0, 7, 4, 0), "PAR_EL1" },
            { debug_dap_sr(3, 0, 10, 2, 0), "MAIR_EL1" },      { debug_dap_sr(3, 0, 10, 3, 0), "AMAIR_EL1" },
            { debug_dap_sr(3, 0, 12, 0, 0), "VBAR_EL1" },      { debug_dap_sr(3, 0, 13, 0, 1), "CONTEXTIDR_EL1" },
            { debug_dap_sr(3, 0, 13, 0, 4), "TPIDR_EL1" },     { debug_dap_sr(3, 3, 13, 0, 2), "TPIDR_EL0" },
            { debug_dap_sr(3, 3, 13, 0, 3), "TPIDRRO_EL0" },   { debug_dap_sr(3, 3, 14, 0, 0), "CNTFRQ_EL0" },
            { debug_dap_sr(3, 3, 14, 0, 1), "CNTPCT_EL0" },    { debug_dap_sr(3, 3, 14, 0, 2), "CNTVCT_EL0" },
            { debug_dap_sr(3, 0, 14, 1, 0), "CNTKCTL_EL1" },   { debug_dap_sr(2, 0, 0, 2, 2), "MDSCR_EL1" },
            { debug_dap_sr(3, 4, 1, 0, 0), "SCTLR_EL2" },      { debug_dap_sr(3, 4, 1, 1, 0), "HCR_EL2" },
            { debug_dap_sr(3, 4, 2, 0, 0), "TTBR0_EL2" },      { debug_dap_sr(3, 4, 2, 0, 2), "TCR_EL2" },
            { debug_dap_sr(3, 4, 4, 0, 0), "SPSR_EL2" },       { debug_dap_sr(3, 4, 4, 0, 1), "ELR_EL2" },
            { debug_dap_sr(3, 4, 4, 1, 0), "SP_EL1" },         { debug_dap_sr(3, 4, 5, 2, 0), "ESR_EL2" },
            { debug_dap_sr(3, 4, 6, 0, 0), "FAR_EL2" },        { debug_dap_sr(3, 4, 10, 2, 0), "MAIR_EL2" },
            { debug_dap_sr(3, 4, 12, 0, 0), "VBAR_EL2" },      { debug_dap_sr(3, 6, 1, 0, 0), "SCTLR_EL3" },
            { debug_dap_sr(3, 6, 1, 1, 0), "SCR_EL3" },        { debug_dap_sr(3, 6, 2, 0, 0), "TTBR0_EL3" },
            { debug_dap_sr(3, 6, 2, 0, 2), "TCR_EL3" },        { debug_dap_sr(3, 6, 4, 0, 0), "SPSR_EL3" },
            { debug_dap_sr(3, 6, 4, 0, 1), "ELR_EL3" },        { debug_dap_sr(3, 6, 4, 1, 0), "SP_EL2" },
            { debug_dap_sr(3, 6, 5, 2, 0), "ESR_EL3" },        { debug_dap_sr(3, 6, 6, 0, 0), "FAR_EL3" },
            { debug_dap_sr(3, 6, 10, 2, 0), "MAIR_EL3" },      { debug_dap_sr(3, 6, 12, 0, 0), "VBAR_EL3" },
        };
        auto it = names.find(sys);
        return it == names.end() ? nullptr : it->second;
    }
    static std::string sysreg_label(uint32_t sys)
    {
        if (const char* n = sysreg_name(sys)) return n;
        char b[48];
        std::snprintf(b, sizeof b, "S%u_%u_C%u_C%u_%u", sys >> 14, (sys >> 11) & 7, (sys >> 7) & 15, (sys >> 3) & 15, sys & 7);
        return b;
    }
    int sysreg_index(uint32_t sys)
    {
        const char* n = sysreg_name(sys);
        if (!n) return -1;
        auto it = m_reg.find(n);
        return it == m_reg.end() ? -1 : it->second;
    }

    static constexpr uint32_t DBGDTR = debug_dap_sr(2, 3, 0, 4, 0), DBGDTRRXTX = debug_dap_sr(2, 3, 0, 5, 0);
    static constexpr uint32_t DLR = debug_dap_sr(3, 3, 4, 5, 1), DSPSR = debug_dap_sr(3, 3, 4, 5, 0);
    static constexpr uint32_t FPCR = debug_dap_sr(3, 3, 4, 4, 0), FPSR = debug_dap_sr(3, 3, 4, 4, 1);
    static constexpr uint32_t NZCV = debug_dap_sr(3, 3, 4, 2, 0), DAIF = debug_dap_sr(3, 3, 4, 2, 1);
    static constexpr uint32_t CURRENTEL = debug_dap_sr(3, 0, 4, 2, 2), SPSEL = debug_dap_sr(3, 0, 4, 2, 0);
    static constexpr uint32_t MPIDR = debug_dap_sr(3, 0, 0, 0, 5), CCSIDR = debug_dap_sr(3, 1, 0, 0, 0), CSSELR = debug_dap_sr(3, 2, 0, 0, 0);
    static constexpr uint32_t PAR = debug_dap_sr(3, 0, 7, 4, 0);
    static bool is_sctlr(uint32_t sys) { return sys == debug_dap_sr(3, 0, 1, 0, 0) || sys == debug_dap_sr(3, 4, 1, 0, 0) || sys == debug_dap_sr(3, 6, 1, 0, 0); }

    bool mrs(Core& c, uint32_t sys, unsigned t)
    {
        uint64_t v = 0;
        switch (sys) {
        case DBGDTR: v = (uint64_t(c.dtrtx) << 32) | c.dtrrx; c.rxfull = false; break;
        case DBGDTRRXTX: v = c.dtrrx; c.rxfull = false; break; // DBGDTRRX_EL0
        case DLR: v = named(c, m_pc); break;
        case DSPSR: v = named(c, m_cpsr) & 0xFFFFFFFFu; break;
        case FPCR: v = named(c, m_fpcr); break;
        case FPSR: v = named(c, m_fpsr); break;
        case NZCV: v = named(c, m_cpsr) & 0xF0000000u; break;
        case DAIF: v = named(c, m_cpsr) & 0x3C0u; break;
        case SPSEL: v = named(c, m_cpsr) & 1u; break;
        case CURRENTEL: v = uint64_t(c.el) << 2; break;
        case CSSELR: v = c.csselr; break;
        case MPIDR: {
            Bql g(m_q);
            v = (1u << 31) | m_q.get_uint(c.cpu, "mp-affinity", nullptr);
            break;
        }
        default: {
            const int idx = sysreg_index(sys);
            if (idx >= 0) {
                v = named(c, idx);
                if (is_sctlr(sys) && c.mmu_off) v &= ~uint64_t(1);
            } else if (sys == CCSIDR) {
                v = 0x700FE01Au; // 64-byte lines, 4 ways, 128 sets (QEMU models no caches)
            } else if (sys == debug_dap_sr(3, 1, 0, 0, 1)) {
                v = 0x0A200023u; // CLIDR_EL1: L1 instruction and data, L2 unified (to match CCSIDR)
            } else if (sys == debug_dap_sr(3, 0, 0, 0, 0)) {
                v = p_midr.get_value();
            } else {
                once("cannot read " + sysreg_label(sys) + ": reads as 0");
            }
            if (sys == PAR && c.par_fault) v = 1; // F: the translation failed
        }
        }
        set_X(c, t, v);
        return true;
    }

    bool msr(Core& c, uint32_t sys, unsigned t)
    {
        const uint64_t v = X(c, t);
        switch (sys) {
        case DBGDTR: c.dtrtx = uint32_t(v); c.dtrrx = uint32_t(v >> 32); c.txfull = true; return true;
        case DBGDTRRXTX: c.dtrtx = uint32_t(v); c.txfull = true; return true; // DBGDTRTX_EL0
        case DLR: return set_named(c, m_pc, v);
        case DSPSR: return set_named(c, m_cpsr, v & 0xFFFFFFFFu);
        case FPCR: return set_named(c, m_fpcr, v);
        case FPSR: return set_named(c, m_fpsr, v);
        case NZCV: return set_named(c, m_cpsr, (named(c, m_cpsr) & ~uint64_t(0xF0000000u)) | (v & 0xF0000000u));
        case DAIF: return set_named(c, m_cpsr, (named(c, m_cpsr) & ~uint64_t(0x3C0u)) | (v & 0x3C0u));
        case CSSELR: c.csselr = uint32_t(v); return true;
        default: break;
        }
        const int idx = sysreg_index(sys);
        if (idx < 0) {
            once("cannot write " + sysreg_label(sys) + ": ignored");
            return true;
        }
        const uint64_t cur = named(c, idx);
        if (is_sctlr(sys)) {
            c.mmu_off = (cur & 1) && !(v & 1);
            if ((cur ^ v) & ~uint64_t(1)) once("cannot change " + sysreg_label(sys) + " (except M): ignored");
            return true;
        }
        if (v != cur && !set_named(c, idx, v))
            once("cannot change " + sysreg_label(sys) + " (QEMU's gdbstub writes no system registers): ignored");
        return true;
    }

    /** Execute an A64 instruction written to EDITR on halted core n; false sets EDSCR.ERR. */
    bool exec(unsigned n, uint32_t in)
    {
        Core& c = m_cores[n];
        if (!c.cpu) return false;
        const unsigned t = in & 31;
        if ((in & 0xFFD00000u) == 0xD5100000u) // MSR or MRS (register), op0 2 or 3
            return (in & (1u << 21)) ? mrs(c, (in >> 5) & 0xFFFF, t) : msr(c, (in >> 5) & 0xFFFF, t);
        if ((in & 0xFFFFF000u) == 0xD5033000u || (in & 0xFFFFF000u) == 0xD5032000u) return true; // barriers, hints
        if ((in & 0xFFF8F01Fu) == 0xD500401Fu) return true; // MSR (immediate): PSTATE fields of the halted core
        if ((in & 0xFFF80000u) == 0xD5080000u) {            // SYS: DC, IC, TLBI (no caches in QEMU), AT
            if (((in >> 12) & 0xF) == 7 && ((in >> 8) & 0xF) == 8) c.par_fault = true;
            return true;
        }
        if ((in & 0xFFE0001Cu) == 0xD4A00000u) { // DCPS<n>
            const unsigned el = in & 3;
            if (!el || el > m_max_el) return false;
            if (el > c.el) c.el = el;
            return true;
        }
        if (in == 0xD6BF03E0u) { // DRPS: back to the EL the core halted in
            c.el = c.real_el;
            return true;
        }
        if ((in & 0xFFFFFFE0u) == 0x910003E0u) { // MOV Xd, SP
            set_X(c, t, named(c, m_sp));
            return true;
        }
        if ((in & 0xFFFFFC1Fu) == 0x9100001Fu) // MOV SP, Xn
            return set_named(c, m_sp, X(c, (in >> 5) & 31));
        if ((in & 0xFFEFFC00u) == 0x4E083C00u || (in & 0xFFEFFC00u) == 0x4E081C00u) { // UMOV Xd, Vn.D[i] / INS Vd.D[i], Xn
            const bool to_x = (in & 0xFFEFFC00u) == 0x4E083C00u;
            const unsigned i = (in >> 20) & 1, nn = (in >> 5) & 31;
            const unsigned vreg = to_x ? nn : t;
            if (m_v[vreg] < 0) return false;
            uint8_t b[64] = {};
            unsigned len = 0;
            Bql g(m_q);
            if (!read_reg(c, m_v[vreg], b, len) || len < 16) return false;
            if (to_x) {
                uint64_t v;
                std::memcpy(&v, b + 8 * i, 8);
                set_reg64(c, m_x[t], v);
                return true;
            }
            const uint64_t v = nn == 31 ? 0 : reg64(c, m_x[nn]);
            std::memcpy(b + 8 * i, &v, 8);
            return m_q.write_reg(c.cpu, b, m_v[vreg]) > 0;
        }
        if ((in & 0x3F200C00u) == 0x38000400u) { // LDR/STR (immediate, post-index), integer registers
            const unsigned opc = (in >> 22) & 3, bytes = 1u << (in >> 30), rn = (in >> 5) & 31;
            if (opc > 1) return false; // sign-extending loads: not used by OpenOCD
            int64_t imm = (in >> 12) & 0x1FF;
            if (imm & 0x100) imm -= 0x200;
            const uint64_t base = rn == 31 ? named(c, m_sp) : X(c, rn);
            if (opc == 1) {
                uint64_t v = 0;
                if (!load(c, base, bytes, v)) return false;
                set_X(c, t, v);
            } else if (!store(c, base, X(c, t), bytes)) {
                return false;
            }
            if (rn == 31)
                set_named(c, m_sp, base + uint64_t(imm));
            else
                set_X(c, rn, base + uint64_t(imm));
            return true;
        }
        char b[64];
        std::snprintf(b, sizeof b, "instruction 0x%08x is not supported", in);
        once(b);
        return false;
    }

    /** Halt or resume core n through its QBox halt signal, on the SystemC thread. Writes only changes. */
    void signal_halt(unsigned n, bool on)
    {
        if (n >= halt.size()) return;
        on_sim([this, n, on] {
            if (!halt[n].get_interface()) return; // not bound
            halt[n]->write(on);
        });
        std::fprintf(stderr, "debug-dap: core %u %s\n", n, on ? "halted (external debug request)" : "restarted");
    }
};

#endif
