/*
 * perf: architecture exploration models for VP Studio.
 *
 * Four module types, all in perf.so (platforms name it: dylib_path = "perf"):
 *   traffic_gen  an initiator that issues reads and writes by a pattern or
 *                from a recorded list, through an approximately-timed
 *                (AT, nb_transport) initiator socket
 *   at_bus       an AT interconnect: arbitration between initiators, a
 *                request channel (address and write data) and a response
 *                channel (read data), a pipeline latency, an address map
 *                taken from the bound targets like QBox's router
 *   dram_ctrl    an AT DRAM controller: banks, open rows, tRCD/tCL/tRP,
 *                refresh, a shared data bus, FCFS or FR-FCFS scheduling
 *   perf_stats   writes the statistics (JSON) when every traffic_gen is
 *                done, and can stop the simulation then
 *
 * None of them stores data: they model time only. The statistics live in
 * PerfStats (one per process, defined in perf.cc).
 */
#ifndef PERF_H
#define PERF_H

#include <systemc>
#include <tlm>

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#define PERF_API __attribute__((visibility("default")))
#define PERF_VERSION "1.2.0"

/** Attached by traffic_gen to each transaction: who issued it and when. */
struct PerfTag : tlm::tlm_extension<PerfTag> {
    int gen = -1;          // index in PerfStats::gens
    uint32_t qos = 0;      // higher is more important (at_bus arbitration "priority")
    sc_core::sc_time issued;
    int32_t prio = -1;     // set by the last at_bus: the priority it used (-1: qos)
    bool urgent = false;   // set by the last at_bus: within the master's reserved bandwidth (min_mbps)
    uint32_t priority() const { return prio >= 0 ? (uint32_t)prio : qos; }
    tlm::tlm_extension_base* clone() const override { return new PerfTag(*this); }
    void copy_from(const tlm::tlm_extension_base& e) override { *this = static_cast<const PerfTag&>(e); }
};

/** Latency samples with exact percentiles. */
struct PerfSamples {
    std::vector<double> ns;
    void add(double v) { ns.push_back(v); }
    double percentile(double p); // sorts
    double mean() const;
};

struct PerfGenStats {
    std::string name, label;
    uint64_t reads = 0, writes = 0, bytes = 0, issued = 0;
    uint64_t errors = 0;   // answered with an error (no target at the address, ...): not in reads, writes or bytes
    std::string first_error;
    double first_issue_ns = -1, last_done_ns = 0;
    PerfSamples latency;   // issue to response
    bool done = false;
};

/** One master (initiator) on one at_bus. */
struct PerfMasterStats {
    uint64_t bytes = 0, grants = 0;
    uint64_t urgent = 0;       // grants within the reserved bandwidth (min_mbps)
    uint64_t limited = 0;      // grants that waited for the bandwidth limit (max_mbps)
    double limit_wait_ns = 0;  // total time requests waited for the bandwidth limit
    PerfSamples resp_wait;     // response ready to response channel start
    std::string qos;           // the bus's settings for this master ("priority=3 min_mbps=6000"), or empty
};

struct PerfBusStats {
    std::string name;
    double req_busy_ns = 0, resp_busy_ns = 0;
    std::map<std::string, PerfSamples> wait; // by initiator label: arrival to grant
    std::map<std::string, PerfMasterStats> masters; // by initiator label
    std::string topology;                            // shared or crossbar
    std::map<std::string, double> req_channels;      // busy ns per request channel ("shared" or "to <target>")
    std::map<std::string, double> resp_channels;     // busy ns per response channel ("shared" or "to <initiator>")
};

struct PerfMemStats {
    std::string name;
    uint64_t reads = 0, writes = 0, bytes = 0;
    uint64_t row_hits = 0, row_misses = 0, row_conflicts = 0, refreshes = 0;
    double data_busy_ns = 0;
    PerfSamples service; // arrival in the controller to the end of the data
};

class PERF_API PerfStats
{
public:
    static PerfStats& get();
    int add_gen(const std::string& name, const std::string& label);
    int add_bus(const std::string& name);
    int add_mem(const std::string& name);
    PerfGenStats& gen(int i) { return gens[i]; }
    PerfBusStats& bus(int i) { return buses[i]; }
    PerfMemStats& mem(int i) { return mems[i]; }
    void gen_done(int i); // all issued and answered
    bool all_done() const;
    /** The statistics as JSON; complete: every traffic_gen was done. */
    std::string json(bool complete);
    /** One line per initiator and memory, for the console. */
    std::string summary();

    // set by perf_stats
    std::string output;
    bool stop_when_done = true;
    bool written = false;
    void write_now(bool complete);

    std::vector<PerfGenStats> gens;
    std::vector<PerfBusStats> buses;
    std::vector<PerfMemStats> mems;
};

#endif
