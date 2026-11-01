/** Minimal Drive v3 client for the hidden appDataFolder (scope drive.appdata only). */
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const SYNC_FILE = 'aether-sync.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

async function ok(r: Response, what: string): Promise<Response> {
  if (!r.ok) throw new Error(`drive: ${what} failed (${r.status})`);
  return r;
}

export async function findSyncFile(fetch: Fetch, token: string): Promise<{ id: string; modifiedTime?: string } | null> {
  const q = encodeURIComponent(`name='${SYNC_FILE}' and trashed=false`);
  const r = await ok(await fetch(`${API}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=1`, { headers: { authorization: `Bearer ${token}` } }), 'list');
  const j = (await r.json()) as { files?: { id: string; modifiedTime?: string }[] };
  return j.files?.[0] ?? null;
}

export async function uploadSync(fetch: Fetch, token: string, data: unknown): Promise<string> {
  const body = JSON.stringify(data);
  const existing = await findSyncFile(fetch, token);
  if (existing) {
    await ok(await fetch(`${UPLOAD}/${existing.id}?uploadType=media`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body }), 'update');
    return existing.id;
  }
  const boundary = `aether${Math.random().toString(36).slice(2)}`;
  const multipart = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: SYNC_FILE, parents: ['appDataFolder'] })}\r\n--${boundary}\r\ncontent-type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await ok(await fetch(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart }), 'create');
  return ((await r.json()) as { id: string }).id;
}

/** Downloads the sync file (null when none exists). Rejects files over 5 MB. */
export async function downloadSync(fetch: Fetch, token: string): Promise<Record<string, unknown> | null> {
  const f = await findSyncFile(fetch, token);
  if (!f) return null;
  const r = await ok(await fetch(`${API}/${f.id}?alt=media`, { headers: { authorization: `Bearer ${token}` } }), 'download');
  const text = await r.text();
  if (text.length > 5_000_000) throw new Error('drive: sync file too large');
  const j = JSON.parse(text) as unknown;
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('drive: sync file is not an object');
  return j as Record<string, unknown>;
}

export async function deleteSync(fetch: Fetch, token: string): Promise<boolean> {
  const f = await findSyncFile(fetch, token);
  if (!f) return false;
  await ok(await fetch(`${API}/${f.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }), 'delete');
  return true;
}
