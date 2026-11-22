#!/usr/bin/env bash
# Build the container image for the QBox commit pinned in qbox.pin.json.
# usage: tools/container/build-image.sh [--jobs N]     (docker, or podman)
# The image is tagged NAME:qbox-<first 12 characters of the commit>.
set -euo pipefail
studio="$(cd "$(dirname "$0")/../.." && pwd)"
engine="${VP_CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}"
[ -n "$engine" ] || { echo "neither docker nor podman found (set VP_CONTAINER_ENGINE)" >&2; exit 1; }
jobs=""
[ "${1:-}" = "--jobs" ] && jobs="$2"
read -r name commit base < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["image"]["name"], d["qbox"]["commit"], d["image"]["base"])' "$studio/qbox.pin.json")
tag="$name:qbox-${commit:0:12}"
"$engine" build -t "$tag" --build-arg BASE="$base" --build-arg JOBS="$jobs" -f "$studio/tools/container/Dockerfile" "$studio"
echo "built $tag"
