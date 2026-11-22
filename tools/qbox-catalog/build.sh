#!/usr/bin/env bash
# Build qbox-catalog against an existing QBox build, without changing QBox.
#
# The compiler flags and link line are copied from QBox's own platforms-vp
# target (compile_commands.json and link.txt), so the tool uses exactly the
# headers, defines and libraries of the QBox build it will introspect.
#
# usage: tools/qbox-catalog/build.sh <qbox-build-dir> [output-binary]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
build="$(cd "${1:?usage: build.sh <qbox-build-dir> [output]}" && pwd)"
out="${2:-$here/qbox-catalog}"
src="$here/qbox_catalog.cc"
obj="$(mktemp -d)/qbox_catalog.o"

link_txt="$build/platforms/CMakeFiles/platforms-vp.dir/link.txt"
[ -f "$build/compile_commands.json" ] || { echo "no compile_commands.json in $build" >&2; exit 1; }
[ -f "$link_txt" ] || { echo "no $link_txt (build platforms-vp first)" >&2; exit 1; }

# Compile command of platforms/src/main.cc, with our source and object swapped in.
read -r cdir ccmd < <(python3 - "$build/compile_commands.json" "$src" "$obj" <<'EOF'
import json, shlex, sys
db, src, obj = sys.argv[1:]
e = next(x for x in json.load(open(db)) if x["file"].endswith("platforms/src/main.cc"))
args = e.get("arguments") or shlex.split(e["command"])
out, i = [], 0
while i < len(args):
    a = args[i]
    if a == "-o": out += ["-o", obj]; i += 2; continue
    if a == "-c": out += ["-c", src]; i += 2; continue
    if a.endswith("main.cc") or a.startswith("-MF") or a in ("-MD", "-MMD"): i += 1; continue
    if a in ("-MT", "-MF"): i += 2; continue
    out.append(a); i += 1
print(e["directory"], shlex.join(out))
EOF
)
echo "compiling $src"
(cd "$cdir" && eval "$ccmd")

# Link line of platforms-vp, with our object and output swapped in. It uses
# paths relative to the platforms build directory, so run it from there.
lcmd="$(sed -e "s#\"\?CMakeFiles/platforms-vp.dir/src/main.cc.o\"\?#$obj#" -e "s#-o \.\./platforms-vp#-o $out#" "$link_txt")"
# libdl for dlopen of module libraries.
lcmd="$lcmd -ldl"
echo "linking $out"
(cd "$build/platforms" && eval "$lcmd")
rm -rf "$(dirname "$obj")"
echo "built $out"
