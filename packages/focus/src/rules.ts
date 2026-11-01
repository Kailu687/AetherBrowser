import { getHostname } from 'tldts';

export type RuleAction = 'allow' | 'warn' | 'block';
/** "pages": top-level navigations. "embedded": iframes such as embedded players. */
export type RuleScope = 'pages' | 'embedded' | 'both';

export interface FocusRule {
  id: string;
  /**
   * "youtube.com" matches the domain and all subdomains.
   * "youtube.com/shorts" matches that path and everything below it.
   * "*" inside the path matches one path segment, e.g. "reddit.com/r/*\/comments".
   */
  pattern: string;
  action: RuleAction;
  scope?: RuleScope;
  label?: string;
}

export interface ParsedPattern {
  host: string;
  pathSegments: string[];
}

export class InvalidPatternError extends Error {}

export function parsePattern(pattern: string): ParsedPattern {
  let p = pattern.trim().toLowerCase();
  p = p.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '');
  const slash = p.indexOf('/');
  const host = (slash === -1 ? p : p.slice(0, slash)).replace(/^www\./, '');
  const path = slash === -1 ? '' : p.slice(slash);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) throw new InvalidPatternError(`"${pattern}" is not a valid site`);
  const pathSegments = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return { host, pathSegments };
}

export function isValidPattern(pattern: string): boolean {
  try {
    parsePattern(pattern);
    return true;
  } catch {
    return false;
  }
}

export interface UrlParts {
  host: string;
  pathSegments: string[];
}

export function urlParts(url: string): UrlParts | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  const host = getHostname(url);
  if (!host) return undefined;
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  return { host: host.toLowerCase(), pathSegments: path.toLowerCase().split('/').filter(Boolean) };
}

function hostMatches(host: string, ruleHost: string): boolean {
  return host === ruleHost || host.endsWith('.' + ruleHost);
}

function pathMatches(path: string[], rulePath: string[]): boolean {
  if (rulePath.length > path.length) return false;
  return rulePath.every((seg, i) => seg === '*' || seg === path[i]);
}

/** Higher is more specific: path depth dominates, then the number of host labels. */
export function specificity(p: ParsedPattern): number {
  return p.pathSegments.length * 1000 + p.host.split('.').length;
}

const ACTION_PRIORITY: Record<RuleAction, number> = { allow: 3, warn: 2, block: 1 };

export interface RuleMatch {
  rule: FocusRule;
  action: RuleAction;
}

/**
 * Picks the most specific matching rule, so "allow youtube.com" plus "warn youtube.com/shorts"
 * warns only on Shorts. When two rules are equally specific the more permissive one wins,
 * which lets an explicit allow act as an exception.
 */
export function evaluateRules(url: string, rules: readonly FocusRule[], context: 'pages' | 'embedded'): RuleMatch | undefined {
  const parts = urlParts(url);
  if (!parts) return undefined;
  let best: { rule: FocusRule; score: number } | undefined;
  for (const rule of rules) {
    const scope = rule.scope ?? 'pages';
    if (scope !== 'both' && scope !== context) continue;
    let parsed: ParsedPattern;
    try {
      parsed = parsePattern(rule.pattern);
    } catch {
      continue;
    }
    if (!hostMatches(parts.host, parsed.host) || !pathMatches(parts.pathSegments, parsed.pathSegments)) continue;
    const score = specificity(parsed);
    if (!best || score > best.score || (score === best.score && ACTION_PRIORITY[rule.action] > ACTION_PRIORITY[best.rule.action])) {
      best = { rule, score };
    }
  }
  return best && { rule: best.rule, action: best.rule.action };
}
