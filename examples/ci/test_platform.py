"""Example checks on a running simulation, for vp-run --exec.

    node bin/vp-run.js --qbox ~/qbox --snapshot --expect 'login:' \
        --exec 'python3 -m pytest -q examples/ci/test_platform.py' \
        ~/qbox/platforms/ubuntu/ubuntu-aarch64.platform.json

vp-run sets VP_AGENT_PORT, so SimAgent() finds the simulation. Without pytest,
run the file itself: python3 examples/ci/test_platform.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "tools", "vp-py"))
from vpstudio import AgentError, SimAgent  # noqa: E402


def test_agent_answers():
    with SimAgent() as sim:
        info = sim.info()
        assert info["protocol"] == 1
        assert "sim.runFor" in info["methods"], "the sim agent is older than 0.4.0"


def test_run_for_pauses_after_the_time():
    with SimAgent() as sim:
        sim.pause()
        start = sim.time()
        sim.run_for("200 ms")
        status = sim.wait_for_pause(timeout=120)
        assert status["reason"] == "time"
        ran = status["time"]["seconds"] - start
        assert 0.2 <= ran < 0.2 + 0.05, f"ran {ran:.4f} s for a 200 ms request"
        sim.resume()


def test_platform_has_eight_cpus():
    with SimAgent() as sim:
        cpus = {p["name"].split(".")[1] for p in sim.list_params(prefix="platform.cpu_")}
        assert len(cpus) == 8, sorted(cpus)


def test_locked_parameter_is_refused():
    with SimAgent() as sim:
        try:
            sim.set_param("platform.qemu_inst.tcg_mode", "SINGLE")
        except AgentError as e:
            assert e.code == -32003, e
        else:
            raise AssertionError("a locked parameter was changed")


if __name__ == "__main__":
    failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as e:  # report every check, like pytest -q
                failed += 1
                print(f"FAIL {name}: {e}")
    sys.exit(1 if failed else 0)
