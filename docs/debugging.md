# 除錯：偵錯主控台與 gdb 終端機

[VP Studio](../README.md) 的說明文件。

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

QEMU 把每顆 CPU 回報成一個 thread（`CPU#0 [halted]` 到 `CPU#7`）。

**多個 QEMU instance**（例如應用處理器叢集加一顆即時核心）：每個 instance 有自己的 gdb server，顯示它所有的 CPU。Start Simulation with Target Debug Port 在每個 instance 的一顆 CPU 上開一個埠（`vpStudio.debug.gdbPort` 起依序遞增，平台自己設了 `gdb_port` 的 instance 照平台的），Add Debug Configurations 為每個 instance 寫一個設定（第一個仍叫「VP: attach to target software」並帶 vmlinux，其他的叫「VP: attach to target software (<instance>)」、不帶符號），再加一個複合設定「VP: attach to every QEMU instance」一次附加全部；呼叫堆疊中每個 instance 是一個工作階段。遠端模擬仍只轉送一個 gdb 埠。實測：Ubuntu 平台加一個 `qemu_rt`（一顆關機狀態的 Cortex-A53）後，兩個埠 1234、1235 都開，複合設定附加出兩個工作階段。注意同一平台中各 QEMU instance 的 `tcg_mode` 要相同（一個 MULTI、一個 SINGLE 時這版 QBox 載入第二個 libqemu 就 segfault）。

**核心模組的符號**：**Load Kernel Module Symbols**（Debug 組第三段）讀出客體核心已載入的模組（vp-linux.py 的 `vp-lsmod`／`-vp-lsmod`：名稱、位址、各 section 的實際位址），在 `vpStudio.debug.moduleDirs` 與 vmlinux 旁的 `modules/<release>/` 找 `.ko`，以 `add-symbol-file` 載入（.text 與 .data、.rodata、.bss 等 section 放在核心實際的位置，略過已釋放的 .init／.exit）。找不到的模組，若平台的磁碟映像是 ext4 且本機有 `debugfs`（e2fsprogs），會詢問是否從映像（唯讀）的 `/lib/modules/<release>` 複製出來。之後每個除錯工作階段第一次停下時自動載入找得到的模組（設定 `vpStudio.debug.moduleSymbols`，預設開；不詢問、不複製）。Ubuntu 的 `.ko` 只有符號表沒有 DWARF：函式名稱、反組譯與呼叫堆疊可用，原始碼行不行；要原始碼行請把 `-dbgsym` 套件的 `.ko` 放進 `vpStudio.debug.moduleDirs`。壓縮的 `.ko.zst`、`.ko.xz` 不支援。實測：Ubuntu 平台 26 個模組，`vp-lsmod` 全部列出約 1 秒；載入 virtio_net 後 `virtnet_poll` 在 0xffffc98b54215a10，反組譯為正確的函式開頭。沒有符號檔時，位置顯示為 `?? ()`；在平台檢視「Software images」選擇符號檔（例如 vmlinux）後重新執行 `Add Debug Configurations`，就會顯示函式名稱。

## 除錯版面：Debug Layout

附加並暫停後執行 **VP Studio: Debug Layout**（VP Studio 選單的 Debug 組、CPU Registers 檢視標題列）：

- 左側是 Run and Debug 側欄：變數、監看、呼叫堆疊、中斷點、**CPU Registers**、**Peripheral Registers**（周邊暫存器；與 VP Studio 側欄的是同一份，模擬由 sim agent 連線時才出現）。
- 編輯區分成三塊：左邊原始碼，右上反組譯（VS Code 內建的 Disassembly View），右下記憶體（Memory Inspector，開在 `$sp`）。
- 已經開著的反組譯或記憶體分頁不會重複開。目標還在執行時只排版面，提示暫停後再執行一次。
- 分頁可以拖到別的群組，或在分頁上按右鍵「Move into New Window」放到第二個螢幕。

反組譯也可以單獨開：**VP Studio: Show Disassembly**，或 CPU Registers 中 PC 旁的 **dis**。內容是呼叫堆疊中選取的 CPU 與框架的 PC 附近。第一次開時會詢問是否在工作區設定 `debug.disassemblyView.showSourceCode: false`：VS Code 預設把原始碼行混在指令中，搭配 CDT 與 Linux 核心時指令會不依位址排列、還有重複（cdt-gdb-vscode 3.0.0 實測）；只顯示指令時順序正確。

## 查看記憶體：Memory Inspector

不想下 `x/16xg` 這類 gdb 指令時，用 Eclipse CDT 的 **Memory Inspector**（`eclipse-cdt.memory-inspector`，EPL-2.0）顯示記憶體。VP Studio 不另做記憶體檢視，而是帶著位址打開它：

- **VP Studio: Show Memory…**（VP Studio 選單的 Debug 組、CPU Registers 檢視標題列的圖示）：輸入位址或運算式，例如 `0xffff8000080ebd80`、`&jiffies`、`$sp`、`$x1`。
- **CPU Registers 檢視**：PC、SP、LR 與看起來像位址的通用暫存器（0x1000 以上）旁有 **mem** 按鈕（通用暫存器的按鈕在滑鼠移上該列時出現），按了就開在那個值。
- Memory Inspector 自己的入口：「變數」「監看」中對指標按右鍵選 **Show in Memory Inspector**。

沒有安裝時不必自己找：附加除錯器時 VP Studio 會詢問是否安裝（可選 Don't Ask Again），按 Show Memory 或 mem 時也會先詢問再安裝（VS Code 從 Marketplace、獨立版已內建）。**Memory Inspector 只能讀它安裝之後才開始的除錯工作階段**；在除錯中途安裝時，VP Studio 會提供「Reattach」：中斷除錯器再重新附加，模擬繼續執行，暫停後再開一次記憶體即可。以 Remote-SSH 連線時它裝在遠端，與 VP Studio 同一端。

在記憶體分頁中：表格上下的「Load … more bytes」可往前、往後多讀；右上角的齒輪可改每列幾組、每組幾個位元組與位元組順序；在表格上按右鍵可打開 ASCII 欄、把記憶體存成檔案（Store Memory to File…）或設資料中斷點（Break on Value Change 等；經 QEMU gdbstub 的 watchpoint，尚未實測）。資料格可直接修改。每次暫停會重新讀取（設定 `memory-inspector.refreshOnStop`），可以開多個 Memory 分頁。

**每列的格式**：Memory Inspector 自己的預設是每組 1 byte、每列 4 組，一列只有 4 bytes。VP Studio 把預設改成每組 4 bytes、每列 4 組，也就是每列 4 個 32 位元 word（16 bytes），word 以 little-endian 組成數值，例如核心指標 `0xffff800008223dd0` 顯示為 `08223dd0 ffff8000`。要換格式，用 **VP Studio: Memory Layout…**（Debug 組），選 word 大小（1、2、4、8、16 bytes）與每列幾個 word（1 到 32，或依分頁寬度自動排滿）。例如選 64-bit words 時，指標整個顯示成 `ffff800008223dd0`。設定寫在使用者設定的 `memory-inspector.groupings.bytesPerMAU`、`MAUsPerGroup`、`groupsPerRow`，之後開的記憶體分頁都採用；已經開著的分頁維持原格式，要改的話用該分頁右上角的齒輪。自己在設定中寫過這些值的話，以你的值為準（VP Studio 只改預設值）。

注意：

- 讀的是**呼叫堆疊中選取的那顆 CPU** 看到的虛擬位址（經該 CPU 的 MMU）。Linux 開了 KPTI 時，停在使用者空間（EL0）的 CPU 讀不到核心位址；改選一顆停在 EL1 的 CPU（CPU Registers 檢視的 MODE）。
- 這是 gdb 的記憶體讀取，讀到 MMIO 位址時會真的對裝置存取（可能有讀取副作用）。周邊暫存器請用 VP Studio 的 **Peripheral Registers** 檢視，它讀實體位址、模擬執行中也能看。

## 中斷點：條件、命中次數、logpoint

中斷點都在 VS Code 的「中斷點」檢視管理，CDT 把它們轉成 gdb 中斷點。依 cdt-gdb-vscode 3.0.0 的實作與實測：

| 種類 | 怎麼設 | 條件 | 命中次數 | 備註 |
|---|---|---|---|---|
| 原始碼行 | 在原始碼行號左側按一下；按右鍵「Add Conditional Breakpoint」 | 支援 | 支援 | 本機沒有原始檔也可以（下述指令） |
| 函式 | 「中斷點」檢視的 + | **不支援**（CDT 不傳給 gdb，一律停下） | **不支援** | 要條件請用下述指令 |
| logpoint | 原始碼行按右鍵「Add Logpoint」 | — | — | 訊息原樣印在偵錯主控台，**不代入** `{運算式}`；每次命中都會短暫停下再繼續，頻繁呼叫的函式會變慢 |
| 指令 | 反組譯檢視中位址左側 | — | — | 未實測 |
| 資料（watchpoint） | Memory Inspector 表格按右鍵 Break on Value Change 等 | — | — | 經 QEMU gdbstub 的 watchpoint，未實測 |

**VP Studio: Add Conditional Breakpoint…**（Debug 組、「中斷點」檢視標題列）：輸入函式名稱、條件、命中次數。VP Studio 以 gdb 的 `-symbol-info-functions` 找到函式所在的檔案，再問 gdb `break <函式>` 會停在函式本體的哪一行（宣告的那一行可能只對應到被 inline 進別的函式的副本，例如 Linux 5.15 的 `arm64_force_sig_fault`：宣告在 265 行，`do_page_fault` 呼叫的本體從 267 行開始），改設成那一行的原始碼行中斷點，所以條件與命中次數有效，也不需要本機有原始碼。需要先暫停（gdb 查詢需要停住的目標）。同名的 static 函式在多個檔案時會讓你選。

- **條件**：gdb 的 C 運算式，例如 `user_tick == 0`、`$x0 > 0x1000`、`$_streq(((struct task_struct *)$sp_el0)->comm, "bash")`。
- **命中次數**：只接受數字。`5` 表示第 5 次命中時停一次，之後這個中斷點在 gdb 中就刪除了（「中斷點」檢視仍會列出，要再用請刪掉重設）；`>5` 表示第 6 次起每次都停。`>=5` 會換成 `>4`。CDT 以 gdb 的 ignore count 實作：略過的那幾次命中不檢查條件（依 gdb 手冊），之後的命中才依條件決定是否停。
- 實測（Ubuntu 平台，`update_process_times`）：條件 `0` 不會停；`user_tick == 0` 加 `>5` 時 gdb 顯示 `stop only if user_tick == 0`，第 6 次命中停下。

## 異常與中斷：Exceptions & Interrupts

**VP Studio: Exceptions & Interrupts**（Debug 組）開一個面板，列出 CPU 進入的每一次例外與中斷，並可在指定種類發生時停下模擬。需要 sim agent 0.15.0（Build Sim Agent 重建）；設定 `vpStudio.exceptions.record`（預設開）讓 Start Simulation 開啟記錄。不需要附加除錯器，也與客體作業系統無關（裸機程式一樣適用），只支援 AArch64。

- 原理：sim agent 使用 QEMU plugin 的 discontinuity 回呼，在 CPU 進入例外之後、處理程序第一條指令之前讀 ESR、FAR、ELR、SPSR 與 VBAR，所以不受 KPTI、向量表位置影響。
- **記錄**：上方是總數；左側「Counts」依種類與 ESR 的例外類別（EC）累計；右側表格是最近的事件（時間是 QEMU 虛擬時鐘）：CPU、種類、說明（例如「Data abort from a lower EL (translation fault, level 3, read) at 0x…」）、從哪個 EL 到哪個 EL、發生時的 PC、向量位址。滑鼠停在說明上可看 ESR、FAR、ELR；點一列複製。Recording 可暫停記錄，Clear 清除。
- **Stop on**：勾選要停下的種類（Data abort、Instruction abort、Undefined instruction、Alignment fault、BRK、SVC、Trapped system register、SError、IRQ、FIQ），「From」可限定來自 EL0（使用者空間）、EL1（核心）或 EL2。符合時進入例外的那顆 CPU **停在向量入口、處理程序還沒執行**，其他 CPU 停在當時的位置；面板上方的紅框寫出原因，狀態列也會顯示。勾選的項目存在工作區，下次啟動模擬自動套用。
- 有附加除錯器時，gdb 會把這次停止當成 SIGINT，呼叫堆疊顯示的可能是別顆 CPU：到呼叫堆疊選紅框中寫的 CPU（例如 CPU#2）就能看到它停在向量，再用 Debug Layout 的反組譯、記憶體與 CPU Registers 看 ELR、ESR。面板的 Continue 在有除錯器時經由除錯器繼續；在除錯器按繼續也可以，模擬會跟著恢復。
- 注意：SVC 與 IRQ 非常頻繁（Ubuntu 開機約每秒數千次），勾選後幾乎立刻停下。中斷事件的 ESR 不更新，所以不顯示；IRQ 號碼要看 GIC（Peripheral Registers 或訊號追蹤）。

### 例外發生前的呼叫

攔截停下時，面板在紅框下方列出**那顆 CPU 最後的呼叫與返回**（最多 120 筆，依深度縮排，最新的在最下面，每筆寫出距離最後一筆記錄的指令數）以及仍未返回的呼叫鏈，函式名稱取自平台的符號檔（vmlinux，自動算 KASLR 位移）。

- 需要函式追蹤：以 **Start Simulation with Function Trace** 啟動，並以 **Function Trace: Start Recording…** 開始記錄（建議 Kernel）；資料來自 sim agent 的 `ftrace.tail`（只讀那顆 CPU 最新的記錄，不必存檔）。沒有記錄時面板說明怎麼開。
- 進入例外本身若緊接在一個呼叫之後，追蹤會把它記成「呼叫向量表」；這類項目顯示為 ⚡ exception entry，不算進呼叫鏈（ERET 不是 RET，不會有對應的返回）。
- 函式追蹤會讓模擬變慢（Ubuntu 開機約 300 秒，未插入時約 230 秒），所以只在需要時才用。
- 實測（Ubuntu 平台，攔 IRQ）：從 EL0 進入時列出 `el0_svc` → `do_notify_resume` → `__rseq_handle_notify_resume` → `rseq_update_cpu_id` 的呼叫與返回；從 EL1 進入時列出前一次中斷的 `el1_interrupt` → `exit_el1_irq_or_nmi` → `rcu_irq_exit` 的收尾。

## 中斷控制器：Interrupt Controller (GIC)

**VP Studio: Interrupt Controller (GIC)**（Debug 組）開一個面板，列出執行中平台的 GICv3（QBox 的 `arm_gicv3`）每個中斷的狀態。資料經 sim agent 的 `mem.read` 讀 distributor（`dist_iface`）與各 CPU 的 redistributor（`redist_iface_0`），不需要除錯器；需要 agent 0.6.0 以上。

- 每一列是一個 INTID：類型（SPI；SGI 與 PPI 每顆 CPU 各一列）、**由誰驅動**（平台中接到 `spi_in_N`、`ppi_in_cpu_K_N` 的模組與埠）、狀態 **E**nabled／**P**ending／**A**ctive、優先權、level 或 edge、群組（G0／G1）、目標（`GICD_IROUTER` 指定的 CPU，或 any CPU）。
- **Notes** 寫出送不到 CPU 的原因：
  - 有接線但軟體沒有 enable；
  - 所屬群組在 `GICD_CTLR` 關閉；
  - 優先權 0xFF（永遠不會高於 CPU 的優先權遮罩）；
  - 路由到不存在的 affinity；
  - 目標 CPU 的 redistributor 在睡眠（`GICR_WAKER.ChildrenAsleep`）；
  - pending 卻沒被處理（CPU 以 PSTATE.I 或 `ICC_PMR_EL1` 遮蔽，或有更高優先權的中斷在處理中）。
- 上方是 distributor 的群組與 ARE 狀態、各 CPU redistributor 醒著或睡著，以及有接線、已 enable、pending／active、有問題的數量。
- 預設只列「有接線或正在使用」的中斷；可改成只看有問題的、pending／active 的或全部，選一顆 CPU 只看它的 SGI 與 PPI，或以 INTID、裝置名稱篩選。點一列複製。
- 何時讀取：模擬暫停或被除錯器停住時自動讀，Refresh 隨時讀；**Live** 在執行中每秒讀一次（各暫存器不是同一瞬間讀的，pending 這類變化快的位元只供參考）。
- 只讀沒有副作用的狀態暫存器（`GICD_ISENABLER`、`ISPENDR`、`ISACTIVER`、`IPRIORITYR`、`ICFGR`、`IGROUPR`、`IGRPMODR`、`IROUTER`、`GICR_TYPER`、`GICR_WAKER` 等），不讀 `IAR`，所以不會認領中斷。CPU 介面（`ICC_PMR_EL1`、`ICC_IGRPEN1_EL1`）是 CPU 的系統暫存器，要附加除錯器後在 CPU Registers 看。
- 中斷風暴：搭配 Exceptions & Interrupts 的 IRQ 計數，看哪一列一直是 pending 或 active。

## gdb 的常用功能：不必下指令

Debug 組的第三段，都經由附加中的除錯器（除了實體位址的搜尋）：

- **Find in Memory…**：在一段記憶體中找文字、位元組或數值。
  - 位址空間：虛擬（呼叫堆疊選取的 CPU 看到的，經除錯器）或實體（匯流排上，經 sim agent，不需除錯器）。
  - 起點可填位址或運算式（例如 `&_text`）；長度如 `0x100000`、`64k`、`16M`（虛擬最多 256 MiB，實體 64 MiB）。
  - 樣式：`"Linux version"`；`hex: d0 0d fe ed`（照順序的位元組，例如 device tree 檔頭）；數值 `0xd00dfeed`（照目標存放的方式，little-endian，寬度依位數；加 `:be` 為 big-endian）。
  - 結果列成清單：虛擬位址點了開在 Memory Inspector，實體位址點了複製位址（用 QEMU Monitor… 的 xp 看內容）。讀不到的區段跳過並計數。實測 Ubuntu 平台實體 64 MiB 約 7 秒。
- **View Address as Type…**：把一個位址當成某個 C 型別看，加到「監看」裡展開成欄位，例如型別 `struct task_struct`、位址 `$SP_EL0`（arm64 Linux 目前的 task）或 `&init_task`。暫存器用 gdb 的名稱，系統暫存器是大寫（`$SP_EL0`，不是 `$sp_el0`）。
- **Load Symbol File at Address…**：選一個 ELF（Linux 核心模組 `.ko`、函式庫、韌體、使用者程式），填它的 `.text` 載入位址（Linux 模組：客體中以 root 讀 `/sys/module/<名稱>/sections/.text`），等同 gdb 的 `add-symbol-file`。以固定位址連結（非 PIE，ELF 類型 EXEC）的程式在連結時的位址執行，位址欄會自動填好它自己的 `.text`；它的符號只在它是那顆 CPU 上正在跑的行程時才對得上。
- **CPU Stepping…**：「Only the selected CPU steps」等同 `set scheduler-locking step`：單步時其他 CPU 保持停住，按繼續則全部執行；「Every CPU runs」恢復預設。QEMU 的 gdbstub 不支援 non-stop 模式（實測），所以沒有「一顆停住、其他繼續跑」的選項；要個別停住核心請用 OpenOCD 埠的 CTI。
- **QEMU Monitor…**：經 gdb 的 `monitor` 送 QEMU 的 monitor（HMP）指令，輸出開在唯讀的文件。預設項目：`info mtree -f`（每個位址空間的扁平記憶體映射，看 CPU 與裝置實際看到什麼）、`info mtree`、`info registers -a`、`info cpus`、`info qom-tree`、`xp`（**實體記憶體**，填位址）；Other… 可輸入任何指令。這版 libqemu 的 `info pic`、`info roms` 沒有輸出，`info tlb` 不能用。

## 位址轉換：Translate Virtual Address…

除錯暫停時，把一個虛擬位址照 MMU 的方式轉成實體位址，列出每一層頁表描述元。Debug 組的 **Translate Virtual Address…**，或 CPU Registers 中 PC、SP、LR 旁的 **pa** 按鈕。

- 輸入位址或 gdb 運算式（`0xffff800008010000`、`&jiffies`、`$sp`）。用的是呼叫堆疊中選取的 CPU 的 `SCTLR_EL1`、`TCR_EL1`、`TTBR0/1_EL1`、`MAIR_EL1`（經 gdb 讀），描述元從實體記憶體讀（有 sim agent 時用 `mem.read`，否則用 gdb 的 `monitor xp`）。
- 面板顯示：
  - 實體位址，以及它落在平台的哪個模組（`ram_0 + 0x13363e0`）。
  - page 或 block 的大小、所在的層、使用 TTBR0 還是 TTBR1、ASID。
  - EL1 與 EL0 的讀、寫、執行權限，已算入上層表格的 APTable／PXNTable／UXNTable、「EL0 可寫則 EL1 不可執行」與 SCTLR_EL1.WXN。
  - 記憶體類型（MAIR 解讀）與 shareability。
  - 虛擬位址各欄位：每一層的索引與頁內位移。
  - 每一層描述元：表格位址、索引、描述元位址與值、類型、指向哪裡、各個位元。
- 轉換失敗時寫出原因與發生在哪一層：
  - translation fault：描述元無效、保留的編碼，或位址不在任何一個 TTBR 的範圍。
  - access flag fault：AF = 0。
  - address size fault：超出 TCR_EL1.IPS。
- CPU 在 EL0 時（KPTI），核心位址只映射進入核心的跳板，面板會提示改選一顆在 EL1 的 CPU。
- 實體位址落在周邊（device 記憶體）時，**Show register** 會在 Peripheral Registers 選到那個暫存器；**Show in Memory Inspector** 開虛擬位址。
- 最後一個位址在每次停下、以及在呼叫堆疊改選 CPU 時自動重算。
- 支援 4 KB、16 KB、64 KB granule 與 48 位元位址；不支援 52 位元（FEAT_LPA2，會提示）。只做第一階段（EL1&0）；有 hypervisor 的第二階段（HCR_EL2.VM）時只提示。

實測（Ubuntu 平台）：`$pc`（核心程式碼，L3 的 4 KiB page，EL1 r-x、EL0 ---，Normal write-back，contiguous）與 `$sp`（核心堆疊，EL1 rw-，DBM 已寫入）的實體位址，與 QEMU monitor 的 `gva2gpa` 相同；`0xffff000000000000` 是 level 0 的 translation fault，`gva2gpa` 也回報 Unmapped。

## Pretty-printer

附加時，VP Studio 的 Linux 腳本（vp-linux.py）載入一組 gdb pretty-printer，讓「變數」「監看」中幾種核心的值直接顯示成一行：

| 型別 | 顯示 |
|---|---|
| `struct cpumask`（`cpus_mask`、`__cpu_online_mask` 等） | `{0-7}` |
| `atomic_t`、`atomic64_t`、`atomic_long_t` | 數值 |
| `refcount_t` | `refs 2` |
| `kuid_t`、`kgid_t` | 使用者或群組編號 |
| `struct qstr`（`d_name` 等） | `"kmsg"` |

設定 `vpStudio.debug.prettyPrinters`（預設開）在下次附加時生效；gdb 終端機的 `info pretty-printer` 列出它們（集合名稱 `vp-linux`）。

**沒有替 `task_struct`、`dentry`、`file`、`list_head` 這類結構做摘要**，原因是實測（2026-11-23，cdt-gdb-vscode 3.0.0、gdb 15）：
- CDT 附加時會送 `-enable-pretty-printing`。有 printer 的值在 MI 中是 `dynamic=1`、`numchild=0`，CDT 只看 `numchild`，所以這種值**沒有展開箭頭**。替結構加摘要，就打不開它的欄位。（若監看項目在 printer 載入前就已建立，碰巧還能展開，這不可靠。）
- 在「監看」已有該型別的值時才開啟這類 printer，gdb 的 `-var-update` 報「Duplicate variable object name」，在 VS Code 中 gdb 甚至以 internal error 結束。所以不要在除錯中途開關 pretty-printer；要改設定，請在下次附加前改。
- 自己的 printer 也適用同樣的限制：只用 `to_string`、用在不需要展開的型別，並在附加時載入，例如在 launch.json 的 `initCommands` 加上 `source /path/printers.py`。
- 每次停下，畫面上每個用到 printer 的值都會重算，每次讀取都經過 gdbstub，所以 printer 只讀少數欄位、不走訪串列。

實測：監看 `*(struct task_struct *)$SP_EL0` 照常是 `{...}`、可展開，展開後的 `usage = refs 1`；`__cpu_online_mask = {0-7}`；在 gdb 中 pid 1 的 `fd[0]` 的 `f_path.dentry->d_name` 為 `"null"`。

## Watchpoint 與執行到游標

- **Watchpoint**（gdb 的 watch／rwatch／awatch）：Memory Inspector 表格右鍵的 Break on Value Change／Read／Access，或在 gdb 終端機下 `watch jiffies`。QEMU 以 TCG 實作，沒有硬體 debug register 的數量限制，也不會退化成單步。實測：`watch jiffies` 停在 `tick_do_update_jiffies64`，`rwatch jiffies` 停在 `calc_global_load`。
- **執行到游標**：原始碼或反組譯檢視按右鍵 Run to Cursor（以臨時中斷點實作）。**跳到游標（Jump to Cursor）**：CDT 不支援 DAP 的 goto，VP Studio 另提供 **Jump to Cursor (Set PC)**（原始碼編輯器右鍵，或 Debug 組第三段）：把呼叫堆疊選取的 CPU 的 PC 移到游標所在行，只改 PC，暫存器與堆疊不變。
  - 做法：在該位址設臨時中斷點，以 gdb 的 jump 繼續，期間 `scheduler-locking on` 只讓這顆 CPU 執行，它一開始就停在臨時中斷點上，除錯器照常顯示這次停下；之後恢復原本的 scheduler-locking。
  - 本機檔案對到 gdb 的路徑：先經 `vpStudio.debug.sourceMap`（Map Kernel Sources…），再試路徑尾段（`kernel/time/timer.c`、`timer.c`）。沒有程式碼的行由 gdb 換成下一個有程式碼的行，狀態列會寫出實際的行號。一行有多個位址（inline）時，優先用 CPU 目前所在函式的那個，否則讓你選。
  - 沒有開原始碼時改為輸入位址或函式名稱。
  - 實測（Ubuntu 平台，CPU 7 停在 `cpu_do_idle` idle.c:32）：跳到 34 行、32 行，呼叫堆疊與 PC 隨之改變，繼續執行後客體正常。

## 跨視圖聯動：這次停下改變了什麼

每次停下（有附加除錯器時是除錯器的停止，含單步；沒有時是模擬暫停），VP Studio 比對「上一次停下」與「這一次停下」：

- **Peripheral Registers**（VP Studio 側欄與 Run and Debug 側欄）：值不同的暫存器以橘色圖示標出，後面寫「● was 舊值」，欄位也一樣；提示中列出哪些欄位從什麼變成什麼；周邊那一行寫「N changed」。只比對讀過的暫存器（展開的周邊），「讀取有副作用」的暫存器不自動讀，也就不比對。
- **Transaction Trace** 面板與平台檢視的 **Transactions** 分頁：兩次停下之間的匯流排存取以底色標出，面板寫「N accesses since the previous stop」。單步一條寫周邊的指令後，就能看到剛產生的那一筆交易。
- 在 Trace 面板點一筆存取（或在 Transactions 分頁固定一筆），**Peripheral Registers 會跳到它存取的暫存器**（有暫存器描述的周邊），平台檢視同時亮出路徑。

實測（Ubuntu 平台，PL011 探針記錄中）：兩次暫停之間只有一筆 `cpu_6` 讀 UARTFR，被標出，點它時 Peripheral Registers 選到 UARTFR；以 Set Value 寫 UARTILPR 後顯示「0x0000_0005 ● was 0x0000_0000」、PL011 一行「1 changed」。閒置時 PL011 的暫存器在兩次停下之間沒有變（處理完輸入後回到相同狀態），這時不會有標記。

說明：有附加除錯器時，停下以除錯器為準；agent 在單步後會晚約 0.2 秒報一次短暫的「執行中」，若以它為準會把剛比對好的值洗掉。

## OpenOCD：經 JTAG 除錯埠（G-13）

**Start Simulation with OpenOCD Port**（Debug 組）在平台加入 QBox 的 `debug_dap` 模組：模擬器開一個 OpenOCD `remote_bitbang` 的 TCP 埠，後面是 JTAG TAP、ADIv5 DAP、每顆核心的 Armv8 外部除錯暫存器與 CTI。不需要實體的 USB-JTAG 轉接板：OpenOCD 經 TCP 連到模擬器。VP Studio 在平台旁寫出 `debug/<平台>.openocd.cfg`，執行 `openocd -f debug/<平台>.openocd.cfg` 後：

- `telnet localhost 4444`（或 `nc localhost 4444`）下 OpenOCD 的指令：`halt`、`resume`、`step`、`reg`、`reg pc`、`mdw <位址>`、`bp <位址> 4 [hw]`、`rbp all`、`targets`；`vp.sys mdw <實體位址>` 讀系統匯流排；`vp_status` 列出每顆核心的 EDSCR、EDPRSR。
- gdb 連 OpenOCD 的 gdb server：`gdb-multiarch -ex "target extended-remote localhost:3333"`，每顆核心是一個 thread。gdb 斷開時核心繼續執行（設定檔的 `gdb-detach` 事件）。VP Studio 的 `tools/gdb/vp-linux.py` 也能用（`vp-kaslr`、`vp-ps`、`vp-dmesg`）：OpenOCD 沒有 VBAR_EL1，`vp-kaslr` 改由核心 CPU 的 PC 以 2 MiB 為單位找出 KASLR 位移。

核心組成一個 SMP 群組：停一顆就全部停（CTI 交叉觸發）。經核心存取的記憶體（`mdw`、gdb）用該核心的虛擬位址；系統暫存器唯讀（QEMU 的 gdbstub 不寫系統暫存器）；只試過 MTTCG；沒有 watchpoint。不要同時用 OpenOCD 與 QEMU 自己的 gdbstub（`gdb_port`）除錯，兩者都會收到中斷點造成的停止。

需要 VP Studio 0.2.10 起修補 0002 的 `debug_dap`（以 **Build QBox** 更新 QBox；Check QBox Version 會報舊版修補未套用）。舊版的 `debug_dap` 只能經 CTI 停住與恢復核心，OpenOCD 的 aarch64 目標讀不到暫存器。

做法（細節在 QBox 的 `systemc-components/debug_dap/README.md`）：模型找到核心所屬的 QEMU instance（參數 `qemu`），以 libqemu 的函式直接操作 QEMU 的 CPU。停住的核心在自己的執行緒上等一個 QEMU work item（BQL 放開），所以 QBox 的 CPU 迴圈與 VM 重新啟動都不會讓它繼續跑，sim agent 的暫停與繼續也不影響它。OpenOCD 寫進 EDITR 的指令由模型解譯（DCC 傳輸、MRS／MSR、載入與儲存、DCPS／DRPS、barrier 與快取維護），另有 EDSCR.MA 記憶體存取模式、halting step（`cpu_single_step`）、硬體中斷點（DBGBVR／DBGBCR）與軟體中斷點（經核心寫入的 HLT #11 改成 QEMU 中斷點，記憶體內容不變）。

實測（Ubuntu 平台 8 核心，OpenOCD 0.12.0，gdb 15）：
- OpenOCD 的 `halt` 停住 8 顆核心，各核心的 pc、cpsr、x0、v0、ELR_EL1 與模型記錄的一致。`mdw`、`mdb` 經核心讀到核心程式碼。
- `step` 每次前進一條指令（0.05 到 0.2 秒）；硬體中斷點與軟體中斷點都停在 `cpu_do_idle`，原本的指令仍在記憶體中。
- gdb 經 OpenOCD 載入 vmlinux、`vp-kaslr` 找到位移，`hbreak __arm64_sys_newuname` 後在客體執行 `uname`，停在 sys.c:1306，呼叫堆疊到 `el0_svc`；`next`、`finish` 回到 `el0_svc_common`；`vp-ps` 列出行程，`uname` 在命中的核心上。
- 與 sim agent 一起：OpenOCD 停住核心時 agent 暫停、繼續，核心仍停住、主控台沒有輸出；agent 暫停時 OpenOCD 照樣可以停住與恢復核心。

限制：OpenOCD 的 gdb server 只單步它的「目前」thread（OpenOCD 對其他 thread 是假單步，回報完成但沒有執行），以 gdb 的 `thread N` 切換後下 `stepi` 不一定作用在該核心；從中斷點停下的 thread 開始單步則正常。OpenOCD 0.12 的 `mdd`（8 位元組）在 aarch64 目標上只讀 4 位元組，是 OpenOCD 本身的問題。
