#!/usr/bin/env bash
# Build VP Studio as a standalone IDE with Eclipse Theia.
#
# usage: theia/build.sh [--browser] [--skip-install] [--package]
#   --browser       also build the browser application (used for automated tests)
#   --skip-install  reuse node_modules from an earlier run
#   --package       also make the Linux AppImage (electron-app/dist/)
#
# Needs:
#   - Node.js 22.12 or newer (npm) on PATH
#   - python3, make, g++ (native modules are compiled)
#   - development files of libxkbfile, libx11 and libsecret:
#       sudo apt install libxkbfile-dev libx11-dev libsecret-1-dev
#     Without sudo, unpack them somewhere and point VP_DEV_PREFIX at it (its
#     usr/include and usr/lib/x86_64-linux-gnu are added to the search paths).
#   - network access (npm, Open VSX)
#
# Produces electron-app/ ready to run (npm --prefix electron-app start),
# with --browser browser-app/, and with --package electron-app/dist/VP-Studio-*.AppImage.
#
# Run it from a plain terminal: a shell started by VS Code's extension host
# carries ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
studio="$(cd "$here/.." && pwd)"
browser=0
install=1
package=0
for a in "$@"; do
  case "$a" in
    --browser) browser=1 ;;
    --skip-install) install=0 ;;
    --package) package=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<12)) { console.error("Node.js 22.12 or newer is needed (found "+process.versions.node+")"); process.exit(1); }'

if [ -n "${VP_DEV_PREFIX:-}" ]; then
  lib="$VP_DEV_PREFIX/usr/lib/x86_64-linux-gnu"
  export PKG_CONFIG_PATH="$lib/pkgconfig:$VP_DEV_PREFIX/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export CPATH="$VP_DEV_PREFIX/usr/include:$VP_DEV_PREFIX/usr/include/libsecret-1${CPATH:+:$CPATH}"
  export LIBRARY_PATH="$lib${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi
for m in xkbfile x11 libsecret-1; do
  pkg-config --exists "$m" || { echo "missing development files for $m (see the header of this script)" >&2; exit 1; }
done

cd "$here"
if [ "$install" = 1 ]; then
  echo "== npm install"
  npm install --no-audit --no-fund
fi

echo "== VP Studio extension"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$studio" && npx --yes @vscode/vsce@3.2.1 package --allow-missing-repository --skip-license -o "$tmp/vp-studio.vsix")
rm -rf plugins/vp-studio
mkdir -p plugins/vp-studio
(cd plugins/vp-studio && unzip -q "$tmp/vp-studio.vsix")

echo "== bundled extensions (Open VSX)"
npm run download:plugins

# The browser application first: both share node_modules, and the Electron
# rebuild below switches the native modules to Electron's ABI (each build
# copies them into its own lib/backend/native).
if [ "$browser" = 1 ]; then
  echo "== browser application"
  npm --prefix browser-app run rebuild   # native modules for Node's ABI
  npm --prefix browser-app run build
fi
unset ELECTRON_RUN_AS_NODE
echo "== electron application"
npm --prefix electron-app run rebuild   # native modules for Electron's ABI
npm --prefix electron-app run build
if [ "$package" = 1 ]; then
  echo "== AppImage"
  npm --prefix electron-app run package
  ls -la electron-app/dist/*.AppImage
fi
echo "== done. Start it with: npm --prefix $here/electron-app start"
