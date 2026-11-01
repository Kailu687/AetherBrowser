import { getDomain } from 'tldts';
import type { SqlDatabase } from '@aether/plugin-api';
import { transaction } from './db';

/** Encrypts secrets at rest. The desktop app supplies one backed by the OS keychain. */
export interface Cipher {
  encrypt(plain: string): string;
  decrypt(enc: string): string;
}

export interface Credential {
  id: number;
  origin: string;
  domain: string;
  username: string;
  title: string;
  note: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface CredentialInput {
  url: string;
  username: string;
  password: string;
  title?: string;
  note?: string;
  source?: string;
}

export interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: { line: number; reason: string }[];
}

/** Normalises a login URL to its origin; only http(s) and Android app links are kept. */
export function credentialOrigin(url: string): string | null {
  const raw = url.trim();
  if (/^android:\/\//i.test(raw)) return raw.split('/').slice(0, 3).join('/').toLowerCase();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Registrable domain ("eTLD+1") used to match a login to pages on sibling subdomains. */
export function credentialDomain(origin: string): string {
  if (origin.startsWith('android://')) return origin;
  try {
    const host = new URL(origin).hostname;
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  } catch {
    return origin;
  }
}

/**
 * Whether a saved login may be offered on a page. Same registrable domain
 * (accounts.google.com works on mail.google.com) and never from an https
 * login onto an http page.
 */
export function credentialMatchesPage(cred: { origin: string; domain: string }, pageUrl: string): boolean {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return false;
  if (cred.origin.startsWith('https:') && page.protocol === 'http:') return false;
  const pageDomain = getDomain(page.hostname, { allowPrivateDomains: true }) ?? page.hostname;
  return pageDomain === cred.domain;
}

// ---------------------------------------------------------------------------
// CSV (RFC 4180) for Google Password Manager / Chrome / Edge / Firefox exports
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export interface ParsedLogin {
  line: number;
  url: string;
  username: string;
  password: string;
  title: string;
  note: string;
}

/**
 * Reads a password export. Supports Google Password Manager / Chrome / Edge
 * (name,url,username,password,note) and Firefox (url,username,password,...).
 */
export function parseLoginCsv(text: string): { logins: ParsedLogin[]; skipped: { line: number; reason: string }[]; format: string } {
  const rows = parseCsv(text);
  const skipped: { line: number; reason: string }[] = [];
  if (!rows.length) return { logins: [], skipped: [{ line: 1, reason: 'The file is empty' }], format: 'unknown' };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iUrl = col('url', 'login_uri', 'website', 'web site');
  const iUser = col('username', 'login_username', 'user name', 'login');
  const iPass = col('password', 'login_password');
  const iName = col('name', 'title');
  const iNote = col('note', 'notes', 'extra');
  if (iUrl < 0 || iPass < 0) return { logins: [], skipped: [{ line: 1, reason: 'Not a password export: expected url and password columns' }], format: 'unknown' };
  const format = header.includes('httprealm') ? 'firefox' : header[0] === 'name' ? 'google-chrome' : 'generic';
  const logins: ParsedLogin[] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const url = (r[iUrl] ?? '').trim();
    const password = r[iPass] ?? '';
    if (!url) return skipped.push({ line, reason: 'No website' });
    if (!password) return skipped.push({ line, reason: 'No password' });
    logins.push({ line, url, username: iUser >= 0 ? (r[iUser] ?? '') : '', password, title: iName >= 0 ? (r[iName] ?? '') : '', note: iNote >= 0 ? (r[iNote] ?? '') : '' });
  });
  return { logins, skipped, format };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class CredentialStore {
  constructor(
    private db: SqlDatabase,
    private cipher: Cipher,
  ) {}

  private map = (r: any): Credential => ({
    id: r.id,
    origin: r.origin,
    domain: r.domain,
    username: r.username,
    title: r.title,
    note: r.note,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at ?? null,
  });

  list(profileId: string, query?: string): Credential[] {
    if (query) {
      const like = `%${query.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      return this.db
        .prepare(`SELECT * FROM credentials WHERE profile_id = ? AND (origin LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ORDER BY domain, username`)
        .all(profileId, like, like, like)
        .map(this.map);
    }
    return this.db.prepare('SELECT * FROM credentials WHERE profile_id = ? ORDER BY domain, username').all(profileId).map(this.map);
  }

  forPage(profileId: string, pageUrl: string): Credential[] {
    let host = '';
    try {
      host = new URL(pageUrl).hostname;
    } catch {
      return [];
    }
    const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;
    return this.db
      .prepare('SELECT * FROM credentials WHERE profile_id = ? AND domain = ? ORDER BY last_used_at DESC, updated_at DESC')
      .all(profileId, domain)
      .map(this.map)
      .filter((c) => credentialMatchesPage(c, pageUrl));
  }

  count(profileId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE profile_id = ?').get(profileId) as { n: number }).n;
  }

  get(profileId: string, id: number): Credential | null {
    const r = this.db.prepare('SELECT * FROM credentials WHERE profile_id = ? AND id = ?').get(profileId, id);
    return r ? this.map(r) : null;
  }

  /** Decrypts one password. Callers must only hand it to the user or a matching page. */
  reveal(profileId: string, id: number): string | null {
    const r = this.db.prepare('SELECT password_enc FROM credentials WHERE profile_id = ? AND id = ?').get(profileId, id) as { password_enc: string } | undefined;
    return r ? this.cipher.decrypt(r.password_enc) : null;
  }

  markUsed(profileId: string, id: number): void {
    this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE profile_id = ? AND id = ?').run(Date.now(), profileId, id);
  }

  /** Adds or updates (same site + username). Returns what happened. */
  upsert(profileId: string, input: CredentialInput): { id: number; result: 'added' | 'updated' | 'unchanged' } {
    const origin = credentialOrigin(input.url);
    if (!origin) throw new Error('Unsupported website address');
    const username = input.username.slice(0, 1024);
    if (!input.password || input.password.length > 4096) throw new Error('Password is empty or too long');
    const now = Date.now();
    const existing = this.db.prepare('SELECT id, password_enc, title, note FROM credentials WHERE profile_id = ? AND origin = ? AND username = ?').get(profileId, origin, username) as
      | { id: number; password_enc: string; title: string; note: string }
      | undefined;
    if (existing) {
      const same = this.cipher.decrypt(existing.password_enc) === input.password && (input.note ?? existing.note) === existing.note;
      if (same) return { id: existing.id, result: 'unchanged' };
      this.db
        .prepare('UPDATE credentials SET password_enc = ?, title = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(this.cipher.encrypt(input.password), (input.title ?? existing.title).slice(0, 200), (input.note ?? existing.note).slice(0, 4000), now, existing.id);
      return { id: existing.id, result: 'updated' };
    }
    const res = this.db
      .prepare('INSERT INTO credentials (profile_id, origin, domain, username, password_enc, title, note, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(profileId, origin, credentialDomain(origin), username, this.cipher.encrypt(input.password), (input.title ?? '').slice(0, 200), (input.note ?? '').slice(0, 4000), input.source ?? 'manual', now, now);
    return { id: Number(res.lastInsertRowid), result: 'added' };
  }

  update(profileId: string, id: number, patch: { username?: string; password?: string; note?: string }): void {
    const cur = this.get(profileId, id);
    if (!cur) throw new Error('Saved login not found');
    if (patch.username !== undefined) this.db.prepare('UPDATE credentials SET username = ?, updated_at = ? WHERE id = ?').run(patch.username.slice(0, 1024), Date.now(), id);
    if (patch.password) this.db.prepare('UPDATE credentials SET password_enc = ?, updated_at = ? WHERE id = ?').run(this.cipher.encrypt(patch.password), Date.now(), id);
    if (patch.note !== undefined) this.db.prepare('UPDATE credentials SET note = ?, updated_at = ? WHERE id = ?').run(patch.note.slice(0, 4000), Date.now(), id);
  }

  delete(profileId: string, id: number): void {
    this.db.prepare('DELETE FROM credentials WHERE profile_id = ? AND id = ?').run(profileId, id);
  }

  deleteAll(profileId: string): void {
    this.db.prepare('DELETE FROM credentials WHERE profile_id = ?').run(profileId);
  }

  importCsv(profileId: string, text: string, source: string): ImportResult {
    const { logins, skipped } = parseLoginCsv(text);
    const result: ImportResult = { added: 0, updated: 0, unchanged: 0, skipped: [...skipped] };
    transaction(this.db, () => {
      for (const l of logins) {
        try {
          const r = this.upsert(profileId, { url: l.url, username: l.username, password: l.password, title: l.title, note: l.note, source });
          result[r.result]++;
        } catch (err) {
          result.skipped.push({ line: l.line, reason: err instanceof Error ? err.message : 'Invalid row' });
        }
      }
    });
    return result;
  }

  /** Google/Chrome-compatible CSV. The caller must warn that the file is unencrypted. */
  exportCsv(profileId: string): string {
    const rows = [['name', 'url', 'username', 'password', 'note']];
    for (const c of this.list(profileId)) rows.push([c.title || c.domain, c.origin, c.username, this.reveal(profileId, c.id) ?? '', c.note]);
    return toCsv(rows);
  }
}
