"""Python client for the VP Studio sim agent (JSON-RPC 2.0, one message per line over TCP).

Standard library only, Python 3.8 or later. Copy this file next to your tests, or
put tools/vp-py on PYTHONPATH.

    from vpstudio import SimAgent

    with SimAgent() as sim:          # VP_AGENT_HOST / VP_AGENT_PORT, as set by vp-run --exec
        sim.pause()
        status = sim.run_for("100 ms")        # runs, then pauses by itself
        status = sim.wait_for_pause(timeout=60)
        print(status["time"]["text"])

The methods follow the protocol in tools/sim-agent/README.md; each returns the
agent's result as Python values (dict, list, ...).
"""

import json
import os
import queue
import socket
import threading
import time

__all__ = ["SimAgent", "AgentError"]
__version__ = "0.4.0"


class AgentError(Exception):
    """An error response from the agent. code is the JSON-RPC error code."""

    def __init__(self, code, message):
        super().__init__(f"{message} ({code})")
        self.code = code
        self.message = message


class SimAgent:
    """A connection to a running simulation's sim agent.

    host and port default to VP_AGENT_HOST (else 127.0.0.1) and VP_AGENT_PORT.
    connect_timeout: how long to keep retrying while the simulation starts.
    """

    def __init__(self, host=None, port=None, connect_timeout=60.0, timeout=30.0):
        self.host = host or os.environ.get("VP_AGENT_HOST", "127.0.0.1")
        if port is None:
            if "VP_AGENT_PORT" not in os.environ:
                raise ValueError("no port given and VP_AGENT_PORT is not set")
            port = int(os.environ["VP_AGENT_PORT"])
        self.port = int(port)
        self.timeout = timeout
        self.notifications = queue.Queue()  # params of each sim.stateChanged (and any other notification)
        self._pending = {}
        self._lock = threading.Lock()
        self._next_id = 1
        self._seq = 0          # notifications received so far
        self._stop_after = 0   # wait_for_pause looks only at notifications after this one
        self._closed = False
        self._sock = self._connect(connect_timeout)
        self._reader = threading.Thread(target=self._read_loop, name="vpstudio-agent", daemon=True)
        self._reader.start()

    # -------------------------------------------------------------- connection

    def _connect(self, total):
        end = time.monotonic() + total
        last = None
        while True:
            try:
                s = socket.create_connection((self.host, self.port), timeout=5)
                s.settimeout(None)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                return s
            except OSError as e:
                last = e
                if time.monotonic() >= end:
                    raise ConnectionError(f"no sim agent at {self.host}:{self.port}: {last}") from None
                time.sleep(0.5)

    def _read_loop(self):
        buf = b""
        try:
            while True:
                chunk = self._sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self._dispatch(json.loads(line))
        except (OSError, ValueError):
            pass
        finally:
            self._closed = True
            with self._lock:
                pending, self._pending = self._pending, {}
            for q in pending.values():
                q.put({"error": {"code": -32002, "message": "connection to the sim agent closed"}})

    def _dispatch(self, msg):
        # Runs on the reader thread, in the order the agent sent the messages.
        if "id" in msg and msg["id"] is not None:
            with self._lock:
                q = self._pending.pop(msg["id"], None)
            if q is not None:
                msg["_seq"] = self._seq  # notifications that came before this answer
                q.put(msg)
        elif "method" in msg:
            self._seq += 1
            self.notifications.put(dict(msg.get("params") or {}, _method=msg["method"], _seq=self._seq))

    def close(self):
        """Close the connection. The simulation keeps running."""
        self._closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # -------------------------------------------------------------- calls

    def call(self, method, **params):
        """Send one request and return its result; raises AgentError on an error response."""
        return self._call(method, params)[0]

    def _call(self, method, params):
        if self._closed:
            raise AgentError(-32002, "connection to the sim agent closed")
        q = queue.Queue(maxsize=1)
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            self._pending[rid] = q
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params:
            msg["params"] = params
        self._sock.sendall((json.dumps(msg) + "\n").encode("utf-8"))
        try:
            reply = q.get(timeout=self.timeout)
        except queue.Empty:
            with self._lock:
                self._pending.pop(rid, None)
            raise TimeoutError(f"{method}: no answer within {self.timeout} s") from None
        if "error" in reply:
            e = reply["error"]
            raise AgentError(e.get("code"), e.get("message", ""))
        return reply.get("result"), reply.get("_seq", 0)

    def info(self):
        return self.call("agent.getInfo")

    def status(self):
        return self.call("sim.getStatus")

    def time(self):
        """Simulated time in seconds."""
        return self.status()["time"]["seconds"]

    def pause(self):
        return self.call("sim.pause")

    def resume(self):
        return self.call("sim.continue")

    def run_for(self, duration):
        """Run for duration ("100 ms", or seconds as a number), then pause. Returns at once;
        wait_for_pause() then waits for this stop."""
        result, self._stop_after = self._call("sim.runFor", {"duration": duration})
        return result

    def run_until(self, time_):
        """Run until the simulated time time_ ("30 s", or seconds), then pause. Returns at once;
        wait_for_pause() then waits for this stop."""
        result, self._stop_after = self._call("sim.runUntil", {"time": time_})
        return result

    def wait_for_pause(self, timeout=60.0):
        """Wait for the timed stop of the last run_for or run_until; returns the status it
        reports (time: where it stopped, requestedTime: the stop asked for). Notifications
        from before that call, such as the one of a pause(), are skipped."""
        end = time.monotonic() + timeout
        while True:
            left = end - time.monotonic()
            if left <= 0:
                raise TimeoutError(f"the simulation did not pause within {timeout} s")
            try:
                n = self.notifications.get(timeout=min(left, 0.5))
            except queue.Empty:
                if self._closed:
                    raise AgentError(-32002, "connection to the sim agent closed") from None
                continue
            if n["_seq"] <= self._stop_after:
                continue
            if n.get("_method") == "sim.stateChanged" and n.get("reason") == "time":
                return n

    def list_params(self, prefix=None, include_internal=False):
        p = {}
        if prefix:
            p["prefix"] = prefix
        if include_internal:
            p["includeInternal"] = True
        return self.call("cci.listParams", **p)["params"]

    def get_param(self, name):
        return self.call("cci.getParam", name=name)

    def param(self, name):
        """The value of a CCI parameter."""
        return self.get_param(name)["value"]

    def set_param(self, name, value):
        # Integers beyond 2**53 go as JSON text, so no digit is lost on the way.
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2 ** 53:
            return self.call("cci.setParam", name=name, valueJson=str(value))
        return self.call("cci.setParam", name=name, value=value)

    def trace_status(self):
        return self.call("trace.getStatus")

    def trace_enable(self, enabled=True):
        return self.call("trace.setEnabled", enabled=bool(enabled))

    def trace_clear(self):
        return self.call("trace.clear")

    def trace_read(self, since=0, max=2000):
        """Records after sequence number since, as dicts."""
        r = self.call("trace.read", since=since, max=max)
        points = r["points"]
        keys = ("seq", "time", "point", "rw", "address", "length", "data", "status")
        out = []
        for rec in r["records"]:
            d = dict(zip(keys, rec))
            d["point"] = points[d["point"]] if d["point"] < len(points) else d["point"]
            d["address"] = int(d["address"], 16)
            out.append(d)
        return {"records": out, "lastSeq": r["lastSeq"], "dropped": r["dropped"]}
