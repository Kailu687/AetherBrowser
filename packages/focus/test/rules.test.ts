import { describe, expect, it } from 'vitest';
import { evaluateRules, isValidPattern, parsePattern, defaultModes, type FocusRule } from '../src/index.js';

const r = (pattern: string, action: FocusRule['action'], scope?: FocusRule['scope']): FocusRule => ({ id: pattern + action, pattern, action, scope });

describe('focus rules', () => {
  it('parses domains and paths, ignoring scheme and www', () => {
    expect(parsePattern('https://www.YouTube.com/Shorts/')).toEqual({ host: 'youtube.com', pathSegments: ['shorts'] });
    expect(parsePattern('*.reddit.com')).toEqual({ host: 'reddit.com', pathSegments: [] });
    expect(isValidPattern('not a site')).toBe(false);
  });

  it('warns on Shorts while ordinary YouTube lectures stay allowed', () => {
    const rules = [r('youtube.com', 'allow'), r('youtube.com/shorts', 'warn')];
    expect(evaluateRules('https://www.youtube.com/watch?v=abc', rules, 'pages')?.action).toBe('allow');
    expect(evaluateRules('https://m.youtube.com/shorts/xyz', rules, 'pages')?.action).toBe('warn');
    expect(evaluateRules('https://www.youtube.com/shortsfeed', rules, 'pages')?.action).toBe('allow');
  });

  it('matches subdomains but not lookalike domains', () => {
    const rules = [r('instagram.com', 'block')];
    expect(evaluateRules('https://www.instagram.com/', rules, 'pages')?.action).toBe('block');
    expect(evaluateRules('https://notinstagram.com/', rules, 'pages')).toBeUndefined();
  });

  it('lets a more specific allow override a domain block', () => {
    const rules = [r('google.com', 'block'), r('scholar.google.com', 'allow')];
    expect(evaluateRules('https://scholar.google.com/scholar?q=x', rules, 'pages')?.action).toBe('allow');
    expect(evaluateRules('https://news.google.com/', rules, 'pages')?.action).toBe('block');
  });

  it('prefers allow when two rules are equally specific', () => {
    expect(evaluateRules('https://a.com/', [r('a.com', 'block'), r('a.com', 'allow')], 'pages')?.action).toBe('allow');
  });

  it('supports single-segment wildcards', () => {
    const rules = [r('reddit.com/r/*/comments', 'warn')];
    expect(evaluateRules('https://reddit.com/r/rust/comments/1', rules, 'pages')?.action).toBe('warn');
    expect(evaluateRules('https://reddit.com/r/rust', rules, 'pages')).toBeUndefined();
  });

  it('separates page rules from embedded-content rules', () => {
    const rules = [r('youtube.com', 'block', 'embedded')];
    expect(evaluateRules('https://youtube.com/embed/x', rules, 'embedded')?.action).toBe('block');
    expect(evaluateRules('https://youtube.com/embed/x', rules, 'pages')).toBeUndefined();
  });

  it('ignores non-web URLs and invalid rules', () => {
    expect(evaluateRules('aether://newtab', [r('newtab', 'block')], 'pages')).toBeUndefined();
    expect(evaluateRules('https://a.com', [r('???', 'block')], 'pages')).toBeUndefined();
  });

  it('ships valid default rules; study mode keeps WhatsApp Web and lectures open', () => {
    const modes = defaultModes();
    for (const m of Object.values(modes)) for (const rule of m.rules) expect(isValidPattern(rule.pattern)).toBe(true);
    expect(evaluateRules('https://web.whatsapp.com/', modes.study.rules, 'pages')?.action).toBe('allow');
    expect(evaluateRules('https://www.youtube.com/watch?v=lecture', modes.study.rules, 'pages')?.action).toBe('allow');
    expect(evaluateRules('https://www.youtube.com/shorts/a', modes.study.rules, 'pages')?.action).toBe('warn');
    expect(evaluateRules('https://www.instagram.com/reels/a', modes.study.rules, 'pages')?.action).toBe('block');
    expect(modes.relaxed.rules).toEqual([]);
  });
});
