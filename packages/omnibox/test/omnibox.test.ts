import { describe, expect, it } from 'vitest';
import { displayUrl, resolveOmniboxInput } from '../src/index';

describe('resolveOmniboxInput', () => {
  it('treats domains as https URLs', () => {
    expect(resolveOmniboxInput('example.com')).toEqual({ kind: 'url', url: 'https://example.com/' });
    expect(resolveOmniboxInput('docs.python.org/3/library')).toEqual({ kind: 'url', url: 'https://docs.python.org/3/library' });
  });

  it('uses http for local hosts and keeps ports', () => {
    expect(resolveOmniboxInput('localhost:5173')).toEqual({ kind: 'url', url: 'http://localhost:5173/' });
    expect(resolveOmniboxInput('192.168.1.10/admin')).toEqual({ kind: 'url', url: 'http://192.168.1.10/admin' });
  });

  it('keeps explicit schemes', () => {
    expect(resolveOmniboxInput('http://neverssl.com')).toEqual({ kind: 'url', url: 'http://neverssl.com/' });
    expect(resolveOmniboxInput('aether://newtab')).toEqual({ kind: 'url', url: 'aether://newtab' });
  });

  it('refuses script-bearing schemes', () => {
    expect(resolveOmniboxInput('javascript:alert(1)').kind).toBe('invalid');
    expect(resolveOmniboxInput('data:text/html,<b>x</b>').kind).toBe('invalid');
  });

  it('searches plain text with the chosen engine', () => {
    const r = resolveOmniboxInput('op amp slew rate', { engine: 'duckduckgo' });
    expect(r).toEqual({ kind: 'search', engine: 'duckduckgo', query: 'op amp slew rate', url: 'https://duckduckgo.com/?q=op%20amp%20slew%20rate' });
  });

  it('does not treat dotted words with spaces as hosts', () => {
    expect(resolveOmniboxInput('node.js tutorial').kind).toBe('search');
    expect(resolveOmniboxInput('3.14').kind).toBe('search');
  });

  it('supports leading and trailing bangs', () => {
    expect(resolveOmniboxInput('!gh electron')).toMatchObject({ kind: 'bang', bang: 'gh', url: 'https://github.com/search?q=electron&type=repositories' });
    expect(resolveOmniboxInput('LM741 datasheet !ds')).toMatchObject({ kind: 'bang', bang: 'ds', query: 'LM741 datasheet' });
    expect(resolveOmniboxInput('!IEEE radar')).toMatchObject({ kind: 'bang', bang: 'ieee' });
  });

  it('goes to the bang home page with no query', () => {
    expect(resolveOmniboxInput('!arxiv')).toEqual({ kind: 'bang', bang: 'arxiv', query: '', url: 'https://arxiv.org' });
  });

  it('keeps DOI slashes', () => {
    expect(resolveOmniboxInput('!doi 10.1109/5.771073')).toMatchObject({ url: 'https://doi.org/10.1109/5.771073' });
  });

  it('ignores unknown bangs', () => {
    expect(resolveOmniboxInput('!nope thing').kind).toBe('search');
  });
});

describe('displayUrl', () => {
  it('strips scheme and www', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com');
    expect(displayUrl('https://example.com/a?b=1')).toBe('example.com/a?b=1');
    expect(displayUrl('aether://newtab')).toBe('');
  });
});
