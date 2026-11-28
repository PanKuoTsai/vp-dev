#!/usr/bin/env bash
# Check the host tools and development libraries QBox's build needs, before
# CMake or libqemu's configure stops halfway with one missing package.
#
# usage: tools/qbox-pin/check-deps.sh [--preset NAME] [--tsv]
#   --preset NAME   the CMake preset (gcc*, clang*, clang-lto): which compiler
#   --tsv           one line per check, tab-separated, for VP Studio:
#                     ok|missing|old <TAB> what <TAB> package <TAB> note
#                   then "distro <TAB> ID <TAB> ID_LIKE"
# Exit code: 0 everything is there, 1 something is missing.
#
# The list follows QBox's CMakeLists.txt (libelf, libzip, glib-2.0, libfdt,
# asio, Python), the features its libqemu configure enables (sdl, opengl,
# vnc-jpeg, slirp, virglrenderer; pixman) and the build tools. Package names
# are Ubuntu/Debian ones, as in QBox's scripts/install_dependencies.sh.
# pkg-config honours PKG_CONFIG_PATH, so libraries outside /usr are found.
set -u

preset=gcc
tsv=0
while [ $# -gt 0 ]; do
  case "$1" in
    --preset) preset="$2"; shift 2 ;;
    --tsv) tsv=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

missing=()
report() { # state what package note
  if [ "$tsv" = 1 ]; then printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}"; fi
  [ "$1" = ok ] || missing+=("$3|$2|${4:-}")
}
have() { command -v "$1" >/dev/null 2>&1; }
program() { # command package [note]
  if have "$1"; then report ok "$1" "$2"; else report missing "$1" "$2" "${3:-}"; fi
}
module() { # pkg-config module package [note]
  if have pkg-config && pkg-config --exists "$1" 2>/dev/null; then report ok "$1" "$2"
  else report missing "$1" "$2" "${3:-}"; fi
}
header() { # header package [note]: in pkg-config's or the usual include folders
  local d
  for d in /usr/include /usr/local/include /usr/include/*-linux-gnu; do
    if [ -f "$d/$1" ]; then report ok "$1" "$2"; return; fi
  done
  report missing "$1" "$2" "${3:-}"
}

# Build tools
if have cmake; then
  v=$(cmake --version 2>/dev/null | sed -n '1s/[^0-9]*\([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
  major=${v%%.*}; minor=${v#*.}
  if [ -n "$v" ] && { [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 21 ]; }; }; then report ok cmake cmake
  else report old cmake cmake "version ${v:-unknown}; QBox's presets need 3.21 or newer"; fi
else
  report missing cmake cmake
fi
program make make
program git git
program pkg-config pkg-config
program ninja ninja-build "libqemu's build runs ninja"
case "$preset" in
  *clang*)
    program clang clang
    program clang++ clang
    case "$preset" in *lto*) program ld.lld lld "the clang-lto preset links with lld" ;; esac
    ;;
  *)
    program gcc gcc
    program g++ g++
    ;;
esac
if have python3; then
  report ok python3 python3
  if python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then report ok 'python3 venv' python3-venv
  else report missing 'python3 venv' python3-venv "libqemu's configure creates a Python venv"; fi
  if python3 -c 'import os, sysconfig, sys; sys.exit(0 if os.path.exists(os.path.join(sysconfig.get_paths()["include"], "Python.h")) else 1)' >/dev/null 2>&1; then
    report ok Python.h python3-dev
  else
    report missing Python.h python3-dev "QBox's Python binder"
  fi
else
  report missing python3 python3
  report missing 'python3 venv' python3-venv
  report missing Python.h python3-dev
fi

# Libraries: QBox's CMakeLists.txt
module libelf libelf-dev
module libzip libzip-dev
module glib-2.0 libglib2.0-dev
if have pkg-config && pkg-config --exists libfdt 2>/dev/null; then report ok libfdt.h libfdt-dev; else header libfdt.h libfdt-dev; fi
header asio.hpp libasio-dev "char_backend_socket"
# Libraries: what QBox's libqemu configure enables
module pixman-1 libpixman-1-dev
module slirp libslirp-dev "libqemu: user networking"
module sdl2 libsdl2-dev "libqemu: SDL display"
module epoxy libepoxy-dev "libqemu: OpenGL"
module libjpeg libjpeg-dev "libqemu: VNC JPEG"
module virglrenderer libvirglrenderer-dev "libqemu: virgl"

id="" like=""
if [ -r /etc/os-release ]; then
  id=$(. /etc/os-release; echo "${ID:-}")
  like=$(. /etc/os-release; echo "${ID_LIKE:-}")
fi
[ "$tsv" = 1 ] && printf 'distro\t%s\t%s\n' "$id" "$like"

[ ${#missing[@]} -eq 0 ] && exit 0
if [ "$tsv" = 0 ]; then
  echo "QBox's build needs packages this host does not have:" >&2
  pkgs=()
  for m in "${missing[@]}"; do
    IFS='|' read -r pkg what note <<<"$m"
    echo "  $what  (package $pkg${note:+; $note})" >&2
    case " ${pkgs[*]-} " in *" $pkg "*) ;; *) pkgs+=("$pkg") ;; esac
  done
  case " $id $like " in
    *" debian "*|*" ubuntu "*)
      echo "Install them with:" >&2
      echo "  sudo apt install ${pkgs[*]}" >&2 ;;
    *)
      echo "Install them with your distribution's package manager (the names above are Ubuntu's)," >&2
      echo "or see QBox's scripts/install_dependencies.sh." >&2 ;;
  esac
fi
exit 1
