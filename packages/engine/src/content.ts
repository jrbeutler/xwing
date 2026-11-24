// Placeholder universe. Everything here is data so a custom setting can replace it.
import { parseDial } from './maneuvers';
import type { PilotDef, ShipType, UpgradeDef } from './types';

export const SHIP_TYPES: Record<string, ShipType> = {
  kestrel: {
    id: 'kestrel', name: 'Kestrel Fighter', size: 'small',
    primaries: [{ arc: 'front', attack: 3 }], agility: 2, hull: 4, shields: 2,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'barrelRoll' }],
    dial: parseDial('1BL:b 1S:b 1BR:b 2TL:w 2BL:b 2S:b 2BR:b 2TR:w 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 4S:w 4K:r'),
    slots: ['talent', 'torpedo', 'modification'],
  },
  wasp: {
    id: 'wasp', name: 'Wasp Interceptor', size: 'small',
    primaries: [{ arc: 'front', attack: 3 }], agility: 3, hull: 3, shields: 0,
    actions: [{ type: 'focus' }, { type: 'evade' }, { type: 'lock' }, { type: 'barrelRoll' }, { type: 'boost' }],
    dial: parseDial('1TL:w 1TR:w 2TL:w 2BL:b 2S:b 2BR:b 2TR:w 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 3RL:r 3RR:r 4S:b 5S:w 4K:r'),
    slots: ['talent', 'modification'],
  },
  bulwark: {
    id: 'bulwark', name: 'Bulwark Gunship', size: 'medium',
    primaries: [{ arc: 'front', attack: 3 }, { arc: 'rear', attack: 2 }], agility: 1, hull: 7, shields: 3,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'boost', red: true }],
    dial: parseDial('0X:r 1TL:r 1BL:b 1S:b 1BR:b 1TR:r 2TL:w 2BL:w 2S:b 2BR:w 2TR:w 3BL:w 3S:w 3BR:w 4S:w 1RS:r 2SL:r 2SR:r'),
    slots: ['talent', 'missile', 'turret', 'modification', 'modification'],
  },
  // Bomber class. Stats, actions and dial follow the X-Wing 2nd edition BTL-A4 Y-wing: tough (6 hull,
  // 2 shields) but slow to turn, with a red barrel roll. Its Reload action, turret and bomb slots need
  // mechanics the engine does not have yet (ordnance, turret arcs, devices), so they are left out.
  anvil: {
    id: 'anvil', name: 'Anvil Bomber', size: 'small',
    primaries: [{ arc: 'front', attack: 2 }], agility: 1, hull: 6, shields: 2,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'barrelRoll', red: true }],
    dial: parseDial('1BL:b 1S:b 1BR:b 2TL:w 2BL:w 2S:b 2BR:w 2TR:w 3TL:r 3BL:w 3S:w 3BR:w 3TR:r 4S:r 4K:r'),
    // Y-wing style: turret, ordnance and two device (bomb) slots.
    slots: ['talent', 'turret', 'torpedo', 'missile', 'device', 'device', 'modification'],
  },
};

// Costs are squad points (a standard battle is 100). Named pilots are unique; call-sign pilots are generic.
export const PILOTS: Record<string, PilotDef> = {
  'mara-venn': { id: 'mara-venn', name: 'Mara Venn', shipType: 'wasp', initiative: 5, cost: 26, unique: true },
  'syl-ketch': { id: 'syl-ketch', name: 'Syl Ketch', shipType: 'wasp', initiative: 3, cost: 21, unique: true },
  'grunt-seven': { id: 'grunt-seven', name: 'Grunt Seven', shipType: 'wasp', initiative: 1, cost: 17, unique: false },
  'tobin-reyes': { id: 'tobin-reyes', name: 'Tobin Reyes', shipType: 'kestrel', initiative: 4, cost: 25, unique: true },
  'ilse-kord': { id: 'ilse-kord', name: 'Ilse Kord', shipType: 'kestrel', initiative: 2, cost: 21, unique: true },
  'vale-nine': { id: 'vale-nine', name: 'Vale Nine', shipType: 'kestrel', initiative: 1, cost: 19, unique: false },
  'drav-okono': { id: 'drav-okono', name: 'Drav Okono', shipType: 'bulwark', initiative: 4, cost: 34, unique: true },
  'hauler-three': { id: 'hauler-three', name: 'Hauler Three', shipType: 'bulwark', initiative: 2, cost: 30, unique: false },
  'bram-holloway': { id: 'bram-holloway', name: 'Bram Holloway', shipType: 'anvil', initiative: 4, cost: 23, unique: true },
  'rook-twelve': { id: 'rook-twelve', name: 'Rook Twelve', shipType: 'anvil', initiative: 2, cost: 18, unique: false },
};

/** Power-ups. Step one: stat boosts (modifications). Talents, ordnance, turrets and bombs come next. */
export const UPGRADES: Record<string, UpgradeDef> = {
  'hull-plating': {
    id: 'hull-plating', name: 'Hull Plating', slot: 'modification', text: '+1 hull.',
    cost: { small: 4, medium: 6, large: 8 }, stats: { hull: 1 },
  },
  'shield-booster': {
    id: 'shield-booster', name: 'Shield Booster', slot: 'modification', text: '+1 shield.',
    cost: { small: 5, medium: 7, large: 9 }, stats: { shields: 1 },
  },
  'stealth-coating': {
    id: 'stealth-coating', name: 'Stealth Coating', slot: 'modification',
    text: 'Roll 1 extra defense die until you first take damage.', cost: { small: 4, medium: 6, large: 8 }, charges: 1,
  },
};
