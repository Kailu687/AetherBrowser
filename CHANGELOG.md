# Changelog

All notable changes to AETHER. Versions match `apps/desktop/package.json` and the installer name.

## 0.5.0 (2026-11-03)
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

## 0.4.0 (2026-11-01)
A privacy-first, local-first browser for engineering and research, now with a built-in **offline Writer** and the first installable module, **Research & Writing**.

### New
- **Writer (built in, works offline).** A real document editor for papers and reports, not a Markdown box: styles, fonts and sizes, indent and first-line indent, line spacing, lists, tables, images, equations (KaTeX), page breaks, find and replace, an outline, version history and autosave. Templates: IEEE paper, APA paper, literature review, lab report, project report, thesis, letter.
  - Citations from your library with a bibliography in IEEE, APA, MLA or Chicago.
  - Import .docx, .md, .txt and .html. Export to Word (.docx), PDF, LaTeX (+ .bib), Markdown and HTML. Word layout compatibility is good for normal documents but not guaranteed for complex ones.
  - **Writing Intelligence:** suggestions you accept or reject one by one (structure, missing evidence, clarity, style, formatting), and an **AI-writing check** that only reports signals. AETHER never "humanizes" text to evade detectors; write it, cite it, and disclose AI help where required.
- **Module Store and Research & Writing module.** Install it from the Workbench (the ▦ button or Ctrl+Shift+Space). It adds a literature review workspace (research questions, screening, evidence matrix, review outlines sent to the Writer), reference verification that flags missing or suspicious citations instead of inventing details, an offline library and an opt-in reading trail. You approve each permission before it installs, and you can turn it off or remove it any time.
- **Workbench:** apps open over the page or side by side with it (split view).
- **Google account (optional, setup needed):** Settings → Google account. Sign-in happens in your normal browser, using your own Google OAuth client ID, and the token is encrypted on your PC. Bookmarks and settings can sync through a hidden AETHER folder in your Drive. Passwords, history and cookies are never uploaded.

### Security
- Modules get a scoped host: their own database, an allow-list of network hosts (checked on every redirect), no access to cookies, passwords, history or other modules' data, and per-program approval for anything they run. **Safe mode** (Module Store → Restart in safe mode) starts with every module off.

### Not in this release
Code, Projects and Engineering apps and the other modules (DS & ML, Electronics & ECE, Developer, Aerospace, Mechanical, Civil, Biotech, Math/Physics) are being finished and tested, and will ship in later versions.

### Install
Download `AETHER-Setup-0.4.0.exe` below and run it (Windows 10/11, 64-bit). It isn't code-signed yet, so Windows SmartScreen may warn you: choose **More info → Run anyway**. Check the download against the SHA-256 in `latest.json`.

## 0.3.2 (2026-10-31)

### Added
- **Per-site ad-block switches** in the Privacy panel: "Turn off ad-block scripts here" and "Turn off element hiding here". Request blocking stays on, so a site that breaks can keep most of its protection.
- Diagnostics: setting `AETHER_SKIP_SCRIPTLETS=<regex>` skips matching scriptlets, for finding the one that breaks a site.

### Known issue
- YouTube watch pages still don't fully load with ad blocking on (the player shows, but the title and related videos don't). This is being narrowed down. Workaround: Privacy panel → "Turn off ad-block scripts here" on youtube.com, or turn protection off for the site.

## 0.3.1 (2026-10-31)

### Fixed
- **Scriptlet clashes fixed** (this was the first YouTube problem; see 0.3.2 for what's left). AETHER ran the uBlock scriptlets in one shared scope, so their helper code collided (`Identifier 'JSONPath' has already been declared`) and broke YouTube's player and pages. Each scriptlet now runs in its own scope and can't take the page down if it fails.
- Settings: the "Show bookmarks bar" checkbox is laid out properly.

### Added
- **⋮ browser menu** in the toolbar, with:
  - New tab, new window and new private window.
  - History, downloads, bookmarks, passwords, and ad blocking and privacy.
  - Zoom, find, reader view and print.
  - Theme, settings, about and exit.
- **Theme button** (palette icon) in the toolbar for switching themes in one click. All themes are still in Settings → Theme too.

### Changed
- **Redesigned sidebar:**
  - Proper icons instead of emoji, and buttons grouped by feature with a clear marker for the open panel.
  - A taller panel header.
  - The Passwords panel has a clearer layout.
  - Friendly empty states in Passwords, Bookmarks, History and Downloads.

## 0.3.0 (2026-10-30)

### Added
- **Bookmarks bar** under the toolbar (Ctrl+Shift+B, or Settings → Appearance).
  - Folders open as menus, with "Open all".
  - Right-click to open in a new tab or window, or to delete.
- **Reader view** (book button, Ctrl+Alt+R or the page menu). It shows a clean, script-free version of the article, with larger or smaller text, serif or sans, and a link back to the original.
- **Tab groups:**
  - Right-click a tab and choose "Add tab to new group".
  - Name a group by double-clicking its label; click the label to collapse or expand it.
  - Right-click the label for colours, a new tab in the group, moving the group to a new window, ungrouping or closing it.
  - Groups are saved with windows and workspaces.
- **Save-password offer** after you sign in on a site: Save or Update, Never for this site, or Not now. Nothing is saved without your click.
- **Calculate a selection.** Select a formula such as `4.7k*2.2u` on any page and the right-click menu shows the answer, ready to copy.
- **Unpacked Chrome extensions (experimental)** per profile, in Settings → Extensions. Content scripts and background workers work; toolbar popups don't yet.
- **Aviation theme upgrade** (by the theme work):
  - An aircraft and spaceflight icon set across the toolbar and sidebar.
  - Lit push-button styling.
  - Star-field sidebar and new-tab sky with the Earth's limb.
  - Glareshield toolbar, compass headings on the title bar, a DEST prompt in the address bar, a propeller tab spinner and an aircraft taking off along the load bar.
  - New tab page with a heading indicator, a flight-mode annunciator strip and a faint airliner backdrop.
  - Themes can now ship their own icon sets.

## 0.2.0 (2026-10-30)

### Added
- **Windows installer** `AETHER-Setup-0.2.0.exe` (per-user, no admin). It adds desktop and Start menu shortcuts and lets you choose the install folder.
- **Local-folder updates.** When a newer `releases/latest.json` appears in the project folder, AETHER offers "Restart and update". It verifies the installer's SHA-256, installs silently and reopens with your windows restored.
- **Stronger ad blocking**, on by default:
  - Element hiding (cosmetic filters): site-specific rules at document start, plus generic rules matched to the page's classes and ids.
  - uBlock Origin scriptlets (YouTube and anti-adblock fixes).
  - New lists: uBlock quick fixes, filters 2023/2024, badware and resource abuse.
  - Your own `##` hiding rules work in custom filters.
- **Address-bar calculator with units.** Examples:
  - `= 3.3V / 470ohm in mA`
  - `12 kN*m to lbf*ft`
  - `1/(2*pi*10kohm*100nF)`
  - `255 to hex`, `-1 to hex16`, `0b1010 + 0x10`
  - `100 °C to °F`, `10k || 10k`

  Press Enter to copy the result.
- **Themes:** AETHER (default), Aviation (glass cockpit), Daylight, Midnight, Paper, High contrast and System. Choose one in Settings or the command palette.
- **Password manager** per profile, encrypted with your Windows account:
  - Fill on click for the matching site; copy with a 30-second clipboard clear.
  - Import from Google Password Manager, Chrome, Edge or Firefox CSV, then optionally delete the CSV.
  - Export.
  - Ctrl+Shift+L opens it.

### Changed
- The toolbar shows a key icon when the current site has saved logins.

## 0.1.0 (2026-10-29)

- First working browser shell (Electron 38 / Chromium 140):
  - Profiles with isolated storage; multiple windows; workspaces with notes and reading positions.
  - "Keep this window?" on close, with session restore.
  - Split view, private windows, bookmarks, history, downloads, find, zoom, print and the PDF viewer.
  - Bang shortcuts and the command palette.
  - Crash recovery and a memory saver.
- Modules:
  - Privacy (network ad and tracker blocking, HTTPS upgrade, tracking-parameter stripping, GPC).
  - Focus and time tracking.
  - Research: notes, citations, PDF annotations, calculators, paper writer.
