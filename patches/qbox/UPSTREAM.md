# Reports for QBox upstream (drafts)

Drafts to send to the QBox project (https://github.com/qualcomm/qbox). They
have not been sent. The first comes with a patch; the second is an issue only.

---

## 1. MTTCG: simulation ends by starvation when a woken CPU has not re-registered its quantum keeper

*Pull request, with `0001-mttcg-register-woken-cpu.patch` (its description is
the commit message).*

**Summary.** With several CPUs in MTTCG mode (`tcg_mode = "MULTI"`) that start
powered off, booting Linux often ends a few seconds after `SC_START`. There is
no kernel output, the exit status is 0, and nothing reports an error.

**Environment.**
- QBox adfde7985eefe806ebd40b43f2516a5ac5cb5e51.
- `platforms/ubuntu/conf_aarch64.lua`, Cortex-A76.
- `sync_policy = "multithread-unconstrained"`, CPUs start powered off.
- Ubuntu 24.04 host, 4 cores.

**How often.** With 8 CPUs, 5 of 6 boots failed; with 2 CPUs, 1 of 6. The
rate depends on host load and was higher with a pseudo-TTY: up to 10 of 11.

The problem does not occur in these cases:
- 1 CPU;
- `tcg_mode` `SINGLE`, or COROUTINE threading;
- CPUs that do not start powered off;
- QEMU `-d int` logging on.

**Cause.**
1. A CPU that sleeps calls `wait_for_work()`, which stops its quantum keeper.
   `tlm_quantumkeeper_multithread`'s time handler then detaches the
   suspending channel.
2. When another CPU wakes it, `kick_cb()` → `set_signaled()` only signals a
   condition variable. The quantum keeper restarts at the end of
   `wait_for_work()`, once the woken vCPU thread has been scheduled.
3. During `stop_machine` ("alternatives: patching kernel code"), Linux's CPU 0
   sends an IPI and goes to WFI at once.
4. In the window between steps 2 and 3, SystemC has no timed event, no
   attached suspending channel and no pending async update. `sc_simcontext`
   therefore ends the simulation by starvation (`sc_simcontext.cpp`, around
   line 937). The wake-up itself is not lost.

**Fix.** Restart the quantum keeper in `set_signaled()`, from the waking thread
and under `m_signaled_lock`, when it was stopped for sleeping. In
`wait_for_work()`, stop it under the same lock, and only when no wake-up is
pending. Kicks to a running CPU, single-threaded TCG and coroutine mode are
unchanged.

**Testing.** Ubuntu AArch64 without `keep_alive`; a run passes when the kernel
reaches `Run /init`.

| CPUs | Before | After |
|---|---|---|
| 8 | 1/6 | 10/10 |
| 2 | 5/6 | 10/10 |

With the patch and 8 CPUs, the boot reaches `login:`.

QBox test suite (`ctest -j2`, aarch64 build with the patch): 415 of 415 passed in 217 s. This covers MTTCG, `SINGLE`, COROUTINE, icount and 1 to 32 CPUs.

**Workaround until then.** Add a `keep_alive` module to the platform. The cost
is that the simulation no longer ends when all CPUs sleep.

---

## 2. monitor `/pause` does not stop MTTCG CPUs

*Issue.*

**Summary.** `monitor`'s `/pause` calls `sc_core::sc_suspend_all()`
(`systemc-components/monitor/src/monitor.cc`, `/pause` route). In MTTCG mode
this freezes SystemC time, but the guest keeps running.

**Observed.** On the Ubuntu AArch64 platform, with the simulation paused at the
`login:` prompt, keys typed are echoed and the guest answers.

**Cause.**
1. A vCPU woken by an interrupt restarts its quantum keeper.
2. The quantum keeper grants up to two quanta of run budget ahead of the frozen
   SystemC time, so the vCPU keeps executing guest code.
3. QEMU is never told to stop.

**What worked for us.** An external module (VP Studio's sim agent) pauses in
this order:
1. Stop the QEMU VM first. From a non-SystemC thread, with the BQL held, call
   `vm_stop` with `RUN_STATE_PAUSED` for every `QemuInstance`.
2. Then call `sc_suspend_all()`.

To continue, it does the reverse. libqemu's `cpu_can_run` returns true while a
stop is pending, so a vCPU waiting for budget reaches QEMU's stop point instead
of deadlocking.

The result was verified:
- **At the login prompt.** Keys typed while paused got no echo, and host CPU
  use dropped to 0%.
- **During boot.** In 40 random pause/continue cycles, time and output were
  frozen every time.

`/pause` could do the same.
