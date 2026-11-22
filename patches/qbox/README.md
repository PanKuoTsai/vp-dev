# QBox patches

These patches are applied on top of the QBox commit pinned in
[`qbox.pin.json`](../../qbox.pin.json), in the order listed there.
`tools/qbox-pin/build-qbox.sh` applies them, and the container image is built
the same way.

0001 is also reported upstream (drafts in [`UPSTREAM.md`](UPSTREAM.md)). When
the pinned commit moves to a QBox that contains a fix, remove the patch from
`qbox.pin.json` and delete the file. 0002 and 0003 are VP Studio's own
components and stay patches.

## Changing 0002 or 0003

These two add whole components, so they are kept as source in
[`src/`](src), one folder for each patch:

| In `src/<patch>/` | What |
|---|---|
| `tree/` | The files the patch adds, at their path in QBox (`tree/systemc-components/perf/src/perf.cc`). Edit these. |
| `changes.diff` | The patch's changes to files QBox already has (two lines of `systemc-components/CMakeLists.txt`). |
| `message.txt` | The head of the patch: From, Subject and the description. |

The `.patch` file is made from them and committed with them:

```sh
node patches/make-patches.js           # write 0002 and 0003
node patches/make-patches.js --check   # only say whether they are up to date
```

A changed patch does not strand the QBox trees that have the earlier version:
`build-qbox.sh` sees that a patch is partly there and brings the files that
differ up to date (`tools/qbox-pin/apply-patch.sh`). Until then `VP Studio:
Check QBox Version` reports that patch as not applied.

`build-qbox.sh` and `qbox.pin.json` use the `.patch` files as before; nothing
reads `src/` when QBox is built. `npm test` fails when a patch is not what its
source gives (`test/patches.test.js`). 0001 has no source folder: it changes
QBox's own code and is edited as a patch.

| Patch | Fixes | Status |
|---|---|---|
| `0001-mttcg-register-woken-cpu.patch` | Multi-CPU MTTCG platforms sometimes end right after `SC_START` with no output (VP Studio known issue K-01). | Verified 2026-11-15 (boots and QBox's 415 tests), see below. Draft report ready, not yet sent. |
| `0002-vp-studio-probes-debug-dap.patch` | Adds VP Studio's SystemC components: `systemc-components/probes` (`build/probes.so`: types `tracer`, `signal_tracer` and the trace store the sim agent links to) and `systemc-components/debug_dap` (`build/debug_dap.so`: type `debug_dap`, the OpenOCD port). Required: the sim agent does not build without it. | New files plus two lines in `systemc-components/CMakeLists.txt`. Not for upstream. |
| `0003-vp-studio-perf-models.patch` | Adds `systemc-components/perf` (`build/perf.so`: types `traffic_gen`, `at_bus`, `dram_ctrl`, `perf_stats`; perf 1.1.0 with QoS per master), VP Studio's architecture exploration models (Run Performance Experiment, vp-run --perf). Applies after 0002. | New files plus two lines in `systemc-components/CMakeLists.txt`. Not for upstream. |

## 0001: register a woken MTTCG CPU's quantum keeper from the waker

**Problem.** In MTTCG mode, a CPU that sleeps (WFI) stops its quantum keeper,
and so detaches its suspending channel from SystemC. When another CPU woke it,
the quantum keeper restarted only once the woken vCPU thread ran again.

Linux's `stop_machine` (at "alternatives: patching kernel code") sends an IPI
and then puts the sender to sleep at once. In the window before the woken CPU
re-registered, SystemC saw no timed event, no suspending channel and no pending
async update, and it ended the simulation by starvation. The wake-up itself
was not lost.

**Fix** (`qemu-components/common/include/cpu.h`, MTTCG only):
- `set_signaled()`, under `m_signaled_lock`: if the CPU stopped its quantum
  keeper to sleep, restart it before signalling.
- `wait_for_work()`: stop the quantum keeper under the same lock, and only when
  no wake-up is pending.

A wake-up then comes either before the stop, and the quantum keeper keeps
running, or after it, and the waker restarts it.

Other paths are unchanged:
- Kicks to a CPU that is running do nothing more than before.
- Single-threaded TCG and coroutine mode are unchanged.

**Workaround it replaces.** The `keep_alive` module, which every multi-CPU MTTCG
platform needed. Platforms may keep `keep_alive`; it does no harm.

**Verified on 2026-11-15** (QBox adfde798, aarch64 build). The Ubuntu AArch64
platform, without `keep_alive`, CPUs starting powered off. A run passes when
the kernel reaches `Run /init`.

| CPUs | Without the patch | With the patch |
|---|---|---|
| 8 | 1/6 (the 5 failures: no kernel output, end after 11–15 s) | 10/10 |
| 2 | 5/6 (the failure: no kernel output, end after 6 s) | 10/10 |

With the patch and 8 CPUs, the full boot reaches `login:` (175 s). QBox's own
test suite (`ctest -j2`): 415 of 415 passed.

To reproduce: generate the Ubuntu platform with `ARM_NUM_CPUS` 2 or 8 and
without `keep_alive_0`, then boot it a few times.

## 0002: VP Studio's probes and debug_dap

VP Studio's own SystemC models, kept as QBox components so they are built
with QBox (`gs_create_dymod`), like its other components:

- `systemc-components/probes`: `include/probes.h`, `src/probes.cc`. Module
  types `tracer` and `signal_tracer`, the trace store and the initiator-name
  table. The sim agent links to `build/probes.so`. The shared singletons are
  defined in `probes.cc`: QBox loads module libraries with `RTLD_LOCAL`, so
  inline ones would be duplicated per library.
- `systemc-components/debug_dap`: `include/debug_dap.h`,
  `src/debug_dap.cc`. Module type `debug_dap` (remote_bitbang JTAG, ADIv5
  DP, MEM-AP and APB-AP, external debug registers and CTIs).

The source of truth is the user's development QBox. After changing these
components there, regenerate the patch against the pinned commit, without
touching that QBox's git index:

```sh
cd <qbox>
export GIT_INDEX_FILE=$(mktemp -u)
git read-tree HEAD
git add systemc-components/CMakeLists.txt systemc-components/probes systemc-components/debug_dap
git diff --cached HEAD    # the body of the patch, after its From/Subject header
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```

The CMakeLists.txt part of 0002 must not have the perf line: take the lines
for probes and debug_dap only (or regenerate 0003 too, below).

## 0003: VP Studio's perf models

`systemc-components/perf` (`include/perf.h`, `src/perf.cc`, `README.md`):
traffic_gen, at_bus, dram_ctrl and perf_stats, in one library (`perf.so`;
platforms write `"dylib": "perf"`). The statistics singleton `PerfStats` is
defined in `perf.cc`. The README in the component describes the models and
their parameters.

Checked on 2026-11-21 against hand-computed values (DDR4-3200, 64-bit bus):
sequential reads with 64 in flight reach 25.5 GB/s of the 25.6 GB/s peak
(95% of it with refresh: tRFC/tREFI is 4.5%); one access at a time costs
23.25 ns for an open row, 50.75 ns for a row conflict (tRP + tRCD more) and
37 ns at the least with closed pages (tRCD more).

perf 1.1.0 (2026-11-21) adds QoS per master on at_bus (`masters`:
priority, max_mbps, min_mbps, outstanding, window_ns; urgent and
higher-priority requests go first in arbitration, the target queue and the
response channel), `qos` on dram_ctrl (schedule by the bus's class), and
per-master bus statistics. The DRAM now issues a command only when the data
bus is free for its data within one burst; before, it booked the data bus
far ahead when saturated, which left nothing for the scheduler to reorder.
The values above are unchanged with 1.1.0; the bundled examples move by at
most 3% (ddr-contention, ddr-2ch) and their checks fail in the same runs.

The patch applies after 0002 (its CMakeLists.txt part is against the file
with 0002's lines). Regenerate it from the user's QBox with a base tree that
has 0002 applied:

```sh
cd <qbox>
export GIT_INDEX_FILE=$(mktemp -u)
git read-tree HEAD
git apply --cached <vp-studio>/patches/qbox/0002-vp-studio-probes-debug-dap.patch
base=$(git write-tree)
git add systemc-components/CMakeLists.txt systemc-components/perf
git diff --cached $base   # the body of the patch, after its From/Subject header
rm -f "$GIT_INDEX_FILE"; unset GIT_INDEX_FILE
```
