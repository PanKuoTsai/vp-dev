# debug_dap: OpenOCD debug port for VP Studio

The `debug_dap` module (source in `include/debug_dap.h`) lets OpenOCD connect to the
simulation as it would to a board's JTAG port (G-13, first stage). OpenOCD
uses its `remote_bitbang` adapter: every byte on the TCP connection is a pin
change or a TDO read.

Behind the JTAG TAP (IR 4 bits, IDCODE `0x4BA00477`) is an ADIv5 JTAG-DP
(DPIDR `0x4BA01477`, DPv1) with two access ports:
- **AP0, AXI MEM-AP** (IDR `0x44770004`, 64-bit addresses): the `mem` socket,
  bound to the router the CPUs use. Accesses use the debug transport, or a
  zero-delay `b_transport` when the target has none, on the module's own
  SystemC thread (they also go through while the agent has paused the
  simulation). 8-, 16- and 32-bit accesses, single address increment; packed
  increment is reported as unsupported.
- **AP1, APB-AP** (IDR `0x44770002`): a debug bus inside the model. ROM table
  at `0x80000000`; core n's Armv8 external debug registers at
  `0x80010000 + n * 0x20000`, its CTI `0x10000` above that.

Halting: a CTI channel event (CTIAPPPULSE or CTIAPPSET), routed by CTIOUTEN0,
raises trigger out 0 (debug request). If EDSCR.HDE is set, the core halts:
the module writes `true` to `halt_n`, which is bound to the CPU's QBox `halt`
signal (QEMU's per-CPU stop, so interrupts do not wake it). EDSCR.STATUS
becomes `0x13` and EDPRSR.HALTED is set; trigger in 0 then raises the channels
in CTIINEN0 (cross-halt, through the gates of the other CTIs). Trigger out 1
(restart), with the debug request acknowledged by CTIINTACK, resumes it and
sets EDPRSR.SDR. The module only writes the signal when it changes: QBox
calls the CPU's halt callback on every write.

Parameters: `port` (TCP port, 0 for none), `host` (default `127.0.0.1`),
`cpus` (number of `halt_N` sockets), `midr` (shown in MIDR_EL1).

Not in this stage: instructions through EDITR (OpenOCD's `aarch64` target
reads core registers that way, so it cannot be used yet), halting step,
breakpoints and watchpoints (their registers only hold values), EDPCSR.
Resuming a core sets QEMU's `halted` to 0, so a core that was in WFI wakes up
(allowed), and a core the guest powered off must not be resumed.

VP Studio's `lib/debug/debugdap.js` adds the module to a platform and writes the OpenOCD
configuration (`vp.sys` and `vp.dbg` mem_ap targets, one CTI per core, and
the commands `vp_halt`, `vp_resume` and `vp_status`).

Built with QBox (`gs_create_dymod`, `build/debug_dap.so`). The module type is `debug_dap`, as the library, so QBox finds it by the type name (no `dylib_path`). Up to VP Studio's sim agent 0.13.0 the module was `vp_debug_dap`, in the agent's library.
