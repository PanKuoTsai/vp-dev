# debug_dap: OpenOCD debug port for VP Studio

The `debug_dap` module (source in `include/debug_dap.h`) lets OpenOCD connect to the
simulation as it would to a board's JTAG port (G-13). OpenOCD
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
raises trigger out 0 (debug request). If EDSCR.HDE is set, the core halts and
EDSCR.STATUS and EDPRSR.HALTED follow; trigger in 0 then raises the channels
in CTIINEN0 (cross-halt). CTIGATE gates channel events both ways, out of a CTI
to the cross-trigger matrix and into a CTI from it (OpenOCD closes the
stepping core's channel 1 while it restarts the others). Trigger out 1
(restart), with the debug request acknowledged by CTIINTACK, resumes the core
and sets EDPRSR.SDR.

## Core debug

When the model finds the QEMU instance of the cores (parameter `qemu`, its
SystemC name such as `platform.qemu_inst`, or the only instance), it works on
QEMU's CPUs directly (core n is QEMU's CPU n), with functions it looks up in
libqemu (`gdb_read_register`, `cpu_memory_rw_debug`, `cpu_single_step`,
`cpu_breakpoint_insert`, ...). OpenOCD's `aarch64` target then works:

- **Halt.** A halted core's thread waits in a QEMU work item with the BQL
  released ("parked"). QBox's CPU loop sets and clears QEMU's `soft_stopped`
  on every pass in MTTCG, and `vm_start` clears `cpu->stop`, so neither could
  hold a core. While parked, `soft_stopped` is set so that `vm_stop` (the sim
  agent's pause) sees the core as paused; the agent's pause and continue
  leave halted cores halted. The QBox `halt_N` sockets are not used.
- **EDITR.** Instructions are interpreted on the halted core: the DCC
  transfers (MSR/MRS DBGDTR_EL0, DBGDTRTX_EL0, DBGDTRRX_EL0), MRS/MSR of
  DLR_EL0, DSPSR_EL0, FPCR, FPSR, NZCV, DAIF, CurrentEL and the system
  registers QEMU's gdbstub lists (by name), MOV to and from SP, UMOV/INS of
  vector registers, LDR/STR (immediate, post-index) of 1, 2, 4 or 8 bytes,
  DCPS1-3 and DRPS (they move EDSCR.EL only), barriers, hints, and DC, IC,
  TLBI and AT (no-ops: QEMU models no caches; after AT, PAR_EL1 reads as a
  failed translation). Anything else sets EDSCR.ERR (cleared by EDRCR.CSE).
  System registers are read-only (QEMU's gdbstub writes none); writing the
  value they have is accepted, a different value is ignored with a message.
  Clearing SCTLR.M makes the core's memory accesses physical (through the
  `mem` socket), as OpenOCD expects for physical reads.
- **Memory access mode** (EDSCR.MA): reads of DBGDTRTX load the next word
  at X0 and writes of DBGDTRRX store one, X0 += 4.
- **Halting step** (EDECR.SS): the restart single-steps the core (QEMU's
  `cpu_single_step`, without interrupts or timers) and the restart request
  returns only when the step has ended, as on hardware (OpenOCD reads SDR and
  HALTED together, and that read clears SDR).
- **Breakpoints.** DBGBCR<n> with E set and an unlinked address match makes
  a QEMU breakpoint at DBGBVR<n> on that core. A software breakpoint (HLT #11
  written through the core, 4 bytes) becomes a QEMU breakpoint on every core
  instead of being written, and writing the address again (the original
  instruction) removes it. A breakpoint or a finished step stops the VM
  (RUN_STATE_DEBUG); the model halts the cores concerned (STATUS 0x07
  breakpoint, 0x2F HLT, 0x1B step), cross-halts through the CTIs and lets the
  VM run again. A stop it did not cause (QEMU's own gdbstub) is left alone, so
  do not use both debuggers at once. If no CPU sets `gdb_port`, the model
  starts QEMU's gdbstub state without a connection (QEMU needs it for these
  stops).

Not implemented: watchpoints, EDPCSR, vector catch, AArch32. Only MTTCG has
been tried. Without the QEMU instance (or with the functions missing), the
first stage's behaviour remains: halts go through the `halt_N` sockets (QBox's
`halt` signal, QEMU's per-CPU stop) and EDITR reports an error.

Parameters: `port` (TCP port, 0 for none), `host` (default `127.0.0.1`),
`cpus` (number of cores and `halt_N` sockets), `midr` (shown in MIDR_EL1),
`qemu` (the QEMU instance, for core debug).

VP Studio's `lib/debug/debugdap.js` adds the module to a platform and writes
the OpenOCD configuration (an `aarch64` target per core with its CTI in one
SMP group, its gdb server with a thread per core, `vp.sys` and `vp.dbg`
mem_ap targets, and the command `vp_status`).

Built with QBox (`gs_create_dymod`, `build/debug_dap.so`). The module type is `debug_dap`, as the library, so QBox finds it by the type name (no `dylib_path`). Up to VP Studio's sim agent 0.13.0 the module was `vp_debug_dap`, in the agent's library.
