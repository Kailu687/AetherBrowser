## AETHER 0.4.0 — Writer + Research & Writing

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
