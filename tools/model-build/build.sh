#!/usr/bin/env bash
# Build a model made by the VP Studio modeling wizard against a QBox build,
# without changing QBox:
#   1. src/*.cc            -> build/<name>.so   (+ build/<name>.json: which QBox)
#   2. test/*_selftest.cc  -> build/<name>_selftest, then run it
#   3. build/<name>.catalog.json: the model's entry for the component catalog
#
# usage: tools/model-build/build.sh <qbox-build-dir> <model-dir> [--no-test] [--no-catalog]
#
# The compiler flags and link lines are copied from QBox's own build: the
# keep_alive module library for the model, platforms-vp for the self-test.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
studio="$(cd "$here/../.." && pwd)"
build="$(cd "${1:?usage: build.sh <qbox-build-dir> <model-dir> [--no-test] [--no-catalog]}" && pwd)"
model="$(cd "${2:?usage: build.sh <qbox-build-dir> <model-dir>}" && pwd)"
shift 2
test=1
catalog=1
for a in "$@"; do
  case "$a" in
    --no-test) test=0 ;;
    --no-catalog) catalog=0 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

spec="$(ls "$model"/*.model.json 2>/dev/null | head -1)"
[ -n "$spec" ] || { echo "no *.model.json in $model" >&2; exit 1; }
name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$spec")"
out="$model/build"
mkdir -p "$out"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

[ -f "$build/compile_commands.json" ] || { echo "no compile_commands.json in $build (build QBox first)" >&2; exit 1; }

# Print "<directory> <command>" compiling SRC to OBJ with the flags QBox used for REF,
# plus -I for the model's include folder.
compile_cmd() { # ref src obj
  python3 - "$build/compile_commands.json" "$1" "$2" "$3" "$model/include" <<'EOF'
import json, shlex, sys
db, ref, src, obj, inc = sys.argv[1:]
e = next(x for x in json.load(open(db)) if x["file"].endswith(ref))
args = e.get("arguments") or shlex.split(e["command"])
out, i = [], 0
while i < len(args):
    a = args[i]
    if a == "-o": out += ["-o", obj]; i += 2; continue
    if a == "-c": out += ["-c", src]; i += 2; continue
    if a.endswith(ref.split("/")[-1]) or a in ("-MD", "-MMD") or a.endswith("_EXPORTS"): i += 1; continue
    if a in ("-MT", "-MF"): i += 2; continue
    out.append(a); i += 1
out.insert(1, "-I" + inc)
print(e["directory"], shlex.join(out))
EOF
}

# 1. The module library, linked like keep_alive.so.
ref_dir="$build/systemc-components/keep_alive"
link_txt="$ref_dir/CMakeFiles/keep_alive.dir/link.txt"
[ -f "$link_txt" ] || { echo "no $link_txt (build QBox first)" >&2; exit 1; }
objs=()
for src in "$model"/src/*.cc; do
  obj="$tmp/$(basename "$src" .cc).o"
  read -r cdir ccmd < <(compile_cmd "keep_alive/src/keep_alive.cc" "$src" "$obj")
  echo "compiling $src"
  (cd "$cdir" && eval "$ccmd")
  objs+=("$obj")
done
lcmd="$(sed -e "s#\"\?CMakeFiles/keep_alive.dir/src/keep_alive.cc.o\"\?#${objs[*]}#" \
            -e "s#-o \.\./\.\./keep_alive\.so#-o $out/$name.so#" \
            -e "s#-soname,keep_alive\.so#-soname,$name.so#" "$link_txt")"
echo "linking $out/$name.so"
(cd "$ref_dir" && eval "$lcmd")
src_dir="$(sed -n 's/^CMAKE_HOME_DIRECTORY:INTERNAL=//p' "$build/CMakeCache.txt")"
commit="$(git -C "$src_dir" rev-parse HEAD 2>/dev/null || true)"
python3 - "$out/$name.json" "$commit" "$src_dir" "$build" <<'EOF'
import json, sys, datetime
out, commit, src, build = sys.argv[1:]
json.dump({"qbox": {"commit": commit or None, "source": src, "build": build},
           "built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")},
          open(out, "w"), indent=2)
EOF

# 2. The self-test, linked like platforms-vp, then run.
if [ "$test" = 1 ] && [ -f "$model/test/${name}_selftest.cc" ]; then
  ptxt="$build/platforms/CMakeFiles/platforms-vp.dir/link.txt"
  tobj="$tmp/selftest.o"
  read -r cdir ccmd < <(compile_cmd "platforms/src/main.cc" "$model/test/${name}_selftest.cc" "$tobj")
  echo "compiling the self-test"
  (cd "$cdir" && eval "$ccmd")
  tcmd="$(sed -e "s#\"\?CMakeFiles/platforms-vp.dir/src/main.cc.o\"\?#$tobj#" -e "s#-o \.\./platforms-vp#-o $out/${name}_selftest#" "$ptxt") -ldl"
  (cd "$build/platforms" && eval "$tcmd")
  echo "running the self-test"
  "$out/${name}_selftest" 2>&1 | grep -v -e '^$' -e 'SystemC' -e 'Copyright' -e 'ALL RIGHTS RESERVED' || true
  "$out/${name}_selftest" > /dev/null 2>&1 || { echo "self-test failed" >&2; exit 3; }
fi

# 3. The catalog entry, introspected from the built library like QBox's own modules.
if [ "$catalog" = 1 ]; then
  tool="${VP_QBOX_CATALOG:-$studio/tools/qbox-catalog/qbox-catalog}"
  if [ ! -x "$tool" ]; then
    mkdir -p "$(dirname "$tool")"
    echo "building the catalog tool"
    bash "$studio/tools/qbox-catalog/build.sh" "$build" "$tool"
  fi
  "$tool" --qbox-src "$model" --libdir "$out" --only "$name" --jobs 1 \
      --dylib-dir "$out" --hints "$studio/tools/qbox-catalog/hints.json" --out "$out/$name.catalog.json"
fi
echo "built $out/$name.so"
