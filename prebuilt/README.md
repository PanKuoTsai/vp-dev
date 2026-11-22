# Prebuilt programs

Programs that are committed as binaries because the machine that needs them
cannot build them. Everything else VP Studio uses is built from source on the
user's machine (`tools/`).

| File | Source | Built with | Used by |
|---|---|---|---|
| `win32/vp-askpass.exe` | `tools/askpass/vp-askpass.c` | `tools/askpass/build.sh` (mingw-w64, on Linux) | `lib/sim/askpass.js`: the SSH_ASKPASS program on Windows, where OpenSSH starts only `.exe` files |

`SHA256SUMS` holds the hash of each file. `tools/askpass/build.sh` rewrites it
when it rebuilds the program, and the tests check that the committed program
matches it (`test/remote.test.js`).

```sh
cd prebuilt && sha256sum -c SHA256SUMS
```

The hash shows that the file is the one that was committed with this list. It
does not show that the file was built from the source: the build is not
reproducible bit for bit across compiler versions. To be sure of that, rebuild
it with `tools/askpass/build.sh` and commit the result.
