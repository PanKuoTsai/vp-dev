# sim-agent

A SystemC module that lets VP Studio control a running QBox simulation:
read the simulated time, pause, continue, and list, read or set CCI parameters.
It speaks JSON-RPC 2.0 over TCP.

The agent is an out-of-tree QBox module library. The module factory loads it
through `dylib_path`, so QBox is not modified.

## Build

```sh
tools/sim-agent/build.sh <qbox>/build          # writes tools/sim-agent/sim_agent.so
```

`build.sh` copies the compiler flags and link line of QBox's own `keep_alive`
module library, so QBox must be built first. The library must be rebuilt
whenever the pinned QBox commit changes (same ABI as the simulator that
loads it). Takes about 10 seconds.

The RapidJSON headers come with SystemC CCI. `build.sh` takes CCI's location
from `build/CMakeCache.txt` (`SystemCCCI_SOURCE_DIR`), so it also works when
QBox keeps its dependencies in a CPM source cache (`CPM_SOURCE_CACHE`, for
example `<qbox>/packages`) instead of `build/_deps`; as a last resort it
searches that cache. Set `VP_RAPIDJSON_INCLUDE` to the directory that holds
`rapidjson/rapidjson.h` to override the search.

## Use

VP Studio adds the agent to every simulation it starts (setting
`vpStudio.simAgent.library`). It picks a free port and connects
automatically. To add it by hand, put this after the platform table:

```lua
platform["sim_agent"] = {
    moduletype = "sim_agent";
    dylib_path = "/abs/path/to/tools/sim-agent/sim_agent";  -- ".so" is appended
    port = 51000;          -- 0 picks a free port
    host = "127.0.0.1";    -- default; only local connections
    buses = 1;             -- bus_N initiator sockets for mem.read / mem.write (0.6.0)
    bus_0 = {bind = "&router.target_socket"};
};
```

VP Studio gives the agent one `bus_N` socket per router of the platform, in
the order the platform lists them.

At start of simulation it prints `sim-agent: listening on HOST:PORT` to
stdout. If it cannot listen, it prints a message to stderr and the simulation
runs without it. Then use **VP Studio: Connect to Sim Agent…**.

## Protocol

Each message is one line of JSON (UTF-8, ending with `\n`), following
JSON-RPC 2.0. `params` must be an object, or left out. Several clients may be
connected at once.

| Method | Params | Result |
|---|---|---|
| `agent.getInfo` | | `{name, version, protocol, module, systemc, qemuInstances, buses, checkpoints, methods}`. `protocol` is 1. `checkpoints` (0.10.0): whether this QBox's libqemu saves device state (see Checkpoints). |
| `sim.getStatus` | | Status (below) |
| `sim.pause` | | Status. Pausing twice is harmless. |
| `sim.continue` | | Status |
| `sim.runFor` | `duration` | Status. Runs (continuing if paused) and pauses by itself after `duration` of simulated time. 0.4.0 and later. |
| `sim.runUntil` | `time` | Status. Same, but pauses at the absolute simulated `time`. 0.4.0 and later. |
| `cci.listParams` | `prefix?`, `includeInternal?` | `{params: [Param]}`. Names starting with `__` (factory entries) are left out unless `includeInternal` is true. |
| `cci.getParam` | `name` | Param |
| `cci.setParam` | `name`, and `value` (any JSON) or `valueJson` (JSON text) | Param, after the write |
| `trace.getStatus` | | `{enabled, points, probes, count, lastSeq, dropped, capacity}`. `probes` (0.9.0): `[{name, kind, recording}]`, kind `bus`, `memory` or `signal` |
| `trace.setEnabled` | `enabled` | Same as `trace.getStatus`. Pauses or resumes recording at every probe; which probes are on stays. |
| `trace.setPoints` | `points?` (probe names; none: every probe), `recording` | Same as `trace.getStatus`. Turns recording at those probes on or off. 0.9.0 and later. |
| `trace.clear` | | Same as `trace.getStatus`. Sequence numbers keep counting. |
| `trace.read` | `since?` (default 0), `max?` (default 2000, at most 20000) | `{records, points, lastSeq, dropped}`: records with `seq` > `since`, oldest first |
| `break.set` | `breakpoints`: array of Breakpoint | `{breakpoints, points}`. Replaces the whole list. 0.5.0 and later. |
| `break.list` | | Same as `break.set` |
| `break.clear` | | Same as `break.set`, with no breakpoints |
| `mem.read` | `address`, `size?` (1 to 4096, default 4), `bus?` (default 0), `width?` | `{address, data, length, via}`. `data` is hex in memory order. 0.6.0 and later. `width` (0.15.0; 1, 2, 4 or 8): split into accesses of that many bytes, for register blocks (QEMU's GIC answers 4 and 8 byte accesses only; one access of the whole size reads zeros). `mem.write` takes it too. |
| `profile.getStatus` | | `{active, problem?, enabled, period, seconds, cpus: [{cpu, samples}]}`. 0.8.0 and later. |
| `profile.read` | `cpu?` | Same, plus `blocks: [[address, samples]]`, most samples first, of one CPU or all |
| `profile.setEnabled` | `enabled` | Same as `profile.getStatus`. Off keeps the samples. |
| `profile.reset` | | Same; drops the samples and starts the interval (`seconds`) again |
| `mem.write` | `address`, `data` (hex in memory order, 1 to 4096 bytes), `bus?` | Same as `mem.read` |
| `ftrace.getStatus` | | `{active, problem?, enabled, space, capacity, seconds, cpus: [{cpu, events, stored}]}`. 0.11.0 and later; `active` needs `ftrace = true` at start. |
| `ftrace.setEnabled` | `enabled`, `space?` (`"all"`, `"kernel"`, `"user"`) | Same as `ftrace.getStatus`. Starts or stops recording; keeps the records. |
| `ftrace.clear` | | Same; drops the records and starts the time (`seconds`, record times) again |
| `ftrace.save` | `path` (absolute, on the simulator's machine) | `{path, cpus, events}`. Writes the records, see Function trace. |
| `ftrace.tail` | `cpu`, `count?` (1 to 4096, default 64) | `{cpu, total, enabled, records: [[from \| kind, to, ns, insns]]}`: the newest records of one vCPU, oldest first; addresses as hex strings (kind in the low 2 bits: 1 call, 2 return). 0.16.0 and later. The Exceptions panel shows them for the CPU a catch stopped. |
| `exc.getStatus` | | `{active, problem?, recording, capacity, total, hits, counts: [{kind, ec?, count}], rules, hit?}`. 0.15.0 and later; `active` needs `exceptions = true` at start. |
| `exc.read` | `after?` (sequence number, default 0), `max?` (default 2000, at most 10000) | `{events, last, dropped}`: Events with `seq` > `after`, oldest first |
| `exc.setRecording` | `recording` | Same as `exc.getStatus`. Off keeps the events; catching still works. |
| `exc.clear` | | Same; drops the events and counts, numbering starts again at 1 |
| `exc.setCatch` | `rules`: `[{kind?, ec?, fromEl?}]` | Same. Replaces the rules; see Exceptions and interrupts. |
| `ckpt.save` | `dir`, `memories?`: `[{name, address, size, bus?}]`, `registers?`: `[{name, address, size?, bus?}]` | `{agent, time, devices, memories, registers}`, also written to `dir/agent.json`. Needs the simulation paused (or halted by a debugger). 0.10.0 and later. |

Status: `{state: "running" | "paused" | "halted" | "ended", time: {seconds, text}, deltaCycles, stopAt?, reason?, requestedTime?}`.
- `exceptionHit` (0.15.0, an Event of Exceptions and interrupts) is there while a catch rule keeps the simulation paused; `reason` is then `"exception"`.
- `stopAt` (`{seconds, text}`) is there while a timed stop is pending.
- `reason` is `"time"` in the notification sent when a timed stop pauses the
  simulation; `requestedTime` is then the time that was asked for, and `time`
  is where it actually stopped (see "Timed stops" below).
`halted` means a debugger (gdb on a CPU's `gdb_port`) has stopped the VM; see
"Debugger halts" below.
`text` is SystemC's own form, for example `"19090650666 ns"`.

Param: `{name, type, category, value, isDefault, isPreset, description}`.
- `type` is the C++ type (`uint32_t`, `string`, `bool`, …).
- `category` is the CCI data category (`bool`, `integer`, `real`, `string`, `list`, `other`).
- `value` is the parameter's `cci_value` as JSON. It is `null` when the type has no converter.
- `isPreset` means the configuration (Lua) set the value.
- `locked` means the parameter's owner has locked it.
- `mutability` is `mutable`, `immutable` (can only be preset before the simulation) or `other`.

`cci.setParam` converts the value with the parameter's own `cci_value`
converter. Use `valueJson` for integers above 2^53, which a JSON number in
`value` would round. Run-time writes have limits:
- **Pre-write callbacks.** A parameter's owner can refuse a value.
- **When it takes effect.** CCI does not say when a model reads a parameter.
  Many QBox models read theirs only at construction, so a write is accepted
  but has no effect until the next start. Models that react at once register
  a post-write callback, for example `memory_dumper`'s `dump`.

Each trace record is a compact array:
`[seq, time_s, point, "R" | "W", address, length, data_hex, status, initiator]`.
- `point` indexes `points`, the labels of the tracers.
- `address` is absolute, as a hex string.
- `data_hex` holds the first 16 bytes of the access.
- `status` is the TLM response status (1 = OK, -2 = address error, and so on).
- `initiator` (0.12.0) is the port that issued the access, relative to the
  top container (`"cpu_3.mem"`, `"gpex_0.bus_master"`), or `""` when it is
  unknown (signals, an access that came through no router). Breakpoint hits
  carry it as `record.initiator`. Older agents send eight elements.

The store keeps the newest 100,000 records. `dropped` counts the older ones it
discarded.

Notification `sim.stateChanged` (params: Status) is sent to every client
whenever `sim.pause`, `sim.continue`, `sim.runFor` or `sim.runUntil` changes
the state, and when a timed stop pauses the simulation.

Errors use the JSON-RPC codes `-32700` (parse error), `-32600` (invalid
request), `-32601` (method not found) and `-32602` (invalid params), plus:
- `-32001`: no such parameter.
- `-32002`: the simulation has ended.
- `-32003`: the parameter is locked or immutable.
- `-32004`: the value was rejected. Either it does not convert to the
  parameter's type (`conversion from cci_value failed`), or a callback refused
  it.
- `-32005`: not possible now: a debugger has the target stopped (state
  `halted`), so `sim.runFor` and `sim.runUntil` are refused.

## Checkpoints (0.10.0)

`ckpt.save` writes into `dir`:
- `devices.qemu`: the state of QEMU's CPUs and devices, from QEMU's
  `qmp_xen_save_devices_state` (device state only, no RAM). The agent finds
  it in libqemu with `dladdr` and `dlsym` and calls it with the BQL held.
- `mem-<name>.bin`: each memory in `memories`, as a sparse file (pages of
  zeros are holes). It is read through DMI on the agent's bus socket, or
  through debug accesses when the memory gives no DMI. QBox's RAM is SystemC
  memory (`gs_memory`) that QEMU only maps, so QEMU's own state never holds it.
- `agent.json`: the time, the memories and the values of `registers`. These
  registers are of SystemC peripherals with no other way in (QBox's `Pl011`);
  they are read through the bus.

The parameter `restore_from` names such a folder. The agent then loads it
right after the simulation starts:
1. It pauses.
2. It loads the memories, then the QEMU state, then writes the registers back.
3. It runs on, or stays paused when `restore_paused` is true.

`sim.getStatus` then carries `restore: {dir, state, error?}`, with state
`pending`, `restored` or `failed`. A failed load leaves the simulation
paused: by then part of the state is loaded.

What makes it work:
- **libqemu must have VP Studio's patch.** Unpatched, libqemu does not register
  the state of its devices (`hw/core/qdev.c`, `CONFIG_LIBQEMU`), so only the
  CPUs and timers would be saved. A guest loaded from such a file hangs in WFI:
  the GIC is in its reset state. The patch
  (`patches/libqemu/0001-register-device-vmstate.patch`) exports
  `libqemu_device_vmstate`. Without that symbol `ckpt.save` and `restore_from`
  refuse, and `agent.getInfo` reports `checkpoints: false`.
- **Loading.** The stream has no configuration section, so the agent sets the
  migration property `send-configuration` to false before the load. It also
  registers the migration yank instance, which the end of the load removes.
- **Time.** The QEMU virtual clock comes back with the device state. SystemC
  time cannot go back, but it catches up by itself: QBox's CPUs keep their
  quantum keepers at "virtual clock - SystemC time", so SystemC jumps to the
  saved time. SystemC events that models had scheduled for later are not
  saved.

Disk images are not saved by the agent: VP Studio copies them (`lib/sim/checkpoint.js`).

Verified on 2026-11-16 with the Ubuntu AArch64 platform (8 CPUs, MTTCG):

| Step | Result |
|---|---|
| Save | device state 80 KB in 2 ms; RAM 1.27 GB of data out of 4 GiB in about 1.5 s; the 4 GB disk copied |
| Load into a new simulation | 2.3 to 2.5 s |
| Guest after the load | Goes on where it was: a background loop counts on, and files in RAM and on disk are there. Disk writes, the network and `poweroff` all work. |
| Again | The same checkpoint loads again. A checkpoint saved from a loaded simulation loads too. |

## Timed stops

`duration` and `time` are a string such as `"500 ms"`, `"1.5 s"` or
`"250us"` (units `s`, `ms`, `us`, `ns`, `ps`; a bare number in the string is
seconds), or a JSON number of seconds. A stop time that is not after the
current time is refused with `-32602`. Any pause, including `sim.pause`,
cancels a pending stop; `sim.continue` keeps it. Only one stop is pending at a
time, and a new `sim.runFor`/`sim.runUntil` replaces it.

The agent does not schedule an event at the stop time. An event of its own
would move time: when every vCPU sleeps (WFI) or the VM is being stopped,
nothing holds SystemC time back, so time jumps straight to the next event.
That happened with a first version: `runUntil 99999 s` followed by a pause
jumped to 99999 s at once. Instead, a `SC_PRE_TIMESTEP` stage callback looks
at the time SystemC is about to advance to. Once that reaches the stop time,
it wakes the server thread, which pauses exactly as `sim.pause` does: VM
first, then SystemC.

Two consequences:
- **Overshoot.** The pause lands at the first event at or after the stop time,
  plus what runs while the vCPUs acknowledge the stop. The notification
  reports both times.
- **Idle guests.** While the guest idles, SystemC time moves only as the CPUs
  wake up, and the run towards the stop moves with it. The status bar shows
  the same time, so the two agree.

Verified on 2026-11-15 (agent 0.4.0, Ubuntu platform, 8 CPUs, quantum 10 ms):
- **Accuracy.** 20 times `runFor 500 ms` from paused during boot: each took
  0.50 to 0.53 s of wall time, and overshot by 0.06 to 4.6 ms (mean 1.4 ms).
  250 us, 2 ms, 10 ms and 1 ms runs overshot by 1 to 3 ms.
- **No time jump.** With `runUntil` set 1000 s ahead and a pause 3 s of wall
  time later, time had moved 3.0 s.
- **Cancel and shutdown.** A manual pause cancels the pending stop. With a
  stop pending, SIGHUP still ends the simulator.

## Exceptions and interrupts (0.15.0)

With `exceptions = true` (and the same `libidlinker` plugin as the profiler)
the agent registers QEMU's discontinuity callback (QEMU 10 and later) for
interrupts and exceptions. It runs on the vCPU thread, with the BQL, right
after the vCPU has taken the exception and before the first instruction of the
handler: ESR, FAR, ELR and SPSR of the target EL already hold the new values
and the PC is the vector. Nothing is instrumented at translation, so it costs
only a callback per exception.

- An Event is `[seq, vtime_ns, cpu, type, vec, elFrom, elTo, fromPc, toPc,
  esr, far, elr, x8]`: `type` 1 interrupt, 2 exception (QEMU's); `vec` the vector
  slot, (PC − VBAR_ELx) / 0x80, 0 to 15, or 255 when the PC is not in the
  vector table (slots 0–3 current EL with SP_EL0, 4–7 current EL with SP_ELx,
  8–11 lower EL AArch64, 12–15 lower EL AArch32; within a group sync, IRQ, FIQ,
  SError); `elTo` from PSTATE, `elFrom` from SPSR (0 for AArch32);
  addresses and registers as hex strings. `vtime_ns` is QEMU's virtual clock.
  ESR and FAR mean something only for synchronous exceptions and SError.
- The newest `exceptions_buffer` events are kept (default 4096); `counts`
  covers every event since the last `exc.clear`, by kind and, for
  synchronous ones, exception class (ESR bits 31:26).
- Registers are read with `qemu_plugin_read_register`. QBox puts a
  forward-declaration-only `glib.h` first on the include path, so the agent
  mirrors glib's public `GArray`/`GByteArray` layouts and takes
  `g_byte_array_new` from the glib libqemu already loaded (`dlopen` with
  `RTLD_NOLOAD`).
- A rule matches by `kind` (`sync`, `irq`, `fiq`, `serror`, `any`), `ec`
  (synchronous only), `fromEl` and `syscalls` (numbers: only an SVC, EC 0x15,
  whose x8 is one of them; Linux passes the system call number in x8). Events
  have a 13th element, x8 for an SVC (0 otherwise). On the first match the callback halts that
  vCPU (libqemu's `cpu_halt`, so it stops on the vector) and wakes the server
  thread, which pauses the rest as `sim.pause` does; the status then has
  `reason: "exception"` and `exceptionHit` (an Event) until the simulation
  runs again.
- A debugger attached to the gdbstub sees the pause as a stop (SIGINT, on the
  thread it last continued, not necessarily the CPU that took the
  exception). If it continues the VM itself, the agent notices the virtual
  clock moving and continues too (reason `"resumed"`); this applies to every
  pause by the agent.
- Measured on the Ubuntu platform (8 CPUs, about 1,800 events a second during boot): boot to `login:` took 241 s and 252 s without recording, 276 s and 235 s with it; the difference is within the spread between runs. An interrupt costs four register reads (CPSR, VBAR, SPSR and nothing else), a synchronous exception six.


With `ftrace = true` (and the same `libidlinker` plugin as the profiler) the
agent records every call and return of the guest software, per vCPU:

- At translation, each AArch64 call (`BL`, `BLR`, `BLRAA`…) and return
  (`RET`, `RETAA`…) gets an inline store of "its address | kind" into a
  per-vCPU scoreboard slot: no call into the agent.
- Every block starts with a conditional callback that runs only when that
  slot is set. A branch ends its block, so the block that runs next is where
  the call or return went. The callback writes `{from | kind, to, host ns,
  instructions}` into the vCPU's ring and clears the slot.
- Every block also adds its instruction count to a per-vCPU counter, inline.
- The ring keeps the newest `ftrace_buffer` records per vCPU (default 262144,
  8 MiB). It is allocated when the vCPU records its first call.
- Recording is off at start: `ftrace.clear`, then `ftrace.setEnabled`.
  `space: "kernel"` keeps only branches from the upper half of the address
  space.

`ftrace.save` writes `VPFTRC01`, u32 version 1, u32 number of CPUs, and per
CPU: u32 cpu, u32 0, u64 records written, u64 records kept, then the kept
records (four u64 each), oldest first, little-endian. VP Studio's
`lib/analysis/ftrace.js` matches returns to calls by return address and writes a
Chrome trace file for Perfetto UI and a summary.

Limits:
- An exception taken right after a call shows as a call to the vector.
- Tail calls (a plain `B`) are not seen; a return then closes both frames.
- AArch32 code is not decoded (its words could look like A64 calls).
- Times are host time; instruction counts are exact.

Verified on 2026-11-17 (Ubuntu platform, 8 CPUs, recording 3 s of kernel
after `Run /init`):
- 1.18 million records on 8 CPUs; three busy CPUs filled their ring (they keep
  the newest 262144).
- With `vmlinux`, the KASLR offset `lib/analysis/ftrace.js` derives from the call
  targets alone was `0x498b99600000`, the same as `kimage_vaddr` gives.
- 588,000 slices, all properly nested per CPU; the hottest functions were
  `blake2s_compress` and `sha512_transform` (entropy and key setup at boot).
- Boot to `login:` took 302 s with the calls instrumented (recording only for
  3 s), against 221 to 234 s without.

## Sampling profiler

With `profile = true` the agent samples the program counter of each vCPU
through QEMU's plugin API. QBox's own McipsPlugin works the same way: the API
is libqemu's function table (`plugin_api()`). A plugin built as a separate
`.so` cannot be loaded, because libqemu is loaded with local symbols:
`libhotblocks.so` failed with `undefined symbol: qemu_plugin_bool_parse`.

The plugin id comes from QBox's `libidlinker` plugin, which writes it into a
CCI parameter. The launcher adds both:

```lua
platform["qemu_inst"]["qemu_args.-plugin"] = "libidlinker.so,key=platform.sim_agent.profile_id"
platform["sim_agent"] = { ...; profile = true; profile_period = 10000; plugin_qemu = "qemu_inst" }
```

The id is valid only in the QEMU instance the plugin is loaded into. With
several instances the agent must use that one: `plugin_qemu` (0.16.0) names it
(the instance's name in the platform; empty: the first instance found, which
before 0.16.0 could be another one, and registering callbacks there crashed the
simulator). Profiling, the function trace and exception recording cover the
CPUs of that instance only.

How samples are taken:
- Every translated block adds its instruction count to a per-vCPU scoreboard
  counter, inline, without a call.
- A conditional callback fires when the counter reaches `profile_period`,
  records the block's start address and sets the counter back to 0. A sample
  is therefore about `profile_period` instructions of that vCPU, counted for
  the block running then. Blocks rarely span two functions.
- Callbacks run on vCPU threads. The state is a leaked singleton and checks
  `alive`, because callbacks can come after the agent is destroyed.

Only the first QEMU instance is profiled. VP Studio maps addresses to
functions with an ELF symbol file (`lib/analysis/elfsym.js`, `lib/analysis/profile.js`). For an
arm64 Linux kernel it finds the KASLR offset by itself:
- It looks for the loaded image with the arm64 Image magic (`ARMd` at offset
  `0x38`), reading through `mem.read`.
- It reads `kimage_vaddr`, which the kernel relocates at boot to the address
  it runs at, and subtracts the linked `_text`.

Verified on 2026-11-16 (agent 0.8.0, Ubuntu platform, 8 CPUs):
- **Samples.** 470,000 samples in the first 40 s of boot, from all 8 CPUs.
- **KASLR.** The offset found was `0x498b99600000`. 98.4% of the kernel
  samples fell in a function of `vmlinux-5.15.0-203-generic`, against 1.5%
  without the offset.
- **Hottest functions.** `ZSTD_decompressSequences` (48%) and
  `HUF_decompress4X2_usingDTable_internal` (16%): the initrd being unpacked.
- **Controls.** One CPU can be read alone, and reset and sampling off work.
- **Cost.** Boot to `login:` took 256 s with profiling, against 227 to 233 s
  without: about 12% slower. 2.75 million samples were taken.

## Memory and register access

`mem.read` and `mem.write` make an access through the agent's `bus_N`
initiator socket, which is bound to a router. No simulated time passes, and the
VM does not have to be stopped. VP Studio's register view reads only while the
simulation is paused or halted.

The agent uses debug transport (`via: "debug"`). Some targets have none: QBox's
SystemC `Pl011` only has `b_transport`, and its debug transport leaves the
response incomplete. For those, the agent makes a normal `b_transport` with no
delay on the SystemC thread instead (`via: "b_transport"`).

Debug transport into a QEMU device is no safer than a normal access. QBox's
QEMU target implements it as a normal access, so reading a register still has
its side effect, for example reading the PL011 data register takes a received
character. The register descriptions mark such registers (`readSideEffect`).

The tracers ignore the agent's own accesses: they are not recorded and do not
hit breakpoints. An access the bus cannot complete is refused with `-32004`
and the TLM response (`TLM_ADDRESS_ERROR_RESPONSE` for an address nothing is
mapped at).

Verified on 2026-11-15 (agent 0.6.0, Ubuntu platform, paused at 25 s):
- **Reads.**
  - PL011 identification `0x11 0x10 0x14 0x00`, FR `0x90` (both FIFOs empty), through `b_transport`;
  - virtio magic `0x74726976`, version 1, device ID 2 (block);
  - GICD_CTLR `0x53`, TYPER `0x0378001e`, PIDR2 `0x3b` (GICv3);
  - the kernel's `MZ` header in RAM at `0x81200000`.
- **Writes.** Writing `Z` and a newline to the PL011 data register printed them
  on the console.
- **Time and errors.** Simulated time did not move. An unmapped address, a bus
  that does not exist and bad hex data were refused.

## Bus breakpoints

A breakpoint pauses the simulation when a traced access matches it. Only
accesses that go through a `vp_tracer` are seen, so the device must be traced
(Start Simulation with Tracing). Memories are traced with DMI allowed, so CPU
accesses through DMI are not seen there either.

Breakpoint (in `break.set`; numbers as JSON numbers or strings such as `"0x1000"`):
- `id`: optional; numbered from 1 when left out.
- `point`: a trace point label (`"pl011_uart_0.target_socket"`), or left out
  or `null` for any. An unknown label is refused with `-32001`.
- `from`, and `to` or `size`: the address range, inclusive. `from` alone is
  one address. Left out: any address. An access matches when it overlaps the
  range.
- `access`: `"r"`, `"w"` or `"rw"` (default).
- `value` and optional `mask` (default all ones): match only when
  `(data & mask) == (value & mask)`. Data is read as a little-endian number
  from the first 8 bytes of the access.

Breakpoints are checked whether or not recording is on (`trace.setEnabled`).
With recording off, the hit's `record.seq` is 0.

When one matches, the agent pauses the simulation exactly as `sim.pause`
does. The `sim.stateChanged` notification has `reason: "breakpoint"`. Until
the simulation runs again, every Status carries `breakpointHit`:
- `breakpoint`: the id that matched.
- `record`: `{seq, time, point, rw, address, length, data, status}`.
- `accessesAfter`: traced accesses the CPUs made between the hit and the pause.
- `matchesAfter`: how many of those matched a breakpoint too. They have
  happened, and they do not stop the simulation.

The pause is not exact. The access that matches may run on a vCPU thread, and
the VM can only be stopped from the server thread (see "How it works").
Stopping a vCPU from inside the access would need QEMU's main loop, and when
the access runs on the SystemC thread it would deadlock. To stop on the exact
instruction, use a gdb watchpoint on the CPU instead.

Verified on 2026-11-15 (agent 0.5.0, Ubuntu platform, PL011 and virtio disk
traced):
- **Write to the PL011 data register.** A write breakpoint on `0x10000000`
  stopped on the first character the kernel printed (`[`).
- **Continue, 30 times.** Each continue stopped on a later character. The CPUs
  made 0 to 2 more accesses before each pause took hold (mean 0.67). 3 of the
  30 characters matched in that window and were not stopped on, which
  `matchesAfter` reported.
- **Value.** `value: 0x0a, mask: 0xff` stopped only on newlines, with
  recording off too.
- **Any point.** A read anywhere in the virtio window stopped on the first
  read of the magic value (`virt`).
- **Clear.** After `break.clear` the simulation ran without stopping, and no
  hit was left in the status.

## Names (2026-11-20)

The agent's source is `sim_agent.cc`, its library `sim_agent.so` (with
`sim_agent.json`) and its module type and instance `sim_agent`; builds
before 2026-11-20 are `vp_sim_agent.so` with type `vp_sim_agent`, which VP
Studio still finds and starts with the old type name. The probes VP Studio
adds are instances `trace_<module>_<port>` and `trace_sig_<source>_<port>`,
the debug port `debug_dap` (`vp_trace_…` and `vp_debug_dap` before). The
name in `agent.getInfo` and the prefix of its messages are `sim-agent`
(`vp-sim-agent` before); clients do not check it.

## Where the probes are (0.14.0)

The tracers (module types `tracer` and `signal_tracer`; `vp_tracer` and
`vp_signal_tracer` up to agent 0.13.0, the names the sections below use), the trace store (records, probe
switches, bus breakpoints) and the table of initiator names are a QBox
component since agent 0.14.0: `<qbox>/systemc-components/probes`, built
with QBox into `build/probes.so`. Platforms name the library with
`dylib_path = "probes"`. The agent links to that library (`NEEDED
probes.so`, found through the QBox build directory in its RUNPATH), so
both share one store: QBox loads libraries with RTLD_LOCAL, so the
singletons (`TraceStore::get`, `InitiatorNames::get`, `agent_access`) are
defined only in probes.so. They come to a QBox through VP Studio's patch
`patches/qbox/0002-vp-studio-probes-debug-dap.patch` (applied by
`tools/qbox-pin/build-qbox.sh` and Build QBox). `build.sh` stops with a
message when the QBox has no probes component. Agents up to 0.13.0 carried the tracers themselves;
VP Studio picks the library by the agent's version.

## Signal tracing (vp_signal_tracer)

The library also registers `vp_signal_tracer` (0.7.0), for signal
connections such as interrupt lines. It has a `TargetSignalSocket<bool> in`
and an `InitiatorSignalSocket<bool> out`. The source's output binds to `in`,
and `out` binds to the destination's input. The launcher rewires the end that
declares the binding, and leaves the platform JSON unchanged.

Every write is passed on unchanged. Each change of level is a record in the
same store as the bus accesses: `"S"` in `trace.read`, with `data` `"01"` or
`"00"` and the simulated time of the write. The first write is always
recorded. Breakpoints never match signal records.

Connections between two QEMU sockets (`QemuInitiatorSignalSocket` to
`QemuTargetSignalSocket`) are not offered. QBox sets such a GPIO inside QEMU
directly. With a SystemC module in between, every change goes through the
SystemC thread with the BQL released. On the GIC's lines to the CPUs
(`gic_0.irq_out_N` to `cpu_N.irq_in`) Linux then did not boot at all (no
output in 60 s). The timer lines still booted, but their timing changed. On
the Ubuntu platform that leaves `pl011_uart_0.irq`, the line of a SystemC
model. Models made with the modeling wizard are SystemC models too.

Verified on 2026-11-15 (agent 0.7.0, Ubuntu platform, PL011 bus and
interrupt traced):
- **Boot.** The platform booted to `login:` in 229 s.
- **A key typed on the console.** The interrupt went high. The driver then
  read MIS (`0x30`), wrote ICR, read FR, and read `0x78` (`x`) from the data
  register, and the interrupt went low.
- **Timestamps.** They come from the thread that made the change, so a
  change can carry a time slightly earlier than an access recorded just
  before it. The VCD export sorts by time.

## Probes everywhere, switched while running (0.9.0)

A tracer that does not record is a probe in waiting. With agent 0.9.0 VP
Studio puts one at every place a probe fits when a simulation starts:
- every bus-mapped port that `vp_tracer` can take (not replicated, no `{i}`
  or `repeat`);
- every signal `vp_signal_tracer` can take (not QEMU to QEMU).

Each one is started with `record = false`, except those chosen in "Start
Simulation with Tracing". `trace.setPoints` turns recording on and off by
probe name, at once, without a restart.

What a probe that does not record costs:
- **Bus probe.** One more forward per access. It still refuses DMI and
  removes the QEMU region hint, so the device is always accessed through
  SystemC: that hint cannot be taken back once QEMU has mapped the region.
- **Memory probe.** Nothing beyond the forward: it lets DMI through. When it
  starts recording, it refuses DMI from then on and invalidates the pointers
  already handed out, through the router (QEMU CPUs drop them at their next
  safe point). CPU accesses to the memory then go through the probe. When it
  stops, DMI is allowed again.
- **Signal probe.** One more callback per change. It follows the level while
  not recording, so the first change recorded after turning it on is a real
  change.

Bus breakpoints are checked at every probe, recording or not. A memory probe
that does not record lets DMI through, so a breakpoint on it misses CPU
accesses; turn the probe on first.

Verified on 2026-11-16 with the Ubuntu AArch64 platform (8 CPUs):
- **Probes.** 12 in total: 9 bus, 2 memory (`ram_0`, `fallback_0`) and the
  PL011 interrupt.
- **Cost.** Boot to `login:` took 221 s with all 12 in place and none
  recording, and 234 s without probes: within the run-to-run spread.
- **Switching.** After login, turning the PL011 and its interrupt on and
  typing a key gave 10 accesses and 2 signal changes. Turning `ram_0` on
  showed CPU accesses to RAM straight away (20,000 in 3 s, the read limit).
  Turning everything off stopped the records at once: the sequence number
  stayed the same 6 s later.

## Transaction tracing (vp_tracer)

The same library registers a second module type, `vp_tracer`. It is a
pass-through placed between a bus and one target socket of a device.

The launcher wires it in when it generates the Lua:
- The tracer's `target_socket` takes the device port's address, size and bus
  binding.
- The device port is rebound to the tracer's `initiator_socket`. It keeps
  its address and size, because some modules read them: `gs_memory` takes its
  size from `target_socket.size`.

The platform description does not change.

What the tracer does with each kind of access:
- **`b_transport`**: forwarded, and recorded after it completes. The address
  is the offset the bus passed on plus the tracer's base, so the record shows
  the absolute address.
- **Debug transport and DMI**: passed through, not recorded.

Parameters:
- `label`: the name the records carry.
- `allow_dmi` (default false): when false, the tracer refuses DMI and removes
  QBox's `QemuMrHintTlmExtension` from responses. When true, it does so only
  while it records.
- `record` (default true, 0.9.0): whether it records from the start.
- `router` (0.12.0): the router in front of the tracer, as the platform names
  it (`"router"`, `"periph.bus"`). Empty: the only router of the platform.

How the initiator is found (0.12.0): every QBox router stamps a transaction
with the index of the `target_socket` binding it came in on
(`gs::PathIDExtension`, one entry per router, outermost first). The index is
the order in which initiators were bound to that socket. At
`start_of_simulation` the agent reads each router's binders
(`tlm_utils::multi_target_base_if::get_binders()`, then `get_other_side()`)
into an index-to-port table. `trace.read` resolves a record's stamps against
it, starting from the tracer's router; a stamp that leads to another router's
`initiator_socket` continues with that router's stamp. The access path only
copies the stamps. Verified on the Ubuntu platform (2026-11-19): every one of
48,020 records named a CPU, and on the GICv3 redistributor `cpu_n` used frame n.

Why the hint has to go: a QEMU CPU that sees this hint maps the QEMU device's
memory region straight into its own address space. After the first access,
every access would then bypass SystemC and the trace. With the hint removed,
the virtio-mmio devices showed their whole probe sequence instead of one read.
Memories are traced with `allow_dmi` on, because without DMI every CPU access
to them would go through the bus.

Verified on 2026-11-15 with the Ubuntu AArch64 platform, tracing the PL011
and both virtio-mmio devices during boot:
- **Records.** About 30,000 accesses in 45 s of simulated time. They include
  the PL011 PrimeCell ID reads (0x11, 0x10, 0x14) and the virtio magic,
  version and device ID.
- **Boot.** Unaffected.

## OpenOCD debug port (debug_dap)

Since agent 0.14.0 the debug port is a QBox component, module type `debug_dap` (`vp_debug_dap` before):
`<qbox>/systemc-components/debug_dap`, built into `build/debug_dap.so` (its README describes it). It does
not depend on the agent. Agent 0.13.0 carried it in its library (then `vp_sim_agent.so`).

## Debugger halts

When gdb stops the target, QEMU stops the VM: every vCPU pauses and the QEMU
virtual clock freezes. On the Ubuntu platform SystemC time then stops too,
because nothing else schedules timed events. A platform with SystemC models
of its own keeps simulated time running, though. With QBox's
`realtimelimiter`, for example, it went from 22.7 s to 25.7 s during a 3 s
halt. Timers then fire in the models while the software under debug is
frozen.

How the agent handles it:
- **Detection.** The agent's server thread reads the virtual clock every 50 ms
  (QBox reads it without the BQL too). The clock advances whenever the VM
  runs, idle CPUs included. If it stands still for 150 ms while no client has
  paused, the agent reports `halted`.
- **While halted.** The agent suspends SystemC, so time stops, and notifies
  the clients.
- **Resume.** When the clock moves again, the agent resumes SystemC.
- **Start-up.** Detection only starts after the clock has been seen moving
  once, so start-up never looks like a halt.
- **When it is off.** In icount mode, where an idle VM freezes the clock
  too, and when the agent parameter `watch_debugger` is false.

`sim.pause` and `sim.continue` during a halt leave the VM to the debugger.
Pausing does not stop it again, and continuing does not restart it.

Verified on 2026-11-15 with the Ubuntu platform, with and without a
`realtimelimiter`:
- **During a gdb halt.** Time stayed frozen, and the agent reported `halted`
  even across a pause and continue.
- **After detach.** Time advanced at 2 s per 2 s.
- **No false alarms.** Booting for 228 s and sitting idle at `login:` for
  20 s never reported `halted`.

## How it works

- A server thread owns the sockets. Each request that touches the simulation
  is run as a job on an `SC_THREAD` of the agent, woken by an async event
  that is not attached as suspending. The agent therefore never keeps a
  simulation alive. This is the same pattern as `gs::runonsysc`. The agent
  has its own copy so that it can catch every exception (a throwing job
  disables `runonsysc` for good) and can let go of jobs at shutdown.
- Pausing stops two things: the QEMU VM (`vm_stop` with `RUN_STATE_PAUSED`,
  for every `QemuInstance`, under the BQL) and SystemC time
  (`sc_suspend_all`).
  - **Why `sc_suspend_all` alone is not enough.** QBox's `monitor` only does
    that. It freezes time, but in MTTCG mode a vCPU woken by an interrupt
    restarts its quantum keeper. That gives it up to two quanta of new run
    budget ahead of the frozen time, so a guest at a login prompt still
    echoes keys and answers.
  - **Order matters.** The VM is stopped first, from the agent's server
    thread, while SystemC can still advance. A vCPU waiting for run budget
    can then reach the stop point. After that, SystemC is suspended.
    Continue does the reverse.
  - **Why this does not deadlock in QBox's run loop.** libqemu's
    `cpu_can_run` returns true while a stop is pending, so the vCPU goes
    back to QEMU's loop and acknowledges it. It returns false while the vCPU
    is stopped, so the vCPU sleeps in QBox's `wait_for_work`.
  - While paused, the simulator uses no host CPU.
  - Jobs still run while SystemC is suspended, because each one runs inside
    `sc_unsuspendable()`.
  - A client that disconnects leaves the simulation paused. Reconnect and
    continue.
- JSON is parsed with the RapidJSON headers that come with CCI, placed in a
  private namespace. CCI conversions run with `SC_ERROR` set to throw, so a
  bad value cannot abort the simulator.

Verified on 2026-11-14 with the Ubuntu AArch64 platform (8 cores, MTTCG):
- **Paused at the login prompt.** Keys typed while paused got no echo. On
  continue, `root` and `Password:` appeared. The simulated time stayed
  frozen, and host CPU use dropped from 17% to 0%.
- **Paused during boot.** Over 40 random pause/continue cycles, time and
  output were frozen in all 40. No call took more than 0.01 s, and the boot
  went on to systemd.
- **Stopped while paused.** SIGHUP still ends the simulator at once.
- **Parameters.** `cci.listParams` returned 135 parameters.

Verified on 2026-11-15 (agent 0.3.0), with `cci.setParam` on a running
Ubuntu platform:
- **Writes.** Integer writes with `value` and with `valueJson` succeeded. A
  write equal to the default reads back with `isDefault` true.
- **Rejections.** These were rejected with `-32004`: a string for a
  `uint32_t`, a negative value, a value beyond 32 bits, and malformed JSON.
- **Other errors.** An unknown name gave `-32001`. Writes to the four locked
  `qemu_inst` parameters (`tcg_mode`, `icount`, and others) gave `-32003`.
- **Lock count.** None of the 136 parameters is immutable; four are locked.

Only MTTCG (`tcg_mode = "MULTI"`) has been tested. `SINGLE` and `COROUTINE`
have not.
