# 第三方授權聲明（THIRD_PARTY_NOTICES）

本 repo 以 [MIT](LICENSE) 授權。下列檔案含有改寫自第三方 MIT 授權專案的程式碼，依 MIT
條款附上原始版權與許可聲明。`core/vendor/` 內的檔案由主專案
[open-4wd](https://github.com/xjustloveux/open-4wd)（MIT）同步而來，來源路徑與 SHA-256 見
[core/vendor/MANIFEST.json](core/vendor/MANIFEST.json)。

## @orbitdb/core

- 受影響檔案：`core/vendor/ledger/bounded-sync.ts`（Sync 骨架改寫自 `src/sync.js`）、
  `core/vendor/ledger/bounded-events-database.ts`（`collectReferences` 改寫自
  `src/oplog/log.js` 的 `getReferences`）。
- 上游：<https://github.com/orbitdb/orbitdb>，版本 4.0.0，授權 MIT。

```text
The MIT License (MIT)

Copyright (c) 2015-2018 Protocol Labs Inc.
Copyright (c) 2018 Haja Networks Oy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
