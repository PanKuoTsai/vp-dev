#!/usr/bin/env bash
# Build the QBox commit pinned in qbox.pin.json, plus the VP Studio pieces
# built against it (sim agent, component catalog).
#
# usage: tools/qbox-pin/build-qbox.sh [options] DEST
#   DEST              QBox checkout to create or reuse (cloned if missing)
#   --jobs N          parallel build jobs (default: number of CPUs)
#   --targets LIST    libqemu targets, ";"-separated (default: from the pin)
#   --no-catalog      do not regenerate the component catalog
#   --no-agent        do not build the sim agent
#   --preset NAME     CMake configure preset (default: from the pin)
#   --no-patches      do not apply VP Studio's patches
#   --no-checkout     build DEST as it is when it is not at the pinned commit
#                     (default: check out the pinned commit, if DEST has no
#                     local changes to tracked files)
#   --cpm-cache DIR   CPM source cache for QBox's dependencies, given to the
#                     first configure as -DCPM_SOURCE_CACHE (default: QBox's
#                     own choice: DEST/Packages when it exists, else build/_deps)
#
# Results:
#   DEST/build/platforms-vp          the simulator and its module libraries
#   DEST/vp-studio/sim_agent.so      sim agent for this build (not with --no-agent)
#   DEST/vp-studio/qbox-catalog.json component catalog of this build (not with --no-catalog)
#   DEST/build/vp-studio-build-info.json  what was built, from which commit
# With --no-agent and --no-catalog nothing is written outside DEST/build, so
# the QBox source tree gets no untracked folder.
#
# QBox's own CMake fetches SystemC, CCI, SCP and libqemu at versions fixed by
# its package-lock.cmake, so the QBox commit pins all of them. The build needs
# network access and the packages of QBox's scripts/install_dependencies.sh.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
studio="$(cd "$here/../.." && pwd)"
pin="$studio/qbox.pin.json"
jobs="$(nproc)"
targets=""
catalog=1
agent=1
cpm=""
preset_opt=""
patching=1
checkout=1
dest=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jobs) jobs="$2"; shift 2 ;;
    --targets) targets="$2"; shift 2 ;;
    --no-catalog) catalog=0; shift ;;
    --no-agent) agent=0; shift ;;
    --cpm-cache) cpm="$2"; shift 2 ;;
    --preset) preset_opt="$2"; shift 2 ;;
    --no-patches) patching=0; shift ;;
    --no-checkout) checkout=0; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) dest="$1"; shift ;;
  esac
done
[ -n "$dest" ] || { echo "usage: build-qbox.sh [--jobs N] [--targets LIST] [--preset NAME] [--cpm-cache DIR] [--no-patches] [--no-checkout] [--no-catalog] [--no-agent] DEST" >&2; exit 2; }

pinval() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); v=eval("d"+sys.argv[2]); print(";".join(v) if isinstance(v,list) else v)' "$pin" "$1"; }
repo="$(pinval '["qbox"]["repository"]')"
commit="$(pinval '["qbox"]["commit"]')"
preset="${preset_opt:-$(pinval '["build"]["preset"]')}"
[ -n "$targets" ] || targets="$(pinval '["build"]["libqemuTargets"]')"
mapfile -t patches < <(python3 -c 'import json,sys; [print(p) for p in json.load(open(sys.argv[1]))["qbox"]["patches"]]' "$pin")

echo "== QBox $commit from $repo"
if [ ! -d "$dest/.git" ]; then
  mkdir -p "$dest"
  git -C "$dest" init -q
  git -C "$dest" remote add origin "$repo"
fi
dest="$(cd "$dest" && pwd)"
if ! git -C "$dest" cat-file -e "$commit^{commit}" 2>/dev/null; then
  git -C "$dest" fetch -q --depth 1 origin "$commit"
fi
head="$(git -C "$dest" rev-parse -q --verify HEAD 2>/dev/null || true)"
if [ "$head" = "$commit" ]; then
  # Already there, possibly with the patches applied by an earlier run.
  echo "== already at $commit"
elif [ "$checkout" = 0 ] && [ -n "$head" ]; then
  echo "== $dest is at $head, not the pinned $commit: building it as it is (--no-checkout)"
else
  if [ -n "$(git -C "$dest" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    echo "$dest has local changes to tracked files; refusing to check out over them" >&2
    exit 1
  fi
  git -C "$dest" -c advice.detachedHead=false checkout -q "$commit"
fi

[ "$patching" = 1 ] || { patches=(); echo "== not applying VP Studio's patches (--no-patches)"; }
# apply-patch.sh: applied already, not applied, or an earlier version of the
# patch applied (VP Studio was updated since this QBox was patched).
. "$here/apply-patch.sh"
for p in ${patches[@]+"${patches[@]}"}; do
  vp_apply_patch "$dest" "$studio/$p" "$p"
done

cpm_args=()
if [ -n "$cpm" ]; then
  mkdir -p "$cpm"
  cpm_args=(-DCPM_SOURCE_CACHE="$(cd "$cpm" && pwd)")
fi
echo "== configure (preset $preset, libqemu targets $targets${cpm:+, CPM cache $cpm})"
(cd "$dest" && cmake --preset "$preset" -DLIBQEMU_TARGETS="$targets" ${cpm_args[@]+"${cpm_args[@]}"})
# libqemu is fetched by the configure step, into build/_deps/libqemu-src unless
# QBox uses a CPM source cache (CPM_SOURCE_CACHE); CMakeCache.txt says where.
mapfile -t qpatches < <(python3 -c 'import json,sys; [print(p) for p in json.load(open(sys.argv[1])).get("libqemu", {}).get("patches", [])]' "$pin")
[ "$patching" = 1 ] || qpatches=()
lq="$(sed -n 's/^libqemu_SOURCE_DIR:[A-Z]*=//p' "$dest/build/CMakeCache.txt" 2>/dev/null | head -1)"
[ -n "$lq" ] || lq="$dest/build/_deps/libqemu-src"
for p in ${qpatches[@]+"${qpatches[@]}"}; do
  f="$studio/$p"
  [ -d "$lq" ] || { echo "no $lq after configure; cannot apply $p" >&2; exit 1; }
  vp_apply_patch "$lq" "$f" "$p (libqemu)"
done
echo "== build ($jobs jobs)"
cmake --build "$dest/build" -j "$jobs"
[ -x "$dest/build/platforms-vp" ] || { echo "build finished without build/platforms-vp" >&2; exit 1; }

out="$dest/vp-studio"
if [ "$agent" = 1 ] || [ "$catalog" = 1 ]; then mkdir -p "$out"; fi
if [ "$agent" = 1 ]; then
  echo "== sim agent"
  bash "$studio/tools/sim-agent/build.sh" "$dest/build" "$out/sim_agent.so"
fi

if [ "$catalog" = 1 ]; then
  echo "== component catalog"
  bash "$studio/tools/qbox-catalog/build.sh" "$dest/build" "$out/qbox-catalog-tool"
  "$out/qbox-catalog-tool" --qbox-src "$dest" --libdir "$dest/build" --jobs "$jobs" \
      --hints "$studio/tools/qbox-catalog/hints.json" --out "$out/qbox-catalog.json"
  # Compare with the catalog bundled with the extension: they should list the
  # same module types when the bundled one was made from the pinned commit.
  python3 - "$studio/catalog/qbox-catalog.json" "$out/qbox-catalog.json" <<'EOF'
import json, sys
a, b = (json.load(open(f)) for f in sys.argv[1:3])
ta, tb = set(a["modules"]), set(b["modules"])
print(f"bundled catalog: {len(ta)} types from {a['qbox']['commit'][:12]}; this build: {len(tb)} types")
if ta - tb: print("  only in the bundled catalog:", ", ".join(sorted(ta - tb)))
if tb - ta: print("  only in this build:", ", ".join(sorted(tb - ta)))
EOF
fi

python3 - "$dest/build/vp-studio-build-info.json" "$commit" "$repo" "$targets" ${patches[@]+"${patches[@]}"} -- ${qpatches[@]+"${qpatches[@]}"} <<'EOF'
import json, sys, datetime
out, commit, repo, targets, *rest = sys.argv[1:]
cut = rest.index("--")
patches, qpatches = rest[:cut], rest[cut + 1:]
json.dump({"qbox": {"commit": commit, "repository": repo, "patches": patches}, "libqemu": {"patches": qpatches},
           "libqemuTargets": targets.split(";"),
           "built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")},
          open(out, "w"), indent=2)
EOF
echo "== done: $dest/build/platforms-vp"
