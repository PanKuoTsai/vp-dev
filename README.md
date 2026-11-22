# VP Studio

以 JSON 平台描述為核心，在 VS Code 相容編輯器中設定、檢視、執行與除錯 QBox 虛擬平台的擴充套件。

發行者 ID 為 `novatek`（擴充套件識別碼 `novatek.vp-studio`），獨立版的 appId 為 `tw.com.novatek.vp-studio`。

## 這一版有什麼

| 功能 | 說明 |
|---|---|
| 平台描述編輯 | `*.platform.json` 自動套用 schema：自動完成、欄位說明、格式錯誤提示 |
| 語意檢查 | bind 或 args 指向不存在的實例、同優先權的位址重疊、大小為 0，即時顯示在「問題」面板 |
| Lua 產生 | 由 JSON 產生 QBox 的 Lua 設定檔，寫在 JSON 旁邊（`<name>.generated.lua`） |
| 平台檢視 | 方塊圖、記憶體映射表、訊號連線表、變數表；雙擊方塊或點表格列跳到 JSON 中的定義，存檔前就會即時更新 |
| 參數編輯 | 點方塊圖中的模組，下方列出它的參數（來自元件目錄：預設值、型別、說明）。依型別輸入：布林用下拉選單，整數接受十進位、十六進位、`${變數}` 加偏移，清單與 `sc_time` 用 JSON；清空即回到預設值。不合法的輸入在欄位下方說明原因、不寫入；變更只改動 JSON 中該參數那一處。複製多份的模組（如 `cpu ×8`）可用「Applies to」選擇套用到全部或單一實例（寫入 `perIndex`，需要時自動建立）；只能設在一顆 CPU 的參數（`gdb_port`）在「全部」時停用並說明。Lua 運算式只顯示，需在 JSON 中修改 |
| 軟體映像檔設定 | 平台檢視中的「Software images」表單：新增、移除、以檔案選擇器挑選 elf 或 bin、設定載入位址；變更直接寫回 JSON，只改動 `entries` 那一段 |
| 新增與刪除模組 | 平台檢視的「Add module…」（或命令 `VP Studio: Add Module…`）：從元件目錄挑型別、取名（自動建議不重複的名稱）、選擇建構參數（只列出型別相符的模組），寫入 JSON 並自動選取新模組；需要 `dylib` 時自動帶入。必填參數由「問題」面板提示。參數面板的「Delete module」：列出其他模組綁到它的連線，確認後一併刪除（一次編輯，Ctrl+Z 可整個復原）；若有模組以它為建構參數則拒絕刪除 |
| 連線 | 每個模組面板的「Connections」列出元件目錄中的所有埠，以及每個埠綁到哪裡（自己宣告的 → 與其他模組綁過來的 ←），可逐條「Disconnect」。「Connect…」或在方塊圖上從一個方塊拖到另一個方塊：選埠、選對方模組，只列出種類相容的埠（訊號輸出接輸入、匯流排起始端接目標端），向量埠詢問編號（預設下一個未用的），複製多份的模組可用 `{i}` 一對一對應；接到 router 的目標埠會詢問位址與大小。照原檔慣例由裝置端寫入（router 端從不宣告） |
| 子系統（巢狀 Container） | schema 0.2：模組加上 `"modules": {…}`（`type` 用 `"Container"`）就成為子系統，裡面再放模組，可多層。子系統內的 bind 與 args 名稱先在自己的子系統找，找不到再往外層找，所以可直接寫 `router.initiator_socket` 接到外層匯流排；`periph.uart_0.irq` 這種有點的名稱可指到子系統裡面。產生的 Lua 是巢狀的 Container，往外的連線寫成 `&platform.…`（QBox 據此決定建構順序）。方塊圖中子系統可收合成一個方塊（接在其內容所用的外層匯流排上，內部的匯流排一併隱藏）或展開（內容各自畫出，標示所屬子系統）；子系統面板有 Expand/Collapse、「Add module here…」、內容清單與「Delete subsystem」（連同內容，以及外面接進來的連線）。「Add Module…」可選放在哪一層，或新增空的子系統。連線、參數、交易追蹤、device tree、CCI 參數寫回都支援子系統內的模組；寫入的名稱是從該處能解析回去的最短名稱 |
| 映像檔檢查 | 檔案是否存在、載入範圍是否超出記憶體、是否落在非記憶體模組或未映射位址、映像檔之間是否重疊、ELF 被當成 raw binary 載入 |
| 除錯符號連動 | 載入的 ELF 或指定的符號檔（例如 vmlinux）會自動成為除錯設定的 `program` |
| 模組側邊欄 | 活動列 VP Studio 中的「Platform Modules」樹狀檢視，列出模組與埠 |
| 元件目錄檢查 | 模組型別（附相近名稱建議）、建構參數數量、埠名稱、連線兩端種類、參數名稱與型別、必填參數 |
| 執行模擬 | 一鍵產生 Lua 並在整合終端機啟動模擬器；UART（stdio 後端）就在該終端機。平台中標為 `hostPort` 的變數（如 SSH 轉發埠 `HOST_PORT_SSH`）若已被占用，會自動改用空閒埠並告知，狀態列提示顯示實際使用的埠。啟動前會檢查平台的可寫入磁碟映像檔是否正被另一個模擬器鎖住（QEMU 一次只允許一個寫入者），是的話先說明是哪個行程（僅 Linux）；也會讀 ext4 映像的 superblock，可用空間低於 5%（最多 256 MB）時警告並說明如何清理（客體磁碟滿時仍能開機，但名稱解析、時間同步等服務會失敗；每次未經 `poweroff` 就結束模擬都會留下一份 systemd 日誌） |
| 暫停、繼續、模擬時間 | 由擴充套件啟動的模擬會自動加入 sim agent 並連線：狀態列顯示模擬時間，點一下暫停或繼續；編輯器右上角與參數檢視也有按鈕。gdb 停住 CPU 時，SystemC 模擬時間也一起停，狀態列顯示「Halted by debugger」。`VP Studio: Run For…` 執行一段模擬時間後自動暫停（例如 `500 ms`），`Run Until…` 跑到指定的模擬時間暫停；排定時狀態列顯示「目前時間 → 停止時間」，暫停時的提示也有這兩個連結。停點落在停止時間或稍後（Ubuntu 平台實測晚 0 到 5 ms，quantum 為 10 ms）；手動暫停會取消排定的停止。客體閒置時 SystemC 時間走得很慢，執行到停止時間也跟著變慢 |
| 交易追蹤 | `VP Studio: Start Simulation with Tracing…`：從匯流排上的埠（各裝置的 target socket）勾選要追蹤的，啟動時在 router 與裝置之間插入追蹤模組（平台 JSON 不變）。「Transaction Trace」面板持續顯示每筆存取：模擬時間、追蹤點、讀寫、位址、大小、值與回應狀態；可依追蹤點、讀寫、位址或位址範圍篩選，暫停跟隨、開關錄製、清除、匯出 CSV。裝置的存取完整記錄；記憶體預設允許 DMI，CPU 直接存取的部分看不到。清單最後的「Signals」可勾選中斷等訊號線（需 sim agent 0.7.0）：每次電位變化以「signal ↑／↓」與匯流排存取依序列在同一張表，可用 Access 篩選「signal」，「Export VCD…」存成 VCD 用波形檢視器（如 GTKWave）開啟。只列出至少一端是 SystemC 模型的訊號線（Ubuntu 平台是 PL011 的中斷；建模精靈的模型也是）：兩端都是 QEMU 的線在 QEMU 內部直接連接，插入追蹤會改變同步方式，GIC 到 CPU 的線因此無法開機 |
| 效能剖析 | `VP Studio: Start Simulation with Profiling`：每顆 CPU 每執行約 1 萬條指令取樣一次程式位址（需 sim agent 0.8.0），旁邊開出 Profile 面板，每 2 秒更新：各函式的樣本比例、kernel／user space、長條圖。可選 CPU、Reset（重新開始計算區間）、暫停取樣。函式名稱取自符號檔：平台的除錯符號檔，或按 Choose… 選（例如 vmlinux）；arm64 Linux 的 KASLR 位移由 guest 記憶體自動算出，不必加 nokaslr。符號對不上時顯示警告。user space 的位址只歸成一列（不載入程式的符號）。只剖析第一個 QEMU 執行個體；開機約慢 12% |
| 函式進出追蹤 | `VP Studio: Start Simulation with Function Trace`（需 sim agent 0.11.0）：記錄客體每次函式呼叫與返回（AArch64 的 BL/BLR/RET），每顆 CPU 保留最新的 262144 筆（`vpStudio.ftrace.bufferPerCpu`）。執行中以 **Function Trace: Start Recording…** 選 Kernel／Everything／User space 開始記錄（可搭配 Run For…），**Function Trace: Stop and Save** 存到平台旁的 `traces/`，並以符號檔（例如 vmlinux）轉成：`.json` 時間軸（在 [Perfetto UI](https://ui.perfetto.dev) 開啟，檔案不會上傳）與 `.md` 摘要（各函式呼叫次數、自身與含子函式的指令數）。KASLR 位移由執行中的核心或呼叫目標自動算出。已存的 `.vpft` 可用 **Function Trace: Convert Trace File…** 重新轉換。時間是主機時間，指令數是精確值；看不到 tail call。插入追蹤時開機約慢 30%，只在記錄時才寫入 |
| 周邊暫存器 | 活動列 VP Studio 中的「Peripheral Registers」：列出平台中有暫存器描述的周邊（隨附 PL011、GICv3 distributor、virtio-mmio；建模精靈的模型用它的 `*.model.json`），暫停時展開即讀取：暫存器值與各位元欄位。鉛筆圖示（Set Value…）可改整個暫存器或單一欄位（讀出、改欄位、寫回；w1c 只寫該欄位），寫入前確認。讀取會改變裝置的暫存器（例如 PL011 的 DR 會取走一個字元）與唯寫暫存器不自動讀，可按 Read Now。讀寫經 sim agent 的匯流排連接埠（需 0.6.0），不推進模擬時間、不會被交易追蹤記錄。描述檔格式見 `catalog/registers/` |
| Linux 感知 | 以 VP 的除錯設定附加到目標（`gdbtarget`）並以 vmlinux 為 program 時，擴充套件自動在 gdb 載入 `tools/gdb/vp-linux.py`（設定 `vpStudio.debug.linuxAwareness`）：附加時依執行中的核心校正 KASLR 位移（第一次停住的呼叫堆疊就正確），gdb 終端機可用 `vp-ps`、`vp-dmesg`、`vp-kaslr`。活動列 VP Studio 中的「Guest Processes」檢視在目標停住時列出各 CPU 正在跑什麼，以及依父行程排成樹的行程與執行緒；標題列的「Show Guest Kernel Log」在編輯器開出核心日誌。只用核心的 DWARF 型別，不需要核心建置產生的檔案。實測與客體 `ps -e`、`dmesg` 完全一致。說明見 `tools/gdb/README.md` |
| 交付套件 | `VP Studio: Export Kit…`（平台檔案的右鍵選單也有）把平台、它引用的每個檔案（loader 的映像、磁碟映像、Lua、除錯符號）、釘選的 QBox 版本與修補、所用模型的原始碼打包成一個 `.tar.gz`，附產生的 README 與 `SHA256SUMS`。平台旁的 `${TOP}` 路徑保持原本的相對位置；絕對路徑的檔案放進 `platform/_external/` 並改寫成 `${TOP}` 相對路徑。不含 QBox 本身。打包前可取消勾選大檔（1 GiB 以上預設不勾，例如 4 GB 的磁碟映像），README 記下大小、sha256 與下載位置。`VP Studio: Open Kit…` 解開到指定資料夾並逐檔比對 sha256，再列出缺的檔案（可「Locate…」選本機檔案，比對 sha256 後複製進套件）、QBox 版本差異、要建置的模組，最後開啟平台。命令列：`vp-run --export-kit`、`--import-kit` |
| 存檔與還原 | 需 sim agent 0.10.0 與 libqemu 修補（`patches/libqemu/`，`Check QBox Version` 會檢查）。模擬執行中按 `VP Studio: Save Checkpoint…`（Simulation Parameters 標題列也有按鈕）：暫停、存下 QEMU 的 CPU 與裝置狀態、RAM（`gs_memory`，經 DMI，只存非零頁）、SystemC 周邊的暫存器（PL011）與磁碟映像副本，存在平台旁的 `checkpoints/<名稱>/`，之後繼續執行。`VP Studio: Start from Checkpoint…`（平台檔案右鍵選單也有）啟動新的模擬並在開始時載入，客體從存檔時的狀態接著跑；磁碟先複製到存檔的 `run/`，存檔本身不變。Ubuntu 平台存檔約 9 秒（含 4 GB 磁碟），從存檔到客體回應約 15 秒，冷開機約 240 秒。MTTCG 本身不確定，所以只保證從同一個狀態繼續，不保證每次結果相同；主機端連線（SSH）不會接續；沒有狀態介面的 SystemC 模型會在存檔前列出。命令列：`vp-run --save-checkpoint DIR`、`--restore DIR`（加 `--snapshot` 不複製磁碟）|
| 探針（預先插好、執行中開關） | 需 sim agent 0.9.0。每次啟動模擬時，在所有可插的位置預先放探針：匯流排上的埠（非複本、沒有 `{i}`／`repeat`）與至少一端是 SystemC 模型的訊號線。探針平時不記錄。要觀察哪些線（可多條），執行 `VP Studio: Choose Probes…` 或在 Transaction Trace 面板最上方的「Probes」按 Choose… 勾選，立即生效、不必重啟；面板上每個記錄中的探針有 ✕ 可單獨停掉。分 Bus／Memory／Signals 三類。記憶體探針開始記錄時會收回 CPU 的直接存取權（DMI），之後 CPU 對它的每筆存取都看得到，模擬會變慢；停止後恢復。記錄中的選擇記在工作區，作為下次「Start Simulation with Tracing」的預設。Ubuntu 平台共 12 個探針，全插上且不記錄時開機時間與沒插相同（221 秒對 234 秒）。設定 `vpStudio.probes.insertAll` 關閉時，只在「Start Simulation with Tracing」選的位置放探針（舊行為；舊版 agent 也是如此） |
| 匯流排中斷點 | 交易追蹤面板的「Break on」：選追蹤點（或任何點）、讀或寫、位址或範圍，選填的 Value 與 Mask（例如 Value `0x0a`、Mask `0xff`：只比對最低 8 位元；Mask 空著比對整個值），按 Add。符合的存取一發生就暫停模擬，面板頂端說明是哪筆存取並標出那一列，狀態列顯示「breakpoint #n」，按 Continue 繼續。中斷點記在工作區，下次啟動仍在；只對有追蹤的裝置有效（需 sim agent 0.5.0）。停點不是精確的：CPU 會再跑 0 到幾筆存取才停住，面板會說明這段期間有幾筆存取、其中幾筆也符合條件；要停在精確的指令請用 gdb watchpoint |
| CCI 參數檢視 | 活動列 VP Studio 中的「Simulation Parameters」，依階層列出執行中模擬的 CCI 參數與目前值；滑鼠停留顯示型別、說明、是否由設定檔指定；暫停時自動重新讀取 |
| 修改執行中的參數 | 參數旁的鉛筆圖示或右鍵「Set Value…」：依型別檢查輸入（整數接受十六進位並檢查範圍，字串不需引號），寫入執行中的模擬。被鎖住或 immutable 的參數不提供修改並說明原因。寫入後可按「Save in Platform」把同一個值寫進平台 JSON（複本寫在該實例的 `perIndex`），下次啟動也會套用。模型何時讀取新值由模型決定，很多只在啟動時讀一次，訊息中會說明 |
| 除錯 | 以指定 gdb 埠啟動；產生兩組 launch 設定（目標軟體、模擬器行程） |
| device tree 產生 | `VP Studio: Generate Device Tree`（檔案總管右鍵）：由平台描述產生 DTS 並立即以 `dtc` 編成 DTB：沒設 `devicetree.output` 時兩者都在平台旁邊（`<name>.generated.dts`/`.dtb`）；設了則 DTS 與 output 的 DTB 同目錄同名（例如 `generated.dts` 與 `generated.dtb`）。手動修改 DTS 不會被編譯，下次產生時會被覆寫。位址取自各模組接到匯流排的埠，中斷號碼取自接到 GIC 的連線（`spi_in_N` 為 SPI N，`ppi_in_cpu_k_N` 為 PPI N-16）。支援 Arm CPU（`mp_affinity` 與 `psci_conduit` 的 Lua 運算式會被求值）、PSCI、generic timer、PMU、GICv2/v3、RAM（背景記憶體除外）、PL011、PL031、virtio-mmio、generic PCIe host（ECAM、視窗、INTx 對應）、`chosen`（bootargs、console、由 loader 項目與檔案大小算出的 initrd 範圍）。其他型別可在模組加 `"devicetree": {"compatible": …}` 產生節點，或 `false` 排除；不認得又有位址的模組列在 VP Studio 輸出中。平台設定 `devicetree.output` 時，Start Simulation 會先重新產生，確保 device tree 與平台一致；若沒有 loader 項目載入它，「問題」面板會警告 |
| 建模精靈 | `VP Studio: New Model…` 建立 `models/<name>/`：在 `<name>.model.json` 描述暫存器（位移、大小、rw/ro/wo/w1c、重設值、欄位）、CCI 參數、中斷輸出與訊號輸入（有 schema 自動完成，錯誤即時顯示在「問題」面板）。存檔就重新產生 `include/<name>_regs.h`（socket、參數、位址解碼、存取型別、hook、欄位常數）與自我測試；`include/<name>.h`、`src/<name>.cc` 只產生一次，在其中覆寫 `after_write_<REG>`、`read_<REG>`、`on_<input>` 加入行為。`Build Model`（編輯器右上角）對 QBox 建置編出 `.so`、跑自我測試（重設值、各存取型別、位元組存取、未映射位址）、自省成元件目錄項目；之後平台的「Add Module…」就會列出它，寫入 `"dylib": "${TOP}…"` 相對路徑。說明見 `tools/model-build/README.md` |
| IP-XACT 匯入 | `VP Studio: Import IP-XACT…`（`.xml` 檔的右鍵選單也有）：讀 IP-XACT 元件（SPIRIT 1.4/1.5、IEEE 1685-2009、-2014、-2022）的 memoryMap、addressBlock、register、registerFile（可巢狀、可 `dim` 陣列）與 field（bitOffset、bitWidth、access、modifiedWriteValue、readAction、reset），數值可寫成 IP-XACT 的各種寫法或參數的運算式（例如 `REG_SPACE - 4`、`'h40 * NUM`）。挑一個 address block，匯入成三種之一：**新模型**（建模精靈的 `*.model.json` 加上產生的 C++，再自己加參數、訊號埠與行為）；**取代既有模型的暫存器**（保留參數、埠與自己寫的 C++）；**現有模組型別的暫存器描述**（`registers/<型別>.registers.json`，例如替 QEMU 裝置寫描述，Peripheral Registers 檢視即可列出它的暫存器；工作區的描述優先於隨附的）。存取權限依欄位合併成暫存器層級（全唯讀 → ro，one-to-clear → w1c，混合時取 rw 並說明）；沒辦法照原樣匯入的部分（bank、subspace map、2022 的 type definition、非 8/16/32/64 位元的暫存器、write-once 等）寫在 VP Studio 輸出中。範例：`examples/ipxact/simple_timer.xml`。SystemRDL 請先用 PeakRDL 轉成 IP-XACT（`peakrdl ip-xact`） |
| 第三方除錯器 | `VP Studio: Third-Party Debugger Setup…`（平台檔案右鍵選單也有）：依平台的 gdb 埠、CPU 型別、核心數與符號檔，在平台旁的 `debug/` 寫出 TRACE32 的 PRACTICE 腳本（`<平台>.trace32.cmm`：`SYStem.CPU`、`SYStem.PORT host:port`、`SYStem.GDBconfig GDBSERVER OFF`、`SYStem.Mode Attach`、`Data.LOAD.Elf … /NoCODE`）與說明（`<平台>.debuggers.md`：TRACE32、Arm Development Studio、任何 GDB 用戶端的步驟）。TRACE32 以 GDB Front-End 連 QEMU gdbstub 是 Lauterbach 文件中的支援情境（每顆核心是一個 thread）；Arm DS 能否以 gdbserver 連 bare-metal 目標，Arm 官方與第三方說法不一，**未確認**。QBox 的 gdbstub 監聽所有網路介面、沒有密碼，說明中附 SSH tunnel 的做法 |
| 遠端模擬 | 模擬器在另一台機器上跑，VP Studio 留在本機，只用 OpenSSH（不需要微軟的 Remote 擴充套件）。`VP Studio: Select Simulation Host…` 選 `~/.ssh/config` 中的主機或輸入 `user@host`，並填遠端對應這個工作區資料夾的路徑（通常是 QBox 資料夾）。之後 Start Simulation（含除錯、追蹤、剖析）就在遠端執行：Lua 在本機產生、寫到遠端的平台資料夾（`${TOP}` 在遠端解析）；平台需要的檔案在遠端找不到或大小不同時列出，可直接上傳；模擬器在終端機的 `ssh -tt` 裡執行（主控台照常互動，關閉終端機即停止）；sim agent、gdb 埠與平台的主機轉發埠（如客體 SSH）轉到本機的埠，暫停、參數、暫存器、追蹤、剖析、gdb 附加都照常。`Build Sim Agent on Remote Host`把原始碼送到遠端，對遠端的 QBox 建置；`Check Remote Host` 檢查登入、模擬器、QBox 建置、agent 與 QBox commit。`Build Model on Remote Host` 把建模精靈的模型送到遠端對應的資料夾建置，並把目錄項目取回本機。登入用金鑰，或設定 `vpStudio.remote.auth` 為 `password`（VP Studio 經 SSH_ASKPASS 問一次密碼，可記在 VS Code 的密碼儲存區，`Forget Remote Password` 清除）；遠端執行時不支援存檔與還原。Windows 原生的 VS Code 一律以這種方式執行（INSTALL.md 第 12 節）：只在本機建置 QBox 的指令不顯示，`dtc` 在遠端執行。容器：本機用 `tools/container/run.sh` 當模擬器；遠端主機上的容器同理（`vpStudio.remote.executable` 指向遠端的 run.sh） |
| 效能分析（架構探索） | 不跑真正的軟體，以流量產生器模擬各個 master 的存取，經近似時序（AT，nb_transport）的匯流排送到 DRAM 控制器，量測頻寬、延遲分布、仲裁等待、DRAM row hit rate。模型在 QBox 的 `perf` 元件（VP Studio 的 QBox 修補 0003，`build/perf.so`）：`traffic_gen`（循序、隨機、跨步或回放存取紀錄；讀寫比、burst、速率、在途交易上限、qos）、`at_bus`（round_robin／priority／fcfs 仲裁、請求與回應通道、pipeline 延遲；位址照 router 的寫法放在目標端；`masters` 依 master 設 QoS：`priority`、頻寬上限 `max_mbps`、保證頻寬 `min_mbps`、在途上限 `outstanding`，可當記憶體控制器前端 MAU；`topology` 為 `shared` 或 `crossbar`，at_bus 可接在 at_bus 後面（MAU 接在系統匯流排後，連線設 `relative_addresses: false`、MAU 設 `input_queue`））、`dram_ctrl`（bank、open row、tRCD/tCL/tRP、refresh、FR-FCFS／FCFS、open／closed page、`qos` 依 MAU 給的優先權排程；預設約 DDR4-3200 64 位元）、`perf_stats`（寫出統計 JSON）。平台照常寫在 `*.platform.json`，平台檢視把 `at_bus` 畫成匯流排。`VP Studio: Run Performance Experiment` 執行一次，Performance 面板列出各 initiator 的頻寬與延遲（mean、p50、p99、max）、延遲直方圖、DRAM 與匯流排的統計；`New Performance Sweep…` 建立 `*.perfsweep.json`（要變動的參數與值、要看的指標、CI 門檻），`Run Performance Sweep…` 跑每一種組合（預設同時跑 CPU 數一半的模擬），面板以折線圖比較，結果存在 `perf-results/`（`results.json`、`results.csv`、每次的統計）。`Create Performance Example` 放兩份範例：顯示、DMA、CPU 共用一個 DDR 通道（`ddr-contention`），以及兩個不交錯的通道（`ddr-2ch`：兩個 `dram_ctrl` 各管 512 MiB，顯示器用通道 0、DMA 與 CPU 用通道 1），以及兩顆 DDR 各有自己的 MAU（`mau-2ddr`：`mau0`＋`ddr0` 管 0–0x7FFF_FFFF、`mau1`＋`ddr1` 管 0x8000_0000–0xDFFF_FFFF，CPU 優先權較高、display 保留 6000 MB/s），以及系統匯流排（crossbar）後面接兩個 MAU（`mau-sysbus`，CPU 是一個 master、位址跨兩顆 DDR），各附一份掃描檔（`mau-qos` 比較有無保留頻寬，`mau-sysbus` 比較共用匯流排與 crossbar；掃描檔可寫 `mau0.masters.display.min_mbps` 掃單一 QoS 值）。面板的「Masters on each bus」列出每個 master 在各匯流排的頻寬、QoS 設定、請求與回應等待、保留頻寬內的比例與被上限擋下的次數。多個通道目前以各管一段位址的方式表示，`at_bus` 還不支援交錯（interleave）。命令列：`vp-run --perf`、`vp-run --perf-sweep`（`--junit` 給 CI）。結果的準度取決於參數，需以 DRAM datasheet、匯流排規格或 RTL 校正；CPU 不能接到 `at_bus`（QEMU 用 b_transport）。說明見 QBox 修補中的 `systemc-components/perf/README.md` |
| 獨立版（Theia） | `theia/`：以 Eclipse Theia 1.74 把 VP Studio 包成獨立的桌面程式（Linux AppImage，約 175 MB），不需要安裝 VS Code。內建 VP Studio、CDT GDB Debug Adapter 與 JSON 語言支援（皆來自 Open VSX，不依賴微軟專有擴充套件）。`theia/build.sh --package` 建置；說明見 `theia/README.md` |
| QBox 版本釘選 | 這一版測試過的 QBox commit 記在 `qbox.pin.json`。啟動模擬時比對模擬器所屬的 QBox、元件目錄、sim agent 各自來自哪個 commit，不一致就警告（不擋啟動）；`VP Studio: Check QBox Version` 列出完整比對。`tools/qbox-pin/build-qbox.sh` 從乾淨的 clone 建置釘選的 QBox，並一併建置 sim agent 與元件目錄；`tools/container/` 有對應的容器映像（尚未實際建置） |

## 這一版沒有什麼

- 建立含 `repeat` 的連線（如 GIC 對每顆 CPU 的 `irq_out_{i}`）仍需在 JSON 中撰寫；表單只建立單一連線或以複本 `{i}` 對應的連線
- sim agent：不能單步；指定時間暫停會稍晚於指定時間（最多約一個 quantum）；無法得知修改的參數是否立即生效
- 建模精靈：只產生記憶體映射的暫存器型周邊（一個 target socket）；不產生計時、DMA 或主動發起交易的程式碼，這些需在 `<name>.h` 自行撰寫；暫存器沒有 side effect 的宣告（如讀取即清除），用 `read_<REG>` hook 實作
- 遠端模擬：不支援存檔與還原；命令列 `vp-run` 只在本機執行；建模精靈的模型要在遠端自己建置（`tools/model-build/build.sh`）；遠端需是 Linux（讀 `/proc/net/tcp` 找空閒埠）
- IP-XACT：只讀暫存器映射，不讀 bus interface、port、view 等；依目標 SoC 補齊周邊模型要等決定目標 SoC（待決定事項 Q-08）
- 子系統：不能以 `count` 複製整個子系統，也不能宣告子系統自己的埠（QBox 的 `container_builder` 埠別名未支援）；名稱會遮蔽外層同名模組，新增時會擋下，手寫時「問題」面板以 info 提示
- device tree：GICv3 ITS、GICv2m、SMMU、16550 等 UART 尚無內建對應（可用模組的 `devicetree` 自行描述）；不讀取既有的 DTS 做比對

## 驗證狀態

| 項目 | 狀態 |
|---|---|
| 產生器、分析、映像檔檢查、JSON 局部編輯、目錄檢查、sim agent 客戶端、參數表單、新增與刪除模組、連線、主機埠、磁碟映像鎖、交易追蹤、版本比對、執行中參數的輸入檢查與寫回平台、device tree 產生、Lua 運算式求值、子系統、建模精靈、外部 CPU 模組的 dylib 檢查、磁碟映像可用空間、Linux 感知、交付套件與 tar、存檔與還原、修補偵測、XML 與 IP-XACT 匯入、第三方除錯器設定、遠端模擬、EL3 開機檢查、函式進出追蹤 | 131 個單元測試通過（`npm test`）；產生器輸出與 Python 原型逐位元一致 |
| 參數表單的網頁行為 | 已在無頭 Firefox 中以腳本實際操作（選取、送出、重設、篩選、錯誤顯示、切換套用範圍、`gdb_port` 鎖定、重新渲染後還原選取、範圍、篩選與焦點）；使用者已在 VS Code 中使用（2026-11-14） |
| sim agent（`tools/sim-agent`） | 已驗證（2026-11-14，Ubuntu AArch64 8 核心）：在 `login:` 暫停時打字客體無回應、主機 CPU 降到 0%，繼續後才出現；開機中隨機暫停與繼續 40 次全部確實凍結、無卡住；`lib/simagent.js` 對實際 agent 跑過連線、暫停、繼續、通知、參數列表 |
| 暫停按鈕、狀態列、參數檢視（VS Code 介面） | 已驗證（2026-11-14，使用者以 F5 實測） |
| 元件目錄（`catalog/qbox-catalog.json`） | 由 `tools/qbox-catalog` 從 QBox 產生：111 種模組，107 種已自省。範例平台檢查為 0 個問題；把 CPU 換成 A53 時預測的錯誤，與 QBox 實際中止時的訊息一致 |
| 軟體映像檔表單 | 已在瀏覽器中實際操作測試（輸入、驗證、新增、移除） |
| 平台檢視的 HTML | 已在瀏覽器中實際渲染檢查；子系統的收合、展開、面板按鈕已在無頭 Firefox 中以腳本操作 |
| 建模精靈產生的模型 | 已驗證（2026-11-15）：範例模型編譯、自我測試 21 項全過、元件目錄自省成功；放進 Ubuntu 平台後由 CPU 執行的測試程式存取，交易追蹤看到寫入、hook 改變的值與重設值，hook 的訊息出現在主控台 |
| 子系統的 Lua 能否在 QBox 開機 | 已驗證（2026-11-15）：PL011 與 virtio 根磁碟移入子系統 `periph`，往外綁到 router、GIC、console backend，開機到 `login:` |
| 產生的 Lua 能否在 QBox 開機 | 已驗證（2026-11-14）：Ubuntu AArch64 8 核心開機到 `login:`，可登入，`poweroff` 可結束模擬。多 CPU 平台需要 `keep_alive` 模組，見 CLAUDE.md |
| 擴充套件在 VS Code 中的行為 | 已驗證（2026-11-14）：在 VS Code 中以 F5 載入並試過各指令 |
| `gdb_port` 參數名稱 | 已確認：CPU 有 `gdb_port` 參數（QBox 原始碼與元件目錄） |
| launch 設定格式、gdb 設在 `cpu_0` 能否看到所有核心 | **未驗證**，可在設定中更改 |
| loader 的 `elf_file` 欄位名稱、ELF 以實體位址（p_paddr）載入 | 已確認（對照 QBox 的 loader 原始碼，見 CLAUDE.md） |

## 安裝

需要 Node.js 18 以上（只有打包時用到，擴充套件本身沒有相依套件）。

方法一，打包成 .vsix 後安裝：

```bash
cd vp-studio
npx @vscode/vsce package --allow-missing-repository
code --install-extension vp-studio-0.2.*.vsix   # vsce 依 package.json 的版本命名，例如 vp-studio-0.2.1.vsix
```

方法二，開發模式：用 VS Code 開啟 `vp-studio` 資料夾，按 Ctrl+F5（不偵錯執行），會開一個載入此擴充套件的新視窗。按 F5（偵錯）在 VS Code 1.143.1 上偶爾會讓新視窗的擴充套件主機在啟動時當掉，與本擴充套件無關，見 CLAUDE.md。

## 使用

所有 VP Studio 指令分成 Simulation、Analysis、Debug、Platform、Models、Setup 六組，不必從命令面板找，有四個地方可以用滑鼠選：

- **左側活動列的 VP Studio 圖示**：最上面的「Actions」依分組列出指令，點一下就執行，只列出現在能用的（例如模擬執行中才有 Pause）。Platform Modules、Simulation Parameters、Peripheral Registers、Guest Processes 也在這裡。
- **編輯器右上角的「VP Studio ▾」**（開著平台檔時）：下拉選單，分組與分隔線同上。
- **狀態列左下的「VP Studio」**：先選分組，再選指令；開著任何檔都能用（也是命令 `VP Studio: Menu…`）。
- **獨立版的選單列**：Terminal 與 Help 之間的「VP Studio」。

分組定義在 `lib/menu.js`，四個地方共用；新增指令時要加進去（測試會檢查每個指令都在某一組，並確認 package.json 的子選單與它一致）。

1. 用 VS Code 開啟 QBox 原始碼根目錄，並先依 QBox README 建置完成。
2. 命令面板執行 `VP Studio: Create Example Platform (Ubuntu AArch64)`，存到 `platforms/ubuntu/`。位置很重要，因為描述中的 `${TOP}` 是相對於產生的 Lua 檔所在目錄。
3. 開啟該 `.platform.json`，編輯器右上角有「Show Platform View」與「Start Simulation」。
4. 換成自己的韌體：在平台檢視的「Software images」按 `Add image…` 選檔。ELF 會自動辨識，位址取自檔案本身；bin 需要填載入位址，可用十六進位、十進位，或 `${變數名}` 加偏移。kernel 以 bin 載入時，在「Symbol file for debugging」選 `vmlinux`。
5. 暫停與參數檢視：先建置 sim agent（`tools/sim-agent/build.sh <qbox>/build`，QBox 版本變更後要重建）。之後「Start Simulation」會自動加入 agent 並連線，狀態列出現模擬時間；外部啟動的模擬可用 `VP Studio: Connect to Sim Agent…` 連線。協定見 `tools/sim-agent/README.md`。
6. 目標軟體除錯：執行 `VP Studio: Start Simulation with Target Debug Port`，再執行 `VP Studio: Add Debug Configurations`，`program` 會自動填入平台的符號檔（沒有設定時才需要手動填），然後從除錯面板附加。launch 設定使用 CDT GDB Debug Adapter 擴充套件（`eclipse-cdt.cdt-gdb-vscode`）與 `gdb-multiarch`。細節見下一節。

## 除錯：偵錯主控台與 gdb 終端機

附加除錯後有兩個地方可以輸入，連的是同一個 gdb：

- **偵錯主控台**（面板的 Debug Console）：VS Code 的除錯主控台，經由 CDT 送出。
- **gdb 終端機**：`Add Debug Configurations` 產生的設定帶 `"openGdbConsole": true`，附加時終端機面板會多一個 gdb 分頁，是真正的 gdb 命令列。設定也帶 `"environment": { "DEBUGINFOD_URLS": "" }`：Ubuntu 的 gdb 在這個變數有值時，載入符號會停下來問「Enable debuginfod for this session?」，附加就卡住；符號檔在本機，不需要它。要用空字串而不是 `null`：gdb 終端機模式下 `null` 無效，變數會從 VS Code 的環境帶回來。另帶 `"gdbArguments": ["-q", "-iex", "set pagination off"]`：終端機面板太矮時，gdb 會停在「--Type <RET> for more」等你按 Enter，附加也跟著卡住。只支援 Linux／macOS（gdb 7.12 以上）；Windows 上沒有這個分頁。

兩者的差別（依 cdt-gdb-vscode 3.0.0 的行為）：

| | 偵錯主控台 | gdb 終端機 |
|---|---|---|
| 輸入 | 預設是**運算式**；gdb 指令要自己在最前面打 `>`，例如 `>info threads`。左側的 `›` 只是 VS Code 的提示符號，不算 | 一律是 gdb 指令，不用加 `>` |
| 運算式的上下文 | 呼叫堆疊面板**選取的** thread 與框架；CPU 在執行時沒有框架，運算式會回「Evaluation of expression without frameId is not supported」 | gdb 自己的目前 thread／框架，可能與介面選取不同；在這裡 `thread 3` 不會改變介面選取 |
| 結果 | 結構、陣列可展開成樹狀 | 純文字 |
| 顯示格式 | 運算式後加 `,x`、`,d`、`,o`、`,b`，例如 `$pc,x` | gdb 原本的寫法：`p/x $pc`、`x/4i $pc` |
| 補完與歷史 | 只有 `>` 指令有補完；上下鍵歷史 | gdb 的 Tab 補完、上下鍵、Ctrl+R |
| 多行與互動式指令 | 不支援（`commands`、`define`、`python … end`、`if/while`、需要回答 y/n 的確認） | 支援 |
| 與介面同步 | CDT 知道你做了什麼 | 暫停、繼續、單步會反映到介面；但在這裡設的中斷點**不會**出現在 Breakpoints 面板，`enable`/`disable` 也不會反映到介面 |

建議的分工：

- **中斷點、單步、暫存器與變數**：用 VS Code 的介面（Breakpoints、Variables、呼叫堆疊）。中斷點只從介面設，避免介面看不到的中斷點。
- **暫停時看一個值**：偵錯主控台輸入運算式，例如 `$pc,x`、`$sp`。
- **查詢與進階操作**：gdb 終端機，例如 `info threads`、`x/16xw 0x9000000`、`info registers`、多行指令與腳本。

QEMU 把每顆 CPU 回報成一個 thread（`CPU#0 [halted]` 到 `CPU#7`）。沒有符號檔時，位置顯示為 `?? ()`；在平台檢視「Software images」選擇符號檔（例如 vmlinux）後重新執行 `Add Debug Configurations`，就會顯示函式名稱。
## 命令列與 CI（vp-run）

`bin/vp-run` 不開 IDE 就能啟動平台、看主控台（UART）輸出是否出現指定文字，並以結束碼回報結果，給 CI 與測試腳本用。需要 Node.js 18 以上：依序用 `VP_NODE`、`PATH` 上的 `node`、VS Code 內建的 Node（所以裝了 VS Code 就不必另裝 Node.js）；從 .vsix 解開的檔案沒有執行權限時用 `sh bin/vp-run`。平台檢查、Lua 產生、啟動前檢查與擴充套件相同（共用 `lib/`）。

```sh
bin/vp-run --qbox ~/qbox --snapshot --timeout 900 --junit boot.xml \
  --expect 'login:' --send root \
  --expect 'Password:' --send root \
  --expect '# $' --send poweroff --wait-exit \
  ~/qbox/platforms/ubuntu/ubuntu-aarch64.platform.json
```

| 選項 | 用途 |
|---|---|
| `--expect REGEX`、`--send TEXT` | 依序執行：等主控台輸出符合 REGEX（JavaScript 語法，每次從上一個符合處之後找）；送出 TEXT 加 Enter |
| `--send-env NAME` | 送出環境變數 NAME 的值加 Enter；報告只寫 `$NAME`，給密碼用（CI 的密碼變數） |
| `--qbox DIR`、`--exe PATH` | QBox 資料夾（模擬器的工作目錄，預設目前目錄）與模擬器（預設 `build/platforms-vp`） |
| `--timeout SEC` | 整次執行的實際時間上限，預設 600 秒 |
| `--sim-timeout TIME` | 模擬時間到 TIME（例如 `30 s`）就算失敗；需要 sim agent 0.4.0 以上 |
| `--wait-exit` | 步驟完成後等模擬器自己結束（例如送出 `poweroff` 之後），結束碼 0 才算通過；沒有任何步驟時也是如此 |
| `--exec CMD` | 步驟完成後執行 CMD（`sh -c`），以它的結束碼為準；環境變數有 `VP_AGENT_HOST`、`VP_AGENT_PORT`、`VP_PLATFORM` 與平台的主機轉發埠（`HOST_PORT_SSH` 對應 `VP_HOST_PORT_SSH`） |
| `--snapshot` | 以 `snapshot=on` 開磁碟映像：客體的修改不寫回，每次都從同一份映像開始，也不會累積 `*.journal~`（K-11） |
| `--param INST.NAME=VALUE` | 這次執行改一個模組參數（VALUE 以 JSON 解析，失敗就當字串） |
| `--agent PATH` 或 `none` | sim agent 函式庫；預設依序找 `VP_SIM_AGENT`、VS Code／VSCodium／VP Studio 獨立版建置的位置、擴充套件資料夾 |
| `--log FILE`、`--junit FILE`、`--quiet` | 主控台輸出另存檔案；JUnit XML 報告（每個步驟一個 testcase，附最後 64 KB 主控台輸出）；不把主控台輸出印到 stdout |

結束碼：0 通過、1 步驟失敗或逾時、2 模擬器異常結束、3 設定錯誤（找不到檔案、平台有錯誤、磁碟映像被占用等）。結束時以 SIGHUP 收掉模擬器，10 秒內沒結束就 SIGKILL，不留下行程。

Python 測試腳本用 `tools/vp-py/vpstudio.py`（只用標準函式庫）呼叫 sim agent：

```python
from vpstudio import SimAgent
with SimAgent() as sim:            # 由 vp-run --exec 設的 VP_AGENT_PORT 找到模擬
    sim.pause()
    sim.run_for("200 ms")
    status = sim.wait_for_pause(timeout=60)
    print(status["time"]["text"], sim.param("platform.quantum_ns"))
```

存檔與還原（CI 只開機一次，之後每個測試從存檔開始）：

```sh
bin/vp-run --qbox ~/qbox --expect 'login:' --send root --expect 'Password:' --send-env ROOT_PW \
  --expect '# $' --save-checkpoint ck/login platforms/ubuntu/ubuntu-aarch64.platform.json
bin/vp-run --qbox ~/qbox --restore ck/login --snapshot --send 'uname -a' --expect aarch64 \
  platforms/ubuntu/ubuntu-aarch64.platform.json
```

`--save-checkpoint DIR` 在步驟跑完後存檔（之後才執行 `--exec`、`--wait-exit`）。`--restore DIR` 從存檔啟動：磁碟先複製到 `DIR/run/`；加 `--snapshot` 則直接以 snapshot=on 開存檔裡的磁碟，不複製、也不保留客體的寫入（這時不能再存檔）。存檔載入失敗時立刻以結束碼 3 結束。實測從存檔到客體回應約 13 到 15 秒，冷開機約 240 秒。

交付套件（給別人開機用，見「這一版有什麼」的交付套件）：

```sh
bin/vp-run --qbox ~/qbox --export-kit ubuntu-kit.tar.gz --omit image_ext4.img \
  --url image_ext4.img=https://example.com/image_ext4.img platforms/ubuntu/ubuntu-aarch64.platform.json
bin/vp-run --import-kit ubuntu-kit.tar.gz --into ~/kits     # 解開並比對 SHA256SUMS
```

`--omit PATH`（可重複；套件中的路徑或檔名）、`--omit-larger MB`、`--url PATH=URL`、`--allow-missing`（平台引用的檔案不存在時仍匯出）、`--overwrite`（解開到已存在的資料夾）。`--import-kit` 有損壞的檔案或缺少被省略的檔案時結束碼為 1。從解開的套件執行平台時，`vp-run` 也在套件內找建模精靈的模型。

效能實驗（平台由 `traffic_gen`、`at_bus`、`dram_ctrl`、`perf_stats` 組成；QBox 要有 `perf.so`）：

```sh
bin/vp-run --qbox ~/qbox --perf examples/perf/ddr-contention.platform.json      # 一次，統計寫到 perf-results/
bin/vp-run --qbox ~/qbox --perf-sweep examples/perf/cpu-outstanding.perfsweep.json --junit perf.xml
```

`--perf-sweep` 跑掃描檔中每一種參數組合，在 `--out DIR`（預設掃描檔旁的 `perf-results/<名稱>-<時間>/`）寫出 `results.json`、`results.csv` 與每次的 `run-<n>.json`，並在標準輸出印出各次的指標。掃描檔的 `checks`（`{"metric": …, "min": …, "max": …, "where": {…}}`）是 CI 門檻：任何一項不符或任何一次執行失敗，結束碼為 1；`--junit` 把每項檢查寫成一個 test case。`--jobs N` 同時執行的模擬數（預設 CPU 數的一半）；`--timeout` 是每次執行的上限。

範例：`examples/ci/test_platform.py`（以 `--exec` 執行）、`examples/ci/.gitlab-ci.yml`、`examples/ci/Jenkinsfile`。Ubuntu 範例映像的帳號密碼是 root/root（QBox `fw/build_linux_dist_image.sh`）。

## 設定

| 設定 | 預設 | 用途 |
|---|---|---|
| `vpStudio.executable` | `build/platforms-vp` | 模擬器執行檔；用容器時填 `tools/container/run.sh` 的絕對路徑 |
| `vpStudio.catalog` | 內附目錄 | 檢查模組型別、埠與參數用的 QBox 元件目錄；可填路徑換成自己產生的目錄，填 `none` 關閉 |
| `vpStudio.simAgent.library` | 擴充套件資料夾內的 `tools/sim-agent/vp_sim_agent.so` | sim agent 函式庫；可填路徑換成別處建置的版本，填 `none` 不加入。打包的 .vsix 不含此檔，需自行建置後填路徑 |
| `vpStudio.workingDirectory` | 工作區資料夾 | 啟動目錄 |
| `vpStudio.dtc` | `dtc` | device tree 編譯器 |
| `vpStudio.perf.timeoutSeconds` | `600` | 效能實驗每次執行的時間上限（秒，實際時間）；掃描檔的 `timeoutSeconds` 優先 |
| `vpStudio.perf.jobs` | `0` | 效能掃描同時執行的模擬數；0 用掃描檔的 `jobs`，否則 CPU 數的一半 |
| `vpStudio.luaFlag` | `-l` | 傳入 Lua 設定檔的旗標 |
| `vpStudio.debug.gdbPort` | `1234` | 目標軟體 gdb 埠 |
| `vpStudio.debug.cpuInstance` | `cpu_0` | 接收 gdb 埠參數的實例 |
| `vpStudio.debug.gdbPortParam` | `gdb_port` | 開啟 gdb 伺服器的 CPU 參數名稱 |
| `vpStudio.debug.targetGdb` | `gdb-multiarch` | 目標軟體用的 gdb |
| `vpStudio.remote.host` | 空（本機） | 在另一台機器上執行模擬：ssh 目的地（`user@host` 或 `~/.ssh/config` 的 Host）|
| `vpStudio.remote.root` | | 遠端對應這個工作區資料夾的絕對路徑 |
| `vpStudio.remote.executable` | `build/platforms-vp` | 遠端的模擬器（絕對路徑或相對 `remote.root`）|
| `vpStudio.remote.sshArgs` | `[]` | 每次呼叫 ssh 時多加的參數，例如 `["-p", "2222"]`、`["-J", "jumphost"]` |
| `vpStudio.remote.auth` | `key` | 登入遠端主機的方式：`key`（金鑰）或 `password`（VP Studio 問一次密碼）|

## 專案結構

```
extension.js                 VS Code 整合：指令、診斷、樹狀檢視、webview、終端機
lib/core.js                  展開、分析、Lua 產生（不依賴 VS Code，可單獨測試）
lib/view.js                  平台檢視的 HTML 與方塊圖
lib/images.js                loader 項目解析、ELF 標頭讀取、載入範圍檢查
lib/jsonedit.js              保留原格式的 JSON 局部編輯
lib/catalog.js               依元件目錄檢查平台
lib/simagent.js              sim agent 的 JSON-RPC 客戶端、參數樹
lib/params.js                平台檢視的參數表單：欄位、輸入解析、寫回 JSON 的編輯
lib/modules.js               新增與刪除模組：型別清單、名稱、建構參數、刪除影響、JSON 編輯
lib/connect.js               連線：埠與雙向綁定、相容埠、由哪端寫入、向量編號、JSON 編輯
lib/elfsym.js                ELF64 函式符號表（vmlinux 等）與位址查詢
lib/profile.js               效能剖析：依函式彙總、arm64 KASLR 位移、符號檔警告
lib/profileview.js           Profile 面板的 HTML
lib/menu.js                  VP Studio 選單：指令分組與 when 條件（下拉選單、Actions 檢視、狀態列、獨立版選單列共用）
lib/ftrace.js                函式進出追蹤：讀取記錄、配對呼叫與返回、Perfetto 時間軸、摘要
lib/registers.js             周邊暫存器：描述檔載入與展開、平台中的周邊、欄位解碼與寫入值
catalog/registers/           隨附的暫存器描述（PL011、GICv3 distributor、virtio-mmio）
lib/trace.js                 交易追蹤：可追蹤的埠、插入追蹤模組的產生器選項、記錄解碼與 CSV
lib/traceview.js             Transaction Trace 面板的 HTML
lib/hostports.js             主機轉發埠的檢查與挑選
lib/disklock.js              磁碟映像檔是否被其他模擬器鎖住
lib/diskspace.js             磁碟映像檔（ext2/3/4）的可用空間
lib/modelgen.js              建模精靈：模型描述的檢查與 C++ 產生
lib/models.js                建模精靈：寫檔、模型的元件目錄項目與合併、平台的 dylib 路徑
lib/devicetree.js            由平台描述產生 device tree source
lib/luaexpr.js               求值平台中簡單的 Lua 運算式（mp_affinity、psci_conduit 等）
lib/pin.js                   QBox 版本比對：釘選的 commit 與模擬器、目錄、sim agent 各自的來源
lib/checkpoint.js            存檔與還原：要存的記憶體、暫存器與磁碟，manifest，從存檔啟動的參數
lib/kit.js                   交付套件：找出平台引用的檔案、改寫絕對路徑、匯出、解開與檢查
lib/tar.js                   串流的 tar（ustar 加 pax）讀寫，供交付套件使用
lib/xml.js                   小型 XML 解析器（IP-XACT 用，無相依套件）
lib/ipxact.js                IP-XACT 匯入：暫存器映射、數值與運算式、轉成模型或暫存器描述
lib/thirdparty.js            第三方除錯器：gdbstub 位址、TRACE32 腳本、說明文件
lib/remote.js                遠端模擬：ssh 指令、空閒埠、路徑對應、檔案檢查與上傳、終端機參數
lib/askpass.js               遠端密碼登入：SSH_ASKPASS 伺服器與啟動程式（askpass-helper.js 由 ssh 執行，向 VP Studio 要密碼；Windows 用 lib/vp-askpass.exe，原始碼 tools/askpass/）
lib/launch.js                啟動前的共用步驟：Lua 路徑、sim agent、snapshot、啟動前檢查、device tree、建置位置
bin/vp-run                   命令列執行與 CI 的入口：找 Node.js（含 VS Code 內建的）執行 vp-run.js
bin/vp-run.js                命令列執行與 CI：主控台 expect/send、逾時、JUnit 報告
tools/vp-py/vpstudio.py      sim agent 的 Python 用戶端（只用標準函式庫）
examples/ci/                 CI 範例：Python 檢查、GitLab CI、Jenkinsfile
tools/qbox-catalog/          元件目錄工具（C++）
tools/sim-agent/             sim agent 模組（C++，QBox 的外部模組函式庫）
tools/qbox-pin/              建置釘選的 QBox（含 sim agent 與元件目錄）
patches/qbox/                套用在釘選 QBox 上的修補，與送上游的報告草稿
theia/                       獨立版：Theia 的桌面版與瀏覽器版、內建擴充套件清單、建置腳本
tools/model-build/           建模精靈的模型：編譯、自我測試、元件目錄項目
tools/container/             容器映像：Dockerfile、建置、執行與取出檔案的腳本
qbox.pin.json                這一版測試過的 QBox commit
schemas/qbox-platform.schema.json   平台描述 schema（0.1；0.2 加入子系統，0.1 檔案不需修改）
schemas/qbox-model.schema.json      模型描述 schema
schemas/qbox-registers.schema.json  暫存器描述 schema（catalog/registers/、工作區的 *.registers.json）
examples/ipxact/simple_timer.xml    IP-XACT 匯入範例
examples/ubuntu-aarch64.platform.json
test/core.test.js            node test/core.test.js
CLAUDE.md                    給後續開發（含 Claude Code）的交接說明
INSTALL.md                   安裝與第一次使用（給新使用者）
```
