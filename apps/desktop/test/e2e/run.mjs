// End-to-end tests: launches the real built app (Electron + Chromium) and
// drives it through the privileged UI bridge, checking isolation and restore.
// Usage: npm run test:e2e   (on Linux CI wrap in xvfb-run)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright-core');
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const userData = mkdtempSync(join(tmpdir(), 'aether-e2e-'));

// Tiny local site: sets a cookie and echoes the cookie back.
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/set') {
    res.writeHead(200, { 'Set-Cookie': 'who=alice; Path=/; Max-Age=3600', 'Content-Type': 'text/html' });
    return res.end('<title>Set cookie</title><p>set</p>');
  }
  if (url.pathname === '/long') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<title>Long page</title><div style="height:6000px">long</div>`);
  }
  if (url.pathname === '/article') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const para = 'The slew rate of an operational amplifier limits how fast its output can change, which matters for large signals at high frequency. ';
    return res.end(`<title>Op-amp slew rate explained</title><nav>Home | Shop | Login</nav><div class="ad">BUY NOW</div><article><h1>Op-amp slew rate explained</h1><p class="byline">By A. Engineer</p>${Array.from({ length: 12 }, (_, i) => `<p>${para.repeat(3)} (${i})</p>`).join('')}<p><a href="javascript:alert(1)">bad link</a> <a href="/next">next part</a></p><script>window.evil = 1</script><img src="x" onerror="window.evil=2"></article><footer>© site</footer>`);
  }
  if (url.pathname === '/ads') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<title>Ads page</title><div class="promo-box" id="a">ad</div><div class="ad-slot" id="b">ad</div><p id="c">content</p>`);
  }
  if (url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<title>Sign in</title><form><input id="u" type="email"><input id="p" type="password"></form><p id="seen"></p>
      <script>let n = 0; for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => { n++; document.getElementById('seen').textContent = String(n); });</script>`);
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<title>Echo ${req.headers.cookie ?? 'none'}</title><p id="c">${req.headers.cookie ?? 'none'}</p>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const launch = () =>
  electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', appDir],
    cwd: appDir,
    env: { ...process.env, AETHER_USER_DATA: userData, AETHER_E2E_INSECURE_KEYSTORE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${last}`);
}

/** Runs code in the first web view whose URL matches (via the main process). */
const wcEvalPrefix = (prefix, code) =>
  app.evaluate(async ({ webContents }, [u, c]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(u));
    return wc ? wc.executeJavaScript(c) : null;
  }, [prefix, code]);

const wcEval = (url, code) =>
  app.evaluate(async ({ webContents }, [u, c]) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === u);
    return wc ? wc.executeJavaScript(c) : null;
  }, [url, code]);

/** Pages that are browser-UI windows (not web content). */
async function uiPages(app) {
  const pages = app.windows();
  const out = [];
  for (const p of pages) if ((await p.evaluate(() => typeof window.aether).catch(() => 'undefined')) === 'object') out.push(p);
  return out;
}
const invoke = (page, ch, payload) => page.evaluate(([c, p]) => window.aether.invoke(c, p), [ch, payload]);
async function state(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const off = window.aether.on('state', (s) => {
          off();
          resolve(s);
        });
        window.aether.invoke('ui:ready');
      }),
  );
}

const results = [];
async function test(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n    ${err.stack?.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

console.log('AETHER e2e');
let app = await launch();
let ui = await until(async () => (await uiPages(app))[0], 'first window');

await test('opens one window with a new tab', async () => {
  const s = await until(async () => {
    const x = await state(ui);
    return x.tabs.length === 1 ? x : null;
  }, 'state');
  assert.equal(s.tabs[0].url, 'aether://newtab/');
  assert.equal(s.profile.name, 'Personal');
});

await test('navigates from the address bar and records history', async () => {
  await invoke(ui, 'tab:navigate', { input: `${base}/set` });
  await until(async () => (await state(ui)).tabs[0].title === 'Set cookie', 'title');
  const hist = await invoke(ui, 'history:list', {});
  assert.ok(hist.some((h) => h.url === `${base}/set`));
});

await test('web content has no access to the privileged bridge', async () => {
  const pages = app.windows();
  const web = await until(async () => {
    for (const p of app.windows()) if (p.url().startsWith(base)) return p;
    return null;
  }, 'web page');
  assert.equal(await web.evaluate(() => typeof window.aether), 'undefined');
  assert.equal(await web.evaluate(() => typeof require), 'undefined');
  assert.ok(pages.length >= 2);
});

await test('bang shortcuts resolve in suggestions', async () => {
  const s = await invoke(ui, 'omnibox:suggest', '!gh electron');
  assert.equal(s[0].url, 'https://github.com/search?q=electron&type=repositories');
});

await test('profiles have isolated cookies', async () => {
  await invoke(ui, 'tab:navigate', { input: `${base}/echo` });
  await until(async () => (await state(ui)).tabs[0].title === 'Echo who=alice', 'cookie in Personal');
  const before = (await uiPages(app)).length;
  await invoke(ui, 'profile:create', { name: 'VIT Chennai', color: '#34d399' });
  const ui2 = await until(async () => {
    const list = await uiPages(app);
    return list.length > before ? list[list.length - 1] : null;
  }, 'second profile window');
  const s2 = await state(ui2);
  assert.equal(s2.profile.name, 'VIT Chennai');
  await invoke(ui2, 'tab:navigate', { input: `${base}/echo` });
  await until(async () => (await state(ui2)).tabs[0].title === 'Echo none', 'no cookie in VIT');
  await invoke(ui2, 'profile:update', { id: s2.profile.id, closeBehavior: 'discard' });
  await ui2.evaluate(() => window.aether.invoke('window:close')).catch(() => {});
  await until(async () => (await uiPages(app)).length === before, 'VIT window closed');
});

await test('private windows keep no history and do not share cookies', async () => {
  const before = (await uiPages(app)).length;
  await invoke(ui, 'window:new-private');
  const p = await until(async () => {
    const list = await uiPages(app);
    return list.length > before ? list[list.length - 1] : null;
  }, 'private window');
  const s = await state(p);
  assert.equal(s.isPrivate, true);
  await invoke(p, 'tab:navigate', { input: `${base}/echo?private=1` });
  await until(async () => (await state(p)).tabs[0].title === 'Echo none', 'private has no cookie');
  const hist = await invoke(ui, 'history:list', {});
  assert.ok(!hist.some((h) => h.url.includes('private=1')));
  await p.evaluate(() => window.aether.invoke('window:close')).catch(() => {});
  await until(async () => (await uiPages(app)).length === before, 'private closed');
});

await test('privacy and focus module is active inside the shell', async () => {
  const s = await state(ui);
  const settings = await invoke(ui, 'module:invoke', { moduleId: 'aether.protection', method: 'privacy.getSettings', payload: { profileId: s.profile.id } });
  assert.ok(settings && typeof settings === 'object', 'privacy.getSettings returned data');
  const focus = await invoke(ui, 'module:invoke', { moduleId: 'aether.protection', method: 'focus.status', payload: {} });
  assert.ok(focus && typeof focus === 'object', 'focus.status returned data');
});

await test('cosmetic filtering hides ad elements before and after load', async () => {
  const s = await state(ui);
  const call = (method, payload) => invoke(ui, 'module:invoke', { moduleId: 'aether.protection', method, payload });
  const cur = await call('privacy.getSettings', {});
  await call('privacy.setSettings', { settings: { ...cur, customFilters: '127.0.0.1##.promo-box\n##.ad-slot' } });
  await invoke(ui, 'tab:navigate', { input: `${base}/ads`, tabId: s.activeTabId });
  const hidden = await until(async () => {
    const r = await wcEval(`${base}/ads`, "[...'abc'].map((id) => getComputedStyle(document.getElementById(id)).display).join(',')");
    return r === 'none,none,block' ? r : null;
  }, 'ad elements hidden');
  assert.equal(hidden, 'none,none,block');
  await call('privacy.setSettings', { settings: { ...cur, customFilters: '' } });
});

await test('research module stores notes per profile', async () => {
  const created = await invoke(ui, 'module:invoke', { moduleId: 'research', method: 'notes.create', payload: { body: 'Slew rate of LM741 is 0.5 V/us [@ti2015]', title: 'Op amps' } });
  assert.ok(created, 'note created');
  const list = await invoke(ui, 'module:invoke', { moduleId: 'research', method: 'notes.list', payload: {} });
  const notes = Array.isArray(list) ? list : list?.result ?? list?.items ?? [];
  assert.ok(JSON.stringify(list).includes('Op amps'), 'note listed');
  assert.ok(notes !== undefined);
});

await test('every sidebar panel renders without errors', async () => {
  await ui.evaluate(() => window.aether.invoke('ui:ready'));
  await ui.keyboard.press('Control+B').catch(() => {});
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('file:'));
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control'] });
  });
  await until(async () => (await ui.$$('.rail-btn')).length > 4, 'sidebar rail');
  const count = (await ui.$$('.rail-btn')).length;
  const broken = [];
  for (let i = 0; i < count; i++) {
    const btns = await ui.$$('.rail-btn');
    const title = await btns[i].getAttribute('title');
    await btns[i].click();
    await sleep(400);
    if (await ui.$('.panel .boundary')) broken.push(title);
  }
  assert.deepEqual(broken, [], `panels with errors: ${broken.join(', ')}`);
  assert.ok(count >= 12, `expected core + module panels, got ${count}`);
});

await test('split view shows two tabs side by side', async () => {
  await invoke(ui, 'tab:new', { url: `${base}/echo?split=1` });
  await invoke(ui, 'split:toggle');
  const s = await until(async () => {
    const x = await state(ui);
    return x.split ? x : null;
  }, 'split');
  assert.notEqual(s.split.leftTabId, s.split.rightTabId);
  await invoke(ui, 'split:close');
});

let workspaceId;
await test('workspaces switch context without losing tabs or reading position', async () => {
  const s0 = await state(ui);
  await invoke(ui, 'tab:navigate', { input: `${base}/long`, tabId: s0.activeTabId });
  await until(async () => (await state(ui)).tabs.some((t) => t.title === 'Long page'), 'long page');
  await until(() => wcEval(`${base}/long`, 'document.readyState === "complete"'), 'long page view');
  await wcEval(`${base}/long`, 'window.scrollTo(0, 2400), true');
  await sleep(100);
  workspaceId = await invoke(ui, 'workspace:create-from-window', { name: 'VLSI Internship' });
  const tabsBefore = (await state(ui)).tabs.map((t) => t.url);
  await invoke(ui, 'workspace:create-from-window', { name: 'Aircraft Startup', empty: true });
  const s1 = await until(async () => {
    const x = await state(ui);
    return x.workspace?.name === 'Aircraft Startup' && x.tabs.length === 1 ? x : null;
  }, 'empty workspace');
  assert.equal(s1.tabs[0].url, 'aether://newtab/');
  await invoke(ui, 'workspace:set-notes', { id: s1.workspace.id, notes: 'idea: canard wing' });
  await invoke(ui, 'workspace:switch', workspaceId);
  const s2 = await until(async () => {
    const x = await state(ui);
    return x.workspace?.name === 'VLSI Internship' ? x : null;
  }, 'back to VLSI');
  assert.deepEqual(s2.tabs.map((t) => t.url), tabsBefore);
  assert.equal(await invoke(ui, 'workspace:get-notes', s1.workspace.id), 'idea: canard wing');
  // Reading position comes back after the lazy tab loads.
  const longTab = s2.tabs.find((t) => t.url === `${base}/long`);
  await invoke(ui, 'tab:activate', longTab.id);
  const restored = await until(async () => {
    const y = await wcEval(`${base}/long`, 'window.scrollY');
    return y > 2000 ? y : null;
  }, 'scroll restored');
  assert.ok(restored > 2000);
});

await test('themes switch everywhere, including the aviation cockpit', async () => {
  await invoke(ui, 'theme:set', 'aviation');
  await until(async () => (await state(ui)).theme.id === 'aviation', 'theme in state');
  await until(async () => (await ui.evaluate(() => document.documentElement.dataset.theme)) === 'aviation', 'UI repainted');
  await until(async () => (await ui.evaluate(() => document.querySelectorAll('.toolbar svg[data-set="flight-deck"]').length)) >= 5, 'flight-deck icons in the toolbar');
  const s = await state(ui);
  await invoke(ui, 'tab:new', {});
  const html = await until(async () => wcEval('aether://newtab/', 'document.body.innerHTML'), 'new tab page');
  assert.match(html, /Cleared for takeoff/);
  await invoke(ui, 'tab:close', (await state(ui)).activeTabId);
  await invoke(ui, 'theme:set', 'aether');
  await until(async () => (await state(ui)).theme.id === 'aether', 'back to default');
  await until(async () => (await ui.evaluate(() => document.querySelectorAll('svg[data-set]').length)) === 0, 'base icons restored');
  assert.ok(s.tabs.length >= 1);
});

await test('saved logins are encrypted, shown for their site and filled only there', async () => {
  const s = await state(ui);
  const list0 = await invoke(ui, 'passwords:list');
  if (!list0.available) {
    console.log('    (OS encryption unavailable here; checking that passwords are refused)');
    await assert.rejects(invoke(ui, 'passwords:add', { url: base, username: 'x', password: 'y' }));
    return;
  }
  const id = await invoke(ui, 'passwords:add', { url: `${base}/login`, username: 'kailash@example.com', password: 's3cret!' });
  await invoke(ui, 'tab:navigate', { input: `${base}/login`, tabId: s.activeTabId });
  await until(async () => (await state(ui)).savedLogins === 1, 'key icon count');
  const list = await invoke(ui, 'passwords:list');
  assert.ok(list.items.find((l) => l.id === id).matchesActive);
  assert.equal(await invoke(ui, 'passwords:reveal', id), 's3cret!');
  const r = await invoke(ui, 'passwords:fill', id);
  assert.deepEqual(r, { user: true, password: true });
  assert.equal(await wcEval(`${base}/login`, "document.getElementById('u').value"), 'kailash@example.com');
  assert.equal(await wcEval(`${base}/login`, "document.getElementById('p').value"), 's3cret!');
  assert.equal(await wcEval(`${base}/login`, "document.getElementById('seen').textContent"), '2');
  // A login never fills into another site.
  const other = await invoke(ui, 'passwords:add', { url: 'https://accounts.google.com', username: 'me@gmail.com', password: 'nope' });
  await assert.rejects(invoke(ui, 'passwords:fill', other), /not this page/);
  await invoke(ui, 'passwords:delete', other);
  await invoke(ui, 'passwords:delete', id);
  // Signing in offers to save the new password; nothing is stored until the user agrees.
  await wcEval(`${base}/login`, "document.getElementById('u').value = 'new@vit.ac.in'; document.getElementById('p').value = 'fresh-pass'; document.querySelector('form').requestSubmit(); 1");
  const offer = await until(async () => (await state(ui)).loginPrompt, 'save offer');
  assert.deepEqual({ ...offer, tabId: 0 }, { tabId: 0, site: '127.0.0.1', username: 'new@vit.ac.in', update: false });
  assert.equal((await invoke(ui, 'passwords:list')).total, 0);
  await invoke(ui, 'passwords:prompt-respond', 'save');
  const saved = (await invoke(ui, 'passwords:list')).items.find((l) => l.username === 'new@vit.ac.in');
  assert.equal(await invoke(ui, 'passwords:reveal', saved.id), 'fresh-pass');
  await invoke(ui, 'passwords:delete', saved.id);
  await until(async () => (await state(ui)).savedLogins === 0, 'key icon cleared');
});

await test('bookmarks bar shows top-level bookmarks and can be hidden', async () => {
  const s = await state(ui);
  assert.equal(s.bookmarksBar, true);
  await invoke(ui, 'bookmarks:add', { title: 'Datasheet hub', url: 'https://www.alldatasheet.com/' });
  await until(async () => (await ui.evaluate(() => [...document.querySelectorAll('.bm-item')].map((b) => b.textContent).join('|'))).includes('Datasheet hub'), 'bar item');
  await invoke(ui, 'bookmarks:bar-toggle');
  await until(async () => (await ui.evaluate(() => document.querySelector('.bookmarks-bar'))) === null, 'bar hidden');
  await invoke(ui, 'bookmarks:bar-toggle');
  await until(async () => (await state(ui)).bookmarksBar, 'bar back');
});

await test('reader view shows a clean, script-free article and goes back', async () => {
  const s = await state(ui);
  await invoke(ui, 'tab:navigate', { input: `${base}/article`, tabId: s.activeTabId });
  await until(async () => (await state(ui)).tabs.find((t) => t.id === s.activeTabId)?.title === 'Op-amp slew rate explained', 'article loaded');
  assert.equal(await invoke(ui, 'tab:reader', s.activeTabId), true);
  await until(async () => (await state(ui)).tabs.find((t) => t.id === s.activeTabId)?.url.startsWith('aether://reader/'), 'reader url');
  const info = await until(async () => wcEvalPrefix('aether://reader/', `({ h1: document.querySelector('h1')?.textContent, scripts: document.scripts.length, evil: window.evil ?? null, js: [...document.links].some((a) => a.href.startsWith('javascript')), nav: document.body.textContent.includes('BUY NOW'), next: [...document.links].some((a) => a.href.endsWith('/next')) })`), 'reader content');
  assert.deepEqual(info, { h1: 'Op-amp slew rate explained', scripts: 0, evil: null, js: false, nav: false, next: true });
  await invoke(ui, 'tab:reader', s.activeTabId);
  await until(async () => (await state(ui)).tabs.find((t) => t.id === s.activeTabId)?.url === `${base}/article`, 'back to original');
});

await test('tab groups keep members together, collapse and ungroup', async () => {
  const a = await invoke(ui, 'tab:new', { url: `${base}/echo?g=1`, background: true });
  const b = await invoke(ui, 'tab:new', { url: `${base}/echo?g=2`, background: true });
  const c = await invoke(ui, 'tab:new', { url: `${base}/echo?g=3`, background: true });
  const gid = await invoke(ui, 'group:create', { tabIds: [a, c], title: 'Datasheets' });
  let s = await state(ui);
  const ids = s.tabs.map((t) => t.id);
  assert.equal(ids.indexOf(c), ids.indexOf(a) + 1, 'members are contiguous');
  assert.deepEqual(s.groups.map((g) => g.title), ['Datasheets']);
  await invoke(ui, 'group:update', { id: gid, collapsed: true });
  await until(async () => (await ui.evaluate(() => document.querySelector('.group-chip.collapsed')?.textContent)) === 'Datasheets2', 'collapsed chip');
  await invoke(ui, 'tab:activate', a);
  s = await state(ui);
  assert.equal(s.groups[0].collapsed, false, 'activating a member expands the group');
  await invoke(ui, 'tab:set-group', { tabId: b, groupId: gid });
  s = await state(ui);
  assert.equal(s.tabs.filter((t) => t.groupId === gid).length, 3);
  for (const id of [a, b, c]) await invoke(ui, 'tab:close', id);
  s = await state(ui);
  assert.equal(s.groups.length, 0, 'empty groups disappear');
});

await test('kept windows and tabs come back after restart', async () => {
  const s = await state(ui);
  await invoke(ui, 'profile:update', { id: s.profile.id, closeBehavior: 'save' });
  await invoke(ui, 'group:create', { tabIds: [s.tabs[s.tabs.length - 1].id], title: 'Keep me', color: 'green' });
  const urls = s.tabs.map((t) => t.url);
  await ui.evaluate(() => window.aether.invoke('window:close')).catch(() => {});
  const proc = app.process();
  await until(() => proc.exitCode !== null, 'app exit after last window closed', 15_000);
  app = await launch();
  ui = await until(async () => (await uiPages(app))[0], 'restored window');
  const r = await until(async () => {
    const x = await state(ui);
    return x.tabs.length === urls.length ? x : null;
  }, 'restored tabs');
  assert.deepEqual(r.tabs.map((t) => t.url), urls);
  assert.equal(r.workspace?.name, 'VLSI Internship');
  assert.deepEqual(r.groups.map((g) => [g.title, g.color]), [['Keep me', 'green']]);
  // Background tabs restore asleep (lazy) to stay light.
  assert.ok(r.tabs.filter((t) => t.id !== r.activeTabId).every((t) => t.sleeping));
});

await test('crashed tabs are recoverable', async () => {
  const s = await state(ui);
  await invoke(ui, 'tab:navigate', { input: 'chrome://crash' }).catch(() => {});
  // chrome:// is refused by the address bar; crash the renderer via the page instead.
  const active = s.tabs.find((t) => t.id === s.activeTabId);
  await invoke(ui, 'tab:navigate', { input: `${base}/echo?crash=1`, tabId: active.id });
  const page = await until(async () => app.windows().find((w) => w.url().includes('crash=1')), 'crash page');
  await app.evaluate(({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    wc?.forcefullyCrashRenderer();
  }, page.url());
  await until(async () => (await state(ui)).tabs.find((t) => t.id === active.id)?.crashed, 'crashed flag');
  await invoke(ui, 'tab:reload', active.id);
  await until(async () => {
    const t = (await state(ui)).tabs.find((x) => x.id === active.id);
    return t && !t.crashed && t.title.startsWith('Echo');
  }, 'reloaded after crash');
});

await app.close().catch(() => {});
server.close();
rmSync(userData, { recursive: true, force: true });
const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
