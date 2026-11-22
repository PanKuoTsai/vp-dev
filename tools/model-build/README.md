# Modeling wizard: building a model

VP Studio's modeling wizard turns a peripheral description
(`<name>.model.json`) into the C++ of a QBox module. This script builds it.

```sh
tools/model-build/build.sh <qbox>/build <model-folder> [--no-test] [--no-catalog]
```

**Build Model** in VS Code runs this script. It takes the QBox build from
`vpStudio.executable`.

## What the folder holds

| File | Written | Contents |
|---|---|---|
| `<name>.model.json` | by you | Registers (offset, size, access, reset, fields), CCI parameters, signal outputs and inputs. |
| `include/<name>_regs.h` | every time the description is saved | Sockets, parameters, register storage, address decoding, access types, hooks, field constants. |
| `test/<name>_selftest.cc` | every time | Self-test of the generated decoding. |
| `include/<name>.h` | once, then yours | The class to add behaviour to, by overriding hooks. |
| `src/<name>.cc` | once, then yours | Registers the type with QBox (`GSC_MODULE_REGISTER_C`). |
| `CMakeLists.txt` | once | For building inside a QBox tree (`gs_create_dymod`). |

Generated decoding:
- **Access types.**
  - `rw`
  - `ro`: writes are ignored.
  - `wo`: reads return 0.
  - `w1c`: writing a 1 clears that bit.
- **Byte access.** Accesses smaller than a register, or spanning several
  registers, are merged byte by byte, little endian.
- **Unmapped bytes.** They read as 0 and ignore writes (`"unmapped": "ignore"`,
  the default). With `"error"`, they give a TLM address error.
- **Outside the region.** An access beyond the region is always an address
  error.
- **Debug transport.** It reads and writes the stored values without calling
  the hooks. QBox's loader and gdb use it.

Hooks to override in `<name>.h`:
- `read_<REG>(value)`: returns the value the bus gets.
- `after_write_<REG>(old_value, value)`: called after a bus write.
- `on_<input>(value)`: called when an input changes. An input named `reset`
  resets the registers by default.

Helpers:
- `set_<output>(bool)` drives an output, and does nothing while the output is
  not connected.
- `reg_<REG>()` reads a register.
- Each parameter is a member named `p_<name>`.

## What the script does

1. **Library.** Compiles `src/*.cc` with the flags of QBox's `keep_alive`
   module and links `build/<name>.so` the same way. It writes
   `build/<name>.json` with the QBox commit it was built against.
2. **Self-test.** Compiles `test/<name>_selftest.cc` with the flags of
   `platforms-vp`, links `build/<name>_selftest`, and runs it. The test
   checks:
   - every reset value;
   - each access type;
   - byte writes and reads;
   - unmapped and out-of-region accesses.

   It runs on the generated base class, so behaviour you add does not affect
   it. Exit code 3 means the test failed.
3. **Catalog entry.** Runs `tools/qbox-catalog` on the library
   (`--dylib-dir`) and writes `build/<name>.catalog.json`. VS Code finds every
   `*.model.json` whose catalog entry exists and adds the model to the
   component catalog.

In a platform, **Add Module…** then lists the model.
- **Model near the platform**, as in a shared repository: it writes
  `"dylib": "${TOP}…/build/<name>"`, relative to the platform.
- **Model elsewhere**: it writes no `dylib`. VP Studio puts the library's path
  on the current machine into the generated Lua only.

Either way, no machine-specific absolute path goes into the platform file.

## Logging

QBox shows a module's `SCP_WARN`/`SCP_INFO` messages only when its
`log_level` is set high enough. Set it in the platform's parameters for the
module, for example `"log_level": 3`:

| Level | Shows |
|---|---|
| 1 | fatal |
| 2 | errors |
| 3 | warnings |
| 4 | info |
| 5 | debug |
| 6 | trace |

## Verified (2026-11-15, QBox adfde798)

- **Sample model.** It had registers of 1, 2, 4 and 8 bytes covering the four
  access types, fields, four parameter types, one output and two inputs. It
  built in about 15 s, and its self-test passed 21 of 21 checks.
- **Catalog entry.** It lists the socket, the output, both inputs and the
  four parameters with their defaults. A full QBox catalog regenerated with the
  updated tool is unchanged.
- **In the Ubuntu platform.** Added with Add Module's `moduleDef` at
  0x09200000, its interrupt wired to the GIC, with `clock_hz` set from the
  platform. A five-instruction program on cpu_0 wrote CTRL and read STATUS
  and ID. The transaction trace showed:
  - the write of 5;
  - STATUS = 0x50, set by the `after_write_CTRL` hook;
  - ID = 0x00010001, the reset value.

  With `log_level` 4, the hooks' messages appeared on the console.
