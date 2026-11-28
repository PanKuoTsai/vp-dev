# Container image

A container image with QBox at the pinned commit (see
[`tools/qbox-pin`](../qbox-pin/README.md)), plus the sim agent and component
catalog built against it. The image is built by `tools/qbox-pin/build-qbox.sh`,
the same script used for a local build.

> **Status:** these files have not been built or run yet. The development
> machine has neither docker nor podman. `build-qbox.sh` itself was verified
> with a clean clone on the host.

## Build

```sh
tools/container/build-image.sh [--jobs N]
```

The image is tagged `vp-studio-qbox:qbox-<first 12 characters of the commit>`.
It uses docker, or podman if docker is missing; set `VP_CONTAINER_ENGINE` to
choose. The build fetches QBox and its dependencies and compiles QEMU, so
expect it to take a long time.

## Run from VP Studio

1. Copy the sim agent and catalog out of the image:

   ```sh
   tools/container/extract.sh ~/.vp-studio/qbox-1dd01f4b1fbf
   ```

2. Set the VS Code settings. Use absolute paths; `~` is not expanded.

   ```jsonc
   "vpStudio.executable": "/abs/path/to/vp-studio/tools/container/run.sh",
   "vpStudio.simAgent.library": "/home/me/.vp-studio/qbox-1dd01f4b1fbf/sim_agent.so",
   "vpStudio.catalog": "/home/me/.vp-studio/qbox-1dd01f4b1fbf/qbox-catalog.json"
   ```

3. Export `VP_QBOX_MOUNTS` with the absolute path of that directory, so the
   simulator in the container sees the agent at the same path.

What `run.sh` sets up:
- **Files.** It mounts the working directory at the same path, so the
  generated Lua and the platform's firmware resolve as on the host. Add other
  directories to `VP_QBOX_MOUNTS`, separated by `:`.
- **Network.** It uses host networking, so the sim agent, gdb ports and QEMU
  host forwarding (`ssh -p 2222`) behave as with a local simulator.
- **Stopping.**
  - Closing the terminal stops the container. This is what Stop Simulation
    does.
  - Ctrl-\ also works, through `--init`.

The QBox version check cannot see into the container. With `run.sh` as the
executable, it only reports that it cannot tell which QBox the simulator was
built from.

## A container you can only `docker exec` into

When QBox lives in a container somebody else runs (no `--network host`, no
published ports), VP Studio's remote simulation can still use it: run
`container-sshd.sh` on the server to start an SSH server of your own inside the
container, and reach it with `ProxyJump` through the server. VP Studio then
treats the container as the remote host (commands, free ports, `-L` forwards
all inside the container). Step-by-step instructions, including the Windows
(WSL2) side, are in INSTALL.md section 11.

```sh
bash container-sshd.sh --key /tmp/vp-key.pub <container>   # prints the ~/.ssh/config entry
bash container-sshd.sh --stop <container>
```

Only `~/.vp-sshd/` and `~/.ssh/environment` are written inside the container
(plus `/run/sshd` as root). Without an sshd there, it is fetched with
`apt-get download openssh-server` and unpacked, not installed. Verified with a
stand-in for docker on Linux; not yet with real Docker.
