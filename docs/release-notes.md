## AETHER 0.5.0 — Data Science & ML, powered by Epoch

Everything in 0.4.0 (the browser, the built-in offline Writer and the Research & Writing module), plus the second installable module: **Data Science & ML**, with **Epoch**, AETHER's own machine-learning engine. It trains models on your PC with no Python, no internet and no account.

### New: Data Science & ML module
Install it from the Workbench (▦ or Ctrl+Shift+Space → Module Store). It needs only two permissions: its own storage and files you pick. It makes no network connections.
- **Datasets.** Open CSV/TSV, JSON, JSON Lines or Parquet. See the inferred schema, missing values, distributions, duplicates, outliers and columns that look like personal data (emails, phone numbers, Aadhaar, PAN, card numbers, API keys).
- **Cleaning pipelines.** Filter, derive with a safe formula language, fill or drop missing values, deduplicate, scale, one-hot encode, group, sample, **k-means clustering** and **PCA**. Preview, save as a new version (with its SHA-256 and every step recorded), and export the steps as pandas code.
- **Charts and comparison.** Histograms, bar, line, scatter and box plots, correlation matrices, and drift between two dataset versions.
- **Epoch ML trainer.** Ten model families: baseline, ridge and logistic regression, k-nearest neighbours, naive Bayes, decision tree, random forest, **gradient-boosted trees**, **neural networks (MLP)** and **linear SVM**. Binary, multi-class and regression targets; numeric, categorical and **free-text** columns (TF-IDF); balanced class weights for imbalanced data; training and validation curves with early stopping.
- **Honest evaluation.** Every run is checked for leakage first (target proxies, identifiers, rows on both sides of the split, group overlap), compared with a baseline and with its training score, and can use cross-validation and hyperparameter search on the training rows only. Permutation importance, worst predictions and per-group scores show where it fails.
- **Experiments.** Compare runs, write a report into the Writer, export or import a model (imported files are validated before use), predict new rows, and turn any run into a **scikit-learn script** to continue in Python.

### Limits
Epoch is for tabular and short-text data, up to 500,000 rows and 1,000 model inputs, on the CPU. It is not a deep-learning framework: no GPU, images, audio or transformer models. Python notebooks and local AI model management come in a later version.

### Install
Download `AETHER-Setup-0.5.0.exe` below and run it (Windows 10/11, 64-bit). It isn't code-signed yet, so Windows SmartScreen may warn you: choose **More info → Run anyway**. Check the download against the SHA-256 in `latest.json`.
