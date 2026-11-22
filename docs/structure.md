# 專案結構

[VP Studio](../README.md) 的說明文件。

```
extension.js                 VS Code 進入點：註冊指令、檢視與各種 provider（activate、deactivate）
src/                         VS Code 整合：指令、診斷、樹狀檢視、webview、終端機，依功能分檔
  shared.js                  執行期間的共用狀態（檢視與面板、執行中的模擬、sim agent 連線），各檔經由同一個物件讀寫
  common.js                  各檔都用到的小工具：設定、平台檔副檔名、擴充套件資料夾、輸出頻道、工作目錄
  platformFiles.js           平台檔：選取、載入、診斷、產生 Lua
  platformView.js            平台檢視面板；platformEdit.js 是面板送回的編輯（映像檔、模組、連線、重整）
  simUi.js                   啟動與停止模擬；agentUi.js 是 sim agent 連線、暫停與繼續；remoteUi.js、askpassUi.js 是遠端模擬
  traceUi.js、profileUi.js、ftraceUi.js、perfUi.js、registersUi.js、paramsUi.js   各分析面板與檢視
  debugUi.js、linuxUi.js     除錯設定、OpenOCD 埠、CPU 暫存器、Linux 感知
  其餘                       catalogUi、devicetreeUi、modelUi、qboxUi、versionUi、checkpointUi、kitUi、examplesUi、modulesTree、menuUi
lib/                         核心邏輯，都不依賴 VS Code，可單獨測試；擴充套件與 vp-run 共用
lib/platform/                平台描述：展開與分析、Lua 產生、依元件目錄檢查、保留格式的 JSON 編輯
  core.js                    展開、分析、Lua 產生（不依賴 VS Code，可單獨測試）
  images.js                  loader 項目解析、ELF 標頭讀取、載入範圍檢查
  jsonedit.js                保留原格式的 JSON 局部編輯
  catalog.js                 依元件目錄檢查平台
  params.js                  平台檢視的參數表單：欄位、輸入解析、寫回 JSON 的編輯
  modules.js                 新增與刪除模組：型別清單、名稱、建構參數、刪除影響、JSON 編輯
  connect.js                 連線：埠與雙向綁定、相容埠、由哪端寫入、向量編號、JSON 編輯
  luaexpr.js                 求值平台中簡單的 Lua 運算式（mp_affinity、psci_conduit 等）
  dataflow.js                資料流：各 initiator 經 router 能到達的位址範圍，與能到達某個 target 的 initiator
  restructure.js             平台重整：更換模組的模型（保留匯流排上的位置）、把模組收進子系統
lib/sim/                     啟動與執行：啟動前檢查、sim agent 客戶端、存檔與還原、遠端模擬
  simagent.js                sim agent 的 JSON-RPC 客戶端、參數樹
  hostports.js               主機轉發埠的檢查與挑選
  disklock.js                磁碟映像檔是否被其他模擬器鎖住
  diskspace.js               磁碟映像檔（ext2/3/4）的可用空間
  checkpoint.js              存檔與還原：要存的記憶體、暫存器與磁碟，manifest，從存檔啟動的參數
  remote.js                  遠端模擬：ssh 指令、空閒埠、路徑對應、檔案檢查與上傳、終端機參數
  askpass.js                 遠端密碼登入：SSH_ASKPASS 伺服器與啟動程式（askpass-helper.js 由 ssh 執行，向 VP Studio 要密碼；Windows 用 prebuilt/win32/vp-askpass.exe，原始碼 tools/askpass/）
  launch.js                  啟動前的共用步驟：Lua 路徑、sim agent、snapshot、啟動前檢查、device tree、建置位置
lib/analysis/                觀測與分析：交易追蹤、剖析、函式追蹤、周邊暫存器、效能實驗
  elfsym.js                  ELF64 函式符號表（vmlinux 等）與位址查詢
  profile.js                 效能剖析：依函式彙總、arm64 KASLR 位移、符號檔警告
  ftrace.js                  函式進出追蹤：讀取記錄、配對呼叫與返回、Perfetto 時間軸、摘要
  registers.js               周邊暫存器：描述檔載入與展開、平台中的周邊、欄位解碼與寫入值
  trace.js                   交易追蹤：可追蹤的埠、插入追蹤模組的產生器選項、記錄解碼與 CSV
  perf.js                    效能分析：執行一次或參數掃描、讀取統計、挑指標、CI 門檻（擴充套件與 vp-run 共用）
  qos.js                     at_bus 的 masters 參數：各 master 的 QoS 設定的解析與寫回
lib/debug/                   除錯：Linux 感知、CPU 暫存器、OpenOCD 埠、第三方除錯器
  thirdparty.js              第三方除錯器：gdbstub 位址、TRACE32 腳本、說明文件
  guestlinux.js              Linux 感知：經 CDT 對 tools/gdb/vp-linux.py 送指令、解讀結果
  cpuregs.js                 CPU 暫存器：分組、AArch64 PSTATE 解碼、上次停住後變動的值
  debugdap.js                OpenOCD 連接埠：在平台加入 debug_dap 模組、寫出 OpenOCD 設定
lib/generate/                產生與匯入：device tree、建模精靈、IP-XACT
  modelgen.js                建模精靈：模型描述的檢查與 C++ 產生
  models.js                  建模精靈：寫檔、模型的元件目錄項目與合併、平台的 dylib 路徑
  devicetree.js              由平台描述產生 device tree source
  xml.js                     小型 XML 解析器（IP-XACT 用，無相依套件）
  ipxact.js                  IP-XACT 匯入：暫存器映射、數值與運算式、轉成模型或暫存器描述
  dtcompare.js               device tree 預覽與比對：行差異、以 dtc 轉成同一形式後比較
lib/setup/                   環境與交付：QBox 版本與建置、交付套件
  pin.js                     QBox 版本比對：釘選的 commit 與模擬器、目錄、sim agent 各自的來源
  kit.js                     交付套件：找出平台引用的檔案、改寫絕對路徑、匯出、解開與檢查
  tar.js                     串流的 tar（ustar 加 pax）讀寫，供交付套件使用
  qboxsetup.js               建置 QBox：QBox 資料夾與建置目錄的狀態、建置設定、build-qbox.sh 的參數
lib/webview/                 各面板的 HTML（平台檢視、追蹤、剖析、效能、Build QBox、CPU 暫存器）
  view.js                    平台檢視的 HTML 與方塊圖
  profileview.js             Profile 面板的 HTML
  traceview.js               Transaction Trace 面板的 HTML
  perfview.js                Performance 面板的 HTML
  cpuregsview.js             CPU Registers 檢視的 HTML
  qboxview.js                Build QBox 檢視的 HTML
  webtheme.js                各 webview 共用的外觀：圖示與 media/theme.css
  media.js                   讀取 media/ 中的樣式表與頁面腳本，供各頁面內嵌
media/                       各 webview 頁面的樣式表與頁面腳本：theme.css（共用）、<頁面>.css、<頁面>.js（platform、trace、profile、perf、qbox、cpuregs）；產生頁面時內嵌進帶 nonce 的 <style> 與 <script>
lib/menu.js                  VP Studio 選單：指令分組與 when 條件（下拉選單、Actions 檢視、狀態列、獨立版選單列共用）
catalog/registers/           隨附的暫存器描述（PL011、GICv3 distributor、virtio-mmio）
prebuilt/                    版本庫內唯一的編譯產物：win32/vp-askpass.exe 與它的 SHA256SUMS（說明見 prebuilt/README.md）
bin/vp-run                   命令列執行與 CI 的入口：找 Node.js（含 VS Code 內建的）執行 vp-run.js
bin/vp-run.js                命令列執行與 CI：主控台 expect/send、逾時、JUnit 報告
tools/vp-py/vpstudio.py      sim agent 的 Python 用戶端（只用標準函式庫）
examples/                    參考用的範例，不會被指令複製
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
templates/                   Create Example 指令複製到工作區的範本，測試也以它們為輸入
  ubuntu-aarch64.platform.json      Ubuntu AArch64 參考平台（Create Example Platform）
  perf/                             效能實驗的平台與掃描檔（Create Performance Example）
test/run.js                  執行全部測試（npm test）；node test/run.js core view 只跑指定的檔
test/<主題>.test.js          各主題的測試，可單獨執行：node test/core.test.js
test/harness.js              test、testAsync（非同步測試排在所有同步測試之後）
test/helpers.js              多個測試檔共用的範例平台、元件目錄與暫存工作區
.github/workflows/ci.yml     CI：在 Linux 上以 Node.js 18 與 22 執行 npm test，並執行 npm run lint
eslint.config.js             ESLint 設定（npm run lint；先 npm install 取得 ESLint）
CLAUDE.md                    給後續開發（含 Claude Code）的交接說明
INSTALL.md                   安裝與第一次使用（給新使用者）
docs/                        功能說明、驗證狀態、除錯、命令列與 CI、設定、專案結構（由 README.md 連結）
```
