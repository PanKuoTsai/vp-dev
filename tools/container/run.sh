#!/usr/bin/env bash
# Run platforms-vp from the container image, as if it were installed locally.
# Set "vpStudio.executable" to this script's absolute path.
#
# - The current directory is mounted at the same path, so the generated Lua and
#   the platform's files resolve as on the host. Further directories (the sim
#   agent, firmware elsewhere) go in VP_QBOX_MOUNTS, ":"-separated.
# - Host networking: the sim agent, gdb ports and QEMU host forwarding are
#   reachable on the host's ports as with a local simulator.
# - Closing the terminal (VP Studio's Stop Simulation) stops the container.
#
# VP_QBOX_IMAGE overrides the image (default: the pinned one), and
# VP_CONTAINER_ENGINE the engine (default: docker, else podman).
set -uo pipefail
studio="$(cd "$(dirname "$0")/../.." && pwd)"
engine="${VP_CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}"
[ -n "$engine" ] || { echo "neither docker nor podman found (set VP_CONTAINER_ENGINE)" >&2; exit 1; }
image="${VP_QBOX_IMAGE:-$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["image"]["name"]+":qbox-"+d["qbox"]["commit"][:12])' "$studio/qbox.pin.json")}"
mounts=(-v "$PWD:$PWD")
IFS=: read -ra extra <<< "${VP_QBOX_MOUNTS:-}"
for d in "${extra[@]}"; do [ -n "$d" ] && mounts+=(-v "$d:$d"); done
tty=(); [ -t 0 ] && tty=(-it)
name="vp-qbox-$$"
# A closed terminal hangs up the docker client but not the container.
trap '"$engine" kill --signal HUP "$name" >/dev/null 2>&1' HUP TERM
"$engine" run --rm --init --name "$name" --network host "${tty[@]}" "${mounts[@]}" -w "$PWD" \
    "$image" platforms-vp "$@"
