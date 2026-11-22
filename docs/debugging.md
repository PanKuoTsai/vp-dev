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

QEMU 把每顆 CPU 回報成一個 thread（`CPU#0 [halted]` 到 `CPU#7`）。沒有符號檔時，位置顯示為 `?? ()`；在平台檢視「Software images」選擇符號檔（例如 vmlinux）後重新執行 `Add Debug Configurations`，就會顯示函式名稱。
