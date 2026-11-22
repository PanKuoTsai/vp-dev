#!/usr/bin/env bash
# Build lib/sim/vp-askpass.exe (the SSH_ASKPASS launcher for VS Code on Windows)
# with the mingw-w64 cross compiler:
#   sudo apt install gcc-mingw-w64-x86-64
# or, without sudo, unpack gcc-mingw-w64-x86-64-win32, gcc-mingw-w64-base,
# binutils-mingw-w64-x86-64, mingw-w64-x86-64-dev and mingw-w64-common with
# "apt-get download" + "dpkg -x" and put their usr/bin on PATH.
# The .exe is committed next to lib/sim/askpass.js, so this is needed only after
# changing vp-askpass.c.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cc="$(command -v x86_64-w64-mingw32-gcc || command -v x86_64-w64-mingw32-gcc-win32 || command -v x86_64-w64-mingw32-gcc-13-win32 || true)"
[ -n "$cc" ] || { echo "no mingw-w64 C compiler (x86_64-w64-mingw32-gcc)" >&2; exit 1; }
"$cc" -Os -s -municode -mwindows -Wall -Wextra -o "$here/../../lib/sim/vp-askpass.exe" "$here/vp-askpass.c"
echo "built lib/sim/vp-askpass.exe ($(stat -c %s "$here/../../lib/sim/vp-askpass.exe") bytes)"
