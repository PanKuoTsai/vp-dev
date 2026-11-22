# 驗證狀態

[VP Studio](../README.md) 的說明文件。

| 項目 | 狀態 |
|---|---|
| 產生器、分析、映像檔檢查、JSON 局部編輯、目錄檢查、sim agent 客戶端、參數表單、新增與刪除模組、連線、主機埠、磁碟映像鎖、交易追蹤、版本比對、執行中參數的輸入檢查與寫回平台、device tree 產生、Lua 運算式求值、子系統、建模精靈、外部 CPU 模組的 dylib 檢查、磁碟映像可用空間、Linux 感知、交付套件與 tar、存檔與還原、修補偵測、XML 與 IP-XACT 匯入、第三方除錯器設定、遠端模擬、EL3 開機檢查、函式進出追蹤 | 189 個單元測試通過（`npm test`）；產生器輸出與 Python 原型逐位元一致 |
| 參數表單的網頁行為 | 已在無頭 Firefox 中以腳本實際操作（選取、送出、重設、篩選、錯誤顯示、切換套用範圍、`gdb_port` 鎖定、重新渲染後還原選取、範圍、篩選與焦點）；使用者已在 VS Code 中使用（2026-11-14） |
| sim agent（`tools/sim-agent`） | 已驗證（2026-11-14，Ubuntu AArch64 8 核心）：在 `login:` 暫停時打字客體無回應、主機 CPU 降到 0%，繼續後才出現；開機中隨機暫停與繼續 40 次全部確實凍結、無卡住；`lib/sim/simagent.js` 對實際 agent 跑過連線、暫停、繼續、通知、參數列表 |
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
