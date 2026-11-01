import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { clipboard, dialog, safeStorage } from 'electron';
import { credentialDomain, credentialMatchesPage, credentialOrigin, CredentialStore, type Cipher, type Credential, type ImportResult } from '@aether/storage';
import type { Shell } from './shell';
import type { BrowserWindowController } from './window';

/** Google's own export page; it asks for the Google password before exporting. */
export const GOOGLE_PASSWORDS_URL = 'https://passwords.google.com/options';
const CLIPBOARD_CLEAR_MS = 30_000;
const MAX_CSV_BYTES = 10 * 1024 * 1024;
// Separate from the scroll world (1001) so page-fill code never shares globals.
const FILL_WORLD = 1002;

const osCipher: Cipher = {
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64')),
};

/** Fills the first visible password field and the username field before it. Runs in an isolated world. */
function fillScript(username: string, password: string): string {
  return `(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly; };
    const setValue = (el, value) => {
      el.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const pw = inputs.find((el) => el.type === 'password');
    const userTypes = ['text', 'email', 'tel', ''];
    let user = null;
    const scope = pw ? inputs.slice(0, inputs.indexOf(pw)) : inputs;
    for (let i = scope.length - 1; i >= 0; i--) if (userTypes.includes(scope[i].type) || scope[i].autocomplete === 'username') { user = scope[i]; break; }
    const username = ${JSON.stringify(username)};
    if (user && username) setValue(user, username);
    if (pw) setValue(pw, ${JSON.stringify(password)});
    return { user: !!(user && username), password: !!pw };
  })()`;
}

export interface PasswordSummary extends Credential {
  /** True when this login belongs to the active tab's site. */
  matchesActive: boolean;
}

/**
 * Saved sign-ins for a profile, encrypted with the OS keychain (DPAPI on
 * Windows). Passwords are only decrypted to copy, reveal, fill a matching
 * page, or export at the user's request; they never go to web content of
 * another site and never into private windows.
 */
export class PasswordManager {
  readonly store: CredentialStore;
  private clipboardTimer: NodeJS.Timeout | null = null;
  /** Download paths already offered for import, so each is offered once. */
  private offered = new Set<string>();

  constructor(private shell: Shell) {
    this.store = new CredentialStore(shell.store.db, osCipher);
  }

  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  private guard(w: BrowserWindowController): void {
    if (w.isPrivate) throw new Error('Saved passwords are not available in private windows');
    if (!this.available) throw new Error('This system offers no OS encryption, so AETHER will not store passwords');
  }

  /** Number of saved logins for a page; drives the toolbar key icon. */
  countForPage(profileId: string, url: string): number {
    if (!/^https?:/i.test(url)) return 0;
    try {
      return this.store.forPage(profileId, url).length;
    } catch {
      return 0;
    }
  }

  list(w: BrowserWindowController, query?: string): { available: boolean; items: PasswordSummary[]; total: number } {
    if (w.isPrivate) return { available: false, items: [], total: 0 };
    const activeUrl = w.activeTab?.url ?? '';
    const items = this.store.list(w.profileId, query || undefined).map((c) => ({ ...c, matchesActive: !!activeUrl && credentialMatchesPage(c, activeUrl) }));
    items.sort((a, b) => Number(b.matchesActive) - Number(a.matchesActive));
    return { available: this.available, items, total: this.store.count(w.profileId) };
  }

  add(w: BrowserWindowController, input: { url: string; username: string; password: string; note?: string }): number {
    this.guard(w);
    const r = this.store.upsert(w.profileId, { ...input, source: 'manual' });
    w.changed();
    return r.id;
  }

  update(w: BrowserWindowController, id: number, patch: { username?: string; password?: string; note?: string }): void {
    this.guard(w);
    this.store.update(w.profileId, id, patch);
  }

  delete(w: BrowserWindowController, id: number): void {
    this.store.delete(w.profileId, id);
    w.changed();
  }

  reveal(w: BrowserWindowController, id: number): string {
    this.guard(w);
    const pw = this.store.reveal(w.profileId, id);
    if (pw === null) throw new Error('Saved login not found');
    return pw;
  }

  /** Copies the password (or username) and clears the clipboard after 30 s if it still holds it. */
  copy(w: BrowserWindowController, id: number, field: 'password' | 'username'): void {
    this.guard(w);
    const cred = this.store.get(w.profileId, id);
    if (!cred) throw new Error('Saved login not found');
    const value = field === 'username' ? cred.username : this.reveal(w, id);
    clipboard.writeText(value);
    if (field === 'password') {
      this.store.markUsed(w.profileId, id);
      if (this.clipboardTimer) clearTimeout(this.clipboardTimer);
      this.clipboardTimer = setTimeout(() => {
        if (clipboard.readText() === value) clipboard.clear();
        this.clipboardTimer = null;
      }, CLIPBOARD_CLEAR_MS);
    }
  }

  /** Fills a login into the active tab, only if that tab is on the login's site right now. */
  async fill(w: BrowserWindowController, id: number): Promise<{ user: boolean; password: boolean }> {
    this.guard(w);
    const cred = this.store.get(w.profileId, id);
    const tab = w.activeTab;
    const wc = tab?.wc;
    if (!cred || !wc || wc.isDestroyed()) throw new Error('Nothing to fill');
    // Checked against the committed URL immediately before injecting.
    if (!credentialMatchesPage(cred, wc.getURL())) throw new Error(`This login is for ${cred.domain}, not this page`);
    const password = this.store.reveal(w.profileId, id)!;
    const result = (await wc.executeJavaScriptInIsolatedWorld(FILL_WORLD, [{ code: fillScript(cred.username, password) }], false)) as { user: boolean; password: boolean };
    if (result?.password) this.store.markUsed(w.profileId, id);
    return result ?? { user: false, password: false };
  }

  async importFromFile(w: BrowserWindowController, path?: string): Promise<(ImportResult & { file: string }) | null> {
    this.guard(w);
    if (!path) {
      const r = await dialog.showOpenDialog(w.win, {
        title: 'Import passwords from a CSV export',
        properties: ['openFile'],
        filters: [{ name: 'Password export (CSV)', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      path = r.filePaths[0];
    }
    const info = await stat(path);
    if (info.size > MAX_CSV_BYTES) throw new Error('That file is too large to be a password export');
    const text = await readFile(path, 'utf8');
    const result = this.store.importCsv(w.profileId, text, /google/i.test(basename(path)) ? 'google' : 'csv');
    w.changed();
    if (result.added + result.updated + result.unchanged > 0) await this.offerDelete(w, path);
    return { ...result, file: basename(path) };
  }

  /** The CSV holds every password in plain text; offer to delete it once imported. */
  private async offerDelete(w: BrowserWindowController, path: string): Promise<void> {
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'warning',
      message: 'Delete the exported CSV file?',
      detail: `${basename(path)} contains your passwords in plain text. They are now stored encrypted in AETHER, so the file is no longer needed.`,
      buttons: ['Delete file', 'Keep it'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await rm(path, { force: true }).catch(() => w.send('toast', { kind: 'error', text: 'Could not delete the CSV file. Please delete it yourself.' }));
  }

  async exportToFile(w: BrowserWindowController): Promise<boolean> {
    this.guard(w);
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'warning',
      message: 'Export passwords as plain text?',
      detail: 'Anyone who can open the exported file can read every password in it. Keep it somewhere safe and delete it when you are done.',
      buttons: ['Export', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    const { filePath, canceled } = await dialog.showSaveDialog(w.win, { defaultPath: 'AETHER Passwords.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (canceled || !filePath) return false;
    await writeFile(filePath, this.store.exportCsv(w.profileId), { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  private neverKey = (profileId: string) => `passwords:never:${profileId}`;

  /** A page form was submitted with a password: offer to save or update it (never silently). */
  offerFromSubmit(w: BrowserWindowController, tabId: number, url: string, username: string, password: string): void {
    if (w.isPrivate || !this.available || !/^https?:/i.test(url) || !password) return;
    const site = credentialDomain(credentialOrigin(url) ?? '');
    if (this.shell.store.getSetting<string[]>(this.neverKey(w.profileId), []).includes(site)) return;
    const existing = this.store.forPage(w.profileId, url).filter((c) => c.username === username);
    if (existing.some((c) => this.store.reveal(w.profileId, c.id) === password)) return;
    w.loginOffer = { tabId, url, site, username, password, update: existing.length > 0, at: Date.now() };
    w.changed();
  }

  respondToOffer(w: BrowserWindowController, action: 'save' | 'never' | 'dismiss'): void {
    const offer = w.loginOffer;
    w.loginOffer = null;
    if (!offer) return;
    if (action === 'save') {
      this.guard(w);
      this.store.upsert(w.profileId, { url: offer.url, username: offer.username, password: offer.password, source: 'manual' });
    } else if (action === 'never') {
      const key = this.neverKey(w.profileId);
      const list = this.shell.store.getSetting<string[]>(key, []);
      if (!list.includes(offer.site)) this.shell.store.setSetting(key, [...list, offer.site].slice(-500));
    }
    w.changed();
  }

  /** Step 1 of "Import from Google": opens Google's export page in this profile (sign-in happens there). */
  openGoogleExport(w: BrowserWindowController): void {
    this.guard(w);
    w.openTab(GOOGLE_PASSWORDS_URL, { source: 'omnibox' });
  }

  /** A finished download that looks like a password export: offer to import it right away. */
  async downloadCompleted(profileId: string, isPrivate: boolean, path: string): Promise<void> {
    if (isPrivate || !this.available || this.offered.has(path)) return;
    if (!/passwords?.*\.csv$/i.test(basename(path))) return;
    this.offered.add(path);
    const w = [...this.shell.windows.values()].find((x) => x.profileId === profileId && !x.isPrivate && x.win.isFocused()) ?? [...this.shell.windows.values()].find((x) => x.profileId === profileId && !x.isPrivate);
    if (!w) return;
    const { response } = await dialog.showMessageBox(w.win, {
      type: 'question',
      message: 'Import these passwords into AETHER?',
      detail: `${basename(path)} looks like a password export. AETHER can import it into this profile, encrypted with your OS account.`,
      buttons: ['Import', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return;
    try {
      const r = await this.importFromFile(w, path);
      if (r) w.send('toast', { kind: 'info', text: `Imported ${r.added} new and ${r.updated} updated logins${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.` });
    } catch (err) {
      w.send('toast', { kind: 'error', text: err instanceof Error ? err.message : 'Import failed' });
    }
  }
}
