# VP Studio 安裝與第一次使用

給第一次安裝 VP Studio 的人。做完這份說明，就能開啟 QBox 的 Ubuntu AArch64 參考平台、在 VS Code 中開機、暫停、追蹤與除錯。功能說明見 [README.md](README.md)。

## 1. 需要的東西

| 項目 | 說明 |
|---|---|
| 作業系統 | Linux，已在 Ubuntu 24.04（x86-64）上驗證。Windows 11：獨立版（AppImage）只能在 WSL2 中執行，見第 10 節，沒有 Windows 原生的獨立版；或在 Windows 版 VS Code 安裝 .vsix、模擬在 Linux 主機或容器上執行，見第 12 節 |
| VS Code | 1.75 以上 |
| QBox 的建置相依套件 | 見 QBox 的 `scripts/install_dependencies.sh`（Ubuntu 24.04：`cmake g++ gcc git libasio-dev libelf-dev …`） |
| `dtc` | 產生 device tree 用：`sudo apt install device-tree-compiler` |
| `gdb-multiarch` | 除錯目標軟體用：`sudo apt install gdb-multiarch` |
| CDT GDB Debug Adapter | VS Code 擴充套件 `eclipse-cdt.cdt-gdb-vscode`，在 VS Code 中附加除錯用 |
| 磁碟空間 | QBox 建置約 4 GB；Ubuntu 參考平台的映像檔約 5 GB |

## 2. 安裝

兩種形態，功能相同，擇一即可：

- **獨立程式**（不需要 VS Code）：執行 `./VP-Studio-0.2.2-x86_64.AppImage ~/qbox`（需要 `libfuse2`）。已內建 CDT GDB Debug Adapter 與 JSON 語言支援。建置方式見 `theia/README.md`。

  在 Ubuntu 23.10、24.04 以後，直接執行會立刻中止，訊息是 `The SUID sandbox helper binary was found, but is not configured correctly`。這時要自己加上 `--no-sandbox`：

  ```sh
  ./VP-Studio-0.2.2-x86_64.AppImage --no-sandbox ~/qbox
  ```

  原因：這些版本預設禁止一般使用者建立 user namespace（`kernel.apparmor_restrict_unprivileged_userns = 1`），Chromium 的沙箱因此改用 setuid 的 `chrome-sandbox`，而 AppImage 裡的檔案不可能屬於 root。用 `sysctl kernel.apparmor_restrict_unprivileged_userns` 檢查：值是 1 才需要加；Ubuntu 22.04、RHEL/Rocky、Fedora、Debian 等預設可直接執行。

  `--no-sandbox` 會關掉 Chromium 用來隔離畫面行程的沙箱。VP Studio 只開啟本機的檔案與擴充套件自己的畫面，但若在獨立程式中開啟不信任的工作區或擴充套件，隔離就少了一層。要不要這樣執行由你決定；不想關沙箱時，請改用 VS Code 擴充套件。
- **VS Code 擴充套件**：

```sh
code --install-extension vp-studio-0.2.*.vsix   # 檔名帶版本，例如 vp-studio-0.2.1.vsix
```

以下以 VS Code 擴充套件為例；獨立程式的指令與畫面相同。

擴充套件會安裝在 `~/.vscode/extensions/novatek.vp-studio-<版本>/`（以 Remote-SSH 連到這台機器時是 `~/.vscode-server/extensions/`），以下以 `$VPS` 代表這個目錄。資料夾名稱帶版本，每次更新都會變，所以用下面的指令取最新的一個：

```sh
VPS=$(ls -d ~/.vscode/extensions/novatek.vp-studio-* ~/.vscode-server/extensions/novatek.vp-studio-* 2>/dev/null | sort -V | tail -1)
```

更新時直接安裝新的 `.vsix` 即可，不必先解除安裝；裝完執行 Developer: Reload Window。

## 3. 建置 QBox

VP Studio 的每個版本都對一個測試過的 QBox commit 驗證過，並附帶修補（`$VPS/qbox.pin.json`、`$VPS/patches/qbox/`）。請用其中一種方式取得 QBox：

**A. 建置釘選的 QBox（建議）**：自動 clone、checkout 釘選的 commit、套用修補、建置，並一併建出 sim agent 與元件目錄：

```sh
bash $VPS/tools/qbox-pin/build-qbox.sh ~/qbox
```

需要網路（QBox 會下載 SystemC、CCI、libqemu）。4 核心的機器約 25 分鐘起跳；只需要 AArch64 時可加 `--targets aarch64` 縮短時間。

**B. 使用既有的 QBox 原始碼**：確認是同一個 commit（`git -C ~/qbox rev-parse HEAD` 與 `qbox.pin.json` 的 `commit` 相同），套用修補後再建置：

```sh
cd ~/qbox
git apply $VPS/patches/qbox/*.patch
cmake --preset gcc                     # 這一步下載 libqemu 到 build/_deps/libqemu-src
LQ=$(sed -n 's/^libqemu_SOURCE_DIR:[A-Z]*=//p' build/CMakeCache.txt)   # libqemu 實際所在位置
git -C "$LQ" apply $VPS/patches/libqemu/*.patch
cmake --build build -j$(nproc)
```

若你的 QBox 設定了 CPM 原始碼快取（`CPM_SOURCE_CACHE`，例如把相依套件放在 `qbox/packages/`），libqemu 與 SystemC CCI 的原始碼就不在 `build/_deps/` 底下，而是記錄在 `build/CMakeCache.txt` 的 `libqemu_SOURCE_DIR`、`SystemCCCI_SOURCE_DIR`。上面的指令、Build Sim Agent 與 Check QBox Version 都會從那裡讀取。Build Sim Agent 仍然找不到 RapidJSON 標頭檔時，設定環境變數 `VP_RAPIDJSON_INCLUDE` 為含有 `rapidjson/rapidjson.h` 的資料夾。

**C. 在 VP Studio 中執行 Build QBox**：先安裝 VP Studio（第 2 節），用 VS Code 開啟 QBox 原始碼資料夾（或一個空資料夾），執行 **VP Studio: Build QBox**（Setup）。它開啟一個檢視，上方列出目前的狀態（QBox commit 是否為釘選的、建置目錄的設定、修補是否套用、模擬器、probes.so 與 debug_dap.so、sim agent），下方是建置設定：
1. **QBox 資料夾**：既有的 QBox 原始碼，或一個空資料夾（會 clone 釘選的 QBox）。不在釘選的 commit 時可勾選先 checkout 釘選的 commit（預設不勾，照現況建置；有本機修改時不會 checkout）。
2. **建置設定**：configure preset（gcc、gcc-debug、clang、clang-debug、clang-lto）、QEMU 目標（只勾 AArch64 就足夠 Ubuntu AArch64 平台）、平行工作數。
3. **相依套件的原始碼放哪裡**（CPM 原始碼快取 `CPM_SOURCE_CACHE`）：不使用快取（下載到 `build/_deps/`）、QBox 會自動使用的 `<qbox>/Packages`、既有的 `<qbox>/packages`、環境變數 `CPM_SOURCE_CACHE`，或自選資料夾。幾份 QBox 可以共用同一個快取。
4. **VP Studio 的修補**：列出每個修補是否已套用，預設套用尚未套用的。
5. **建置之後**：一併建 sim agent、讓 VP Studio 使用這份 QBox（設定 `vpStudio.executable`）。

右側列出將執行的指令（`tools/qbox-pin/build-qbox.sh` 與選項）與這次會改變什麼；按 **Build QBox** 在終端機執行。已經設定過的建置目錄，預設值就是它原本的設定，直接按 Build 只重編有變動的部分；改了 QEMU 目標、Release／Debug 或套件位置會先列出來。建置目錄不能換編譯器（gcc 與 clang 互換），這時檢視會擋下，並提供「Move the old build directory aside」把舊的移開。

如果 VS Code 裝了 CMake Tools 擴充套件（`ms-vscode.cmake-tools`），它在開啟含 `CMakePresets.json` 的資料夾時會自己 configure QBox，用的是 preset 的預設值（全部 QEMU 目標、不用套件快取）：刪掉的 `build/` 會自己長回來、重新下載約 1 GB 的相依套件，也蓋掉你在這裡選的設定。Build QBox 檢視偵測到時會提醒，按「Turn off CMake Tools auto-configure」就在 QBox 資料夾的 `.vscode/settings.json` 把 `cmake.configureOnOpen`、`cmake.automaticReconfigure`、`cmake.configureOnEdit` 設為 `false`（只影響這個資料夾）。

兩組修補：
- `patches/qbox/`：
  - `0001`：修正多 CPU 平台偶發「一開始就結束、沒有任何輸出」的問題。沒有套用時，多 CPU 平台必須保留 `keep_alive` 模組（範例平台已經帶著）。
  - `0002`：加入 VP Studio 的 SystemC 元件 `systemc-components/probes`（交易與訊號探針，建出 `build/probes.so`）與 `systemc-components/debug_dap`（OpenOCD 除錯埠，`build/debug_dap.so`）。**必須套用**：sim agent 連結 `probes.so`，沒有它 Build Sim Agent 會失敗，追蹤與 OpenOCD 連線也不能用。只新增檔案與 `systemc-components/CMakeLists.txt` 的兩行，不改 QBox 其他部分。

  說明見 `$VPS/patches/qbox/README.md`。
- `patches/libqemu/`：讓 QEMU 的裝置狀態可以存檔。存檔與還原（Save Checkpoint、Start from Checkpoint、`vp-run --restore`）需要它，說明見 `$VPS/patches/libqemu/README.md`。已經建好的 QBox 只要套用後再 `cmake --build build`，約 20 秒。

## 4. 設定 VS Code

用 VS Code 開啟 QBox 原始碼根目錄（例如 `~/qbox`）。預設設定就是以這個目錄的 `build/platforms-vp` 為模擬器；QBox 在別處時，設定 `vpStudio.executable` 為 `platforms-vp` 的路徑。

執行 **VP Studio: Check QBox Version**：輸出應該顯示模擬器、元件目錄與 sim agent 都和測試過的 QBox 相同。

## 5. 第一次要建置的元件

這個元件與你的 QBox 建置綁在一起，所以在你的機器上建置，而不是隨擴充套件發布。只需建一次；QBox 版本變更或重新安裝擴充套件後要重建。

| 指令 | 用途 | 時間 |
|---|---|---|
| **VP Studio: Build Sim Agent** | 暫停、繼續、參數檢視、修改參數、交易追蹤、除錯時間同步 | 約 10 秒 |

沒有建置 sim agent 時，Start Simulation 仍可執行，但會提示上述功能關閉，並提供「Build Sim Agent」按鈕。

之後改了 QBox（套用修補、修改 QBox 的元件）要重新編譯時，執行 **VP Studio: Build QBox**（Setup），在開啟的檢視（第 3 節 C）直接按 Build QBox：設定和建置目錄原本的一樣，所以只重編有變動的部分，沒有變動時約 20 秒。sim agent 連結 QBox 的 `probes.so`，所以 QBox 要先建好，Build Sim Agent 才會成功；檢視預設建完 QBox 後一併建 sim agent。模擬執行中按 Build 會先詢問（編譯會覆蓋它載入的函式庫）。

## 6. Ubuntu AArch64 參考平台

平台需要 QBox 的 Ubuntu 映像檔（核心 `Image.bin`、`ubuntu.dtb`、initrd 與 `image_ext4.img`），放在 QBox 的 `platforms/ubuntu/fw/Artifacts/`。

### 取得映像檔

**A. 使用打包好的映像檔（建議）**：`ubuntu-aarch64-images-0.2.0.tar.zst`（約 1.9 GB，與發布檔分開提供，附 `.sha256`）。內含上述四個檔案、`ubuntu.dts` 與第 8 節的 `vmlinux`，已測試可開機到 `login:`（帳號 root，密碼 root）。磁碟映像已清理日誌，並設定 journald 最多 32 MB。

```sh
sha256sum -c ubuntu-aarch64-images-0.2.0.tar.zst.sha256
tar --zstd -xf ubuntu-aarch64-images-0.2.0.tar.zst                  # 沒有 zstd：sudo apt install zstd
cd ubuntu-aarch64-images-0.2.0/Artifacts && sha256sum -c ../SHA256SUMS && cd ..
cp -a Artifacts ~/qbox/platforms/ubuntu/fw/                          # 改成你的 QBox 位置
```

已經有 `Artifacts/` 時，`cp` 會覆蓋同名檔案（包括你自己的 `image_ext4.img`），請先備份。每位使用者各用自己的一份：客體寫入的變更會留在 `image_ext4.img` 裡，同一份映像也不能同時給兩個模擬器使用。

**B. 自己建置**：執行 QBox 的 `platforms/ubuntu/fw/build_linux_dist_image.sh`（以 mkosi 建立），產生在 `platforms/ubuntu/fw/Artifacts/`。

### 開機

1. 命令面板執行 **VP Studio: Create Example Platform (Ubuntu AArch64)**，存到 `platforms/ubuntu/`（`${TOP}` 指向這個目錄，位置很重要）。
2. 開啟該 `.platform.json`，按編輯器右上角的 **Start Simulation**。8 核心約 3 到 4 分鐘開機到 `login:`。
3. 要結束時，在客體輸入 `poweroff`。用 Stop Simulation 或 Ctrl-\ 直接結束雖然可以，但每次都會在客體留下一份未關閉的日誌，次數多了會把客體磁碟寫滿；VP Studio 在可用空間不足時會警告並說明清理方法。

## 7. 平台檔可以共用

平台檔（`*.platform.json`）不含任何本機的絕對路徑：

- QBox 的元件只寫型別，函式庫位置由擴充套件在產生 Lua 時決定。
- 映像檔與建模精靈的模型以 `${TOP}`（平台檔所在目錄）的相對路徑表示。
- 產生的 `*.generated.lua`、`*.generated.dts/.dtb` 含本機路徑，是每台機器各自產生的檔案，不要放進版本控制。

## 8. 以原始碼層級除錯 Ubuntu 核心（選用）

需要與映像核心完全相同的 `vmlinux`。第 6 節的打包檔已附上 `vmlinux-5.15.0-203-generic`，用它就不必再下載。自己建置映像時，Ubuntu 的核心除錯符號在 ddebs 套件庫：

```sh
# 映像的核心版本：strings platforms/ubuntu/fw/Artifacts/Image.bin | grep -m1 '^Linux version'
V=5.15.0-203-generic; P=linux-image-unsigned-$V-dbgsym_5.15.0-203.213_arm64.ddeb   # 依版本調整
curl -O http://ddebs.ubuntu.com/pool/main/l/linux/$P                                  # 約 1.1 GB
dpkg-deb --fsys-tarfile $P | tar -x ./usr/lib/debug/boot/vmlinux-$V
cp usr/lib/debug/boot/vmlinux-$V platforms/ubuntu/fw/Artifacts/
```

確認是同一份建置：`strings vmlinux-$V | grep -m1 '^Linux version'` 要與 `Image.bin` 的那一行完全相同。

（VP Studio 附加除錯器時會自動依執行中的核心校正 KASLR 位移，所以下面這步通常不必做；只有關掉 `vpStudio.debug.linuxAwareness` 時才需要。）

**關掉 KASLR。** QBox 附的 `ubuntu.dtb` 帶 `kaslr-seed`，核心會被載入到隨機位址，vmlinux 的符號位址就對不上。讓 VP Studio 產生 device tree，並在命令列加上 `nokaslr`：

```json
"devicetree": {
  "output": "${TOP}fw/Artifacts/generated.dtb",
  "bootargs": "systemd.unit=multi-user.target audit=off loglevel=8 root=LABEL=root-arm64 rootfstype=ext4 rw nokaslr"
},
```

並把 `load` 中 `ubuntu.dtb` 那一項改成 `${TOP}fw/Artifacts/generated.dtb`（產生的 device tree 不帶 `kaslr-seed`）。

**附加除錯。**

1. 平台檢視的「Software images」→「Symbol file for debugging」選 `vmlinux-…`。
2. 執行 **Start Simulation with Target Debug Port**，再執行 **Add Debug Configurations**（`program` 會自動指向 vmlinux）。
3. 在「執行與偵錯」選 **VP: attach to target software** 按 ▶。暫停後，呼叫堆疊顯示核心函式名稱與原始檔行號，例如閒置的 CPU 停在 `cpu_do_idle()`（`arch/arm64/kernel/idle.c`）。gdb 指令在附加時另開的 gdb 終端機輸入。

原始檔路徑是 Ubuntu 建置機上的 `/build/linux-…/linux-5.15.0/`；要看原始碼內容，安裝對應的 `linux-source` 並在 gdb 用 `set substitute-path` 對應過去。

## 9. 在另一台機器上執行模擬（選用）

模擬器可以放在效能較好的 Linux 主機（或其上的容器）上執行，VP Studio 留在自己的電腦上。只用 OpenSSH，不需要其他擴充套件。

1. 遠端主機：照第 3 節建置 QBox，並準備好平台需要的檔案（例如 `platforms/ubuntu/fw/Artifacts/`）。缺的檔案在啟動時也可以從本機上傳，4 GB 的磁碟映像建議事先自己複製過去。
2. 本機：設定好金鑰登入，確認 `ssh <主機>` 不用輸入密碼就能登入（建議）。不能用金鑰時，改用密碼登入，見本節最後的「以密碼登入」。
3. 在 VS Code 中執行 **VP Studio: Select Simulation Host…**，選主機（`~/.ssh/config` 裡的 Host 會列出），再填遠端 QBox 資料夾的絕對路徑。這一步會接著執行 **Check Remote Host**，在輸出面板列出缺什麼。
4. 執行 **VP Studio: Build Sim Agent on Remote Host**（約 20 秒）。
5. 之後 Start Simulation 就會在遠端執行，終端機標題是 `VP: <平台> @ <主機>`。客體 SSH 等轉發埠也會轉到本機，用 `ssh -p 2222 root@localhost` 連線；若本機的 2222 已被占用，會改用其他埠並顯示出來。
6. 要改回在本機執行，在 **Select Simulation Host…** 選 **This machine**。

模擬器在容器裡、而你只能 `docker exec` 進去（容器由別人管理，無法加 `--network host` 或開埠）時，先照第 11 節的步驟 1 在容器裡啟動你自己的 SSH 伺服器，再把容器當成這裡的「主機」。

以密碼登入：
- 設定 `vpStudio.remote.auth` 為 `password`。也可以不先設：金鑰登入被拒、而主機接受密碼時，Check Remote Host、Select Simulation Host… 與 Start Simulation 會詢問「Use Password」，按下就會改好。
- 第一次連線時，VS Code 跳出密碼輸入框；之後同一個視窗不再詢問。第一次登入成功後會問要不要記住：選 Remember 就存進 VS Code 的密碼儲存區（Windows 認證管理員、Linux 的登入金鑰圈），下次開 VS Code 也不必再輸入；選 This Session Only 則關掉視窗就忘記。
- 密碼打錯時登入失敗，下一次操作會重新詢問。存起來的密碼被拒絕時會自動刪除。
- 要清掉存起來的密碼，執行 **VP Studio: Forget Remote Password**。
- 做法：ssh 透過 `SSH_ASKPASS` 向 VP Studio 要密碼（需要 OpenSSH 8.4 以上；Windows 10/11 內建的與 Ubuntu 22.04 以後都符合）。密碼只在 VS Code 的記憶體裡（或你選擇的密碼儲存區），不會寫進檔案、命令列或環境變數。
- 密碼登入時，第一次連到的主機會自動接受並記住它的主機金鑰（`StrictHostKeyChecking=accept-new`）；主機金鑰變了仍會拒絕連線。
- 每次 ssh 呼叫都重新驗證，比金鑰登入稍慢。金鑰的 passphrase 與一次性驗證碼每次都會詢問，不會記住。
- Windows：ssh 執行的是擴充套件裡的 `prebuilt\win32\vp-askpass.exe`。Windows 版 OpenSSH 無法執行路徑含中文等非 ASCII 字元或空白的程式（例如使用者名稱是中文時，會出現 `CreateProcessW failed error:2`），這時 VP Studio 會把它複製到 `C:\ProgramData\VPStudio-<代碼>\`，並以 `icacls` 把該資料夾限定為你的帳號、SYSTEM 與 Administrators；每次使用前核對內容。

限制：
- 遠端執行的模擬不能存檔與還原。
- `vp-run` 只在本機執行；要在遠端跑 CI，就在遠端執行 `vp-run`。
- 建模精靈的模型要在遠端以 `tools/model-build/build.sh` 建置。

## 10. 在 Windows 上使用（WSL2）

VP Studio 與 QBox 都只在 Linux 上執行。Windows 上的做法是在 WSL2 的 Ubuntu 中建置 QBox、執行獨立版，畫面由 WSLg 顯示在 Windows 桌面上，用法與 Linux 相同。

> **尚未實測**：這一節依 WSL2 的公開行為整理，0.2.0 版還沒有在 Windows 上驗證。遇到問題請回報。

需要 Windows 11，或已從 Microsoft Store 更新 WSL 的 Windows 10 22H2（WSLg 圖形顯示需要它）。

1. **安裝 WSL2 與 Ubuntu**：以系統管理員開啟 PowerShell，執行下面的指令，重新開機後依提示建立 Ubuntu 帳號：

   ```powershell
   wsl --install -d Ubuntu-24.04
   wsl --update
   ```

2. **給 WSL 足夠的資源**（建議）：WSL 預設只用主機一半的記憶體。QBox 建置與 8 核心模擬都吃記憶體和 CPU，在 Windows 的 `%UserProfile%\.wslconfig` 寫入（數值依機器調整）：

   ```ini
   [wsl2]
   memory=12GB
   processors=8
   ```

   存檔後在 PowerShell 執行 `wsl --shutdown`，再重新開啟 Ubuntu。

3. **安裝相依套件**：在 Ubuntu 中安裝第 1 節列的 QBox 建置相依套件、`dtc` 與 `gdb-multiarch`。另外，WSL 的 Ubuntu 是精簡安裝，獨立版的畫面還需要這些函式庫，以及中文字型：

   ```sh
   sudo apt install libfuse2t64 libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libcups2t64 fonts-noto-cjk
   ```

4. **檔案放在 Linux 的檔案系統裡**：QBox、平台與映像檔都要放在 WSL 的家目錄（例如 `~/qbox`），**不要放在 `/mnt/c/…`**。Windows 磁碟經由 WSL 的檔案分享存取，建置與開機會慢很多；QEMU 的磁碟映像鎖與 VP Studio 的鎖偵測也可能無法正常運作。

5. **建置 QBox**：照第 3 節在 `~/qbox` 建置。

6. **執行獨立版**：把下載的 AppImage 從 Windows 複製進來（`<使用者>` 換成 Windows 的帳號名稱）再執行。視窗會出現在 Windows 桌面上：

   ```sh
   cp /mnt/c/Users/<使用者>/Downloads/VP-Studio-0.2.2-x86_64.AppImage ~/
   chmod +x ~/VP-Studio-0.2.2-x86_64.AppImage
   ~/VP-Studio-0.2.2-x86_64.AppImage ~/qbox
   ```

   - 出現 FUSE 相關錯誤（例如 `dlopen(): error loading libfuse.so.2` 或 `fuse: device not found`）時，改成解開後執行：

     ```sh
     cd ~ && ./VP-Studio-0.2.2-x86_64.AppImage --appimage-extract
     ~/squashfs-root/AppRun ~/qbox
     ```

   - 出現第 2 節的 SUID sandbox 訊息時，同樣要自己加上 `--no-sandbox`。WSL 的核心通常沒有啟用 AppArmor，一般不需要加；可用 `sysctl kernel.apparmor_restrict_unprivileged_userns` 檢查，值是 1 才需要加，沒有這個值就不用加。

7. 之後照第 4 到 6 節操作。客體的轉發埠會出現在 WSL 的 `localhost`，WSL2 預設也會轉到 Windows，所以在 Windows 的終端機也能 `ssh -p 2222 root@localhost`。

想用 VS Code 版：可以在 WSL 的 Ubuntu 中安裝 Linux 版 VS Code，以 WSLg 顯示，再照第 2 節安裝 `.vsix`。從 Windows 版 VS Code 經微軟的 WSL 擴充套件連進 WSL 的方式沒有測試過，本產品也不依賴它。

Windows 上另一種做法是第 9 節的遠端模擬：模擬器跑在另一台 Linux 主機上。獨立版沒有 Windows 版，但 Windows 版 VS Code 可以直接安裝 `.vsix`，見第 12 節。模擬器在 server 的容器裡時，見第 11 節。

## 11. Windows 電腦搭配 server 上的容器

情境：模擬器（QBox）裝在 Linux server 的 Docker 容器裡，容器由別人管理，你只能 `ssh` 到 server 再 `docker exec` 進容器；你自己用的是 Windows 電腦。容器沒有把 X 的顯示埠或其他埠開出來，所以不在容器裡開 GUI，而是：

- VP Studio 在你的 Windows 電腦上執行（WSL2 裡的獨立版，第 10 節；或 Windows 版 VS Code，第 12 節，下面在 WSL 裡做的 ssh 設定改放在 `%USERPROFILE%\.ssh\config`）。
- 模擬器在容器裡執行（第 9 節的遠端模擬）。
- 兩者之間只走 SSH：你在容器裡以自己的身分啟動一個 SSH 伺服器，Windows 經 server 跳進容器（`ProxyJump`）。模擬器的終端機、sim agent、gdb 與客體的轉發埠都經這條 SSH 轉到你的電腦。

```
Windows（WSL2：VP Studio）──ssh──> server ──ssh（ProxyJump）──> 容器（sshd、platforms-vp）
```

> **尚未在真正的 Docker 與 Windows 上實測**：`container-sshd.sh` 以模擬的 docker 在 Linux 上驗證過（下載 sshd、金鑰登入、ProxyJump、`-L` 轉發、VP Studio 的遠端指令、重跑與停止）。遇到問題請回報。

先確認：
- 容器裡有建好的 QBox，而且套用了 VP Studio 的修補（含 0002，第 3 節），`build/` 下有 `platforms-vp`、`probes.so`、`debug_dap.so`。QBox 在容器裡若不是你能寫入的，請管理者套用修補並建置。
- 平台檔與映像檔要放在**容器看得到、你能寫入**的資料夾。在 server 上執行 `docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' <容器>` 可看到掛載了哪些資料夾；之後填的路徑一律是**容器內的路徑**。

### 步驟 1：在容器裡啟動 SSH 伺服器（在 server 上做）

1. 把 WSL 裡的公鑰複製到 server（沒有金鑰就先在 WSL 執行 `ssh-keygen -t ed25519`）：

   ```sh
   # 在 WSL 裡
   scp ~/.ssh/id_ed25519.pub <server>:/tmp/vp-key.pub
   ```

2. 把 VP Studio 的 `tools/container/container-sshd.sh` 複製到 server，在 server 上執行。腳本在 `.vsix` 裡（`.vsix` 是 zip 檔，可以 `unzip -p vp-studio-0.2.*.vsix extension/tools/container/container-sshd.sh > container-sshd.sh` 取出）：

   ```sh
   bash container-sshd.sh --key /tmp/vp-key.pub <容器名稱>
   ```

   腳本會：
   - 從 `docker inspect` 找出容器的位址。bridge 網路時是容器自己的 IP（只有 server 本機連得到）；host 網路時是 127.0.0.1。網路模式為 `none` 時無法使用。
   - 在容器裡用現成的 `sshd`。沒有的話，以 `apt-get download openssh-server` 下載並解開到 `~/.vp-sshd/`，不安裝任何東西。這需要 Debian 或 Ubuntu 的容器、而且容器能上網。
   - 以你在容器裡的身分啟動 SSH 伺服器（預設埠 22022，`--port` 可改），只接受金鑰。
   - 把容器的 `PATH`、`LD_LIBRARY_PATH` 等變數寫進 `~/.ssh/environment`，SSH 連進來的指令才找得到 QBox 需要的東西。

   容器裡只會寫 `~/.vp-sshd/` 與 `~/.ssh/environment`；你在容器裡是 root 時另外建立 `/run/sshd`。在別人管理的容器裡開服務，建議先告知管理者。

3. 腳本最後會印出一段 `~/.ssh/config` 設定，類似：

   ```
   Host vp-<容器名稱>
     HostName 172.17.0.2
     Port 22022
     User root
     ProxyJump <server>
   ```

**容器重新啟動後要再執行一次步驟 2**（SSH 伺服器不會自己回來，容器的 IP 也可能改變；改變時要更新 `HostName`）。要停掉它：`bash container-sshd.sh --stop <容器名稱>`。

### 步驟 2：Windows 端（WSL2）

1. 照第 10 節裝好 WSL2、Ubuntu 與獨立版。**這種用法不需要在 WSL 裡建置 QBox**；只要 `gdb-multiarch`（除錯用）與 `dtc`（device tree 用）。
2. 在 **WSL 的** `~/.ssh/config` 加上 server 與步驟 1 印出的那段。server 也要能以金鑰登入、不問密碼：

   ```
   Host <server>
     HostName server.example.com
     User <你在 server 的帳號>

   Host vp-<容器名稱>
     HostName 172.17.0.2
     Port 22022
     User root
     ProxyJump <server>
   ```

3. 在 WSL 測試，兩個都不能問密碼（第一次會詢問是否信任主機金鑰，回答 yes）：

   ```sh
   ssh <server> true
   ssh vp-<容器名稱> 'command -v cc; ls <容器內的 QBox>/build/platforms-vp'
   ```

### 步驟 3：VP Studio 設定

1. 在 WSL 裡建一個工作區資料夾（例如 `~/work/ubuntu`，不要放 `/mnt/c`），放平台檔（`*.platform.json`）；這個資料夾對應到容器裡的一個資料夾。
2. 啟動獨立版開這個資料夾，先在設定（Ctrl+,，搜尋 `vpStudio.remote`）把 **Remote: Executable**（`vpStudio.remote.executable`）設成容器內模擬器的絕對路徑，例如 `/opt/qbox/build/platforms-vp`。預設值 `build/platforms-vp` 是相對於遠端資料夾，只適用於工作區就是 QBox 資料夾的情形。
3. 執行 **VP Studio: Select Simulation Host…**，選 `vp-<容器名稱>`。詢問「Folder on vp-<容器名稱>」時，填這個工作區資料夾在容器內對應的絕對路徑（`vpStudio.remote.root`）；平台與映像檔的路徑會照這個對應改寫。

   接著會自動執行 **Check Remote Host**，輸出面板列出每一項是否通過。
4. 執行 **VP Studio: Build Sim Agent on Remote Host**（在容器裡建置，約 20 秒）。
5. 打開平台檔，按 **Start Simulation**。終端機標題是 `VP: <平台> @ vp-<容器名稱>`；平台需要而容器裡沒有或大小不同的檔案，會詢問是否上傳（4 GB 的磁碟映像建議事先放到容器看得到的資料夾）。
6. 之後照第 4 到 8 節使用：狀態列的模擬時間、暫停與繼續、參數、追蹤、gdb 附加都在你的電腦上，連線經 SSH 轉發。客體的 SSH 轉發埠出現在 WSL 的 `localhost`（例如 `ssh -p 2222 root@localhost`），WSL2 預設也會轉給 Windows。
7. Stop Simulation 關掉終端機時，容器裡的模擬器跟著結束。

限制（與第 9 節相同）：從存檔啟動、函式追蹤存檔、`vp-run` 不支援遠端；建模精靈的模型要在容器裡自行以 `tools/model-build/build.sh` 建置。

常見問題：
- `ssh vp-<容器>` 出現 `Connection refused`：容器裡的 SSH 伺服器沒在跑（容器重啟過），在 server 上重跑步驟 1 的 2。
- 出現 `channel 0: open failed: administratively prohibited`：server 的 sshd 不允許轉送（`AllowTcpForwarding no`），`ProxyJump` 無法使用，請 server 管理者開放。
- 腳本說 `missing libraries`：下載的 sshd 與容器的系統版本不合，請管理者在容器中安裝 `openssh-server`（安裝後不需要啟動系統的 sshd，腳本會用它的執行檔）。
- 連得上但 Check Remote Host 說找不到編譯器或 QBox：SSH 進來的環境變數與 `docker exec` 不同，檢查容器裡的 `~/.ssh/environment`。

## 12. Windows 原生的 VS Code（模擬器在 Linux 主機）

不用 WSL，直接在 Windows 版 VS Code 安裝 `.vsix`。QBox 只能在 Linux 上執行，所以在 Windows 上 VP Studio **一律使用第 9 節的遠端模擬**：模擬器在 Linux 主機（或第 11 節的容器）上跑，編輯、平台檢視、參數、追蹤、剖析與除錯在 Windows 上。

> **尚未在 Windows 上實測**：路徑轉換以單元測試驗證，Build Model on Remote Host 與遠端 `dtc` 以 Linux 上的測試 sshd 實際跑過。遇到問題請回報。

### 準備（Windows 端）

1. **OpenSSH 用戶端**：Windows 10 1809 以後內建。在 PowerShell 執行 `ssh -V` 確認；沒有的話到「設定 → 系統 → 選用功能」加入「OpenSSH 用戶端」。
2. **登入方式**：建議用金鑰：在 PowerShell 執行 `ssh-keygen -t ed25519`，再執行 `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <主機> "cat >> ~/.ssh/authorized_keys"`（最後一次輸入密碼），之後 `ssh -o BatchMode=yes <主機> true` 不能詢問密碼。不能用金鑰時，改用密碼登入（第 9 節最後的「以密碼登入」）：VP Studio 問一次密碼，可記在 Windows 認證管理員。主機寫在 `%USERPROFILE%\.ssh\config` 時，Select Simulation Host… 會列出來。容器（第 11 節）的 `Host vp-<容器>` 設定照樣放在這個檔案，`ProxyJump` 在 Windows 的 OpenSSH 也能用。
3. **安裝 VS Code 與擴充套件**：安裝 Windows 版 VS Code、CDT GDB Debug Adapter（`eclipse-cdt.cdt-gdb-vscode`），再從 `.vsix` 安裝 VP Studio（第 2 節）。
4. **gdb（要除錯目標軟體時）**：需要 Windows 上能除錯 AArch64 的 gdb，例如 Arm GNU Toolchain 的 `aarch64-none-elf-gdb.exe`（要用 Linux 感知時選帶 Python 的版本）。在設定把 `vpStudio.debug.targetGdb` 設成它的完整路徑。

### 準備（Linux 主機端）

照第 3 節建好 QBox（含 VP Studio 的修補 0002），並安裝 `dtc`（`sudo apt install device-tree-compiler`）：Windows 沒有 `dtc`，VP Studio 會在主機上執行它。

### 設定與使用

1. 在 Windows 開一個工作區資料夾，例如 `C:\work\ubuntu`，放平台檔。Linux 主機上要有一個**對應的資料夾**，例如 `/home/me/work/ubuntu`；平台用 `${TOP}` 寫的檔案路徑在兩邊相同（Windows 上的 `\` 會轉成 `/`）。
2. 執行 **VP Studio: Select Simulation Host…**：選主機，填主機上對應的資料夾（`vpStudio.remote.root`），再填主機上的模擬器（`platforms-vp` 的絕對路徑；對應的資料夾就是 QBox 資料夾時保留預設值）。接著自動執行 **Check Remote Host**。
3. 執行 **VP Studio: Build Sim Agent on Remote Host**。
4. 打開平台檔，**Start Simulation**。平台需要的檔案在主機上找不到或大小不同時，會詢問是否從 Windows 上傳；磁碟映像等大檔建議直接放在主機上。平台裡以 `/` 開頭的絕對路徑（例如 `/data/images/initrd.img`）視為主機上的檔案，不會上傳。
5. 之後的操作與 Linux 相同。客體的轉發埠在 Windows 的 `localhost`，例如 `ssh -p 2222 root@localhost`。

在 Windows 上：
- **不顯示**只在本機建置或執行 QBox 的指令：Build QBox、Build Sim Agent、Check QBox Version（改用 Check Remote Host）、Start Simulation with OpenOCD Port、存檔與從存檔啟動。
- **Build Model** 會改用 **Build Model on Remote Host**：在 Windows 產生程式碼，把模型資料夾送到主機上對應的位置建置與自我測試，再把目錄項目取回，平台就能用這個模型。
- **Device tree**（Generate Device Tree、Device tree 分頁、`devicetree.output`）用主機上的 `dtc`；`vpStudio.dtc` 保持 `dtc` 即可，也可以設成某個 Windows 版 dtc 的路徑。在 Linux 上把它設成 `remote` 也會改用主機上的 dtc。
- **除錯**：Add Debug Configurations 只加「attach to target software」（連到 `127.0.0.1` 的轉發埠），不加附加模擬器行程的設定；不支援 `openGdbConsole`，偵錯主控台輸入 gdb 指令要以 `>` 開頭。符號檔（例如 `vmlinux`）要放在 Windows 這邊，gdb 在本機讀它。
- **軟體映像檔的檢查**（檔案是否存在、arm64 Image 檔頭、配置圖）看的是 Windows 上的檔案；映像檔只在主機上時，平台檢視會說找不到，這不影響在主機上啟動。
- `vp-run` 只在 Linux 上執行。
