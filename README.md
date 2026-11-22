# VP Studio

以 JSON 平台描述為核心，在 VS Code 相容編輯器中設定、檢視、執行與除錯 QBox 虛擬平台的擴充套件。

發行者 ID 為 `novatek`（擴充套件識別碼 `novatek.vp-studio`），獨立版的 appId 為 `tw.com.novatek.vp-studio`。

## 功能概觀

- **平台**：平台描述編輯、語意檢查、元件目錄檢查、Lua 產生、平台檢視、參數編輯、新增與刪除模組、連線、子系統（巢狀 Container）、模組側邊欄、device tree 產生
- **軟體映像檔**：軟體映像檔設定、映像檔檢查、除錯符號連動
- **模擬**：執行模擬、暫停／繼續／模擬時間、存檔與還原、遠端模擬、CCI 參數檢視、修改執行中的參數
- **分析**：交易追蹤、探針（預先插好、執行中開關）、匯流排中斷點、效能剖析、函式進出追蹤、周邊暫存器、效能分析（架構探索）
- **除錯**：除錯、Linux 感知、第三方除錯器
- **模型**：建模精靈、IP-XACT 匯入
- **交付與環境**：交付套件、QBox 版本釘選、獨立版（Theia）

每一項的說明、用法與限制見[功能說明](docs/features.md)。

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
6. 目標軟體除錯：執行 `VP Studio: Start Simulation with Target Debug Port`，再執行 `VP Studio: Add Debug Configurations`，`program` 會自動填入平台的符號檔（沒有設定時才需要手動填），然後從除錯面板附加。launch 設定使用 CDT GDB Debug Adapter 擴充套件（`eclipse-cdt.cdt-gdb-vscode`）與 `gdb-multiarch`。細節見[除錯：偵錯主控台與 gdb 終端機](docs/debugging.md)。

## 開發

- `npm test`：執行 `test/` 下的全部測試，不需要先 `npm install`。
- `npm run lint`：ESLint（設定在 `eslint.config.js`）；先執行一次 `npm install` 取得 ESLint，需要 Node.js 20.19 以上。
- 推送到 `main` 與每個 pull request 都會由 GitHub Actions 在 Linux 上執行這兩項（`.github/workflows/ci.yml`）。

## 文件

| 文件 | 內容 |
|---|---|
| [INSTALL.md](INSTALL.md) | 安裝與第一次使用（給新使用者） |
| [功能說明](docs/features.md) | 每項功能做什麼、怎麼用，以及這一版還做不到的事 |
| [驗證狀態](docs/verification.md) | 哪些已實際驗證、在什麼時候、哪些還沒有 |
| [除錯：偵錯主控台與 gdb 終端機](docs/debugging.md) | 附加除錯後兩個輸入處的差別與建議的分工 |
| [命令列與 CI（vp-run）](docs/cli.md) | 不開 IDE 啟動平台、檢查主控台輸出、存檔與還原、交付套件、效能實驗 |
| [設定](docs/settings.md) | `vpStudio.*` 各項設定與預設值 |
| [專案結構](docs/structure.md) | 每個資料夾與檔案放什麼 |
| [theia/README.md](theia/README.md) | 獨立版（Theia）的建置與執行 |
