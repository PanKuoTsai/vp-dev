/*
 * vp_probes: probes for VP Studio (transaction and signal tracing, G-12).
 *
 * The records, the probes' switches, the bus breakpoints and the table of
 * initiator names live here, in probes.so. The tracers in this library
 * write them; VP Studio's sim agent (a separate library that links to this
 * one) reads and controls them. QBox loads libraries with RTLD_LOCAL, so the
 * singletons are defined once, in probes.cc, and not inline.
 */
#ifndef PROBES_H
#define PROBES_H

#include <systemc>
#include <tlm>
#include <tlm_utils/multi_socket_bases.h>
#include <tlm-extensions/pathid_extension.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <tuple>
#include <vector>

#define PROBES_API __attribute__((visibility("default")))
#define PROBES_VERSION "1.0.0"

/* ---------------------------------------------------------------- transaction trace */

/** One bus access seen by a tracer. */
struct TraceRecord {
    uint64_t seq;
    double time_s;      // simulated time when the access completed (approximate for CPU threads)
    uint32_t point;     // index into TraceStore::points
    bool write;
    uint64_t address;   // absolute: the tracer's base plus the offset the router passed on
    uint32_t length;
    uint8_t data[16];   // the first bytes of the data; for a signal, data[0] is its new level
    int status;         // tlm_response_status
    bool signal;        // a signal change (signal_tracer), not a bus access
    uint16_t router;    // the router in front of the tracer (InitiatorNames::router_id)
    uint8_t npath;      // entries in path: the ids the routers stamped (PathIDExtension), outermost first
    int16_t path[4];
};

/**
 * Who issued a traced access. Each QBox router stamps a transaction with the
 * index of the target_socket binding it came in on (gs::PathIDExtension, one
 * entry per router on the way). The index is the order in which initiators
 * bound to that socket; the socket's binders know the port on the other side.
 * The table is built once at start_of_simulation (bindings are final then),
 * before the agent starts serving, and only read afterwards.
 * Names are relative to the top-level container ("cpu_3.mem", "periph.dma.mem").
 */
class InitiatorNames
{
public:
    /** The one table, in probes.so (every library that uses it shares it). */
    PROBES_API static InitiatorNames& get();

    /** During elaboration: the id of a router named as the platform names it ("router", "periph.bus"); "" = the only router. */
    uint16_t router_id(const std::string& name)
    {
        std::lock_guard<std::mutex> l(m_mu);
        for (size_t i = 0; i < m_router_names.size(); i++)
            if (m_router_names[i] == name) return uint16_t(i);
        m_router_names.push_back(name);
        return uint16_t(m_router_names.size() - 1);
    }

    static std::string relative(const std::string& n)
    {
        const size_t dot = n.find('.');
        return dot == std::string::npos ? n : n.substr(dot + 1);
    }

    /** On the SystemC thread, after elaboration: index -> initiator port of every router's target_socket. */
    void build()
    {
        std::lock_guard<std::mutex> l(m_mu);
        m_table.clear();
        for (auto* o : sc_core::sc_get_top_level_objects()) scan(o);
        m_built = true;
    }

    /** The initiator port of an access, or "" when the routers' stamps do not lead to one. */
    std::string resolve(uint16_t router, uint8_t npath, const int16_t* path)
    {
        std::lock_guard<std::mutex> l(m_mu);
        if (!m_built || !npath || router >= m_router_names.size()) return "";
        std::string cur = m_router_names[router];
        if (cur.empty()) {
            if (m_table.size() != 1) return "";
            cur = m_table.begin()->first;
        }
        for (int k = int(npath) - 1; k >= 0; k--) {
            auto it = m_table.find(cur);
            if (it == m_table.end() || path[k] < 0 || size_t(path[k]) >= it->second.size()) return "";
            const std::string& port = it->second[size_t(path[k])];
            const size_t dot = port.rfind('.');
            const std::string owner = dot == std::string::npos ? port : port.substr(0, dot);
            // Came in from another router: continue with the stamp that router made.
            if (k > 0 && m_table.count(owner)) {
                cur = owner;
                continue;
            }
            return port;
        }
        return "";
    }

private:
    void scan(sc_core::sc_object* o)
    {
        auto* t = dynamic_cast<tlm_utils::multi_target_base_if<tlm::tlm_base_protocol_types>*>(o);
        if (t && std::string(o->basename()) == "target_socket" && o->get_parent_object()) {
            std::vector<std::string> names;
            for (auto* b : t->get_binders()) {
                sc_core::sc_port_base* p = b ? b->get_other_side() : nullptr;
                names.push_back(p ? relative(p->name()) : std::string());
            }
            m_table[relative(o->get_parent_object()->name())] = std::move(names);
        }
        for (auto* c : o->get_child_objects()) scan(c);
    }

    std::mutex m_mu;
    std::vector<std::string> m_router_names;
    std::map<std::string, std::vector<std::string>> m_table;
    bool m_built = false;
};

/**
 * Records shared by every tracer and read by the agent. Accesses can come
 * from QEMU vCPU threads as well as the SystemC thread, hence the mutex.
 */
class TraceStore
{
public:
    /** The one store, in probes.so: the tracers write it, the sim agent reads it. */
    PROBES_API static TraceStore& get();

    /**
     * A probe (G-12). kind: "bus", "memory" or "signal". recording: whether it
     * records from the start. changed: called on the SystemC thread when
     * trace.setPoints turns its recording on or off (a memory probe stops or
     * allows DMI there). Probes are added during elaboration only.
     */
    uint32_t add_point(const std::string& label, const char* kind = "bus", bool recording = true,
                       std::function<void(bool)> changed = {})
    {
        std::lock_guard<std::mutex> l(m_mu);
        m_points.push_back(label);
        m_kinds.push_back(kind);
        m_on.emplace_back(recording);
        m_changed.push_back(std::move(changed));
        return uint32_t(m_points.size() - 1);
    }

    /** Whether this probe records (its own switch; recording as a whole is enabled()). */
    bool point_on(uint32_t p) const { return p < m_on.size() && m_on[p].load(std::memory_order_relaxed); }
    /** Whether an access at this probe is worth handing to record(). */
    bool wants(uint32_t p) const
    {
        return (m_enabled.load(std::memory_order_relaxed) && point_on(p)) ||
               m_has_breakpoints.load(std::memory_order_relaxed);
    }
    /** On the SystemC thread. Returns false for an unknown label. */
    bool set_point(const std::string& label, bool on)
    {
        std::function<void(bool)> cb;
        {
            std::lock_guard<std::mutex> l(m_mu);
            size_t i = 0;
            while (i < m_points.size() && m_points[i] != label) i++;
            if (i == m_points.size()) return false;
            if (m_on[i].exchange(on) == on) return true;
            cb = m_changed[i];
        }
        if (cb) cb(on);
        return true;
    }
    struct PointInfo {
        std::string label;
        std::string kind;
        bool recording;
    };
    std::vector<PointInfo> point_info()
    {
        std::lock_guard<std::mutex> l(m_mu);
        std::vector<PointInfo> out;
        for (size_t i = 0; i < m_points.size(); i++) out.push_back({ m_points[i], m_kinds[i], m_on[i].load() });
        return out;
    }

    /** Set while the agent itself accesses the bus (mem.read, mem.write): tracers ignore those. */
    PROBES_API static bool& agent_access();

    /** Every access a tracer sees: kept when recording is on, and checked against the breakpoints. */
    void record(TraceRecord r)
    {
        if (agent_access()) return;
        const bool keep = m_enabled.load(std::memory_order_relaxed) && point_on(r.point);
        const bool check = m_has_breakpoints.load(std::memory_order_relaxed);
        if (!keep && !check) return;
        std::function<void()> fire;
        {
            std::lock_guard<std::mutex> l(m_mu);
            if (keep) {
                r.seq = ++m_seq;
                if (m_records.size() >= CAPACITY) {
                    m_records.pop_front();
                    m_dropped++;
                }
                m_records.push_back(r);
            } else {
                r.seq = 0; // not recorded
            }
            if (r.signal) {
                // Signal changes are recorded only: no breakpoint looks at them.
            } else if (m_hit.valid) {
                // The CPUs run on until the pause takes hold. Matching accesses in
                // that window have happened and will not stop the simulation.
                m_hit.accesses_after++;
                for (const auto& b : m_breakpoints) {
                    if (b.matches(r)) {
                        m_hit.matches_after++;
                        break;
                    }
                }
            } else if (check) {
                for (const auto& b : m_breakpoints) {
                    if (b.matches(r)) {
                        m_hit = { true, b.id, r, 0, 0 };
                        fire = m_on_break; // a copy: the agent may clear it at the end
                        break;
                    }
                }
            }
        }
        if (fire) fire();
    }

    /*
     * Breakpoints on bus accesses. An access matches when it is of the right
     * kind, on the right trace point (or any), overlaps [lo, hi], and, with a
     * mask, (data & mask) == (value & mask), data read as a little-endian
     * number from its first 8 bytes. The first match is kept as the hit until
     * clear_hit(); later accesses only count as accesses_after.
     */
    struct Breakpoint {
        uint32_t id = 0;
        int point = -1; // -1: any trace point
        uint64_t lo = 0, hi = ~uint64_t(0);
        bool on_read = true, on_write = true;
        uint64_t mask = 0, value = 0; // mask 0: any data

        bool matches(const TraceRecord& r) const
        {
            if (r.write ? !on_write : !on_read) return false;
            if (point >= 0 && uint32_t(point) != r.point) return false;
            const uint64_t last = r.address + (r.length ? r.length - 1 : 0);
            if (last < lo || r.address > hi) return false;
            if (!mask) return true;
            uint64_t v = 0;
            const size_t n = std::min<size_t>(8, std::min<size_t>(r.length, sizeof r.data));
            for (size_t i = 0; i < n; i++) v |= uint64_t(r.data[i]) << (8 * i);
            return (v & mask) == (value & mask);
        }
    };
    struct Hit {
        bool valid = false;
        uint32_t breakpoint = 0;
        TraceRecord record{};
        uint64_t accesses_after = 0;
        uint64_t matches_after = 0; // of those, how many matched a breakpoint too
    };

    void set_breakpoints(std::vector<Breakpoint> b)
    {
        std::lock_guard<std::mutex> l(m_mu);
        m_breakpoints = std::move(b);
        m_has_breakpoints = !m_breakpoints.empty();
    }
    std::vector<Breakpoint> breakpoints()
    {
        std::lock_guard<std::mutex> l(m_mu);
        return m_breakpoints;
    }
    Hit hit()
    {
        std::lock_guard<std::mutex> l(m_mu);
        return m_hit;
    }
    void clear_hit()
    {
        std::lock_guard<std::mutex> l(m_mu);
        m_hit = Hit{};
    }
    /** Called (from any thread, without the lock) when a breakpoint matches. */
    void set_on_break(std::function<void()> f)
    {
        std::lock_guard<std::mutex> l(m_mu);
        m_on_break = std::move(f);
    }
    int point_index(const std::string& label)
    {
        std::lock_guard<std::mutex> l(m_mu);
        for (size_t i = 0; i < m_points.size(); i++)
            if (m_points[i] == label) return int(i);
        return -1;
    }

    void set_enabled(bool on) { m_enabled = on; }
    bool enabled() const { return m_enabled.load(); }

    void clear()
    {
        std::lock_guard<std::mutex> l(m_mu);
        m_records.clear();
        m_dropped = 0;
    }

    /** Records with seq > since, at most max of them, oldest first. */
    void read(uint64_t since, size_t max, std::vector<TraceRecord>& out, uint64_t& last_seq, uint64_t& dropped,
              std::vector<std::string>& points)
    {
        std::lock_guard<std::mutex> l(m_mu);
        auto it = std::upper_bound(m_records.begin(), m_records.end(), since,
                                   [](uint64_t s, const TraceRecord& r) { return s < r.seq; });
        for (; it != m_records.end() && out.size() < max; ++it) out.push_back(*it);
        last_seq = m_seq;
        dropped = m_dropped;
        points = m_points;
    }

    void status(size_t& count, uint64_t& last_seq, uint64_t& dropped, std::vector<std::string>& points)
    {
        std::lock_guard<std::mutex> l(m_mu);
        count = m_records.size();
        last_seq = m_seq;
        dropped = m_dropped;
        points = m_points;
    }

    static const size_t CAPACITY = 100000;

private:
    std::mutex m_mu;
    std::deque<TraceRecord> m_records;
    std::vector<std::string> m_points;
    std::vector<std::string> m_kinds;
    std::deque<std::atomic<bool>> m_on; // a deque: elements never move
    std::vector<std::function<void(bool)>> m_changed;
    uint64_t m_seq = 0;
    uint64_t m_dropped = 0;
    std::atomic<bool> m_enabled{ true };
    std::vector<Breakpoint> m_breakpoints;
    std::atomic<bool> m_has_breakpoints{ false };
    Hit m_hit;
    std::function<void()> m_on_break;
};

#endif
