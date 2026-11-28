# 變更記錄

VP Studio 各版本的變更。格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)：每個版本分「新增、變更、修正」，使用者看得到的改變寫在前面。尚未發布的變更放在「未發布」，發布時改成版本號與日期。

## 0.2.12（2026-11-28）

### 變更

- **QBox 釘選改為 v7.4.5**（commit `1dd01f4b`，2026-11-25；以前是 v7.4.3 之後的 `adfde798`）。libqemu 隨之由 libqemu-v11.0-v0.17 升為 v0.21。三個 QBox 修補與 libqemu 修補不需修改即可套用；內附的元件目錄由這版重新產生（新增 `qemu_pcie`、`clic_riscv`，`qemu_rciep_pci` 已從 QBox 移除；並補上修補 0002 的 `tracer`、`signal_tracer`、`debug_dap`）。既有的 QBox 建置要換到這個 commit 重建（Build QBox 勾選 checkout 釘選 commit），sim agent 也要重建；Check QBox Version 在舊建置上會報與釘選不一致。

## 0.2.11（2026-11-27）

### 新增

- **教學：Create Tutorial Workspace**：在 QBox 的 Ubuntu 平台旁建立一套完整演練（`vplogger-tutorial/TUTORIAL.md`）：一支會當掉、又很慢的客體程式 `vplogger`，從除錯（例外記錄、條件中斷點、MMU 轉換、程式符號）、剖析、函式追蹤、交易追蹤，到修正後的比較、CI 回歸測試與架構探索，每一步寫明用哪個工具、看到什麼、知道什麼。附三個版本的程式與原始碼、把程式寫進磁碟映像的 `install-vplogger.sh`（debugfs，不開機）、CI 腳本、架構探索的模型與掃描；建立時設定原始碼對應，並可立刻把程式寫進映像。
- **Export Trace as Replay…**（Transaction Trace 面板的 Replay…）：把記錄到的存取轉成效能模型 `traffic_gen` 的重播檔，照原樣或把某一種存取（例如 virtio 的 QueueNotify）當成一定大小的傳輸；可只取一段、加快時間。
- **Profile 的 Program…**：選一個以固定位址連結的使用者程式，使用者空間的樣本以它的函式名稱列出。
- **Start from Checkpoint…** 可同時打開目標除錯埠、剖析與函式追蹤（以前只能二選一：一般或除錯埠）。
- **vp-run**：`--fail-on REGEX`（主控台一出現就失敗，不等逾時）、`--exceptions`、`--profile`、`--ftrace`、`--probes`（和 Start Simulation 一樣打開 sim agent 的功能，給 `--exec` 的腳本用）。
- 函式追蹤摘要多一張「Functions by instructions with callees」表（含子函式的指令數），一個系統呼叫的整條路徑一眼可見。
- Load Symbol File at Address… 對以固定位址連結的程式自動填好 `.text` 位址。

### 修正

- **Add Conditional Breakpoint 不停**：函式宣告的那一行可能只對應到被 inline 的副本（Linux 的 `arm64_force_sig_fault`：265 行），中斷點永遠不會觸發。現在改用 gdb 對 `break <函式>` 選的那一行（267 行）。
- **從存檔啟動的模擬以同一名稱再存檔，會毀掉存檔**：取代存檔時先刪資料夾，連同模擬正在用的磁碟副本，存檔因此不完整。現在拒絕並說明。從存檔啟動時，若另一個從同一存檔啟動的模擬還在跑，也拒絕複製磁碟（以前會改到它的磁碟）。
- **Markdown 預覽沒有開**（函式追蹤摘要、第三方除錯器說明）：VS Code 的 Markdown 擴充套件還沒啟動時，`markdown.showPreview` 不在已註冊的指令清單裡，VP Studio 就改以文字開啟。現在直接呼叫，失敗才以文字開啟。
- **Add Debug Configurations 找不到平台的符號檔**：焦點在終端機或面板、工作區又有多個平台時，找不到平台，設定裡就沒有 vmlinux。現在改用正在執行的平台。

## 0.2.10（2026-11-23）

### 新增

- **OpenOCD 除錯埠的核心除錯（G-13 第二段）**：Start Simulation with OpenOCD Port 寫出的 OpenOCD 設定改為每顆核心一個 `aarch64` 目標（一個 SMP 群組，gdb server 在 3333 埠、每顆核心一個 thread）。OpenOCD 可以停住、單步、讀寫暫存器與記憶體、設硬體與軟體中斷點，gdb 可經 OpenOCD 除錯客體核心。需要更新 QBox 的修補 0002（Build QBox），模擬器的 `debug_dap` 才有這些功能。
- **Build QBox 先檢查主機的套件**：建置前檢查 QBox 需要的工具與開發套件（cmake 3.21 以上、編譯器、ninja、Python venv 與標頭檔、libelf、libzip、GLib、libfdt、asio，以及 libqemu 用到的 pixman、slirp、SDL2、epoxy、libjpeg、virglrenderer）。以前缺一個套件要等 CMake 或 libqemu 的 configure 跑到一半才失敗，而且一次只報一個。缺套件時 Build QBox 檢視列出缺的項目與 `sudo apt install` 指令（Copy install command、Check again；確定檢查不準時可 Build Anyway），`tools/qbox-pin/build-qbox.sh` 也在 clone 之前停下並印出同樣的清單（`--no-deps-check` 跳過）。單獨檢查：`bash tools/qbox-pin/check-deps.sh`。
- `vp-kaslr`（`tools/gdb/vp-linux.py` 0.3.1）在讀不到 VBAR_EL1 時（OpenOCD 的 gdb server），改由核心 CPU 的 PC 以 2 MiB 為單位找出 KASLR 位移。

### 變更

- OpenOCD 設定不再有 `vp_halt`、`vp_resume`、`vp_halt_all`、`vp_resume_all`：改用 OpenOCD 自己的 `halt`、`resume`。`vp_status` 保留。gdb 斷開時核心繼續執行。

## 0.2.9（2026-11-23）

### 修正

- 客體 `poweroff`（或在模擬器終端機按 Ctrl-\\）讓模擬器結束後，狀態列仍顯示「VP running」、要按 Stop 才恢復。現在 VP Studio 偵測到模擬器結束（VS Code 的 shell integration 回報指令結束，或 sim agent 的連線被另一端關閉）就自動恢復狀態、中斷 agent、關閉 UART 主控台，並在狀態列說明；模擬器的終端機留著，可以看最後的輸出。

## 0.2.8（2026-11-23）

### 新增

- **多個 UART 主控台**：平台中接 `char_backend_socket` 的 UART，Start Simulation 時各開一個終端機（「UART <模組>」），可雙向收發；埠被占用時自動換空閒埠，遠端模擬經 SSH 轉發。

## 0.2.7（2026-11-23）

### 新增

- **Linux pretty-printer**：「變數」「監看」中 `cpumask` 顯示為 `{0-7}`、`atomic_t` 與 `refcount_t` 顯示數值、`kuid_t`／`kgid_t` 顯示編號、`qstr` 顯示名稱（設定 `vpStudio.debug.prettyPrinters`，預設開）。

## 0.2.6（2026-11-23）

### 新增

- **Memory Layout…**：選記憶體分頁每列顯示幾個 word、word 多大（1 到 16 bytes）。

### 變更

- Memory Inspector 的預設改為每列 4 個 32 位元 word（16 bytes），不再是每列 4 bytes。

## 0.2.5（2026-11-23）

### 新增

- **Find in Memory…**：在虛擬（經除錯器）或實體（經 sim agent）位址範圍中找文字、位元組或數值，結果開在 Memory Inspector。
- **View Address as Type…**：把位址當成 C 型別（例如 `struct task_struct` at `$SP_EL0`）加到監看並展開。
- **Load Symbol File at Address…**：在指定位址載入 ELF 的符號（核心模組 `.ko` 等）。
- **CPU Stepping…**：切換單步時只讓選取的 CPU 前進（gdb 的 scheduler-locking step）。
- **跨視圖聯動**：每次停下（除錯器的停止或單步，或模擬暫停），Peripheral Registers 標出自上次停下以來改變的暫存器與欄位（● was 舊值），Transaction Trace 與 Transactions 分頁標出兩次停下之間的匯流排存取；點一筆存取會在 Peripheral Registers 選到它的暫存器。
- **Load Kernel Module Symbols**：讀出客體 Linux 已載入的模組，找到 `.ko`（`vpStudio.debug.moduleDirs`，或從平台的 ext4 磁碟映像複製出來）後以實際的 section 位址載入符號；每個除錯工作階段第一次停下時自動載入找得到的（`vpStudio.debug.moduleSymbols`）。gdb 指令 `vp-lsmod`。
- **多個 QEMU instance 的除錯**：Start Simulation with Target Debug Port 為每個 instance 開一個 gdb 埠，Add Debug Configurations 為每個 instance 寫一個設定，加上一次附加全部的「VP: attach to every QEMU instance」。
- **例外發生前的呼叫**：Exceptions & Interrupts 攔截停下時，列出那顆 CPU 最後的呼叫與返回、仍未返回的呼叫鏈（需以 Start Simulation with Function Trace 啟動並開始記錄；sim agent 0.16.0 的 `ftrace.tail`，要重建）。
- **Jump to Cursor (Set PC)**：原始碼編輯器右鍵（或 Debug 組），把選取 CPU 的 PC 移到游標所在行，只動 PC，其他 CPU 不會趁機執行。CDT 本身不支援跳到游標。
- **Translate Virtual Address…**：除錯暫停時把虛擬位址轉成實體位址，列出每一層頁表描述元、EL1／EL0 的讀寫執行權限、記憶體類型與 shareability，以及實體位址落在哪個模組；轉換失敗時寫出 fault 的種類與層級。CPU Registers 中 PC、SP、LR 旁的 **pa** 按鈕直接轉換該值。
- **QEMU Monitor…**：經 gdb 執行 QEMU monitor 指令（`info mtree -f`、`xp` 看實體記憶體等），輸出開在唯讀文件。
- **Exceptions & Interrupts**：SVC 可只攔特定系統呼叫（名稱或號碼，例如 `openat, ioctl`），事件也顯示系統呼叫名稱（sim agent 記錄 x8）。

### 修正

- 平台有多個 QEMU instance 時，從 VS Code 啟動模擬會 segfault：sim agent 用了第一個找到的 instance 註冊例外記錄（預設開），但 plugin id 屬於另一個。sim agent 0.16.0 新增參數 `plugin_qemu`，由 VP Studio 指定；較舊的 agent 遇到多個 instance 時不開例外記錄。

## 0.2.4（2026-11-23）

### 新增

- **Show Memory…**：除錯暫停時輸入位址或運算式（例如 `&jiffies`、`$sp`），以 Eclipse CDT 的 Memory Inspector 打開記憶體，以 hex 表格查看與修改，不必下 gdb 指令。CPU Registers 檢視中 PC、SP、LR 與像位址的暫存器旁有 **mem** 按鈕，標題列也有這個指令。
- 沒有安裝 Memory Inspector 時，附加除錯器或按 Show Memory 會詢問並直接安裝，不必到擴充功能面板搜尋；在除錯中途安裝時提供「Reattach」，重新附加後即可使用（模擬繼續執行）。
- 獨立版內建 Memory Inspector（`eclipse-cdt.memory-inspector` 1.3.0）。說明見 [docs/debugging.md](docs/debugging.md)。
- **Debug Layout**：一個指令排好除錯版面：Run and Debug 側欄，編輯區左邊原始碼、右上反組譯、右下記憶體；已開的窗格不會重複開。
- **Show Disassembly**：開 VS Code 的反組譯檢視；CPU Registers 中 PC 旁也有 **dis** 按鈕。第一次開時可選擇只顯示指令（混入原始碼時核心的指令會不依位址排列）。
- **Peripheral Registers** 也出現在 Run and Debug 側欄（與 VP Studio 側欄的相同），除錯時不必切換側欄。
- **Interrupt Controller (GIC)**：列出 GICv3 每個中斷由哪個裝置驅動、是否 enable／pending／active、優先權、觸發方式、群組與目標 CPU，並寫出送不到 CPU 的原因（沒 enable、群組關閉、優先權 0xFF、路由到不存在的 CPU、redistributor 睡眠等）。暫停或被除錯器停住時自動讀取，也可在執行中每秒讀取；只讀沒有副作用的暫存器。
- **Exceptions & Interrupts**：記錄 CPU 進入的每一次例外與中斷（種類、ESR 解讀、FAR、EL、PC、向量），並可在指定種類（Data abort、Undefined instruction、SVC、IRQ…，可限定來自 EL0 或 EL1）發生時停下：那顆 CPU 停在向量入口，處理程序還沒執行。不需要除錯器，也不限於 Linux。需要 sim agent 0.15.0（設定 `vpStudio.exceptions.record`，預設開）。
- sim agent 0.15.0：`exc.*` 方法與參數 `exceptions`；`mem.read`／`mem.write` 的 `width` 把一段讀寫拆成暫存器大小的存取；有除錯器時若由除錯器繼續被 agent 暫停的模擬，agent 也跟著繼續（以前 SystemC 會停著）。
- **Add Conditional Breakpoint…**：在函式上設帶條件與命中次數的中斷點。CDT 的函式中斷點會忽略條件與命中次數，這個指令改設在函式所在的原始碼行，本機沒有原始碼也可以。

## 0.2.3（2026-11-22）

### 修正

- **效能面板**：執行或掃描根本無法進行時（結果資料夾無法建立或寫入），面板不再一直停在「Running」，而是顯示「Failed」與原因。按 Stop 與正常結束的行為不變。
- **Build QBox**：VP Studio 更新後修補檔內容有變時，已經套用舊版修補的 QBox 不再建置失敗。`build-qbox.sh` 會逐檔把修補更新到目前版本，被取代的舊檔留在 QBox 的 `build/vp-studio-replaced/`；做不到時停止，不改動任何檔案。
- **Check QBox Version**：修補未套用的警告說明可能是套用了舊版，並建議以 Build QBox 處理。
- **Windows 簽出**：`patches/` 下的檔案一律使用 LF 換行。先前在 `core.autocrlf` 開啟時，修補檔會被轉成 CRLF 而無法套用。
- **元件目錄**（`catalog/qbox-catalog.json`）：不再含有產生它的那台機器的資料夾路徑；`tools/qbox-catalog` 寫檔時改以 `<qbox>`、`<libdir>`、`<qbox-catalog>`、`~` 表示。
- 修補 0002 加進 QBox 的 `debug_dap/README.md` 中，VP Studio 檔案的路徑已更正。
- **打包**：`package.json` 加上 `repository`（GitHub 的 PanKuoTsai/vp-dev）。README 與變更記錄改用相對連結後，沒有它 `npm run package` 會失敗。

### 變更

- **平台描述的 schema** 改為 JSON Schema draft-07，與其他三份一致；接受與拒絕的平台檔和之前相同。四份 schema 的 `$id` 統一為 `https://novatek.com.tw/vp-studio/schemas/<檔名>`。
- **獨立版的檔名跟著版本**：AppImage 為 `VP-Studio-0.2.3-x86_64.AppImage`（以前固定為 0.2.0）。
- **打包**：`tools/` 改為整個隨擴充套件出貨，只排除建置輸出；新增的工具檔不必再逐一登記。
- **README** 精簡為概觀、安裝與使用，其餘章節移到 `docs/`（功能說明、驗證狀態、除錯、命令列與 CI、設定、專案結構）。
- **原始碼的位置**（指令、設定與功能都不變）：
  - `extension.js` 只留啟動與註冊，其餘依功能分到 `src/`。
  - `lib/` 依主題分成 `platform`、`sim`、`analysis`、`debug`、`generate`、`setup`、`webview`。
  - 各 webview 頁面的樣式表與頁面腳本移到 `media/`。
  - Create Example 複製的範本由 `examples/` 移到 `templates/`；隨附的暫存器描述由 `catalog/registers/` 移到 `registers/`。
  - Windows 的 SSH 密碼輔助程式由 `lib/` 移到 `prebuilt/win32/`，並附 SHA-256。
  - 修補 0002、0003 的內容以原始碼存放在 `patches/qbox/src/`，修補檔由 `patches/make-patches.js` 產生。

### 新增

- **CI**（GitHub Actions）：推送到 `main` 與每個 pull request 時，在 Linux 上以 Node.js 18 與 22 執行測試，並執行 lint 與型別檢查。
- **開發工具**：`npm run lint`（ESLint）、`npm run typecheck`（以 TypeScript 檢查 JavaScript，既有的發現記在基準清單，只有新出現的才算失敗）。
- **測試**：依主題分成多個檔案，可單獨執行（`node test/run.js core view`）；新增 schema、修補檔、打包清單與元件目錄的檢查。
- 說明文件：`catalog/README.md`、`prebuilt/README.md`、`tools/README.md`，以及這份變更記錄。

## 0.2.2（2026-11-22）

匯入這個版本庫時的版本。這一版有哪些功能、還沒有哪些，見 [功能說明](docs/features.md)；更早版本的變更沒有記錄在這個版本庫裡。
