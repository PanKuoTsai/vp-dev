#!/usr/bin/env bash
# Put the tutorial programs into the guest's disk image, as /opt/vplogger/,
# without booting it (debugfs, from e2fsprogs). Run it while no simulation
# uses the image.
#
# usage: install-vplogger.sh [--backup] [--uninstall] IMAGE [BIN_DIR]
#   IMAGE      the guest's ext4 image (the platform's image_ext4.img)
#   BIN_DIR    folder with vplogger-bug, vplogger-fix1, vplogger-fix2
#              (default: vplogger/bin next to this script)
#   --backup   copy IMAGE to IMAGE.before-vplogger first (as large as the
#              image; sparse where the file system allows)
#   --uninstall  remove /opt/vplogger from the image instead
#
# Only /opt/vplogger is written; nothing else in the image changes. When the
# file system was not unmounted cleanly (the simulation was stopped without
# poweroff), e2fsck replays its journal first, as the guest would at boot.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
backup=0
uninstall=0
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --backup) backup=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
img="${args[0]:-}"
bin="${args[1]:-$here/vplogger/bin}"
[ -n "$img" ] || { echo "usage: install-vplogger.sh [--backup] [--uninstall] IMAGE [BIN_DIR]" >&2; exit 2; }
[ -f "$img" ] || { echo "no image $img" >&2; exit 1; }
PATH="$PATH:/sbin:/usr/sbin"
command -v debugfs >/dev/null || { echo "debugfs not found: sudo apt install e2fsprogs" >&2; exit 1; }

# A simulation holding the image: QEMU locks it (fcntl OFD lock).
if command -v fuser >/dev/null && fuser "$img" >/dev/null 2>&1; then
  echo "$img is in use (a simulation is running?); stop it first" >&2
  exit 1
fi

if [ "$backup" = 1 ]; then
  echo "== backup: $img.before-vplogger"
  cp --sparse=always "$img" "$img.before-vplogger"
fi

state=$(debugfs -R stats "$img" 2>/dev/null | sed -n 's/^Filesystem state: *//p')
features=$(debugfs -R stats "$img" 2>/dev/null | sed -n 's/^Filesystem features: *//p')
if [ "$state" != "clean" ] || [[ "$features" == *needs_recovery* ]]; then
  echo "== the file system has a journal to replay (the simulation was stopped without poweroff): e2fsck -p"
  e2fsck -p "$img" || { rc=$?; [ $rc -le 1 ] || { echo "e2fsck failed ($rc); run e2fsck -f $img yourself" >&2; exit 1; }; }
fi

if [ "$uninstall" = 1 ]; then
  cmds=""
  for f in vplogger-bug vplogger-fix1 vplogger-fix2 README; do cmds+="rm /opt/vplogger/$f"$'\n'; done
  cmds+="rmdir /opt/vplogger"$'\n'
  debugfs -w -f - "$img" <<<"$cmds" >/dev/null 2>&1 || true
  echo "== removed /opt/vplogger from $img"
  exit 0
fi

for f in vplogger-bug vplogger-fix1 vplogger-fix2; do
  [ -f "$bin/$f" ] || { echo "no $bin/$f" >&2; exit 1; }
done
readme=$(mktemp)
trap 'rm -f "$readme"' EXIT
cat >"$readme" <<'EOF'
VP Studio tutorial programs (Create Tutorial Workspace).
  /opt/vplogger/vplogger-bug    crashes partway through (act 1)
  /opt/vplogger/vplogger-fix1   works, but one fsync per line (act 2, 3)
  /opt/vplogger/vplogger-fix2   buffered writes (act 4)
usage: vplogger-* [-n sensors] [-r records] [-o file]
EOF

# debugfs: mkdir fails when it exists; rm fails when a file is missing: both fine.
cmds="mkdir /opt"$'\n'"mkdir /opt/vplogger"$'\n'
for f in vplogger-bug vplogger-fix1 vplogger-fix2; do
  cmds+="rm /opt/vplogger/$f"$'\n'"write $bin/$f /opt/vplogger/$f"$'\n'
  cmds+="sif /opt/vplogger/$f mode 0100755"$'\n'"sif /opt/vplogger/$f uid 0"$'\n'"sif /opt/vplogger/$f gid 0"$'\n'
done
cmds+="rm /opt/vplogger/README"$'\n'"write $readme /opt/vplogger/README"$'\n'"sif /opt/vplogger/README mode 0100644"$'\n'
cmds+="sif /opt/vplogger mode 040755"$'\n'
debugfs -w -f - "$img" <<<"$cmds" >/dev/null 2>&1
# Check what is there now.
listing=$(debugfs -R "ls -l /opt/vplogger" "$img" 2>/dev/null)
for f in vplogger-bug vplogger-fix1 vplogger-fix2; do
  echo "$listing" | grep -q " $f\$\| $f " || { echo "writing $f into $img failed" >&2; echo "$listing" >&2; exit 1; }
done
echo "$listing" | sed -n '/vplogger-/p'
echo "== installed /opt/vplogger in $img"
