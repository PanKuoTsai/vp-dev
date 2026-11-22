# vp_probes: probes for VP Studio

Two module types that VP Studio puts in a platform, and the state they share
with VP Studio's sim agent:

- `tracer`: a pass-through between a router and one target socket of a
  device. It forwards every call unchanged and records each `b_transport`
  (address, size, data, status, who issued it). Parameters: `label`,
  `allow_dmi`, `record`, `router`.
- `signal_tracer`: placed in a signal connection; records each change of
  level. Parameters: `label`, `record`.
- `TraceStore` and `InitiatorNames` (`include/probes.h`): the records, the
  probes' switches, the bus breakpoints and the table of initiator names.
  The sim agent (a separate library, built by VP Studio's
  `tools/sim-agent/build.sh`) links to this one and reads and controls them.

QBox loads libraries with RTLD_LOCAL, so `TraceStore::get()`,
`InitiatorNames::get()` and `TraceStore::agent_access()` are defined once, in
`src/probes.cc`, never inline: otherwise each library would get its own
copy.

Built with QBox (`gs_create_dymod`, `build/probes.so`). Both types are in
this one library, so platforms name it: `dylib_path = "probes"`. (Up to
VP Studio's sim agent 0.13.0 the types were vp_tracer and vp_signal_tracer,
in the agent's library.) VP
Studio's sim agent README (tools/sim-agent/README.md) describes the probes'
methods (trace.*, break.*) and how they behave.
