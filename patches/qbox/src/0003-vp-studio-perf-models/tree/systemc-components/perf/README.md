# perf: architecture exploration models for VP Studio

Models for questions such as "is the DRAM bandwidth enough when the display,
a DMA and the CPUs run together", "what does round-robin against priority
arbitration do to the latency of each master", "how many transactions in
flight does a master need". They model time only and store no data. All
connections are TLM-2.0 approximately timed (nb_transport, base protocol).

Built with QBox (`gs_create_dymod`, `build/perf.so`). The four types are in
this one library, so platforms name it: `dylib_path = "perf"`.

| Type | Sockets | What it does |
|---|---|---|
| `traffic_gen` | `initiator_socket` | Issues reads and writes by a pattern or from a list, keeps at most `max_outstanding` in flight, records the latency of each (issue to response). |
| `at_bus` | `target_socket` (initiators), `initiator_socket` (targets, with `address` and `size` like on QBox's router) | Arbitration, a request channel (one cycle for the address plus the write data), a response channel (one cycle plus the read data), `latency_cycles` in each direction, `target_queue` requests held per target. |
| `dram_ctrl` | `target_socket` | Queue, banks with open rows, tRCD/tCL/tRP, refresh, one data bus, FCFS or FR-FCFS. |
| `perf_stats` | none | Writes the statistics (JSON) when every `traffic_gen` is done and stops the simulation (`stop_when_done`). |

Parameters (all with defaults; the catalog and `--help` of the types list
them with their descriptions):

- `traffic_gen`: `address`, `size`, `pattern` (sequential, random, stride),
  `stride`, `read_ratio`, `burst_bytes`, `rate_mbps` (0: as fast as
  `max_outstanding` allows), `max_outstanding`, `count`, `start_ns`,
  `duration_ns`, `seed`, `qos`, `replay` (a file of
  `time_ns,R|W,address,length` lines), `label`.
- `at_bus`: `clock_mhz`, `data_bytes`, `latency_cycles`, `arbitration`
  (round_robin, priority, fcfs), `target_queue`, `masters` (QoS per master,
  below), `topology` (shared, crossbar), `input_queue`.
- `dram_ctrl`: `clock_mhz`, `data_bytes`, `burst_length`, `banks`,
  `row_bytes`, `tRCD`, `tCL`, `tRP` (cycles), `tRFC_ns`, `tREFI_ns`,
  `queue_depth`, `scheduler` (fr_fcfs, fcfs), `page_policy` (open, closed),
  `mapping` (row_bank_col, row_col_bank), `frontend_ns`, `age_limit_ns`,
  `qos` (schedule by the priority the at_bus in front gave each request).
  The defaults are roughly DDR4-3200 with a 64-bit bus.
- `perf_stats`: `output` (default `perf-stats.json`), `stop_when_done`.

## Shared bus or crossbar, and buses behind buses (perf 1.2.0)

`topology` "shared" (the default) has one request channel and one response
channel for everyone. "crossbar" has a request channel per target and a
response channel per initiator port: requests to different targets, and
responses to different initiators, move at the same time. A system bus in
front of two memory controllers is usually a crossbar.

An at_bus may be a target of another at_bus (a MAU behind a system bus).
Bind its `target_socket` to the system bus with an address and size, and
with `relative_addresses: false` when it decodes the same absolute
addresses (the default, as on QBox's router, passes addresses relative to
the window). QoS knows each master from the transaction, so a MAU behind
the system bus still sees display, cpu and dma apart. Give such a bus an
`input_queue` larger than 1 (16, say): each initiator port then holds that
many requests waiting for arbitration, so one master held back by its QoS
does not block the others that share the port. With 1, a port waits until
its request is granted (as before).

With a crossbar the statistics report each channel's use under
`channels.request` ("to <target>") and `channels.response` ("to
<initiator>"); `requestUtilization` and `responseUtilization` are the
busiest channel's.

## QoS per master (at_bus `masters`, perf 1.1.0)

An at_bus in front of a dram_ctrl stands for a memory controller's front end
(a MAU): it can treat each master differently. `masters` lists the settings,
by the traffic_gen's module name or label:

    display: priority=3 min_mbps=6000; cpu: max_mbps=8000 outstanding=8

- `priority`: replaces the traffic_gen's `qos` on this bus, for
  `arbitration` "priority" (higher wins).
- `max_mbps`: a bandwidth limit. A token bucket of `max_mbps` x `window_ns`
  bytes (at least one access); a request waits until it holds its size.
- `min_mbps`: reserved bandwidth. A credit of `min_mbps` x `window_ns` bytes
  fills at `min_mbps`; while it covers a request, the request is urgent and
  goes before everyone else's.
- `outstanding`: the most accesses of the master in flight through the bus.
- `window_ns`: the averaging window of the two rates (default 1000).

Urgent requests go first at every stage of the bus: arbitration, the queue
to the target (they pass the requests granted before them) and the response
channel. With `arbitration` "priority", higher priority goes first at those
stages too; otherwise the order is that of arrival. The bus stamps the
priority and urgency it used on the transaction (`PerfTag::prio`, `urgent`),
and a dram_ctrl with `qos` true schedules the most important class first:
FR-FCFS then works within it, the age limit applies to its oldest request,
and a request waiting for a free place in a full queue is taken by class.
An unknown key or a malformed entry stops the simulation; VP Studio's checks
report the same errors before a run, and masters that match no traffic_gen
bound to the bus.

The DRAM issues a command only when the data bus is free for its data about
when the data comes out (within one burst). A controller that committed
commands far ahead would leave nothing in its queue for the scheduler (and
QoS) to choose from when the data bus is saturated.

The statistics file (`"format": "vp-perf-stats"`, version 1) has, for each
initiator, the accesses, the failed ones (`errors`, `firstError`: answered
with an error, such as an address no target decodes; they are left out of
the reads, writes, bytes and latency, and VP Studio fails the run), bytes,
bandwidth and latency (mean, min, p50, p90,
p99, max and a histogram), for each bus the busy time of each channel and
the arbitration wait of each initiator and, per master, the bytes, grants,
urgent grants (within `min_mbps`), grants held by `max_mbps` and the time
they waited, the response channel wait and the QoS settings (`masters`),
for each memory the row hits,
misses and conflicts, refreshes, data bus use, bandwidth and service time.

Limits: the results are as good as the parameters; calibrate the DRAM with
its datasheet and the bus with its specification or RTL. The DRAM model
leaves out power states, ranks and channels, write-to-read turnarounds and
tRAS/tFAW. Generators do not react to latency except through
`max_outstanding`. `at_bus` takes nb_transport initiators only, so QEMU CPUs
(b_transport) cannot be bound to it.
