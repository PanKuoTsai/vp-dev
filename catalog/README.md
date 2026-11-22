# Component catalog

`qbox-catalog.json` is generated. Do not edit it: the next run overwrites it.

It lists the module types of the pinned QBox (`qbox.pin.json`) with their
ports, parameters and constructor arguments. VP Studio checks platforms
against it and fills the Add Module and parameter forms from it.

Regenerate it when the pinned QBox commit or its patches change:

```sh
tools/qbox-catalog/build.sh <qbox>/build
tools/qbox-catalog/qbox-catalog --qbox-src <qbox> --libdir <qbox>/build \
    --out catalog/qbox-catalog.json
```

`tools/qbox-pin/build-qbox.sh` does the same as part of building the pinned
QBox. The details are in `tools/qbox-catalog/README.md`.

The file records where it came from, in `qbox`: the commit, whether the QBox
tree had changes (`dirty`, which is true for a QBox with VP Studio's patches)
and the build folder it read. `VP Studio: Check QBox Version` and the tests
compare that commit with the pin.

Descriptions written by hand are elsewhere: the register descriptions in
`registers/`, the tool's hints in `tools/qbox-catalog/hints.json`.
