import { beforeEach, describe, expect, it } from 'vitest';
import { AetherStore, CredentialStore, credentialMatchesPage, parseCsv, parseLoginCsv } from '../src/index';

// Reversible stand-in for the OS keychain cipher.
const cipher = { encrypt: (s: string) => 'enc:' + Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s.slice(4), 'base64').toString() };

let store: AetherStore;
let creds: CredentialStore;
let profile: string;
beforeEach(() => {
  store = AetherStore.open(':memory:');
  creds = new CredentialStore(store.db, cipher);
  profile = store.createProfile({ name: 'P' }).id;
});

const GOOGLE_CSV = `name,url,username,password,note
accounts.google.com,https://accounts.google.com/signin/v2,kailash@gmail.com,"p,a""ss",
vtop.vit.ac.in,https://vtop.vit.ac.in/vtop/login,21BEC0001,s3cret,"multi
line note"
,https://nopass.example,user,,
`;

describe('CSV', () => {
  it('parses quotes, commas and newlines in fields', () => {
    const rows = parseCsv('a,"b,c","d""e"\r\n"f\ng",h\n');
    expect(rows).toEqual([['a', 'b,c', 'd"e'], ['f\ng', 'h']]);
  });

  it('reads a Google Password Manager export', () => {
    const r = parseLoginCsv(GOOGLE_CSV);
    expect(r.format).toBe('google-chrome');
    expect(r.logins).toHaveLength(2);
    expect(r.logins[0]).toMatchObject({ username: 'kailash@gmail.com', password: 'p,a"ss' });
    expect(r.logins[1].note).toBe('multi\nline note');
    expect(r.skipped).toEqual([{ line: 4, reason: 'No password' }]); // spreadsheet row, not physical line
  });

  it('reads a Firefox export', () => {
    const r = parseLoginCsv('"url","username","password","httpRealm","formActionOrigin"\n"https://github.com","me","pw","",""\n');
    expect(r.format).toBe('firefox');
    expect(r.logins[0]).toMatchObject({ url: 'https://github.com', username: 'me', password: 'pw' });
  });

  it('rejects files that are not password exports', () => {
    expect(parseLoginCsv('a,b\n1,2').logins).toHaveLength(0);
  });
});

describe('CredentialStore', () => {
  it('imports, deduplicates and never stores plaintext', () => {
    const r1 = creds.importCsv(profile, GOOGLE_CSV, 'google');
    expect(r1).toMatchObject({ added: 2, updated: 0, unchanged: 0 });
    const r2 = creds.importCsv(profile, GOOGLE_CSV, 'google');
    expect(r2).toMatchObject({ added: 0, unchanged: 2 });
    const raw = JSON.stringify(store.db.prepare('SELECT * FROM credentials').all());
    expect(raw).not.toContain('s3cret');
    const vit = creds.list(profile).find((c) => c.domain === 'vit.ac.in')!;
    expect(creds.reveal(profile, vit.id)).toBe('s3cret');
  });

  it('matches by registrable domain and refuses https logins on http pages', () => {
    creds.importCsv(profile, GOOGLE_CSV, 'google');
    expect(creds.forPage(profile, 'https://mail.google.com/mail')).toHaveLength(1);
    expect(creds.forPage(profile, 'https://evil-google.com/')).toHaveLength(0);
    expect(creds.forPage(profile, 'https://google.com.evil.io/')).toHaveLength(0);
    expect(credentialMatchesPage({ origin: 'https://accounts.google.com', domain: 'google.com' }, 'http://accounts.google.com/')).toBe(false);
  });

  it('keeps profiles separate and deletes with the profile', () => {
    const other = store.createProfile({ name: 'Q' }).id;
    creds.importCsv(profile, GOOGLE_CSV, 'google');
    expect(creds.list(other)).toHaveLength(0);
    expect(creds.reveal(other, creds.list(profile)[0].id)).toBeNull();
    store.deleteProfile(profile);
    expect(creds.count(profile)).toBe(0);
  });

  it('round-trips an export', () => {
    creds.importCsv(profile, GOOGLE_CSV, 'google');
    const csv = creds.exportCsv(profile);
    const again = parseLoginCsv(csv);
    expect(again.logins.map((l) => l.password).sort()).toEqual(['p,a"ss', 's3cret']);
  });
});
