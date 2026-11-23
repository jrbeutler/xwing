// Placeholder universe. Everything here is data so a custom setting can replace it.
import { parseDial } from './maneuvers';
import type { PilotDef, ShipType } from './types';

export const SHIP_TYPES: Record<string, ShipType> = {
  kestrel: {
    id: 'kestrel', name: 'Kestrel Fighter', size: 'small',
    primaries: [{ arc: 'front', attack: 3 }], agility: 2, hull: 4, shields: 2,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'barrelRoll' }],
    dial: parseDial('1BL:b 1S:b 1BR:b 2TL:w 2BL:b 2S:b 2BR:b 2TR:w 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 4S:w 4K:r'),
  },
  wasp: {
    id: 'wasp', name: 'Wasp Interceptor', size: 'small',
    primaries: [{ arc: 'front', attack: 3 }], agility: 3, hull: 3, shields: 0,
    actions: [{ type: 'focus' }, { type: 'evade' }, { type: 'lock' }, { type: 'barrelRoll' }, { type: 'boost' }],
    dial: parseDial('1TL:w 1TR:w 2TL:w 2BL:b 2S:b 2BR:b 2TR:w 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 3RL:r 3RR:r 4S:b 5S:w 4K:r'),
  },
  bulwark: {
    id: 'bulwark', name: 'Bulwark Gunship', size: 'medium',
    primaries: [{ arc: 'front', attack: 3 }, { arc: 'rear', attack: 2 }], agility: 1, hull: 7, shields: 3,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'boost', red: true }],
    dial: parseDial('0X:r 1TL:r 1BL:b 1S:b 1BR:b 1TR:r 2TL:w 2BL:w 2S:b 2BR:w 2TR:w 3BL:w 3S:w 3BR:w 4S:w 1RS:r 2SL:r 2SR:r'),
  },
};

export const PILOTS: Record<string, PilotDef> = {
  'mara-venn': { id: 'mara-venn', name: 'Mara Venn', shipType: 'wasp', initiative: 5 },
  'tobin-reyes': { id: 'tobin-reyes', name: 'Tobin Reyes', shipType: 'kestrel', initiative: 4 },
  'ilse-kord': { id: 'ilse-kord', name: 'Ilse Kord', shipType: 'kestrel', initiative: 2 },
  'drav-okono': { id: 'drav-okono', name: 'Drav Okono', shipType: 'bulwark', initiative: 4 },
  'syl-ketch': { id: 'syl-ketch', name: 'Syl Ketch', shipType: 'wasp', initiative: 3 },
  'grunt-seven': { id: 'grunt-seven', name: 'Grunt Seven', shipType: 'wasp', initiative: 1 },
};
