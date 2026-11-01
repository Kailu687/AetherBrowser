import type { Session } from 'electron';

const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 400;

/**
 * Fetches favicons through the tab's own session (so profile cookies and
 * privacy rules apply) and hands the UI data: URLs. The privileged UI never
 * loads remote resources itself.
 */
export class FaviconCache {
  private cache = new Map<string, string | null>();

  async fetch(ses: Session, candidates: string[]): Promise<string | null> {
    const url = candidates.find((u) => /^https?:\/\//i.test(u) || u.startsWith('data:image/'));
    if (!url) return null;
    if (url.startsWith('data:image/')) return url.length <= MAX_BYTES * 1.4 ? url : null;
    if (this.cache.has(url)) return this.cache.get(url)!;
    let result: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await ses.fetch(url, { signal: controller.signal, credentials: 'include' } as RequestInit);
      clearTimeout(timer);
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      if (res.ok && /^image\//.test(type) && type !== 'image/svg+xml') {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= MAX_BYTES) result = `data:${type};base64,${buf.toString('base64')}`;
      } else if (res.ok && type === 'image/svg+xml') {
        // SVG is rendered via <img>, which never runs scripts; still cap size.
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= MAX_BYTES) result = `data:image/svg+xml;base64,${buf.toString('base64')}`;
      }
    } catch {
      result = null;
    }
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url, result);
    return result;
  }
}
