/**
 * @aether/omnibox: turns what the user typed into a navigation target.
 *
 * Pure and dependency-free so it can be unit-tested and reused by the new-tab
 * page handler. Rules, in order:
 *   1. "!bang query" or "query !bang"  -> bang shortcut search
 *   2. Explicit scheme (http, https, aether, about, file) -> as-is (if allowed)
 *   3. Looks like a host (domain.tld, localhost, IPv4, [IPv6]) -> https:// (http for local hosts)
 *   4. Anything else -> search with the profile's default engine
 */

export interface SearchEngine {
  id: string;
  name: string;
  /** Template with "{q}" for the URL-encoded query. */
  template: string;
}

export const SEARCH_ENGINES: Record<string, SearchEngine> = {
  google: { id: 'google', name: 'Google', template: 'https://www.google.com/search?q={q}' },
  duckduckgo: { id: 'duckduckgo', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q={q}' },
  bing: { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q={q}' },
  brave: { id: 'brave', name: 'Brave Search', template: 'https://search.brave.com/search?q={q}' },
  startpage: { id: 'startpage', name: 'Startpage', template: 'https://www.startpage.com/do/search?q={q}' },
  ecosia: { id: 'ecosia', name: 'Ecosia', template: 'https://www.ecosia.org/search?q={q}' },
};

export interface Bang {
  trigger: string;
  name: string;
  category: 'search' | 'engineering' | 'academic' | 'code' | 'reference' | 'media' | 'everyday';
  template: string;
  /** Where to go when the bang is used with no query. */
  home: string;
}

const b = (trigger: string, name: string, category: Bang['category'], template: string, home?: string): Bang => ({
  trigger,
  name,
  category,
  template,
  home: home ?? new URL(template.replace('{q}', '')).origin,
});

export const DEFAULT_BANGS: Bang[] = [
  b('g', 'Google', 'search', 'https://www.google.com/search?q={q}'),
  b('ddg', 'DuckDuckGo', 'search', 'https://duckduckgo.com/?q={q}'),
  b('b', 'Bing', 'search', 'https://www.bing.com/search?q={q}'),
  b('brave', 'Brave Search', 'search', 'https://search.brave.com/search?q={q}'),
  b('gi', 'Google Images', 'search', 'https://www.google.com/search?tbm=isch&q={q}'),
  b('maps', 'Google Maps', 'everyday', 'https://www.google.com/maps/search/{q}', 'https://www.google.com/maps'),
  b('tr', 'Google Translate', 'everyday', 'https://translate.google.com/?sl=auto&tl=en&text={q}', 'https://translate.google.com'),
  b('w', 'Wikipedia', 'reference', 'https://en.wikipedia.org/w/index.php?search={q}'),
  b('wa', 'WolframAlpha', 'engineering', 'https://www.wolframalpha.com/input?i={q}'),
  b('scholar', 'Google Scholar', 'academic', 'https://scholar.google.com/scholar?q={q}'),
  b('gs', 'Google Scholar', 'academic', 'https://scholar.google.com/scholar?q={q}'),
  b('arxiv', 'arXiv', 'academic', 'https://arxiv.org/search/?query={q}&searchtype=all'),
  b('ieee', 'IEEE Xplore', 'academic', 'https://ieeexplore.ieee.org/search/searchresult.jsp?queryText={q}'),
  b('pubmed', 'PubMed', 'academic', 'https://pubmed.ncbi.nlm.nih.gov/?term={q}'),
  b('ss', 'Semantic Scholar', 'academic', 'https://www.semanticscholar.org/search?q={q}'),
  b('doi', 'DOI resolver', 'academic', 'https://doi.org/{q}', 'https://doi.org'),
  b('gh', 'GitHub', 'code', 'https://github.com/search?q={q}&type=repositories'),
  b('so', 'Stack Overflow', 'code', 'https://stackoverflow.com/search?q={q}'),
  b('mdn', 'MDN Web Docs', 'code', 'https://developer.mozilla.org/en-US/search?q={q}'),
  b('npm', 'npm', 'code', 'https://www.npmjs.com/search?q={q}'),
  b('pypi', 'PyPI', 'code', 'https://pypi.org/search/?q={q}'),
  b('crates', 'crates.io', 'code', 'https://crates.io/search?q={q}'),
  b('py', 'Python docs', 'code', 'https://docs.python.org/3/search.html?q={q}'),
  b('ds', 'Datasheets (AllDatasheet)', 'engineering', 'https://www.alldatasheet.com/view.jsp?Searchword={q}'),
  b('octo', 'Octopart', 'engineering', 'https://octopart.com/search?q={q}'),
  b('dk', 'Digi-Key', 'engineering', 'https://www.digikey.com/en/products/result?keywords={q}'),
  b('mouser', 'Mouser', 'engineering', 'https://www.mouser.com/c/?q={q}'),
  b('ti', 'Texas Instruments', 'engineering', 'https://www.ti.com/sitesearch/en-us/docs/universalsearch.tsp?searchTerm={q}'),
  b('st', 'STMicroelectronics', 'engineering', 'https://www.st.com/content/st_com/en/search.html#q={q}'),
  b('yt', 'YouTube', 'media', 'https://www.youtube.com/results?search_query={q}'),
  b('r', 'Reddit', 'everyday', 'https://www.reddit.com/search/?q={q}'),
  b('amz', 'Amazon', 'everyday', 'https://www.amazon.com/s?k={q}'),
];

export type OmniboxResult =
  | { kind: 'url'; url: string }
  | { kind: 'search'; url: string; engine: string; query: string }
  | { kind: 'bang'; url: string; bang: string; query: string }
  | { kind: 'invalid'; reason: string };

export interface OmniboxOptions {
  engine?: string;
  bangs?: Bang[];
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'aether:', 'about:', 'file:']);
const BLOCKED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'chrome:', 'devtools:']);

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTLIKE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || IPV4.test(host) || host.startsWith('[');
}

export function findBang(trigger: string, bangs: Bang[] = DEFAULT_BANGS): Bang | undefined {
  const t = trigger.toLowerCase();
  return bangs.find((x) => x.trigger === t);
}

export function searchUrl(query: string, engineId = 'google'): string {
  const engine = SEARCH_ENGINES[engineId] ?? SEARCH_ENGINES.google;
  return engine.template.replace('{q}', encodeURIComponent(query));
}

function parseBang(input: string, bangs: Bang[]): OmniboxResult | null {
  const tokens = input.split(/\s+/);
  const idx = tokens.findIndex((t, i) => /^![a-z0-9]+$/i.test(t) && (i === 0 || i === tokens.length - 1));
  if (idx === -1) return null;
  const bang = findBang(tokens[idx].slice(1), bangs);
  if (!bang) return null;
  const query = tokens.filter((_, i) => i !== idx).join(' ').trim();
  if (!query) return { kind: 'bang', url: bang.home, bang: bang.trigger, query: '' };
  // The DOI resolver takes the raw identifier path.
  const encoded = bang.trigger === 'doi' ? query.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(query);
  return { kind: 'bang', url: bang.template.replace('{q}', encoded), bang: bang.trigger, query };
}

/** Classifies host-like input such as "example.com/path" or "localhost:3000". */
function asHostUrl(input: string): string | null {
  if (/\s/.test(input)) return null;
  const m = /^([^/?#]+)([/?#].*)?$/.exec(input);
  if (!m) return null;
  const hostPort = m[1];
  let host = hostPort;
  const portMatch = /^(.*?)(?::(\d{1,5}))?$/.exec(hostPort);
  if (portMatch && !hostPort.startsWith('[')) host = portMatch[1];
  if (hostPort.startsWith('[')) host = hostPort.slice(0, hostPort.indexOf(']') + 1);
  const hostLower = host.toLowerCase();
  if (!(HOSTLIKE.test(hostLower) || isLocalHost(hostLower))) return null;
  const scheme = isLocalHost(hostLower) ? 'http' : 'https';
  try {
    return new URL(`${scheme}://${input}`).toString();
  } catch {
    return null;
  }
}

export function resolveOmniboxInput(raw: string, opts: OmniboxOptions = {}): OmniboxResult {
  const input = raw.trim();
  const engine = opts.engine ?? 'google';
  const bangs = opts.bangs ?? DEFAULT_BANGS;
  if (!input) return { kind: 'invalid', reason: 'empty' };

  const bang = parseBang(input, bangs);
  if (bang) return bang;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase() + ':';
    if (BLOCKED_SCHEMES.has(scheme)) return { kind: 'invalid', reason: `${scheme} URLs cannot be opened from the address bar` };
    if (ALLOWED_SCHEMES.has(scheme) && !/\s/.test(input)) {
      try {
        return { kind: 'url', url: new URL(input).toString() };
      } catch {
        /* fall through to search */
      }
    }
  }

  const host = asHostUrl(input);
  if (host) return { kind: 'url', url: host };

  return { kind: 'search', url: searchUrl(input, engine), engine, query: input };
}

/** Prettifies a URL for display in the address bar when not focused. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'aether:' && u.hostname === 'newtab') return '';
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      const path = u.pathname === '/' && !u.search && !u.hash ? '' : u.pathname + u.search + u.hash;
      return u.host.replace(/^www\./, '') + path;
    }
    return url;
  } catch {
    return url;
  }
}
export * from './calc';
