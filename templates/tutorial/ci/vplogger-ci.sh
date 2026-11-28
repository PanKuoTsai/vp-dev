#!/usr/bin/env bash
# Act 4 of the VP Studio tutorial: the fix as a regression test. Boots the
# tutorial platform (or starts from a checkpoint), logs in, runs one build of
# vplogger and passes when it writes every record; a crash fails at once.
# Writes a JUnit report for CI.
#
# usage: vplogger-ci.sh [--restore CHECKPOINT_DIR] [--variant fix2] [--records 6000] [--junit FILE]
#   --restore   start from a checkpoint saved at the shell prompt (Save
#               Checkpoint…); without it the platform boots (about 4 minutes)
#   --variant   bug, fix1 or fix2 (default fix2); bug fails, which shows a
#               crash caught by CI
#   VP_RUN      vp-run to use (default: the newest VP Studio installed)
#
# The disk images are opened with snapshot=on (or the checkpoint's copy is
# used): the guest's changes are dropped, so every run starts the same.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
platform="$here/../../vplogger-tutorial.platform.json"
qbox="$(cd "$here/../../../.." && pwd)"
restore=""
variant=fix2
records=6000
junit="$here/vplogger-ci.junit.xml"
while [ $# -gt 0 ]; do
  case "$1" in
    --restore) restore="$2"; shift 2 ;;
    --variant) variant="$2"; shift 2 ;;
    --records) records="$2"; shift 2 ;;
    --junit) junit="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$variant" in bug|fix1|fix2) ;; *) echo "--variant: bug, fix1 or fix2" >&2; exit 2 ;; esac
vprun="${VP_RUN:-}"
if [ -z "$vprun" ]; then
  ext=$(ls -d ~/.vscode/extensions/novatek.vp-studio-* ~/.vscode-server/extensions/novatek.vp-studio-* 2>/dev/null | sort -V | tail -1 || true)
  [ -n "$ext" ] || { echo "VP Studio not found: set VP_RUN to its bin/vp-run" >&2; exit 3; }
  vprun="$ext/bin/vp-run"
fi
start=(--snapshot --expect 'login:' --send root --expect 'Password:' --send root)
[ -n "$restore" ] && start=(--restore "$restore" --send '')
exec "$vprun" --qbox "$qbox" --timeout 900 --junit "$junit" \
  "${start[@]}" --expect '# ' \
  --fail-on 'Segmentation fault|Kernel panic|Bus error' \
  --send "/opt/vplogger/vplogger-$variant -r $records -o /tmp/ci.log; echo VPLOGGER_EXIT=\$?" \
  --expect "vplogger: done, $records records" --expect 'VPLOGGER_EXIT=0' \
  "$platform"
