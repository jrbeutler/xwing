import { describe, expect, it } from 'vitest';
import { basePolygon, polygonDistance, polygonsOverlap } from '../src/geometry';

describe('geometry', () => {
  it('detects overlap and treats touching as not overlapping', () => {
    const a = basePolygon({ x: 0, y: 0, h: 0 }, 40);
    expect(polygonsOverlap(a, basePolygon({ x: 30, y: 0, h: 0 }, 40))).toBe(true);
    expect(polygonsOverlap(a, basePolygon({ x: 40, y: 0, h: 0 }, 40))).toBe(false);
    expect(polygonsOverlap(a, basePolygon({ x: 45, y: 0, h: 0.3 }, 40))).toBe(true);
  });
  it('measures closest distance between bases', () => {
    const a = basePolygon({ x: 0, y: 0, h: 0 }, 40);
    const b = basePolygon({ x: 190, y: 0, h: 0 }, 40);
    expect(polygonDistance(a, b).d).toBeCloseTo(150, 6);
  });
});
