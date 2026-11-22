# Tools

Everything here is part of the packaged extension. QBox runs on the user's
machine, in a version only that machine knows, so what has to match it is
shipped as source and built there.

## Built on the machine that runs the simulator

| Folder | What | Built by |
|---|---|---|
| `sim-agent/` | The sim agent: a QBox module (C++) added to every simulation, for pause, parameters, tracing, profiling and checkpoints. | **Build Sim Agent**, or `sim-agent/build.sh <qbox>/build` |
| `qbox-catalog/` | The tool (C++) that reads module types, ports and parameters out of a QBox build and writes a component catalog. | **Build Model** (for a model's catalog entry), `qbox-pin/build-qbox.sh`, or `qbox-catalog/build.sh` |
| `model-build/` | Builds a modeling wizard model: its library, its self-test and its catalog entry. | **Build Model**, or `model-build/build.sh` |
| `qbox-pin/` | Builds the QBox commit of `qbox.pin.json` from a clean clone, with the patches, the sim agent and the catalog. | **Build QBox**, or `qbox-pin/build-qbox.sh` |

Their outputs (`*.so`, the `qbox-catalog` program, `build/`) are not in the
repository and not in the package: `.gitignore` and `.vscodeignore` name them.

## Used as they are

| Folder | What | Used by |
|---|---|---|
| `gdb/` | `vp-linux.py`: Linux awareness for gdb (KASLR offset, `vp-ps`, `vp-dmesg`). | Loaded into target debug sessions by the extension |
| `vp-py/` | `vpstudio.py`: a Python client of the sim agent, standard library only. | Test scripts, for example under `vp-run --exec` |
| `container/` | The container image of the pinned QBox: Dockerfile and the scripts to build it, run the simulator in it and reach it over ssh. | Whoever sets up a machine or a server with the container |

## For maintainers

| Folder | What |
|---|---|
| `askpass/` | The source of `prebuilt/win32/vp-askpass.exe` and the script that builds it with mingw-w64. Users get the built program; see `prebuilt/README.md`. |

Each folder with more to say has its own README.
