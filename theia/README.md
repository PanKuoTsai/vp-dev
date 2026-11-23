# VP Studio as a standalone IDE (Eclipse Theia)

The VP Studio extension packaged with Eclipse Theia into its own desktop
application, so users do not need VS Code. The extension code is the same as
in the `.vsix`.

| Folder | What |
|---|---|
| `electron-app/` | The desktop application, which is the product. `npm run package` makes the Linux AppImage. |
| `browser-app/` | The same IDE served to a browser. Automated tests use it, and it is the base for remote use later. |
| `plugins/` | Bundled extensions. Generated, see below. |
| `vp-studio-menu/` | Theia extension that puts the VP Studio menu in the menu bar, from VP Studio's `lib/menu.js` and `package.json`. |
| `test/theia-check/` | Test-only extension that drives VP Studio inside Theia. It is not shipped. |

Theia **1.74.3** (the maintained 1.74 line), Electron 42.

## Bundled extensions

| Extension | Source | Why |
|---|---|---|
| VP Studio | `../` packaged with vsce | The product |
| `eclipse-cdt.cdt-gdb-vscode` 3.0.0 | Open VSX | Debugging target software (`gdbtarget`, `gdb`) |
| `eclipse-cdt.memory-inspector` 1.3.0 | Open VSX | Memory view while debugging (address or expression, hex table, edit) |
| `vscode.json`, `vscode.json-language-features` 1.95.3 | Open VSX | JSON language support, which applies the platform and model schemas |

No Microsoft-proprietary extensions are used.

When running, the application loads two sets of extensions:
- **Bundled**: from `resources/app/plugins` (`THEIA_DEFAULT_PLUGINS`, set by
  `electron-app/scripts/theia-electron-main.js`).
- **User-installed**: from `~/.vp-studio/plugins` (`THEIA_PLUGINS`).

## Build

```sh
theia/build.sh --package            # add --browser for the browser application too
```

Requirements:
- Node.js 22.12 or newer. 22.11 cannot run vsce 3.2.1.
- python3, make and g++.
- The development files of libxkbfile, libx11 and libsecret:
  `sudo apt install libxkbfile-dev libx11-dev libsecret-1-dev`. Without sudo:

  ```sh
  apt-get download libxkbfile-dev libx11-dev x11proto-dev libxcb1-dev libxau-dev libxdmcp-dev libsecret-1-dev libgcrypt20-dev libgpg-error-dev
  for d in *.deb; do dpkg-deb -x "$d" ~/devroot; done
  ```

  Then point the `.pc` files' `prefix` and the `.so` links in
  `usr/lib/x86_64-linux-gnu` at `~/devroot` and the system libraries, and
  set `VP_DEV_PREFIX=~/devroot`.

How long it takes:
- **First run**: `npm install` (about 1,200 packages, 530 MB) takes about
  2 minutes.
- **Later runs** (`--skip-install`): about 40 seconds.

The result is `electron-app/dist/VP-Studio-0.2.5-x86_64.AppImage`, about
175 MB.

Run the build from a plain terminal. A shell started by VS Code's extension
host carries `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node.
`build.sh` unsets it.

## Run

```sh
./VP-Studio-0.2.5-x86_64.AppImage ~/qbox     # the folder to open as the workspace
```

The AppImage needs FUSE 2 (`libfuse2`). Without it, set
`APPIMAGE_EXTRACT_AND_RUN=1`.

### Ubuntu 23.10 and later: `--no-sandbox`

On Ubuntu 23.10, 24.04 and later the AppImage stops at once with
`The SUID sandbox helper binary was found, but is not configured correctly`.
Start it with `--no-sandbox`:

```sh
./VP-Studio-0.2.5-x86_64.AppImage --no-sandbox ~/qbox
```

These releases do not let ordinary users create user namespaces
(`kernel.apparmor_restrict_unprivileged_userns = 1`). Chromium's sandbox then
falls back to the setuid `chrome-sandbox` helper, which cannot be owned by root
inside an AppImage. Check a machine with
`sysctl kernel.apparmor_restrict_unprivileged_userns`: only the value 1 needs
the flag. Ubuntu 22.04, RHEL and Rocky, Fedora and Debian start without it by
default. Docker containers also block user namespaces by default.

`--no-sandbox` turns off the isolation of Chromium's renderer processes. The
user adds it; the application never adds it by itself (decided as K-12, option
A). Users who do not want to turn the sandbox off can use the VS Code
extension. A `.deb` package that installs an AppArmor profile would remove the
need for the flag, and is not built yet.

During development, use `npm --prefix theia/electron-app start <folder>`.

Libraries VP Studio builds on the user's machine are written to the
extension's user data folder, `~/.theia/globalStorage/novatek.vp-studio/build/`.
This covers Build Sim Agent and the catalog tool for Build Model. The application folder is read-only inside the AppImage, so this
is required.

## Browser application

```sh
THEIA_WEBVIEW_EXTERNAL_ENDPOINT='{{hostname}}' npm --prefix theia/browser-app start ~/qbox --hostname 127.0.0.1 --port 3000
```

By default, Theia serves each webview from its own subdomain
(`<id>.webview.<host>`). On a bare IP address those names do not resolve, and
the platform view stays blank. `THEIA_WEBVIEW_EXTERNAL_ENDPOINT='{{hostname}}'`
serves webviews from the same host. That is fine on one machine, but Theia
warns that it weakens the isolation between webviews. A remote deployment
should use a wildcard DNS name instead.

## Verified (2026-11-15)

The test extension (`test/theia-check`, loaded through `THEIA_PLUGINS`) ran
inside the application with the QBox folder as the workspace, and wrote what
it found. The results were the same in the browser application, the Electron
application, the unpacked package and the AppImage:
- VP Studio activated, with its 28 commands.
- The Ubuntu platform had no diagnostics.
- The platform view opened. In the browser application, a screenshot shows
  the block diagram rendered.
- Check QBox Version reported that everything matches.
- The CDT debuggers `gdb` and `gdbtarget` were registered.

From inside the AppImage, **Build Sim Agent** built the agent in 15 s into the
user data folder.
