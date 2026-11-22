# qbox-catalog

Lists the module types a QBox build provides and records, for each one, its
constructor arguments, sockets and signal ports, and CCI parameters (name,
type, default, description). The output is the component catalog that
`lib/platform/catalog.js` checks platforms against.

## Build and run

```sh
tools/qbox-catalog/build.sh <qbox>/build
tools/qbox-catalog/qbox-catalog --qbox-src <qbox> --libdir <qbox>/build \
    --out catalog/qbox-catalog.json
```

`build.sh` copies the compiler flags and link line of QBox's own
`platforms-vp` target, so QBox must be built first and is not modified. A full
run takes about 15 seconds.

Options:
- `--hints FILE`: default `hints.json` next to the binary.
- `--jobs N`: default the number of CPUs.
- `--only TYPE,TYPE`: introspect a subset.
- `--dylib-dir DIR`: load every module library by its full path in DIR, for
  libraries outside QBox's build such as wizard models. `tools/model-build`
  passes `--qbox-src <model> --libdir <model>/build --dylib-dir <model>/build`.
  The source scan also covers a model folder's `src` and `include`.

Regenerate `catalog/qbox-catalog.json` whenever the pinned QBox commit
changes. The catalog records the commit it was generated from. It does not
record the folders of the machine: where they would appear (`qbox.libdir`, the
logs of types that could not be introspected, parameter defaults derived from
the program's location) the tool writes `<qbox>`, `<libdir>`, `<qbox-catalog>`
or `~` instead.

## How it works

1. Scans QBox sources for `GSC_MODULE_REGISTER(TYPE, args...)` to get each
   type's constructor argument types. For `sc_object*` arguments it finds the
   class expected, from a typed constructor overload of the same arity or from
   the `dynamic_cast`s in the constructor.
2. Loads every module library (`*.so` with `module_register`) in the build
   directory and lists the registered factories.
3. For each type, runs itself in a child process that builds a container
   with the module (named `dut`) and whatever its constructor needs (a QEMU
   instance, a `qemu_gpex`, a CPU, ...), then walks the object tree and the CCI
   broker. Nothing is elaborated or simulated, so QEMU is never initialised and
   architectures without a built libqemu can still be introspected.

`hints.json` covers what the sources cannot tell: argument classes the scanner
cannot resolve, and parameters a constructor refuses to run without. The
latter are listed in the catalog as `requiredParams`.

## Limits

- Port vectors (`sc_vector`) are sized by parameters; the catalog records them
  as vectors with their size at default parameters (often 0). The checker
  accepts `<name>_<index>` for them.
- Ports or parameters created after construction (for example in
  `before_end_of_elaboration`) are not seen.
- `log_level` is accepted on every module; it belongs to the logger.
- Modules that load external code in their constructor
  (`component_constructor`, `python_binder`) and generic containers
  (`ContainerWithArgs`, `generic_lua_model`) are listed but not introspected.
