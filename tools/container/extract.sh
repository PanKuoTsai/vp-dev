#!/usr/bin/env bash
# Copy the sim agent and component catalog built in the image to a host
# directory, for "vpStudio.simAgent.library" and "vpStudio.catalog".
# Add the directory to VP_QBOX_MOUNTS so the simulator in the container finds
# the agent at the same path.
# usage: tools/container/extract.sh DIR
set -euo pipefail
studio="$(cd "$(dirname "$0")/../.." && pwd)"
dir="${1:?usage: extract.sh DIR}"
engine="${VP_CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}"
image="${VP_QBOX_IMAGE:-$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["image"]["name"]+":qbox-"+d["qbox"]["commit"][:12])' "$studio/qbox.pin.json")}"
mkdir -p "$dir"
id="$("$engine" create "$image")"
trap '"$engine" rm "$id" >/dev/null' EXIT
for f in sim_agent.so sim_agent.json qbox-catalog.json; do
  "$engine" cp "$id:/opt/qbox/vp-studio/$f" "$dir/$f"
done
"$engine" cp "$id:/opt/qbox/build/vp-studio-build-info.json" "$dir/build-info.json"
echo "copied to $dir: set vpStudio.simAgent.library to $dir/sim_agent.so and vpStudio.catalog to $dir/qbox-catalog.json"
