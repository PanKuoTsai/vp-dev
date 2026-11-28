#!/usr/bin/env bash
# Rebuild the three tutorial programs from vplogger.c with an AArch64 cross
# compiler (Ubuntu: sudo apt install gcc-aarch64-linux-gnu). VP Studio ships
# them built; rebuild only after changing the source.
#
# usage: build.sh [output-dir]   (default: the bin folder next to this script)
#
# Dynamically linked against the guest's glibc, non-PIE (the symbols are at
# their link addresses), with debug information for Load Symbols.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/bin}"
cc="${CC:-aarch64-linux-gnu-gcc}"
command -v "$cc" >/dev/null || { echo "no $cc: sudo apt install gcc-aarch64-linux-gnu" >&2; exit 1; }
mkdir -p "$out"
# The debug information names the source /vplogger/vplogger.c (not this machine's path).
flags=(-std=gnu11 -O1 -g -fno-omit-frame-pointer -no-pie -Wall -Wextra "-ffile-prefix-map=$here=/vplogger")
cd "$here"
"$cc" "${flags[@]}" -o "$out/vplogger-bug" vplogger.c
"$cc" "${flags[@]}" -DFIX_OFFLINE -o "$out/vplogger-fix1" vplogger.c
"$cc" "${flags[@]}" -DFIX_OFFLINE -DFIX_BUFFERED -o "$out/vplogger-fix2" vplogger.c
ls -l "$out"/vplogger-*
