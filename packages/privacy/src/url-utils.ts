import { getDomain, getHostname } from 'tldts';

/** Registrable domain ("eTLD+1"), falling back to the hostname for IPs and localhost. */
export function siteOf(url: string): string {
  const host = getHostname(url) ?? '';
  return (getDomain(url, { allowPrivateDomains: true }) ?? host).toLowerCase();
}

export function hostOf(url: string): string {
  return (getHostname(url) ?? '').toLowerCase();
}

export function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_eid',
  'mc_cid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  '__s',
  'ttclid',
]);

/** Returns the URL without known click-tracking parameters, or undefined if nothing changed. */
export function stripTrackingParams(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  let changed = false;
  for (const name of [...parsed.searchParams.keys()]) {
    const lower = name.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) {
      parsed.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return undefined;
  const out = parsed.toString();
  // Avoid leaving a dangling "?" behind.
  return parsed.search === '' ? out.replace(/\?(?=#|$)/, '') : out;
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|\d+\.\d+\.\d+\.\d+)$/i;

/** Upgrades public http:// URLs to https://. Local and IP hosts are left alone because they rarely serve TLS. */
export function httpsUpgrade(url: string): string | undefined {
  if (!url.startsWith('http://')) return undefined;
  const host = hostOf(url);
  if (!host || PRIVATE_HOST.test(host)) return undefined;
  try {
    const u = new URL(url);
    if (u.port && u.port !== '80') return undefined;
    u.protocol = 'https:';
    u.port = '';
    return u.toString();
  } catch {
    return undefined;
  }
}
