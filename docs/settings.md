# 設定

[VP Studio](../README.md) 的說明文件。

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
