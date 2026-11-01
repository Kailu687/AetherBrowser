import { describe, expect, it } from 'vitest';
import { checkDimensions, devtools, dimensionString, niceTicks, sampleFunction } from '../src/index';

describe('eng-tools', () => {
  it('checks dimensions', () => {
    expect(dimensionString('N')).toBe('m·kg·s⁻²');
    expect(checkDimensions('kg*m/s^2 = N').ok).toBe(true);
    expect(checkDimensions('V*A = W').ok).toBe(true);
    expect(checkDimensions('N*m = W').ok).toBe(false);
    expect(checkDimensions('N').error).toMatch(/both sides/);
  });
  it('samples functions with gaps', () => {
    const p = sampleFunction('1/x', -1, 1, 2);
    expect(p).toHaveLength(3);
    expect(p[1].y).toBeNull();
    expect(p[2].y).toBe(1);
    expect(() => sampleFunction('sin(', 0, 1)).toThrow();
  });
  it('ticks and devtools', () => {
    expect(niceTicks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(devtools.b64decode(devtools.b64encode('Ω ok'))).toBe('Ω ok');
    expect(devtools.timestamp('1700000000').unix).toBe(1700000000);
    expect(devtools.json('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
});
