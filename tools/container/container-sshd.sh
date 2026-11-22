#!/usr/bin/env bash
# Start an SSH server of your own inside a running container that you can only
# reach with "docker exec", so that VP Studio's remote simulation (INSTALL.md
# section 9) can use the container as its "remote host": commands, free-port
# lookup and the -L port forwards then all happen inside the container.
#
# Run it on the server that hosts the container (you need docker or podman
# access there). It changes nothing outside the container, and inside the
# container it only writes ~/.vp-sshd/ and ~/.ssh/environment (and creates
# /run/sshd when you are root there). The keys it accepts are in
# ~/.vp-sshd/authorized_keys, not ~/.ssh/authorized_keys.
#
# usage: container-sshd.sh [options] CONTAINER
#   --port N        port of the SSH server in the container (default 22022)
#   --user NAME     user inside the container (default: docker exec's default)
#   --key FILE      public key allowed to log in (default: the first of
#                   ~/.ssh/id_ed25519.pub, ~/.ssh/id_ecdsa.pub, ~/.ssh/id_rsa.pub);
#                   "-" reads it from stdin. Run again with another key to add it.
#   --stop          stop the SSH server instead
#
# Run it again after the container restarts (the container's address may
# change; the script prints the ~/.ssh/config entry to use).
#
# The SSH server listens on the container's own address (bridge network: only
# the server itself and other containers can reach it), or on 127.0.0.1 when
# the container uses the host network. It accepts keys only.
#
# Without an sshd in the container, the script fetches openssh-server with
# "apt-get download" (Debian or Ubuntu containers, with network access) and
# unpacks it into ~/.vp-sshd; it does not install anything.
#
# VP_CONTAINER_ENGINE chooses the engine (default: docker, else podman).
set -euo pipefail

port=22022
user=""
key=""
stop=0
ctr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    --user) user="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    --stop) stop=1; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) ctr="$1"; shift ;;
  esac
done
[ -n "$ctr" ] || { echo "usage: container-sshd.sh [--port N] [--user NAME] [--key FILE] [--stop] CONTAINER" >&2; exit 2; }
engine="${VP_CONTAINER_ENGINE:-$(command -v docker || command -v podman || true)}"
[ -n "$engine" ] || { echo "neither docker nor podman found (set VP_CONTAINER_ENGINE)" >&2; exit 1; }
as=(); [ -n "$user" ] && as=(-u "$user")
inside() { "$engine" exec -i ${as[@]+"${as[@]}"} "$ctr" sh -s -- "$@"; }

if [ "$stop" = 1 ]; then
  inside <<'EOF'
p="$HOME/.vp-sshd/sshd.pid"
if [ -f "$p" ] && kill "$(cat "$p")" 2>/dev/null; then echo "stopped the SSH server in the container"; else echo "no SSH server of ours is running in the container"; fi
EOF
  exit 0
fi

pub=""
if [ "$key" = "-" ]; then pub="$(cat)"
elif [ -n "$key" ]; then pub="$(cat "$key")"
else
  for f in ~/.ssh/id_ed25519.pub ~/.ssh/id_ecdsa.pub ~/.ssh/id_rsa.pub; do
    [ -f "$f" ] && { pub="$(cat "$f")"; break; }
  done
fi
pub="$(printf '%s\n' "$pub" | grep -E '^(ssh-|ecdsa-|sk-)' | head -1 || true)"
[ -n "$pub" ] || { echo "no public key: give the key of the computer you run VP Studio on with --key FILE (or --key - and paste it)" >&2; exit 1; }

state="$("$engine" inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null)" || { echo "no container $ctr" >&2; exit 1; }
[ "$state" = true ] || { echo "container $ctr is not running" >&2; exit 1; }
mode="$("$engine" inspect -f '{{.HostConfig.NetworkMode}}' "$ctr")"
case "$mode" in
  none) echo "container $ctr has no network (network mode none): it cannot be reached over SSH" >&2; exit 1 ;;
  host) addr=127.0.0.1 ;;
  *) addr="$("$engine" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$ctr" | awk '{print $1}')" ;;
esac
[ -n "$addr" ] || { echo "cannot find the address of container $ctr (network mode $mode)" >&2; exit 1; }

echo "== container $ctr: network $mode, SSH server on $addr:$port"
out="$(inside "$addr" "$port" "$pub" <<'EOF'
set -eu
addr="$1"; port="$2"; pub="$3"
d="$HOME/.vp-sshd"
[ -d "$HOME/.ssh" ] || { mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; }
mkdir -p "$d"
chmod 700 "$d"
sshd=""
for c in "$(command -v sshd 2>/dev/null || true)" /usr/sbin/sshd "$d/pkg/usr/sbin/sshd"; do
  [ -n "$c" ] && [ -x "$c" ] && { sshd="$c"; break; }
done
if [ -z "$sshd" ]; then
  command -v apt-get >/dev/null && command -v dpkg >/dev/null || { echo "ERROR: no sshd in the container and no apt-get to fetch one; ask the container's administrator for openssh-server" >&2; exit 1; }
  echo "== fetching openssh-server (apt-get download) into $d/pkg" >&2
  (cd "$d" && rm -f openssh-server_*.deb && apt-get download openssh-server >/dev/null) || { echo "ERROR: apt-get download openssh-server failed (no network or package lists in the container?)" >&2; exit 1; }
  dpkg -x "$d"/openssh-server_*.deb "$d/pkg"
  sshd="$d/pkg/usr/sbin/sshd"
fi
keygen="$(command -v ssh-keygen 2>/dev/null || true)"
[ -n "$keygen" ] || [ ! -x "$d/pkg/usr/bin/ssh-keygen" ] || keygen="$d/pkg/usr/bin/ssh-keygen"
if [ -z "$keygen" ]; then
  echo "== fetching openssh-client (apt-get download) for ssh-keygen" >&2
  (cd "$d" && rm -f openssh-client_*.deb && apt-get download openssh-client >/dev/null && dpkg -x openssh-client_*.deb pkg) || { echo "ERROR: no ssh-keygen in the container and cannot fetch openssh-client" >&2; exit 1; }
  keygen="$d/pkg/usr/bin/ssh-keygen"
fi
missing="$(ldd "$sshd" 2>/dev/null | grep 'not found' || true)"
[ -z "$missing" ] || { echo "ERROR: $sshd cannot run in this container, missing libraries:" >&2; echo "$missing" >&2; exit 1; }
[ -f "$d/host_ed25519" ] || "$keygen" -q -t ed25519 -N '' -f "$d/host_ed25519"
touch "$d/authorized_keys"
grep -qxF "$pub" "$d/authorized_keys" || printf '%s\n' "$pub" >> "$d/authorized_keys"
chmod 600 "$d/authorized_keys"
# SSH sessions do not get the image's ENV; pass on what programs need.
env | grep -E '^(PATH|LD_LIBRARY_PATH|LANG|LC_ALL|PYTHONPATH|CPM_SOURCE_CACHE)=' > "$HOME/.ssh/environment" || true
[ "$(id -u)" = 0 ] && mkdir -p /run/sshd
cat > "$d/sshd_config" <<CFG
ListenAddress $addr
Port $port
HostKey $d/host_ed25519
PidFile $d/sshd.pid
AuthorizedKeysFile $d/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
AllowTcpForwarding local
X11Forwarding no
PermitUserEnvironment yes
# The keys are in this 700 directory; the home directory's own permissions
# are the container's business.
StrictModes no
CFG
[ -f "$d/sshd.pid" ] && kill "$(cat "$d/sshd.pid")" 2>/dev/null && sleep 1 || true
"$sshd" -t -f "$d/sshd_config"
"$sshd" -f "$d/sshd_config" -E "$d/sshd.log"
sleep 1
[ -f "$d/sshd.pid" ] && kill -0 "$(cat "$d/sshd.pid")" 2>/dev/null || { echo "ERROR: the SSH server did not start; see $d/sshd.log:" >&2; tail -5 "$d/sshd.log" >&2; exit 1; }
echo "USER=$(id -un)"
EOF
)"
cuser="$(printf '%s\n' "$out" | sed -n 's/^USER=//p' | tail -1)"
echo "== SSH server running in $ctr as $cuser"
cat <<EOF

Add this to ~/.ssh/config on the computer that runs VP Studio (in WSL, the
Ubuntu ~/.ssh/config). Replace <server> with the Host you use for this server;
it must log in with a key, without a password.

Host vp-$ctr
  HostName $addr
  Port $port
  User $cuser
  ProxyJump <server>

Then check with:  ssh vp-$ctr true
and in VP Studio set vpStudio.remote.host to vp-$ctr (Select Simulation Host…).
EOF
