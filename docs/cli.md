# 命令列與 CI（vp-run）

[VP Studio](../README.md) 的說明文件。

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

交付套件（給別人開機用，見[功能說明](features.md)的交付套件）：

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
