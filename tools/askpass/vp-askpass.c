/*
 * vp-askpass.exe: the SSH_ASKPASS program of VP Studio on Windows.
 *
 * The OpenSSH of Windows starts SSH_ASKPASS with CreateProcess, which runs
 * only .exe files (a .cmd fails with "CreateProcessW failed error:2"), so
 * this launcher runs VP Studio's lib/sim/askpass-helper.js with VS Code's own
 * Node, the way vp-askpass.sh does on Linux:
 *
 *     "%VP_ASKPASS_NODE%" "%VP_ASKPASS_SCRIPT%" <the prompt ssh gave us>
 *
 * The helper asks the VP Studio window for the answer and prints it; its
 * standard output and exit code are ssh's answer. ELECTRON_RUN_AS_NODE and the
 * other VP_ASKPASS_* variables come from ssh's environment, which the child
 * inherits. Only Win32 API, no C runtime start-up code needed beyond mingw's.
 *
 * Build: tools/askpass/build.sh (mingw-w64), output lib/sim/vp-askpass.exe.
 */
#include <windows.h>

static int appendQuoted(wchar_t *out, int at, int cap, const wchar_t *s)
{
    /* CommandLineToArgvW rules: backslashes before a quote are doubled. */
    if (at + 1 >= cap) return -1;
    out[at++] = L'"';
    for (const wchar_t *p = s; *p; p++) {
        int bs = 0;
        while (*p == L'\\') { bs++; p++; }
        if (*p == 0) { bs *= 2; }
        else if (*p == L'"') { bs = bs * 2 + 1; }
        for (int i = 0; i < bs; i++) { if (at + 1 >= cap) return -1; out[at++] = L'\\'; }
        if (*p == 0) break;
        if (at + 1 >= cap) return -1;
        out[at++] = *p;
    }
    if (at + 2 >= cap) return -1;
    out[at++] = L'"';
    out[at] = 0;
    return at;
}

/* The rest of our own command line after the program name, as ssh wrote it. */
static const wchar_t *argsAfterProgram(const wchar_t *cl)
{
    if (*cl == L'"') {
        cl++;
        while (*cl && *cl != L'"') cl++;
        if (*cl) cl++;
    } else {
        while (*cl && *cl != L' ' && *cl != L'\t') cl++;
    }
    while (*cl == L' ' || *cl == L'\t') cl++;
    return cl;
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR unused, int show)
{
    (void)inst; (void)prev; (void)unused; (void)show;
    static wchar_t node[32768], script[32768], cmd[65536];
    if (!GetEnvironmentVariableW(L"VP_ASKPASS_NODE", node, 32768) ||
        !GetEnvironmentVariableW(L"VP_ASKPASS_SCRIPT", script, 32768))
        return 1;
    int at = appendQuoted(cmd, 0, 65536, node);
    if (at < 0 || at + 1 >= 65536) return 1;
    cmd[at++] = L' ';
    at = appendQuoted(cmd, at, 65536, script);
    if (at < 0) return 1;
    const wchar_t *rest = argsAfterProgram(GetCommandLineW());
    if (*rest) {
        if (at + 1 + lstrlenW(rest) + 1 >= 65536) return 1;
        cmd[at++] = L' ';
        lstrcpyW(cmd + at, rest);
    }
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof si);
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi))
        return 1;
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}
