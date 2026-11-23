# VP Studio: Linux awareness for gdb (G-06).
#
# Load it in gdb with "source vp-linux.py" (VP Studio's debug configurations
# do this). Needs the kernel's symbol file with DWARF (vmlinux), loaded as the
# program. Everything is read through the kernel's own types, so the script
# names fields only; no constants from a kernel build are needed.
#
# Commands, while the target is stopped:
#   vp-kaslr [-q]      find the KASLR offset of the running kernel (arm64) and
#                      reload the symbols there (-q: never fails, for initCommands)
#   vp-ps [-t]         processes (-t: also threads), and what each CPU runs
#   vp-dmesg [-n N]    the kernel log (printk ring buffer, Linux 5.10 and later)
#   vp-lsmod           loaded kernel modules with their section addresses
# Pretty-printers (gdb's "vp-linux" collection; "info pretty-printer" lists them,
# "disable pretty-printer global vp-linux" turns them off): one-line values for
# cpumask ({0-7}), atomic_t, refcount_t, kuid_t/kgid_t and qstr. They read a few
# fields and never walk a list, since every read goes to the target.
# There are none for structs such as task_struct: under MI a printer makes the
# variable numchild 0, and the CDT adapter then shows it without an expand arrow
# (the fields could not be opened); and switching such a printer on while
# Variables or Watch hold that type made gdb 15 fail ("Duplicate variable object
# name") and, in VS Code, stop with an internal error (2026-11-23).
# MI commands for tools (VP Studio's Guest Processes view): -vp-ps, -vp-dmesg,
# -vp-kaslr, -vp-lsmod. They return the same data as MI results.

import gdb
import gdb.printing

VERSION = "0.3.0"
MASK64 = (1 << 64) - 1


class VpError(gdb.GdbError):
    pass


# ---------------------------------------------------------------- helpers


def _sym(name):
    try:
        return gdb.parse_and_eval(name)
    except gdb.error:
        return None


def _addr(name):
    """Address of a kernel symbol as the symbol file says, or None."""
    v = _sym("&" + name if not name.startswith("&") else name)
    return None if v is None else int(v.cast(gdb.lookup_type("unsigned long"))) & MASK64


def _u64(addr):
    return int.from_bytes(bytes(gdb.selected_inferior().read_memory(addr, 8)), "little")


def _readable(addr, size=8):
    try:
        gdb.selected_inferior().read_memory(addr, size)
        return True
    except gdb.MemoryError:
        return False


def _kernel_objfile():
    for o in gdb.objfiles():
        if o.lookup_global_symbol("init_task") is not None or o.lookup_static_symbol("init_task") is not None:
            return o
    return None


def _need_kernel():
    if _kernel_objfile() is None:
        raise VpError("No kernel symbols: load the kernel's symbol file with DWARF (vmlinux), for example "
                      "\"symbol-file vmlinux\", or set \"program\" in the debug configuration.")
    try:
        gdb.selected_thread().ptid
    except Exception:
        raise VpError("Not connected to a target.")
    if gdb.selected_thread() is None or gdb.selected_thread().is_running():
        raise VpError("The target is running: pause it first.")


def _offset_ok(off):
    """Whether the kernel runs with this KASLR offset: kimage_vaddr, which the
    kernel sets to where its image runs, must read back as _text + off."""
    kv, text = _addr("kimage_vaddr"), _addr("_text")
    if kv is None or text is None:
        return None
    try:
        return _u64((kv + off) & MASK64) == (text + off) & MASK64
    except gdb.MemoryError:
        return False


def _reg(name):
    try:
        return int(gdb.selected_frame().read_register(name)) & MASK64
    except (gdb.error, ValueError):
        return None


def _el(thread):
    """Exception level a CPU (gdb thread) runs at, from PSTATE (cpsr), or None."""
    prev = gdb.selected_thread()
    try:
        thread.switch()
        return (int(gdb.selected_frame().read_register("cpsr")) >> 2) & 3
    except (gdb.error, ValueError):
        return None
    finally:
        prev.switch()


class _InKernel:
    """Read guest memory through a CPU that runs kernel code. gdb reads through
    the selected CPU's MMU, and with KPTI (arm64 turns it on with KASLR) the
    kernel is not mapped while a CPU runs user code (EL0). The selection is
    restored afterwards, so the debugger's own view does not change."""

    def __enter__(self):
        self.prev = gdb.selected_thread()
        if _el(self.prev) != 0:
            return self
        for t in gdb.selected_inferior().threads():
            if _el(t):
                t.switch()
                return self
        raise VpError("Every CPU runs user code (EL0), where the kernel is not mapped (KPTI). "
                      "Stop again when one CPU is in the kernel, for example idle.")

    def __exit__(self, *exc):
        if self.prev is not None and self.prev.is_valid():
            self.prev.switch()
        return False


_checked = {}  # objfile filename -> offset found to be right


def kaslr(apply=True):
    """Make the symbols match the running kernel. Returns {offset, applied, how}."""
    _need_kernel()
    with _InKernel():
        return _kaslr(apply)


def _kaslr(apply):
    obj = _kernel_objfile()
    key = obj.filename
    ok = _offset_ok(0)
    if ok is None:
        return {"offset": 0, "applied": False, "how": "no kimage_vaddr or _text in the symbol file: not checked"}
    if ok:
        _checked[key] = 0
        return {"offset": 0, "applied": False, "how": "symbols match the running kernel"}
    # The exception vector base points into the kernel image while the CPU
    # runs kernel code (also when idle); its linked place is "vectors".
    candidates = []
    vec = _addr("vectors")
    for t in gdb.selected_inferior().threads():
        if vec is None:
            break
        prev = gdb.selected_thread()
        t.switch()
        v = _reg("VBAR_EL1")
        prev.switch()
        if v:
            candidates.append((v - vec) & MASK64)
    for off in dict.fromkeys(candidates):
        if _offset_ok(off):
            if apply:
                _reload(obj, off)
            _checked[key] = off
            return {"offset": off, "applied": apply, "how": "from VBAR_EL1, checked with kimage_vaddr"}
    raise VpError("The symbols do not match the running kernel, and no KASLR offset fits. "
                  "Is it the vmlinux of the kernel that runs? Booting with \"nokaslr\" avoids the offset.")


def _reload(obj, off):
    """Load the kernel's symbol file again at the offset. Without questions:
    in a gdb console (VP Studio's openGdbConsole) gdb would ask first."""
    name = obj.filename
    main = gdb.current_progspace().filename == name
    confirm = gdb.parameter("confirm")
    gdb.execute("set confirm off", to_string=True)
    try:
        if main:
            gdb.execute("symbol-file -o 0x%x '%s'" % (off, name), to_string=True)
        else:
            gdb.execute("remove-symbol-file '%s'" % name, to_string=True)
            gdb.execute("add-symbol-file '%s' -o 0x%x" % (name, off), to_string=True)
    finally:
        gdb.execute("set confirm %s" % ("on" if confirm else "off"), to_string=True)


def _ensure_symbols():
    _need_kernel()
    obj = _kernel_objfile()
    if obj.filename in _checked:
        with _InKernel():
            if _offset_ok(0):
                return
    kaslr(apply=True)


def _type(name):
    return gdb.lookup_type(name)


def _has_field(t, name):
    return any(f.name == name for f in t.strip_typedefs().fields())


def _container_of(ptr, typename, member):
    t = _type(typename)
    off = next(f.bitpos for f in t.fields() if f.name == member) // 8
    return (ptr.cast(_type("unsigned long")) - off).cast(t.pointer())


def _list(head, typename, member):
    """Entries of a struct list_head."""
    first = head["next"]
    p = first
    n = 0
    while int(p) != int(head.address):
        yield _container_of(p, typename, member)
        p = p["next"]
        n += 1
        if n > 1000000:
            raise VpError("list does not end: memory changed while reading?")


# ---------------------------------------------------------------- processes

_STATES = [(0x01, "S"), (0x02, "D"), (0x04, "T"), (0x08, "t"), (0x40, "X"), (0x80, "X"), (0x100, "W"), (0x200, "P")]


def _state(task):
    t = task.type.strip_typedefs()
    if t.code == gdb.TYPE_CODE_PTR:
        t = t.target()
    exit_state = int(task["exit_state"])
    if exit_state & 0x20:
        return "Z"
    if exit_state & 0x10:
        return "X"
    s = int(task["__state"] if _has_field(t, "__state") else task["state"])
    if s == 0:
        return "R"
    if s & 0x400 and s & 0x02:  # TASK_IDLE: uninterruptible but not counted in the load
        return "I"
    for bit, letter in _STATES:
        if s & bit:
            return letter
    return "?"


def _task_cpu(task):
    t = task.type.target()
    if _has_field(t, "cpu"):
        return int(task["cpu"])
    if _has_field(t, "thread_info") and _has_field(task["thread_info"].type, "cpu"):
        return int(task["thread_info"]["cpu"])
    return -1


def _comm(task):
    return task["comm"].string(length=16).split("\0")[0]


def _task_row(task, running):
    a = int(task)
    try:
        uid = int(task["cred"]["uid"]["val"])
    except gdb.error:
        uid = -1
    return {
        "pid": int(task["pid"]),
        "tgid": int(task["tgid"]),
        "ppid": int(task["real_parent"]["tgid"]),
        "uid": uid,
        "state": _state(task),
        "cpu": _task_cpu(task),
        "running": running.get(a, -1),
        "kernel": int(task["mm"]) == 0,
        "comm": _comm(task),
        "task": "0x%x" % a,
    }


def _possible_cpus():
    n = _sym("nr_cpu_ids")
    n = int(n) if n is not None else 1
    mask = _sym("__cpu_online_mask")
    out = []
    for cpu in range(n):
        if mask is not None:
            word = int(mask["bits"][cpu // 64])
            if not (word >> (cpu % 64)) & 1:
                continue
        out.append(cpu)
    return out


def _per_cpu(name, cpu):
    base = _addr(name)
    off = _sym("__per_cpu_offset")
    if base is None:
        return None
    a = (base + (int(off[cpu]) if off is not None else 0)) & MASK64
    return gdb.Value(a).cast(_sym("&" + name).type)


def running_tasks():
    """{cpu: task pointer} from each CPU's run queue."""
    out = {}
    for cpu in _possible_cpus():
        rq = _per_cpu("runqueues", cpu)
        if rq is None:
            break
        out[cpu] = rq["curr"]
    return out


def processes(threads=False):
    _ensure_symbols()
    with _InKernel():
        return _processes(threads)


def _processes(threads):
    run = running_tasks()
    running = {int(t): cpu for cpu, t in run.items()}
    init = _sym("init_task")
    rows = []
    tt = "struct task_struct"
    has_thread_node = _has_field(_type(tt), "thread_node")
    for task in _list(init["tasks"], tt, "tasks"):
        rows.append(_task_row(task, running))
        if threads:
            if has_thread_node:
                members = _list(task["signal"]["thread_head"], tt, "thread_node")
            else:
                members = _list(task["thread_group"], tt, "thread_group")
            for th in members:
                if int(th) != int(task):
                    rows.append(_task_row(th, running))
    cpus = []
    for cpu, t in sorted(run.items()):
        r = _task_row(t, running)
        cpus.append({"cpu": cpu, "pid": r["pid"], "comm": r["comm"], "idle": r["pid"] == 0})
    return {"processes": rows, "cpus": cpus}


# ---------------------------------------------------------------- modules

_MOD_STATES = {0: "live", 1: "coming", 2: "going", 3: "unformed"}


def modules():
    """Loaded modules: {release, modules: [{name, state, base, size, sections: [{name, address}]}]},
    base and size of the module's core (text) area; sections from its sysfs attributes (the
    addresses add-symbol-file needs), when the kernel keeps them."""
    _ensure_symbols()
    with _InKernel():
        return _modules()


def _modules():
    head = _sym("modules")
    if head is None:
        raise VpError("No \"modules\" list in the symbol file: the kernel has no loadable modules.")
    mt = "struct module"
    has_mem = _has_field(_type(mt), "mem")  # Linux 6.4 and later: mem[MOD_TEXT]
    rows = []
    for m in _list(head, mt, "list"):
        try:
            name = m["name"].string()
        except gdb.error:
            continue
        if has_mem:
            area = m["mem"][0]
        else:
            area = m["core_layout"]
        sections = []
        try:
            sa = m["sect_attrs"]
            if int(sa):
                for i in range(int(sa["nsections"])):
                    a = sa["attrs"][i]
                    sections.append({"name": a["battr"]["attr"]["name"].string(), "address": "0x%x" % (int(a["address"]) & MASK64)})
        except gdb.error:
            sections = []
        rows.append({"name": name, "state": _MOD_STATES.get(int(m["state"]), str(int(m["state"]))),
                     "base": "0x%x" % (int(area["base"].cast(_type("unsigned long"))) & MASK64), "size": int(area["size"]),
                     "sections": sections})
    release = ""
    uts = _sym("init_uts_ns")
    if uts is not None:
        try:
            release = uts["name"]["release"].string()
        except gdb.error:
            release = ""
    return {"release": release, "modules": rows}


# ---------------------------------------------------------------- pretty-printers

def _qstr_name(q):
    """The name of a struct qstr: len bytes at name (len sits in an anonymous union)."""
    try:
        n = int(q["len"])
    except gdb.error:
        n = 255
    try:
        return q["name"].string(length=min(max(n, 0), 255), errors="replace").split("\0", 1)[0]
    except (gdb.error, gdb.MemoryError):
        return "?"


class _Printer:
    """Base: to_string() from summary(), with read errors shown instead of raised."""

    def __init__(self, val):
        self.val = val

    def to_string(self):
        try:
            return self.summary()
        except (gdb.error, gdb.MemoryError, RuntimeError, ValueError) as e:
            return "<unreadable: %s>" % str(e).split("\n")[0][:80]


class _CpumaskPrinter(_Printer):
    def summary(self):
        bits = self.val["bits"]
        words = bits.type.strip_typedefs().range()[1] + 1
        size = bits.type.strip_typedefs().target().sizeof * 8
        cpus = [w * size + b for w in range(words) for b in range(size) if int(bits[w]) >> b & 1]
        out, i = [], 0
        while i < len(cpus):
            j = i
            while j + 1 < len(cpus) and cpus[j + 1] == cpus[j] + 1:
                j += 1
            out.append(str(cpus[i]) if i == j else "%d-%d" % (cpus[i], cpus[j]))
            i = j + 1
        return "{" + ",".join(out) + "}"


class _CounterPrinter(_Printer):
    """atomic_t, atomic64_t, atomic_long_t: the value."""

    def summary(self):
        return str(int(self.val["counter"]))


class _RefcountPrinter(_Printer):
    def summary(self):
        return "refs %d" % int(self.val["refs"]["counter"])


class _IdPrinter(_Printer):
    """kuid_t, kgid_t: the number."""

    def summary(self):
        return str(int(self.val["val"]))


class _QstrPrinter(_Printer):
    def summary(self):
        return '"%s"' % _qstr_name(self.val)


class _Subprinter(gdb.printing.SubPrettyPrinter):
    def __init__(self, name, types, cls):
        super().__init__(name)
        self.types = types
        self.cls = cls


class VpLinuxPrinters(gdb.printing.PrettyPrinter):
    """gdb's "vp-linux" collection. Types are matched by their name before and
    after typedefs (atomic_t is a typedef of an anonymous struct)."""

    def __init__(self):
        subs = [
            _Subprinter("cpumask", ["cpumask", "cpumask_t"], _CpumaskPrinter),
            _Subprinter("atomic", ["atomic_t", "atomic64_t", "atomic_long_t"], _CounterPrinter),
            _Subprinter("refcount", ["refcount_t", "refcount_struct"], _RefcountPrinter),
            _Subprinter("kuid_kgid", ["kuid_t", "kgid_t", "kprojid_t"], _IdPrinter),
            _Subprinter("qstr", ["qstr"], _QstrPrinter),
        ]
        super().__init__("vp-linux", subs)
        self.by_name = {t: sp for sp in subs for t in sp.types}

    def __call__(self, val):
        if not self.enabled:
            return None
        t = val.type
        names = []
        try:
            names.append(t.unqualified().name)
            s = t.strip_typedefs()
            if s.code in (gdb.TYPE_CODE_STRUCT, gdb.TYPE_CODE_UNION):
                names.append(s.unqualified().tag)
        except gdb.error:
            return None
        for n in names:
            sp = self.by_name.get(n) if n else None
            if sp is not None and sp.enabled:
                return sp.cls(val)
        return None


gdb.printing.register_pretty_printer(None, VpLinuxPrinters(), replace=True)


# ---------------------------------------------------------------- dmesg


def _offsets(typename):
    return {f.name: f.bitpos // 8 for f in _type(typename).strip_typedefs().fields()}


def dmesg(last=None):
    """The printk ring buffer (Linux 5.10 and later) as [{seq, ts_nsec, level, text}]."""
    _ensure_symbols()
    with _InKernel():
        return _dmesg(last)


def _dmesg(last):
    prb = _sym("prb")
    if prb is None:
        raise VpError("No printk ring buffer (\"prb\") in the symbol file: Linux 5.10 or later is needed.")
    inf = gdb.selected_inferior()
    rb = prb.dereference()
    desc_ring = rb["desc_ring"]
    data_ring = rb["text_data_ring"]
    count = 1 << int(desc_ring["count_bits"])
    size = 1 << int(data_ring["size_bits"])
    descs, infos, data = int(desc_ring["descs"]), int(desc_ring["infos"]), int(data_ring["data"])
    tail, head = int(desc_ring["tail_id"]["counter"]) & MASK64, int(desc_ring["head_id"]["counter"]) & MASK64

    dsz = _type("struct prb_desc").sizeof
    isz = _type("struct printk_info").sizeof
    do = _offsets("struct prb_desc")
    lo = _offsets("struct prb_data_blk_lpos")
    io = _offsets("struct printk_info")
    long_size = _type("unsigned long").sizeof
    sv_bits = long_size * 8
    flags_shift = sv_bits - 2
    id_mask = ~(3 << flags_shift) & ((1 << sv_bits) - 1)

    desc_mem = bytes(inf.read_memory(descs, dsz * count))
    info_mem = bytes(inf.read_memory(infos, isz * count))
    data_mem = bytes(inf.read_memory(data, size))
    u = lambda b, o, n: int.from_bytes(b[o:o + n], "little")

    # The level is a 3-bit field next to the facility; find it from the type.
    level_bit = None
    for f in _type("struct printk_info").fields():
        if f.name == "level":
            level_bit = f.bitpos
    out = []
    did = tail
    n = 0
    while True:
        idx = did % count
        d = idx * dsz
        sv = u(desc_mem, d + do["state_var"], long_size)
        state = sv >> flags_shift
        if (sv & id_mask) == did and state in (1, 2):  # committed or finalized
            begin = u(desc_mem, d + do["text_blk_lpos"] + lo["begin"], long_size)
            nxt = u(desc_mem, d + do["text_blk_lpos"] + lo["next"], long_size)
            i = idx * isz
            text_len = u(info_mem, i + io["text_len"], 2)
            text = ""
            if not begin & 1 and text_len:
                b, e = begin % size, nxt % size
                if b > e:  # the block wrapped: it is at the start of the ring
                    b = 0
                start = b + long_size  # skip the block's descriptor id
                if e - start < text_len:
                    text_len = max(0, e - start)
                text = data_mem[start:start + text_len].decode("utf-8", "replace")
            level = (u(info_mem, i + level_bit // 8, 1) >> (level_bit % 8)) & 7 if level_bit is not None else None
            out.append({
                "seq": u(info_mem, i + io["seq"], 8),
                "ts_nsec": u(info_mem, i + io["ts_nsec"], 8),
                "level": level,
                "text": text,
            })
        if did == head:
            break
        did = (did + 1) & id_mask
        n += 1
        if n > count:
            break
    if last is not None:
        out = out[-last:]
    return out


def _fmt_ts(ns):
    return "[%5d.%06d]" % (ns // 1000000000, (ns % 1000000000) // 1000)


# ---------------------------------------------------------------- commands


def _args(arg):
    return gdb.string_to_argv(arg)


class VpKaslr(gdb.Command):
    """Find the KASLR offset of the running arm64 kernel and reload the symbols there."""

    def __init__(self):
        super().__init__("vp-kaslr", gdb.COMMAND_DATA)

    def invoke(self, arg, from_tty):
        # -q: for initCommands. Never fails (the attach must go on), and says
        # nothing unless it moved the symbols or could not check them.
        quiet = "-q" in _args(arg)
        try:
            r = kaslr(apply=True)
        except (gdb.GdbError, gdb.error) as e:
            if not quiet:
                raise
            print("vp-linux: kernel symbols not checked yet (%s). vp-ps and vp-dmesg check them again." % e)
            return
        if r["applied"] or not quiet:
            print("vp-linux: KASLR offset 0x%x: %s%s" % (r["offset"], r["how"], " (symbols reloaded)" if r["applied"] else ""))


class VpPs(gdb.Command):
    """List the guest's processes and what each CPU runs. vp-ps -t: threads too."""

    def __init__(self):
        super().__init__("vp-ps", gdb.COMMAND_DATA)

    def invoke(self, arg, from_tty):
        a = _args(arg)
        r = processes(threads="-t" in a)
        print("%7s %7s %5s S %4s  %-16s %s" % ("PID", "PPID", "UID", "CPU", "COMMAND", ""))
        for p in r["processes"]:
            name = ("[%s]" % p["comm"]) if p["kernel"] else p["comm"]
            on = "running on cpu %d" % p["running"] if p["running"] >= 0 else ""
            print("%7d %7d %5d %s %4d  %-16s %s" % (p["pid"], p["ppid"], p["uid"], p["state"], p["cpu"], name, on))
        print("CPUs: " + ", ".join("%d %s" % (c["cpu"], "idle" if c["idle"] else "%s (%d)" % (c["comm"], c["pid"]))
                                     for c in r["cpus"]))


class VpDmesg(gdb.Command):
    """Print the kernel log. vp-dmesg -n N: the last N records."""

    def __init__(self):
        super().__init__("vp-dmesg", gdb.COMMAND_DATA)

    def invoke(self, arg, from_tty):
        a = _args(arg)
        last = int(a[a.index("-n") + 1]) if "-n" in a else None
        for r in dmesg(last):
            ts = _fmt_ts(r["ts_nsec"])
            for line in r["text"].split("\n"):
                print("%s %s" % (ts, line))


class VpLsmod(gdb.Command):
    """vp-lsmod: loaded kernel modules, their core address and size."""

    def __init__(self):
        super().__init__("vp-lsmod", gdb.COMMAND_STATUS)

    def invoke(self, arg, from_tty):
        r = modules()
        gdb.write("%-24s %-18s %10s  %s\n" % ("Module", "Base", "Size", "State"))
        for m in r["modules"]:
            gdb.write("%-24s %-18s %10d  %s\n" % (m["name"], m["base"], m["size"], m["state"]))
        gdb.write("%d modules (Linux %s)\n" % (len(r["modules"]), r["release"]))


VpKaslr()
VpPs()
VpDmesg()
VpLsmod()

if hasattr(gdb, "MICommand"):

    class _MiPs(gdb.MICommand):
        def __init__(self):
            super().__init__("-vp-ps")

        def invoke(self, argv):
            try:
                return processes(threads="-t" in argv)
            except (VpError, gdb.error) as e:
                raise gdb.GdbError(str(e))

    class _MiDmesg(gdb.MICommand):
        def __init__(self):
            super().__init__("-vp-dmesg")

        def invoke(self, argv):
            last = int(argv[argv.index("-n") + 1]) if "-n" in argv else None
            try:
                recs = dmesg(last)
            except (VpError, gdb.error) as e:
                raise gdb.GdbError(str(e))
            return {"records": [{"seq": r["seq"], "ts": r["ts_nsec"], "level": -1 if r["level"] is None else r["level"],
                                 "text": r["text"]} for r in recs]}

    class _MiKaslr(gdb.MICommand):
        def __init__(self):
            super().__init__("-vp-kaslr")

        def invoke(self, argv):
            try:
                r = kaslr(apply=True)
            except (VpError, gdb.error) as e:
                raise gdb.GdbError(str(e))
            return {"offset": "0x%x" % r["offset"], "applied": r["applied"], "how": r["how"]}

    class _MiVersion(gdb.MICommand):
        def __init__(self):
            super().__init__("-vp-linux-version")

        def invoke(self, argv):
            return {"version": VERSION}

    class _MiLsmod(gdb.MICommand):
        def __init__(self):
            super().__init__("-vp-lsmod")

        def invoke(self, argv):
            try:
                return modules()
            except (VpError, gdb.error) as e:
                raise gdb.GdbError(str(e))

    _MiLsmod()
    _MiPs()
    _MiDmesg()
    _MiKaslr()
    _MiVersion()
