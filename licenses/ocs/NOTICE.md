# OCS source integration

OCS Desktop v2.12.0 — Copyright © 2021 enncy.
Repository: https://github.com/ocsjs/ocs-desktop
Commit: 7e29272a3bdab0c84cb30ebc5935f1c3758ac52b
Source archive: https://codeload.github.com/ocsjs/ocs-desktop/zip/7e29272a3bdab0c84cb30ebc5935f1c3758ac52b
Source ZIP SHA-256: 1111f492c0772157df1ca28b5804b2f2747b8af2a7c5d069fc0e488cfdef7a50

The complete, pinned 162-file source tree is retained at vendor/ocs/source in the source distribution. Its per-file SHA-256 and fixed origin are recorded in vendor/ocs/source-manifest.json and shipped at modules/ocs/source-manifest.json. Builds verify the source tree without rewriting it or substituting compiled release files. The original root package.json is preserved here as package.json; it declares MIT. No separate upstream LICENSE text was present in this pinned source tree. This notice does not invent a missing MIT license grant or replace the upstream declaration.

The adapted backend and user interface are compiled into the host application. The bundled application does not include or launch OCS Desktop.exe, its Electron application, or the upstream management window. The controlled browser is a separate browser process under modules/ocs/browser. No preinstalled extensions or user profiles are copied. Runtime npm dependency notices are collected separately under licenses/npm.

## Controlled browser notices

The verified OCS release browser is Google Chrome 137.0.7151.55. Original ABOUT is retained as Chrome-ABOUT and modules/ocs/browser/ABOUT. Chrome-credits.html is the actual chrome://credits/ DOM exported by this exact Chrome binary using a new isolated temporary profile; it contains 541 third-party component entries. It is not the Electron release's LICENSES.chromium.html. Embedded Chrome credits remain available in the unchanged browser resources. Browser and exported license file hashes are recorded in browser.json and verified before copying and installer packaging. Browser changes require reviewing and refreshing these matching license resources explicitly.

Google Chrome: Copyright 2025 Google LLC. All rights reserved. Chrome is made possible by the Chromium open source project and other open source software. See the original ABOUT, chrome://credits and chrome://terms. This notice does not assert that Google Chrome itself is MIT-licensed.

