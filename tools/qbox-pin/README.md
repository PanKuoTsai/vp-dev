# QBox version pinning

Each VP Studio release is tested with one QBox commit. The commit is recorded
in [`qbox.pin.json`](../../qbox.pin.json) at the root of the extension:

| Field | Meaning |
|---|---|
| `qbox.repository`, `qbox.commit` | The tested QBox (full 40-character hash). |
| `qbox.patches` | Patch files (paths relative to the extension) applied to the QBox tree, in order. |
| `libqemu.patches` | Patch files applied to libqemu, which QBox's CMake fetches into `build/_deps/libqemu-src` (tag `libqemu.tag`; with a CPM source cache, the `libqemu_SOURCE_DIR` recorded in `build/CMakeCache.txt`). |
| `build.preset`, `build.libqemuTargets` | How it is built: the QBox CMake preset and the libqemu targets. |
| `image` | Name and base of the container image (see [`tools/container`](../container/README.md)). |
| `tested` | Platforms verified with this commit. |

QBox's `package-lock.cmake` fixes the versions of SystemC, CCI, SCP and libqemu,
so the QBox commit pins all of them.

## Build the pinned QBox

```sh
tools/qbox-pin/build-qbox.sh [--jobs N] [--targets "aarch64"] [--no-catalog] DIR
```

The script:
1. Clones QBox into `DIR`, or reuses it, and checks out the pinned commit. It
   refuses to check out over local changes to tracked files.
2. Applies the QBox patches (`apply-patch.sh`). A patch that is applied is
   left alone. When an earlier version of a patch is applied, because VP
   Studio was updated since, the files that differ are brought to this
   version: a file the patch adds is replaced, and the earlier one is kept in
   `DIR/build/vp-studio-replaced/`. If that cannot be done without touching
   QBox's own files, the script stops and changes nothing.
3. Configures with the preset (this fetches libqemu), applies the libqemu
   patches to `build/_deps/libqemu-src`, and builds.
4. Builds the sim agent against that build.
5. Regenerates the component catalog, unless `--no-catalog` is given. It
   compares the module types with the catalog bundled with the extension.

| Output | Contents |
|---|---|
| `DIR/build/platforms-vp` | The simulator and its module libraries. |
| `DIR/vp-studio/sim_agent.so` | The sim agent, plus its `sim_agent.json` (not with `--no-agent`). |
| `DIR/vp-studio/qbox-catalog.json` | The component catalog of this build (not with `--no-catalog`). |
| `DIR/build/vp-studio-build-info.json` | The commit, patches, targets and build time. |

With `--no-agent` and `--no-catalog` (the way VP Studio's Build QBox runs it)
nothing is written outside `DIR/build`: the QBox source tree gets no
untracked `vp-studio/` folder. Older versions wrote `DIR/vp-studio/build-info.json`;
that folder can be deleted.

The build needs network access (CMake fetches the dependencies) and the
packages listed in QBox's `scripts/install_dependencies.sh`.

`--targets` builds fewer libqemu targets, which is quicker. Module types for
the missing architectures still appear in the catalog.

To add the libqemu patches to a QBox that is already built (about 20 s):

```sh
git -C ~/qbox/build/_deps/libqemu-src apply $VPS/patches/libqemu/*.patch
cmake --build ~/qbox/build -j$(nproc)
```

## Version check in VS Code

When VP Studio starts a simulation, it compares four commits:
- the pinned commit;
- the commit of the simulator's QBox, read from the `CMakeCache.txt` of the
  build and then the git checkout of its source;
- the commit the component catalog was made from;
- the commit the sim agent was built against, read from `sim_agent.json`,
  which `tools/sim-agent/build.sh` writes next to the library.

Any mismatch shows a warning. Starting is not blocked. "Don't Show Again"
silences that exact set of mismatches. **VP Studio: Check QBox Version** writes
the full comparison to the VP Studio output.

The commits matter for different reasons:
- **Sim agent.** A mismatch can stop the simulator from loading it, or crash
  it, because the module ABI changes between QBox versions.
- **Catalog.** A mismatch makes the module, port and parameter checks
  unreliable.

## Changing the pinned commit

1. Update `qbox.commit` (and `date`) in `qbox.pin.json`.
2. Build it with `build-qbox.sh`.
3. Copy `DIR/vp-studio/qbox-catalog.json` to `catalog/qbox-catalog.json`.
4. Run the tests: `npm test`. One test checks that the bundled catalog comes
   from the pinned commit.
5. Boot the platforms listed in `tested` and update the list.
