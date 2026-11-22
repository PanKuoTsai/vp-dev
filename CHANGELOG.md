# 變更記錄

VP Studio 各版本的變更。格式依 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)：每個版本分「新增、變更、修正」，使用者看得到的改變寫在前面。尚未發布的變更放在「未發布」，發布時改成版本號與日期。

## 未發布

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
