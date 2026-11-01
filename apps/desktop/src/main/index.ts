import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, Menu, protocol, safeStorage, session, shell as electronShell, type WebContents } from 'electron';
import { AetherStore } from '@aether/storage';
import { registerIpc } from './ipc';
import { LocalUpdater } from './updater';
import { MAIN_MODULES, addons, isSafeMode } from './modules';
import { INSTALLABLE } from './addon-modules';
import { Shell } from './shell';

// aether:// is a standard, secure scheme for internal pages.
protocol.registerSchemesAsPrivileged([{ scheme: 'aether', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } }]);

const isDev = !!process.env.AETHER_DEV_URL;
// Tests and portable builds can point user data somewhere else.
if (process.env.AETHER_USER_DATA) app.setPath('userData', process.env.AETHER_USER_DATA);

app.setAppUserModelId('dev.aether.browser');
// Lightweight defaults: no background throttling surprises, no Chromium sign-in prompts.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');

let logFile = '';
function log(level: string, args: unknown[]): void {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  } catch {
    /* never let logging crash the app */
  }
}
for (const level of ['info', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    log(level, args);
  };
}

// Crash-proofing: a bug in one handler must not take the whole browser down.
process.on('uncaughtException', (err) => console.error('[main] uncaught exception', err));
process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let shell: Shell | null = null;

  app.on('second-instance', (_e, argv) => {
    if (!shell) return;
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    const target = shell.lastFocused ?? [...shell.windows.values()][0];
    if (target) {
      if (url) target.openTab(url, { source: 'new-tab' });
      if (target.win.isMinimized()) target.win.restore();
      target.win.focus();
    } else {
      shell.openWindow({ profileId: shell.store.listProfiles()[0].id, tabs: url ? [{ url, title: '' }] : undefined });
    }
  });

  // Global WebContents hardening, applied to everything including popups.
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
    wc.on('select-bluetooth-device', (ev, _devices, cb) => {
      ev.preventDefault();
      cb('');
    });
  });

  app.whenReady().then(async () => {
    // Test hook for headless Linux CI that has no keyring. Never set in real use:
    // it makes safeStorage use Chromium's fixed fallback key.
    if (process.platform === 'linux' && process.env.AETHER_E2E_INSECURE_KEYSTORE === '1') safeStorage.setUsePlainTextEncryption(true);
    const userData = app.getPath('userData');
    mkdirSync(join(userData, 'logs'), { recursive: true });
    logFile = join(userData, 'logs', 'aether.log');
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);

    // The privileged UI's own session: it loads only app files, never the network.
    const uiSession = session.fromPartition('aether-ui');
    const uiUrl = isDev ? process.env.AETHER_DEV_URL! : pathToFileURL(join(__dirname, 'renderer', 'index.html')).toString();
    uiSession.webRequest.onBeforeRequest((details, cb) => {
      const ok = details.url.startsWith('file:') || details.url.startsWith('devtools:') || details.url.startsWith('data:') || (isDev && details.url.startsWith(new URL(uiUrl).origin)) || (isDev && details.url.startsWith('ws://localhost'));
      cb({ cancel: !ok });
    });
    uiSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

    let store: AetherStore;
    try {
      store = AetherStore.open(join(userData, 'aether.sqlite'));
    } catch (err) {
      console.error('[main] database open failed, starting with a fresh database', err);
      const { renameSync } = await import('node:fs');
      try {
        renameSync(join(userData, 'aether.sqlite'), join(userData, `aether.corrupt-${Date.now()}.sqlite`));
      } catch {
        /* nothing to move */
      }
      store = AetherStore.open(join(userData, 'aether.sqlite'));
    }

    shell = new Shell({ store, uiUrl, isDev, userDataDir: userData, iconPath: join(__dirname, 'icon.png') });
    registerIpc(shell);
    await shell.loadModules(MAIN_MODULES);
    // Safe mode: installable Modules' main code is not even activated.
    if (!isSafeMode()) await shell.loadInstallable(INSTALLABLE, (profileId, moduleId) => addons.broker.active(profileId, moduleId));
    shell.restoreOrOpen();
    const updater = new LocalUpdater(() => LocalUpdater.defaultDir(), () => shell?.lastFocused?.win ?? null);
    updater.start();

    const s = shell;
    let quitPrepared = false;
    app.on('before-quit', (e) => {
      if (quitPrepared) return;
      e.preventDefault();
      s.quitting = true;
      void s.prepareQuit().finally(() => {
        quitPrepared = true;
        store.close();
        app.quit();
      });
    });
    app.on('activate', () => {
      if (s.windows.size === 0) s.openProfile(s.store.listProfiles()[0].id);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // External protocols (mailto:, zoommtg:, ...) go to the OS, never silently.
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (ev, url) => {
      if (/^(mailto|tel):/i.test(url)) {
        ev.preventDefault();
        void electronShell.openExternal(url);
      }
    });
  });
}
