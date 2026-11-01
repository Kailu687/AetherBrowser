import { describe, expect, it } from 'vitest';
import { quickCalc } from '../src/calc';

const t = (s: string) => {
  const r = quickCalc(s);
  return r && 'text' in r ? r.text : r;
};

describe('quickCalc', () => {
  it('does unit-aware arithmetic', () => {
    expect(t('= 3.3V / 470ohm in mA')).toBe('7.02128 mA');
    expect(t('3.3V / 470ohm')).toBe('7.021 mA');
    expect(t('5V * 20mA')).toBe('100 mW');
    expect(t('12 kN*m to lbf*ft')).toBe('8,850.75 lbf*ft');
    expect(t('60 mph to km/h')).toBe('96.5606 km/h');
    expect(t('1 / (2*pi*10kohm*100nF)')).toBe('159.2 Hz');
    expect(t('9.81 m/s^2 * 2 s')).toBe('19.62 m/s');
  });
  it('supports engineering shorthands and functions', () => {
    expect(t('10k || 10k')).toBe('5,000');
    expect(t('2+2')).toBe('4');
    expect(t('sin(30 deg)')).toBe('0.5');
    expect(t('db(10)')).toBe('20');
    expect(t('sqrt(16 m^2)')).toBe('4 m');
  });
  it('converts bases with two’s complement', () => {
    expect(t('255 to hex')).toBe('0xFF');
    expect(t('0b1010 + 0x10')).toBe('26');
    expect(t('-1 to hex16')).toBe("0xFFFF (16-bit two's complement)");
    expect(t('10 to bin8')).toBe('0b0000_1010');
  });
  it('handles temperatures', () => {
    expect(t('100 °C to °F')).toBe('212 °F');
  });
  it('rejects nonsense dimensions and leaves searches alone', () => {
    expect(quickCalc('= 1 V + 1 A')).toEqual({ error: 'Cannot add quantities with different units' });
    expect(quickCalc('1 V + 1 A')).toBeNull();
    expect(quickCalc('2024 olympics')).toBeNull();
    expect(quickCalc('iphone 15')).toBeNull();
    expect(quickCalc('5')).toBeNull();
    expect(quickCalc('rust vs go')).toBeNull();
  });
});
