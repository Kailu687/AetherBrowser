# Third-party dependencies of @aether/module-data

| Package | Version | Licence | Why |
|---|---|---|---|
| hyparquet | 1.32.0 (pinned) | MIT | Reading Parquet files. Pure JavaScript, no native code, no network. Gzip, Brotli and Zstd pages are decompressed with Node's built-in `zlib`; Snappy is handled by hyparquet. |

Everything else (CSV/JSON parsing, statistics, the Epoch ML engine, k-means, PCA, charts) is written in this package in TypeScript. React is a peer dependency provided by the app.

Nothing in this module opens network connections; its manifest declares `network: 'none'`.
