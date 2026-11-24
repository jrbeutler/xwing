import { describe, expect, it } from 'vitest';
import { maneuverFinalPose, parseDial, BANK_RADIUS } from '../src/maneuvers';

const start = { x: 0, y: 0, h: 0 };
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('maneuver templates', () => {
  it('straight 1 moves base length + one template unit', () => {
    const p = maneuverFinalPose(start, 40, { bearing: 'straight', speed: 1, difficulty: 'white' });
    close(p.x, 80); close(p.y, 0); close(p.h, 0);
  });

  it('bank right 1 ends rotated -45° on the right', () => {
    const R = BANK_RADIUS[1], phi = Math.PI / 4;
    const p = maneuverFinalPose(start, 40, { bearing: 'bankRight', speed: 1, difficulty: 'blue' });
    const rear = { x: 20 + R * Math.sin(phi), y: -R * (1 - Math.cos(phi)) };
    close(p.h, -phi);
    close(p.x, rear.x + Math.cos(-phi) * 20);
    close(p.y, rear.y + Math.sin(-phi) * 20);
  });

  it('turn left mirrors turn right', () => {
    const l = maneuverFinalPose(start, 40, { bearing: 'turnLeft', speed: 2, difficulty: 'white' });
    const r = maneuverFinalPose(start, 40, { bearing: 'turnRight', speed: 2, difficulty: 'white' });
    close(l.x, r.x); close(l.y, -r.y); close(l.h, Math.PI / 2); close(r.h, -Math.PI / 2);
  });

  it('k-turn flips heading at the straight end position', () => {
    const k = maneuverFinalPose(start, 40, { bearing: 'kturn', speed: 4, difficulty: 'red' });
    close(k.x, 40 + 160); close(Math.abs(k.h), Math.PI);
  });

  it('reverse straight backs up', () => {
    const p = maneuverFinalPose(start, 40, { bearing: 'reverseStraight', speed: 1, difficulty: 'red' });
    close(p.x, -80); close(p.h, 0);
  });

  it('reverse bank left ends behind and to the left', () => {
    const p = maneuverFinalPose(start, 40, { bearing: 'reverseBankLeft', speed: 1, difficulty: 'red' });
    expect(p.x).toBeLessThan(-40); expect(p.y).toBeGreaterThan(0);
  });

  it('stop stays put', () => {
    const p = maneuverFinalPose(start, 40, { bearing: 'stop', speed: 0, difficulty: 'red' });
    expect(p).toEqual(start);
  });

  it('parses compact dials', () => {
    expect(parseDial('1BL:b 4K:r')).toEqual([
      { speed: 1, bearing: 'bankLeft', difficulty: 'blue' },
      { speed: 4, bearing: 'kturn', difficulty: 'red' },
    ]);
  });
});
