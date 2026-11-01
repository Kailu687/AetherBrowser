import { runInNewContext, createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isolateScriptlet } from '../../src/preload/scriptlets';

// Two scriptlets shaped like uBO's: each declares the same top-level helpers.
const scriptlet = (name: string, value: number) => `class JSONPath { get v() { return ${value}; } }
function safeSelf() { return ${value}; }
const helper = new JSONPath();
globalThis.${name} = () => helper.v + safeSelf();`;

describe('scriptlet isolation', () => {
  it('raw scriptlets collide in one global scope', () => {
    const ctx = createContext({});
    runInContext(scriptlet('a', 1), ctx);
    expect(() => runInContext(scriptlet('b', 2), ctx)).toThrow(/already been declared/);
  });

  it('isolated scriptlets keep their own helpers', () => {
    const ctx = createContext({});
    runInContext(isolateScriptlet(scriptlet('a', 1)), ctx);
    runInContext(isolateScriptlet(scriptlet('b', 2)), ctx);
    expect(runInContext('a() + "," + b()', ctx)).toBe('2,4');
  });

  it('contains a failing scriptlet', () => {
    expect(() => runInNewContext(isolateScriptlet('decodeURIComponent("%E0%A4%A")'))).not.toThrow();
  });
});
