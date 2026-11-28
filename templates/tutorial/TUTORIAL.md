# VP Studio 教學：vplogger 為什麼會當掉、為什麼這麼慢

同事交來一支在客體 Linux 上執行的程式 `vplogger`：它模擬 8 個感測器，把每一筆取樣寫進日誌檔。回報的問題有兩個：

1. 記錄到一半會 `Segmentation fault`。
2. 就算不當掉，記錄幾千筆也慢得離譜。

這份教學用 VP Studio 的工具一步一步找出原因、修好、再證明真的修好了。每一幕都寫明：**用哪個工具、會看到什麼、因此知道什麼**。

| 幕 | 問題 | 主要工具 |
|---|---|---|
| 0 | 這台機器長什麼樣？ | Platform View、Memory map、Save Checkpoint |
| 1 | 它當在哪裡、為什麼？ | Exceptions & Interrupts、條件中斷點、CPU Registers、Translate Virtual Address、Load Symbol File、Memory Inspector |
| 2 | 時間花在哪裡？誰呼叫誰？ | Profile、Function Trace（Perfetto）、系統呼叫統計 |
| 3 | 硬體看到了什麼？ | Transaction Trace、Break on、Peripheral Registers、Interrupt Controller (GIC)、訊號追蹤（VCD） |
| 4 | 修好了嗎？以後會不會又壞？換硬體有沒有用？ | Start from Checkpoint、vp-run（CI）、Export Trace as Replay、Performance Sweep |

整份做完約 1.5 到 2 小時（第一次開機約 4 分鐘，之後都從存檔開始，約 15 秒）。

## 這個資料夾裡有什麼

| 檔案 | 用途 |
|---|---|
| `../vplogger-tutorial.platform.json` | 教學用的平台：就是 Ubuntu AArch64 範例平台，另外指定了核心的符號檔（vmlinux） |
| `vplogger/vplogger.c` | 程式原始碼（三個版本是同一個檔案，以編譯旗標區分） |
| `vplogger/bin/vplogger-bug` | 第 1 幕：有錯、會當掉 |
| `vplogger/bin/vplogger-fix1` | 第 2、3 幕：不當了，但每寫一行就 `fsync` 一次 |
| `vplogger/bin/vplogger-fix2` | 第 4 幕：緩衝寫入，結束時才 `fsync` |
| `vplogger/build.sh` | 改了原始碼後重建三個版本（需要 `gcc-aarch64-linux-gnu`） |
| `install-vplogger.sh` | 把三個程式寫進客體磁碟映像的 `/opt/vplogger/`（不開機；`--uninstall` 移除） |
| `ci/vplogger-ci.sh` | 第 4 幕：把修正變成回歸測試（vp-run、JUnit） |
| `perf/` | 第 4 幕：架構探索的模型（`logger-ddr.platform.json`）、掃描（`logger-ddr.perfsweep.json`）與範例重播檔 |

程式的除錯資訊把原始檔記成 `/vplogger/vplogger.c`；Create Tutorial Workspace 已經在工作區設定 `vpStudio.debug.sourceMap` 把它對應到這個資料夾的 `vplogger/`，除錯器停下時會開這裡的原始碼。

## 開始之前

- VP Studio 已經可以開機 Ubuntu 平台（INSTALL.md 第 3 到 6 節：QBox、sim agent、Ubuntu 映像檔）。
- 已安裝 CDT GDB Debug Adapter 與 `gdb-multiarch`（第 1 幕）。
- 三個程式已寫進磁碟映像：建立教學時選了 **Install**；或自己執行
  `bash install-vplogger.sh <QBox>/platforms/ubuntu/fw/Artifacts/image_ext4.img`。
  模擬執行中不能寫，腳本會拒絕。

---

## 第 0 幕：認識平台並存檔（約 10 分鐘）

**問題**：這台機器有什麼？日誌最後會寫到哪裡？

1. 開 `vplogger-tutorial.platform.json`，按編輯器右上角的 **Show Platform View**。
   - 看到：8 顆 CPU、一條 router、GICv3、PL011（主控台）、virtio-blk（磁碟）、virtio-net、PCIe。
2. 下方分頁 **Memory map** → **Find address** 輸入 `0x1c0d0050`。
   - 看到：這個位址屬於 `virtioblk_0`（偏移 0x50 是 virtio 的 QueueNotify：驅動程式每送出一批磁碟要求就寫一次）。
   - 按 **Route**：方塊圖亮出 CPU → router → virtio-blk 這條路。第 3 幕看到的存取走的就是它。
3. 按頁首的 **Start Simulation**，等到 `login:`（約 4 分鐘），以 `root`／`root` 登入。
4. **等 30 秒再存檔**：剛登入時使用者工作階段的服務（rygel 等）還在啟動，會把後面的量測弄髒。在主控台執行
   ```
   sleep 30; top -b -n1 | head -12
   ```
   看到 `%Cpu(s)` 的 `id`（閒置）在 70% 以上就可以（`top` 本身在模擬器裡也要花一些 CPU）。
5. 執行 **VP Studio: Save Checkpoint…**，名稱 `login`。
   - 看到：約 10 秒後存好（平台旁的 `checkpoints/login/`，含磁碟映像的副本，約 5 GB）。
6. 按 **Stop**。

**學到**：之後每一幕都用 **Start from Checkpoint…** 從這個存檔開始（約 15 秒），每次的起點完全相同，比較才有意義。

注意：從存檔啟動的模擬，跑在存檔資料夾裡的磁碟副本上，所以**不能用同一個名稱再存一次**（VP Studio 會拒絕）。要重新存 `login`，先用一般的 Start Simulation 開機。

---

## 第 1 幕：它當掉了（除錯，約 30 分鐘）

**問題**：當在哪一行？存取了哪個位址？為什麼？

### 1-1 先重現

1. **Start from Checkpoint…** → 選 `login` → 在「also turn on…」清單勾選 **Target debug port**（方向鍵移動、空白鍵勾選）→ Enter。
2. 在主控台執行 `/opt/vplogger/vplogger-bug`。
   - 看到：`vplogger: 1000 records` … `3000 records`，接著 `Segmentation fault (core dumped)`。

### 1-2 Exceptions & Interrupts：記錄有哪些事件

1. **VP Studio: Exceptions & Interrupts**。記錄預設就開著；按 **Clear** 歸零。
2. 再執行一次 `/opt/vplogger/vplogger-bug`。
3. 看 COUNTS：IRQ 約 5 萬、SVC（系統呼叫）約 7000 到 1 萬 5 千、**Data abort from a lower EL**（EC 0x24）上百到上千次。
   - 事件列表裡 EL0 的 data abort 大多是**正常的 page fault**（程式第一次碰到一頁記憶體時，核心才把它對應進來），程式當掉的那一次只是其中之一。
4. 試試看：在 STOP ON 勾選 **Data abort**、From 選 **EL0 (user space)**，再執行一次程式。
   - 看到：模擬很快停下，但停的是 `sleep`、bash 或其他行程的正常 page fault（FAR 是一般的使用者位址），不是我們要的那一次。按 **Continue** 幾次就知道：這樣找太慢。
   - 取消勾選，按 **Continue**。

**學到**：「攔截」會在每一次符合的例外停下；正常的事件太多時，先「記錄」看有哪些，再用更精確的條件停。

### 1-3 條件中斷點：只停在真正的錯誤

Linux 對 EL0 的錯誤存取送 SIGSEGV 時，一定經過核心函式 `arm64_force_sig_fault`。停在它，就只會停在真正的錯誤。

1. 模擬執行中，執行 **VP Studio: Add Debug Configurations**。
   - 看到：通知寫著 `Target symbols: vmlinux-5.15.0-203-generic`（Create Tutorial Workspace 已經把 vmlinux 寫進平台）。
2. Run and Debug 選 **VP: attach to target software**，按綠色箭頭附加（會載入 vmlinux 並算出 KASLR 位移，約 10 到 30 秒）。
3. 按 **Pause**（F6），執行 **VP Studio: Add Conditional Breakpoint…**：函式輸入 `arm64_force_sig_fault`，條件與 hit count 都直接按 Enter。
   - 看到：`Breakpoint: arm64_force_sig_fault (traps.c:267)`。
   - 中斷點設在函式本體的第一行（267），不是宣告的那一行（265）：265 行在這個核心裡只對應到被 inline 進別的函式的副本，`do_page_fault` 呼叫的那一份從 267 行開始。
4. 按 **Continue**（F5），在主控台執行 `/opt/vplogger/vplogger-bug`。
   - 看到：印到 `3000 records` 後停下，Call Stack 有一顆 CPU 標著 **PAUSED ON BREAKPOINT**。
   - 編輯器會開一個「找不到檔案」的 `traps.c`：核心原始碼不在這台機器上，這是正常的（有原始碼時用 **Map Kernel Sources…**）。
   - Variables → Local：`signo = 11`（SIGSEGV）、`far = 0`、`str = "level 2 translation fault"`。
5. 在 Call Stack 展開那顆 CPU：`arm64_force_sig_fault` ← `do_page_fault` ← `do_translation_fault` ← `do_mem_abort` ← `el0_da` ← `el0t_64_sync_handler`：一次從 EL0（使用者程式）來的 data abort。點 **`do_mem_abort`** 這一層。
6. 在 **Debug Console**（不加 `>`，會在選取的那一層求值）輸入 `regs->pc`。
   - 看到：`4197812`，也就是 `0x400db4`：使用者程式裡出錯的那條指令（程式以固定位址連結，從 `0x400000` 開始）。
7. **Guest Processes**（Run and Debug 側邊欄）：`vplogger-bug` 在停下的那顆 CPU 上。

### 1-4 Translate Virtual Address：位址 0 為什麼不能讀

1. **VP Studio: Translate Virtual Address…**，在面板的輸入框填 `0x0`，按 **Translate**。
   - 看到：`Translation fault, level 2`：用 `vplogger-bug` 的頁表（TTBR0）走一遍，L0、L1 是 table，**L2 的描述元是 0（invalid）**：位址 0 根本沒有對應任何記憶體。和核心說的 `level 2 translation fault` 一致。

### 1-5 Load Symbol File：對回原始碼

1. **VP Studio: Load Symbol File at Address…** → 選 `vplogger/bin/vplogger-bug`。
   - 看到：位址欄已經填好 `0x400b40`（程式自己的 `.text`；固定位址連結的程式就在連結時的位址執行）。按 Enter，通知 `Symbols of vplogger-bug loaded at 0x400b40`。
2. 在 Debug Console 輸入（`>` 開頭是 gdb 指令；數字換成你看到的 `regs->pc`）：
   ```
   >info symbol 4197812
   >list *4197812
   ```
   - 看到：`format_record + 116`，`vplogger.c` 第 100 行附近：`int32_t v = filter(s, s->ops->read(s, tick));`。
3. 開 `vplogger/vplogger.c` 讀這一段：`sensor_offline()` 在第 3000 筆時把 5 號感測器釋放並設成 `NULL`，但 `format_record()` 沒有檢查，直接讀 `s->ops`：`s` 是 `NULL`，`ops` 在結構的偏移 0，所以讀的就是位址 0。
4. 確認：Debug Console 輸入 `>x/8gx &sensors`。
   - 看到：8 個指標裡第 6 個（`sensors+40`，索引 5）是 `0x0000000000000000`，其他都是堆積上的位址。

**學到**：
- 例外向量、ESR、FAR、ELR 各是什麼；從核心的錯誤處理路徑可以拿到使用者程式出錯時的暫存器。
- 用 MMU 轉換確認「這個位址不存在」，而不是猜。
- 修法：跳過離線的感測器。這就是 `vplogger-fix1`（`-DFIX_OFFLINE`）。

結束：在 Breakpoints 檢視刪除中斷點，按除錯工具列的 **Disconnect**（不是 Stop：Stop 會讓模擬停在 halted），再按 VP Studio 的 **Stop**。

---

## 第 2 幕：它很慢（剖析與函式追蹤，約 25 分鐘）

**問題**：`fix1` 不當了，但 3000 筆要半分鐘。時間花在哪裡？

### 2-1 先量

1. **Start from Checkpoint…** → `login` → 勾選 **Profiling** 與 **Function trace** → Enter。Profile 面板會自己打開。
2. 主控台執行 `time /opt/vplogger/vplogger-fix1 -r 3000`。
   - 看到：`real` 約半分鐘到一分鐘（開著剖析與函式追蹤會慢一些）、`user` 不到 1 秒、`sys` 約 10 秒：大部分時間既不在程式、也不在核心計算，而是在**等**。

### 2-2 Profile：時間花在哪裡

1. 在 Profile 面板按 **Reset**，再執行一次 `/opt/vplogger/vplogger-fix1 -r 3000`，完成後看表。
   - 看到：第一名 `queued_spin_lock_slowpath` 約 11%，其餘很分散：`ktime_get`、`psi_group_change`、`__crc32c_le`、`jbd2_*`……；`[user space]` 約 5%。
2. 按 **Program…** 選 `vplogger/bin/vplogger-fix1`：使用者空間的樣本改以程式的函式名稱顯示（`filter`、`format_record`），其他（libc、別的行程）是「outside the program」。

**學到**：剖析是**取樣**，回答「指令花在哪裡」；它分散在一大堆核心函式時，代表問題不是某個函式太慢，而是某件事做了太多次。

### 2-3 系統呼叫：做了幾次

1. **Exceptions & Interrupts**：按 **Clear**，再執行一次程式。
   - 看到：SVC（EC 0x15）約 7000 次，IRQ 約 5 萬 5 千次。3000 筆 × (`write` + `fsync`) = 6000 次系統呼叫，其餘是 bash 與 `time`。

### 2-4 Function Trace：誰呼叫誰

1. 主控台執行 `/opt/vplogger/vplogger-fix1 -r 3000 > /dev/null &`（放到背景，主控台空出來）。
2. 執行 **VP Studio: Function Trace: Start Recording…**，範圍選 **Kernel, calls made at EL1**（核心符號才對得上）；約 1 秒後執行 **Function Trace: Stop and Save**，存檔位置用預設的（平台旁的 `traces/`）。
   - 只錄 1 秒：每顆 CPU 的緩衝區有上限，錄太久只留下最後一段（摘要開頭會提醒哪幾顆 CPU 被截掉）。
3. 存好後會開摘要（Markdown 預覽）。看 **Functions by instructions with callees**：
   - `__arm64_sys_fsync` → `ext4_sync_file` → `file_write_and_wait_range`，每次呼叫數十萬指令；`jbd2_journal_commit_transaction`（ext4 的日誌提交）；`submit_bio` / `blk_mq_submit_bio`（送到磁碟的要求）；`io_schedule`（等磁碟）。
4. 用 [Perfetto UI](https://ui.perfetto.dev) 開同名的 `.json`，搜尋 `__arm64_sys_fsync`，放大一次：
   - 看到：一次 `fsync` 底下是寫回資料頁、提交日誌、送出好幾個 bio，然後在 `io_schedule` 裡睡著等中斷。

**學到**：函式追蹤回答「誰呼叫誰、照什麼順序」，這是剖析給不了的因果關係。每一行一次 `fsync`，就是每一行一次「寫資料 + 寫日誌 + 等磁碟」。

結束：**Stop**。

---

## 第 3 幕：硬體看到了什麼（追蹤，約 20 分鐘）

**問題**：每一次 `fsync` 對磁碟裝置做了什麼？

1. **Start from Checkpoint…** → `login`（不勾任何選項）。探針會自動插上（不記錄）。
2. **VP Studio: Show Transaction Trace**，在左側 PROBES 卡片按 **Choose…**，勾選 `virtioblk_0.mem` → Enter。
3. 主控台執行 `/opt/vplogger/vplogger-fix1 -r 3000`。
   - 看到：三件一組的存取：寫 `0x1c0d0050`（QueueNotify：送出要求）、讀 `0x1c0d0060`（InterruptStatus）、寫 `0x1c0d0064`（InterruptACK），Initiator 欄寫著是哪顆 CPU（`cpu_0.mem`…）。整個程式約 3000 到 6600 組。
   - 點一列：平台檢視亮出這筆存取的路徑。
4. 對照客體自己的計數：
   ```
   cat /sys/block/vda/stat; /opt/vplogger/vplogger-fix1 -r 3000 >/dev/null; cat /sys/block/vda/stat
   ```
   第 5 欄（寫入的要求數）多了約 9000，第 7 欄（寫入的磁區）多了約 98000（約 50 MB）。日誌檔本身只有 356 KB：**寫入放大約 140 倍**。
5. **Break on**：位址 `0x1c0d0050`、寫入，按 Add。
   - 看到：模擬停在下一次 QueueNotify，紅框寫出是哪顆 CPU（by cpu_N.mem）。**Peripheral Registers** 跟著標出 virtio-blk 變動的暫存器（跨視圖聯動）。按 **Continue**，刪掉中斷點。
6. **VP Studio: Interrupt Controller (GIC)**：找 virtio-blk 的 SPI（平台檢視的方塊上寫著 SPI 號碼）：enabled、優先權、路由到哪顆 CPU；程式執行時按 **Live** 可以看到 pending／active 跳動。
7. （選做）訊號：Probes 列打開 `pl011_uart_0.irq`，在主控台打幾個字，按 **VCD…** 匯出，用 GTKWave 看中斷脈衝。
8. 第 4 幕的重播檔就是從這裡匯出的（**Replay…**，見 4-3）。

**學到**：軟體的一行 `fsync`，在硬體上是好幾次 MMIO 啟動、好幾次 DMA、好幾次中斷。追蹤讓這條因果鏈看得見，而且數字可以和客體自己的統計對得上。

---

## 第 4 幕：修好並證明（分析，約 25 分鐘）

### 4-1 同一個起點比較

1. **Start from Checkpoint…** → `login` → 勾選 **Profiling**。
2. 主控台執行：
   ```
   time /opt/vplogger/vplogger-fix1 -r 3000
   time /opt/vplogger/vplogger-fix2 -r 3000
   ```
   中間在 Profile 按 **Reset**、在 Exceptions & Interrupts 按 **Clear**，各記下數字：

   | | fix1 | fix2 |
   |---|---|---|
   | `real`（客體時間） | 約 30 到 60 s | 約 1 s |
   | SVC | 約 7600 | 約 1500（大多是 bash） |
   | IRQ | 約 5 萬 | 約 1600 |
   | QueueNotify（Transaction Trace） | 約 6600 | 約 12 |
   | Profile | 核心分散 | 使用者空間 68%（`snprintf` 等 libc 與 `filter`） |

**學到**：修好之後，瓶頸從「核心與磁碟」移到「程式自己的格式化」。這才是合理的狀態。

### 4-2 變成回歸測試

在終端機（不需要 VS Code），先停掉模擬（磁碟映像不能同時給兩個模擬器用）：

```
cd <QBox>/platforms/ubuntu/vplogger-tutorial
bash ci/vplogger-ci.sh --restore ../checkpoints/login --variant fix2
bash ci/vplogger-ci.sh --restore ../checkpoints/login --variant bug
```

- `fix2`：約 3 秒，`vp-run: passed`，結束碼 0。
- `bug`：主控台一出現 `Segmentation fault` 就失敗（`--fail-on`，不用等逾時），結束碼 1；JUnit 報告 `ci/vplogger-ci.junit.xml` 寫著原因。
- 沒有存檔時省略 `--restore`，會從開機開始（約 4 分鐘，磁碟以 snapshot 開啟，不留變更）。

**學到**：把「修好了」寫成每次都會跑的檢查；CI 可以直接收 JUnit。

### 4-3 架構探索：換更快的記憶體或加 QoS 有沒有用？

假設這支程式要放到一顆產品晶片上，DDR 同時給顯示器（6000 MB/s）和 CPU 用。問題是：**這個日誌流量會不會和它們搶記憶體？給它 QoS 優先權有沒有用？**

1. 準備重播檔（需要第 3 幕的追蹤；沒有的話 `perf/` 裡有範例）：
   1. 從存檔啟動，Transaction Trace 只開 `virtioblk_0.mem`，按 **Clear**（「First 2 s」從追蹤裡第一筆算起，留著別的程式的紀錄就會算錯）。
   2. 主控台執行 `cat /sys/block/vda/stat; /opt/vplogger/vplogger-fix1 -r 3000 >/dev/null; cat /sys/block/vda/stat`，用第 7 欄的差 × 512 算出寫入的位元組數（約 5000 萬）。
   3. 按 **Replay…**（或 **VP Studio: Export Trace as Replay…**）→ 選 `virtioblk_0.mem  write 0x1c0d0050`（每次 QueueNotify 代表一批要求）→ 大小輸入 `total 50561024`（換成你算出的數）→ **First 2 s, 1000 times faster** → 存成 `vplogger-tutorial/perf/vplogger-fix1.replay.csv`（取代範例）。
      - 看到：通知寫出幾個要求、每個多大、模型裡的時間長度。
   4. 按 **Clear**，對 `fix2` 做一次（約 `total 417792`），存成 `perf/vplogger-fix2.replay.csv`。
   - 重播檔的時間來自真實執行；**每次要求的大小是由客體的計數平均出來的**，追蹤本身看不到 DMA（QEMU 裝置的 DMA 直接寫記憶體，不經 SystemC）。追蹤的時間是 SystemC 時間，以 quantum 為單位前進，所以要求會一批一批出現。
2. 開 `perf/logger-ddr.perfsweep.json`，執行 **VP Studio: Run Performance Sweep…**（8 次，每次約 4 秒；模擬器開著時慢一些）。不需要停掉 Ubuntu 的模擬：效能模型是另一個模擬器。
   - 模型：logger（重播）、display（6000 MB/s、保留頻寬）、cpu（隨機存取，優先權 3）共用一個 MAU（at_bus）與一顆 DDR4-3200。
   - 掃描：重播檔 fix1／fix2 × CPU 在途筆數 8／32 × logger 優先權 1／4。
3. 看 Performance 面板：

   | | logger 搬的資料 | logger p99 延遲（CPU 32 筆在途） | 優先權 4 時 | CPU 頻寬的代價 |
   |---|---|---|---|---|
   | fix1 | 3.9 MB（前 2 s，約 400 筆） | 約 7.8 µs | 約 0.9 µs | 8383 → 7546 MB/s（−10%） |
   | fix2 | 0.42 MB（全部 3000 筆） | 約 7.9 µs | 約 1.1 µs | 8383 → 8309 MB/s（−1%） |

   顯示器在每一次都保持 6000 MB/s；DDR 最忙也只到約 60%。

**學到**：
- 就算儲存裝置快 1000 倍，這個流量也不會把 DDR 塞滿：**換更快的記憶體解決不了 vplogger 慢的問題**，問題在軟體（第 2、3 幕）。
- CPU 很忙時，日誌的延遲會被拉長；給它優先權可以拉回來，但代價是 CPU 的頻寬，而且和日誌的流量成正比。軟體修好之後，同樣的優先權幾乎是免費的。
- 架構探索不是只回答「要多快的硬體」，也回答「硬體不是瓶頸」。

---

## 總表：想知道什麼，用什麼

| 想知道 | 工具 | 看什麼 |
|---|---|---|
| 程式當在哪裡 | 條件中斷點（核心的錯誤路徑）＋ Call Stack | `do_mem_abort` 的 `regs->pc` |
| 那個位址能不能用 | Translate Virtual Address… | 哪一層的描述元無效、權限 |
| 位址是哪一行 | Load Symbol File at Address… ＋ `>list *ADDR` | 原始碼行 |
| 有哪些例外、中斷、系統呼叫 | Exceptions & Interrupts（記錄） | 計數表、事件列表 |
| 停在某一種例外 | Exceptions & Interrupts（攔截） | 停在向量上的那顆 CPU |
| 時間花在哪裡 | Profile（＋ Program…） | 函式排行、核心／使用者比例 |
| 誰呼叫誰、照什麼順序 | Function Trace ＋ Perfetto | 摘要的呼叫樹表、時間軸 |
| 硬體收到什麼存取 | Transaction Trace | 位址、讀寫、發起的 CPU、路徑 |
| 某個暫存器什麼時候被寫 | Transaction Trace 的 Break on | 停下的那一筆、Peripheral Registers |
| 中斷有沒有開、送到哪 | Interrupt Controller (GIC)、訊號追蹤（VCD） | enabled、pending、路由 |
| 修好了沒、會不會再壞 | Start from Checkpoint、vp-run（`--fail-on`、JUnit） | 同起點的數字、CI 結果 |
| 換硬體有沒有用 | Export Trace as Replay → Performance Sweep | 頻寬、延遲、使用率 |

## 限制

- QEMU（TCG）沒有真實晶片的時序與快取：這裡的「慢」是以客體時間、指令數、系統呼叫與裝置存取次數衡量，不是實際晶片上的秒數。
- 追蹤的時間是 SystemC 時間，以 quantum 前進；同一個 quantum 內的存取時間相同。
- QEMU 裝置的 DMA 不經 SystemC，追蹤看不到；重播檔的傳輸大小是估計值（見 4-3）。
- 函式追蹤只適合錄短時間（約 1 秒），而且會讓模擬變慢。

改了 `vplogger.c` 想自己試：`bash vplogger/build.sh`，再 `bash install-vplogger.sh <映像檔>`（模擬要先停），然後**重新存一次檔**（舊的存檔裡是舊的程式）。
