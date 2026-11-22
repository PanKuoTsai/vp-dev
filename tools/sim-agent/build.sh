#!/usr/bin/env bash
# Build sim_agent.so against an existing QBox build.
#
# The compiler flags and link line are copied from QBox's own keep_alive
# module library (compile_commands.json and link.txt), so the agent uses
# exactly the headers, defines and libraries of the QBox build that loads it.
#
# The agent links to QBox's vp_probes component (systemc-components/probes:
# the tracers and the trace store they share with the agent), so QBox must be
# built with it: cmake --build <qbox-build-dir> --target probes.
#
# usage: tools/sim-agent/build.sh <qbox-build-dir> [output.so]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
build="$(cd "${1:?usage: build.sh <qbox-build-dir> [output.so]}" && pwd)"
out="${2:-$here/sim_agent.so}"
mkdir -p "$(dirname "$out")"
src="$here/sim_agent.cc"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
obj="$tmp/sim_agent.o"

src_dir="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$build/CMakeCache.txt")"
probes_inc="$src_dir/systemc-components/probes/include"
probes_lib="$build/probes.so"
if [ ! -f "$probes_inc/probes.h" ]; then
  echo "QBox at $src_dir has no probes component (systemc-components/probes)." >&2
  echo "Apply VP Studio's patch patches/qbox/0002-vp-studio-probes-debug-dap.patch to it and build QBox" >&2
  echo "(VP Studio: Build QBox does both), or: git -C $src_dir apply <vp-studio>/patches/qbox/0002-vp-studio-probes-debug-dap.patch" >&2
  exit 1
fi
if [ ! -f "$probes_lib" ]; then
  echo "no $probes_lib: build it first with: cmake --build $build --target probes" >&2
  exit 1
fi
ref_dir="$build/systemc-components/keep_alive"
link_txt="$ref_dir/CMakeFiles/keep_alive.dir/link.txt"
[ -f "$build/compile_commands.json" ] || { echo "no compile_commands.json in $build" >&2; exit 1; }
[ -f "$link_txt" ] || { echo "no $link_txt (build QBox first)" >&2; exit 1; }

# RapidJSON comes with SystemC CCI. CPM puts its sources in build/_deps unless
# QBox was configured with a source cache (CPM_SOURCE_CACHE, for example
# <qbox>/packages); CMakeCache.txt records where they really are.
# VP_RAPIDJSON_INCLUDE overrides the search.
cache_var() { sed -n "s/^$1:[A-Z]*=//p" "$build/CMakeCache.txt" 2>/dev/null | head -1; }
rj_rel="configuration/src/rapidjson/include"
candidates=()
[ -n "${VP_RAPIDJSON_INCLUDE:-}" ] && candidates+=("$VP_RAPIDJSON_INCLUDE")
for v in SystemCCCI_SOURCE_DIR CPM_PACKAGE_SystemCCCI_SOURCE_DIR FETCHCONTENT_SOURCE_DIR_SYSTEMCCCI; do
  d="$(cache_var "$v")"; [ -n "$d" ] && candidates+=("$d/$rj_rel")
done
candidates+=("$build/_deps/systemccci-src/$rj_rel")
rapidjson=""
for c in "${candidates[@]}"; do
  if [ -f "$c/rapidjson/rapidjson.h" ]; then rapidjson="$c"; break; fi
done
if [ -z "$rapidjson" ]; then
  # Last resort: look in the CPM source cache, if QBox used one.
  cpm="$(cache_var CPM_SOURCE_CACHE)"
  if [ -n "$cpm" ] && [ "$cpm" != OFF ] && [ -d "$cpm" ]; then
    h="$(find "$cpm" -path '*/configuration/src/rapidjson/include/rapidjson/rapidjson.h' -print -quit 2>/dev/null || true)"
    [ -n "$h" ] && rapidjson="$(dirname "$(dirname "$h")")"
  fi
fi
if [ -z "$rapidjson" ]; then
  echo "no RapidJSON headers (rapidjson/rapidjson.h) found; looked in:" >&2
  printf '  %s\n' "${candidates[@]}" >&2
  echo "Set VP_RAPIDJSON_INCLUDE to the directory that contains rapidjson/rapidjson.h." >&2
  exit 1
fi
echo "RapidJSON headers: $rapidjson"

# Compile command of keep_alive.cc, with our source and object swapped in.
read -r cdir ccmd < <(python3 - "$build/compile_commands.json" "$src" "$obj" "$rapidjson" "$probes_inc" <<'EOF'
import json, shlex, sys
db, src, obj, rj, probes = sys.argv[1:]
e = next(x for x in json.load(open(db)) if x["file"].endswith("keep_alive/src/keep_alive.cc"))
args = e.get("arguments") or shlex.split(e["command"])
out, i = [], 0
while i < len(args):
    a = args[i]
    if a == "-o": out += ["-o", obj]; i += 2; continue
    if a == "-c": out += ["-c", src]; i += 2; continue
    if a.endswith("keep_alive.cc") or a == "-Dkeep_alive_EXPORTS" or a in ("-MD", "-MMD"): i += 1; continue
    if a in ("-MT", "-MF"): i += 2; continue
    out.append(a); i += 1
out.insert(1, "-I" + rj)
out.insert(1, "-I" + probes)
out.append("-pthread")
print(e["directory"], shlex.join(out))
EOF
)
echo "compiling $src"
(cd "$cdir" && eval "$ccmd")

# Link line of keep_alive.so, with our object, output and soname swapped in.
# It uses paths relative to the keep_alive build directory, so run it there.
lcmd="$(sed -e "s#\"\?CMakeFiles/keep_alive.dir/src/keep_alive.cc.o\"\?#$obj#" \
            -e "s#-o \.\./\.\./keep_alive\.so#-o $out#" \
            -e "s#-soname,keep_alive\.so#-soname,sim_agent.so#" "$link_txt") -pthread $probes_lib -Wl,-rpath,$build"
echo "linking $out"
(cd "$ref_dir" && eval "$lcmd")

# Record the QBox it was built against next to it (sim_agent.json), so VP
# Studio can tell when the library and the simulator come from different
# commits (the module ABI is not stable across QBox versions).
commit="$(git -C "$src_dir" rev-parse HEAD 2>/dev/null || true)"
version="$(sed -n 's/^const char\* const AGENT_VERSION = "\(.*\)";/\1/p' "$src")"
python3 - "${out%.so}.json" "$commit" "$src_dir" "$build" "$version" <<'EOF'
import json, sys, datetime
out, commit, src, build, version = sys.argv[1:]
json.dump({"version": version or None, "qbox": {"commit": commit or None, "source": src, "build": build},
           "built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")},
          open(out, "w"), indent=2)
EOF
echo "built $out (QBox ${commit:-unknown commit})"
