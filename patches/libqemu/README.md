# libqemu patches

QBox fetches libqemu (Qualcomm's QEMU) at configure time into
`build/_deps/libqemu-src` (or, when QBox uses a CPM source cache such as
`CPM_SOURCE_CACHE=<qbox>/packages`, the directory recorded as `libqemu_SOURCE_DIR`
in `build/CMakeCache.txt`); these patches go there, not into the QBox tree.
`tools/qbox-pin/build-qbox.sh` applies them after the configure step. "VP
Studio: Check QBox Version" says whether they are applied.

| Patch | Why |
|---|---|
| `0001-register-device-vmstate.patch` | Checkpoints (G-08). libqemu skips registering the state of its devices for savevm, so a checkpoint has only the CPUs and timers. The guest then hangs after a load, with the GIC in its reset state. The patch registers the state again; an idstr collision only warns. It exports `libqemu_device_vmstate`, which the sim agent checks for. |

By hand, on a QBox that is built already:

```sh
git -C <qbox>/build/_deps/libqemu-src apply <vp-studio>/patches/libqemu/0001-register-device-vmstate.patch
cmake --build <qbox>/build -j$(nproc)
```

The rebuild takes about 20 seconds. A fresh configure that fetches libqemu
again drops the patch: apply it again.

Upstream: the comment the patch removes says libqemu "does not drive savevm".
The patch is worth offering together with the reports in
`../qbox/UPSTREAM.md`.
