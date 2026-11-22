/*
 * debug_dap: a JTAG-reachable Arm debug port for a QBox platform, so that
 * OpenOCD can connect to the simulation (G-13, first stage).
 *
 * OpenOCD talks to it with its remote_bitbang adapter over TCP. Behind the
 * JTAG TAP is an ADIv5 JTAG-DP with two access ports:
 *   AP0  AXI MEM-AP on the system bus (the `mem` socket, bound to a router):
 *        reads and writes anywhere the CPUs can, 64-bit addresses.
 *   AP1  APB-AP on a debug bus inside this model: a ROM table and, for each
 *        core, Armv8 external debug registers and a CTI.
 * A debug request from a CTI (trigger out 0) halts the core through its QBox
 * `halt` signal (QEMU's per-CPU stop); a restart request (trigger out 1)
 * resumes it. EDSCR.STATUS and EDPRSR.HALTED follow.
 *
 * Not in this stage: instructions through EDITR (so OpenOCD's aarch64 target
 * cannot read core registers yet), halting step, and breakpoints or
 * watchpoints (their registers only hold values).
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

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>


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
    tlm_utils::simple_initiator_socket<debug_dap, DEFAULT_TLM_BUSWIDTH> mem;
    sc_core::sc_vector<InitiatorSignalSocket<bool>> halt;

    SC_HAS_PROCESS(debug_dap);
    explicit debug_dap(const sc_core::sc_module_name& n)
        : sc_core::sc_module(n)
        , p_port("port", 0, "TCP port for OpenOCD's remote_bitbang adapter (0: none)")
        , p_cpus("cpus", 1, "Number of cores: halt_0 .. halt_<cpus-1>, each bound to a CPU's halt signal")
        , p_host("host", "127.0.0.1", "Address to listen on")
        , p_midr("midr", 0x414FD0B1, "MIDR_EL1 shown in each core's external debug registers")
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
        if (p_port.get_value()) start_server();
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
        if (m_thread.joinable()) m_thread.join();
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
    };
    std::mutex m_dbg_mu;
    std::vector<Core> m_cores;

    static constexpr uint32_t EDSCR_HDE = 1u << 14;
    static constexpr uint32_t EDSCR_WRITABLE = (1u << 30) | (1u << 29) | (3u << 22) | (1u << 21) | (1u << 20) | EDSCR_HDE | (1u << 3);

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
        }
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
        v |= c.halted ? 0x13 : 0x02; // STATUS: halted by an external debug request, or not in Debug state
        v |= 1u << 24;               // ITE: the instruction register is empty
        if (c.halted) v |= 1u << 8;  // EL: 1 (where the Ubuntu kernel runs)
        v |= 0xFu << 10;             // RW: AArch64 at every EL
        return v;
    }

    bool core_access(unsigned n, bool read, uint32_t off, uint32_t data, uint32_t& r)
    {
        Core& c = m_cores[n];
        if (id_regs(off, 0x9, 0xD0B, r)) return true;
        if (read) {
            switch (off) {
            case 0x088: r = edscr(c); return true;
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
        case 0x090: return true; // EDRCR: nothing sticky to clear in this stage
        case 0x300: c.oslk = data & 1; return true; // OSLAR_EL1
        case 0x310: c.edprcr = data & 0xF; return true;
        case 0xFB0: return true; // EDLAR
        default: break;
        }
        if (off >= 0x400 && off < 0x400 + 16 * 6) { const unsigned i = (off - 0x400) / 16; if ((off & 0xF) == 0) c.bvr[2 * i] = data; else if ((off & 0xF) == 4) c.bvr[2 * i + 1] = data; else if ((off & 0xF) == 8) c.bcr[i] = data; return true; }
        if (off >= 0x800 && off < 0x800 + 16 * 4) { const unsigned i = (off - 0x800) / 16; if ((off & 0xF) == 0) c.wvr[2 * i] = data; else if ((off & 0xF) == 4) c.wvr[2 * i + 1] = data; else if ((off & 0xF) == 8) c.wcr[i] = data; return true; }
        return true; // other registers ignore writes in this stage
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
        // An event leaves its CTI through the gate and reaches the others; it always reaches its own.
        for (unsigned k = 0; k < m_cores.size(); k++) {
            const uint32_t got = k == src ? ch : (ch & m_cores[src].gate);
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
