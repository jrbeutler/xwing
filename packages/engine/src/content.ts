// Placeholder universe. Everything here is data so a custom setting can replace it.
import { parseDial } from './maneuvers';
import type { PilotDef, ShipType, UpgradeDef } from './types';

export const SHIP_TYPES: Record<string, ShipType> = {
  kestrel: {
    id: 'kestrel', name: 'Kestrel Fighter', size: 'small', class: 'fighter', cost: 19,
    primaries: [{ arc: 'front', attack: 3 }], agility: 2, hull: 4, shields: 2,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'barrelRoll' }],
    dial: parseDial('1BL:b 1S:b 1BR:b 2TL:w 2BL:b 2S:b 2BR:b 2TR:w 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 4S:w 4K:r'),
    slots: ['torpedo', 'modification'],
  },
  wasp: {
    id: 'wasp', name: 'Wasp Interceptor', size: 'small', class: 'fighter', cost: 17,
    primaries: [{ arc: 'front', attack: 3 }], agility: 3, hull: 3, shields: 0,
    actions: [{ type: 'focus' }, { type: 'evade' }, { type: 'lock' }, { type: 'barrelRoll' }, { type: 'boost' }],
    dial: parseDial('1TL:w 1TR:w 2TL:w 2BL:b 2S:b 2BR:b 2TR:w 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 3RL:r 3RR:r 4S:b 5S:w 4K:r'),
    slots: ['modification'],
  },
  bulwark: {
    id: 'bulwark', name: 'Bulwark Gunship', size: 'medium', class: 'freighter', cost: 28,
    primaries: [{ arc: 'front', attack: 3 }, { arc: 'rear', attack: 2 }], agility: 1, hull: 7, shields: 3,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'boost', red: true }],
    dial: parseDial('0X:r 1TL:r 1BL:b 1S:b 1BR:b 1TR:r 2TL:w 2BL:w 2S:b 2BR:w 2TR:w 3BL:w 3S:w 3BR:w 4S:w 1RS:r 2SL:r 2SR:r'),
    slots: ['missile', 'turret', 'modification', 'modification'],
  },
  // Bomber class. Stats, actions and dial follow the X-Wing 2nd edition BTL-A4 Y-wing: tough (6 hull,
  // 2 shields) but slow to turn, with a red barrel roll. Its Reload action, turret and bomb slots need
  // mechanics the engine does not have yet (ordnance, turret arcs, devices), so they are left out.
  anvil: {
    id: 'anvil', name: 'Anvil Bomber', size: 'small', class: 'bomber', cost: 16,
    primaries: [{ arc: 'front', attack: 2 }], agility: 1, hull: 6, shields: 2,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'barrelRoll', red: true }],
    dial: parseDial('1BL:b 1S:b 1BR:b 2TL:w 2BL:w 2S:b 2BR:w 2TR:w 3TL:r 3BL:w 3S:w 3BR:w 3TR:r 4S:r 4K:r'),
    // Y-wing style: turret, ordnance and two device (bomb) slots.
    slots: ['turret', 'torpedo', 'missile', 'device', 'device', 'modification'],
  },
  // Light freighter. Stats and dial follow the X-Wing 2nd edition HWK-290, but on a medium base like the
  // Bulwark: its primary weapon fires through a turret arc (turned with the Rotate action), it can Jam an
  // enemy at range 1-2 in that arc, and it carries missiles, torpedoes, a turret and devices. The linked
  // focus/lock→rotate actions are left out.
  wayfarer: {
    id: 'wayfarer', name: 'Wayfarer Light Freighter', size: 'medium', class: 'freighter', cost: 17,
    primaries: [{ arc: 'turret', attack: 2 }], agility: 2, hull: 3, shields: 2,
    actions: [{ type: 'focus' }, { type: 'lock' }, { type: 'jam' }, { type: 'boost', red: true }],
    dial: parseDial('0X:r 1BL:b 1S:b 1BR:b 2TL:w 2BL:w 2S:b 2BR:w 2TR:w 3TL:r 3BL:w 3S:b 3BR:w 3TR:r 4S:w'),
    slots: ['missile', 'torpedo', 'turret', 'device', 'device', 'modification', 'modification'],
  },
  // Fast interceptor. Stats, actions and dial follow the X-Wing 2nd edition RZ-1 A-wing: fragile but very
  // agile (agility 3), white focus/evade/lock/barrel roll/boost, a blue-heavy dial with 5-straight and red loops.
  javelin: {
    id: 'javelin', name: 'Javelin Interceptor', size: 'small', class: 'fighter', cost: 16,
    primaries: [{ arc: 'front', attack: 2 }], agility: 3, hull: 2, shields: 2,
    actions: [{ type: 'focus' }, { type: 'evade' }, { type: 'lock' }, { type: 'barrelRoll' }, { type: 'boost' }],
    dial: parseDial('1TL:w 1TR:w 2TL:b 2BL:b 2S:b 2BR:b 2TR:b 3SL:r 3TL:w 3BL:w 3S:b 3BR:w 3TR:w 3SR:r 4S:b 5S:b 5K:r'),
    slots: ['missile', 'modification'],
  },
};

// Pilots specialise in a ship class and can fly any hull of it (another class: -1 initiative, which
// can cost a talent slot). A ship's cost is the hull's plus the pilot's. Pilot cost: 2 per initiative
// above 1, plus their signature talents. Named pilots are unique; call-sign pilots are generic.
export const PILOTS: Record<string, PilotDef> = {
  'mara-venn': { id: 'mara-venn', name: 'Mara Venn', specialty: 'fighter', ship: 'wasp', initiative: 5, cost: 11, unique: true, talents: ['elusive'] },
  'syl-ketch': { id: 'syl-ketch', name: 'Syl Ketch', specialty: 'fighter', ship: 'wasp', initiative: 3, cost: 7, unique: true, talents: ['hotshot'] },
  'grunt-seven': { id: 'grunt-seven', name: 'Grunt Seven', specialty: 'fighter', ship: 'wasp', initiative: 1, cost: 0, unique: false },
  'tobin-reyes': { id: 'tobin-reyes', name: 'Tobin Reyes', specialty: 'fighter', ship: 'kestrel', initiative: 4, cost: 9, unique: true, talents: ['marksman'] },
  'ilse-kord': { id: 'ilse-kord', name: 'Ilse Kord', specialty: 'fighter', ship: 'kestrel', initiative: 2, cost: 2, unique: true },
  'vale-nine': { id: 'vale-nine', name: 'Vale Nine', specialty: 'fighter', ship: 'kestrel', initiative: 1, cost: 0, unique: false },
  'kira-solace': { id: 'kira-solace', name: 'Kira Solace', specialty: 'fighter', ship: 'javelin', initiative: 5, cost: 13, unique: true, talents: ['outmaneuver'] },
  'wren-tal': { id: 'wren-tal', name: 'Wren Tal', specialty: 'fighter', ship: 'javelin', initiative: 3, cost: 6, unique: true, talents: ['crack-shot'] },
  'lance-four': { id: 'lance-four', name: 'Lance Four', specialty: 'fighter', ship: 'javelin', initiative: 1, cost: 0, unique: false },
  'bram-holloway': { id: 'bram-holloway', name: 'Bram Holloway', specialty: 'bomber', ship: 'anvil', initiative: 4, cost: 9, unique: true, talents: ['payload-expert'] },
  'rook-twelve': { id: 'rook-twelve', name: 'Rook Twelve', specialty: 'bomber', ship: 'anvil', initiative: 2, cost: 2, unique: false },
  'drav-okono': { id: 'drav-okono', name: 'Drav Okono', specialty: 'freighter', ship: 'bulwark', initiative: 4, cost: 10, unique: true, talents: ['damage-control'] },
  'hauler-three': { id: 'hauler-three', name: 'Hauler Three', specialty: 'freighter', ship: 'bulwark', initiative: 2, cost: 2, unique: false },
  'tessa-varn': { id: 'tessa-varn', name: 'Tessa Varn', specialty: 'freighter', ship: 'wayfarer', initiative: 5, cost: 10, unique: true, talents: ['signal-jammer'] },
  'corin-hale': { id: 'corin-hale', name: 'Corin Hale', specialty: 'freighter', ship: 'wayfarer', initiative: 3, cost: 7, unique: true, talents: ['steady-gunner'] },
  'scout-two': { id: 'scout-two', name: 'Scout Two', specialty: 'freighter', ship: 'wayfarer', initiative: 2, cost: 2, unique: false },
};

/**
 * Power-ups: talents, ordnance, turrets, devices and modifications. `effects` is what each does in play,
 * as data the engine interprets (effects.ts); `text` is the same in words for players.
 */
export const UPGRADES: Record<string, UpgradeDef> = {
  // Talents belong to pilots (1 slot at initiative 3-4, 2 at 5+), from their specialty's pool.
  // Fighter talents follow X-Wing 2nd edition talents.
  marksman: {
    id: 'marksman', name: 'Marksman', slot: 'talent', cost: 3, classes: ['fighter', 'bomber'],
    text: 'When attacking a ship in your bullseye, reroll 1 attack die.',
    effects: [{ kind: 'rerollAttack', dice: 1, if: { primary: true, turret: false, bullseye: true } }],
  },
  'crack-shot': {
    id: 'crack-shot', name: 'Crack Shot', slot: 'talent', cost: 2, classes: ['fighter'], charges: 1,
    text: 'Once per battle, when attacking a ship in your bullseye, cancel 1 of its evade results.',
    effects: [{ kind: 'cancelEvade', cost: 'charge', if: { primary: true, bullseye: true } }],
  },
  elusive: {
    id: 'elusive', name: 'Elusive', slot: 'talent', cost: 3, classes: ['fighter'], charges: 1,
    text: 'When defending, spend the charge to reroll 1 defense die. Recover it after you fully execute a red maneuver.',
    effects: [
      { kind: 'rerollDefense', dice: 1, cost: 'charge' },
      { kind: 'trigger', on: 'redManeuverExecuted', if: { chargesBelowMax: true }, do: [{ op: 'recoverCharge' }], log: 'recovered' },
    ],
  },
  outmaneuver: {
    id: 'outmaneuver', name: 'Outmaneuver', slot: 'talent', cost: 5, classes: ['fighter'],
    text: "Your front-arc attacks from outside the defender's firing arc make it roll 1 fewer defense die.",
    effects: [{ kind: 'dice', when: 'attacking', dice: 'defense', delta: -1, if: { frontArc: true, outsideDefenderArcs: true } }],
  },
  hotshot: {
    id: 'hotshot', name: 'Hotshot', slot: 'talent', cost: 3, classes: ['fighter'],
    text: 'After you fully execute a red maneuver, gain 1 focus.',
    effects: [{ kind: 'trigger', on: 'redManeuverExecuted', do: [{ op: 'gainFocus' }], log: 'used' }],
  },
  // Bomber talents.
  'ordnance-specialist': {
    id: 'ordnance-specialist', name: 'Ordnance Specialist', slot: 'talent', cost: 3, classes: ['bomber'],
    text: 'When attacking with a missile or torpedo, reroll 1 attack die.',
    effects: [{ kind: 'rerollAttack', dice: 1, if: { primary: false, turret: false } }],
  },
  'payload-expert': {
    id: 'payload-expert', name: 'Payload Expert', slot: 'talent', cost: 3, classes: ['bomber'],
    text: 'Your bombs and mines each start with 1 extra charge.',
    effects: [{ kind: 'stat', stat: 'deviceCharges', delta: 1 }],
  },
  // Freighter talents.
  'steady-gunner': {
    id: 'steady-gunner', name: 'Steady Gunner', slot: 'talent', cost: 3, classes: ['freighter'],
    text: 'When attacking through your turret arc, reroll 1 attack die.',
    effects: [{ kind: 'rerollAttack', dice: 1, if: { turret: true } }],
  },
  'signal-jammer': {
    id: 'signal-jammer', name: 'Signal Jammer', slot: 'talent', cost: 2, classes: ['freighter'],
    text: 'Your Jam action reaches range 3 (on a ship that has Jam).',
    effects: [{ kind: 'stat', stat: 'jamRange', delta: 1 }],
  },
  'damage-control': {
    id: 'damage-control', name: 'Damage Control', slot: 'talent', cost: 4, classes: ['freighter'], charges: 1,
    text: 'Once per battle, in the End phase, if your shields are below their maximum, recover 1 shield.',
    effects: [{ kind: 'trigger', on: 'endPhase', cost: 'charge', if: { shieldsBelowMax: true }, do: [{ op: 'recoverShield' }], log: 'used' }],
  },
  // Ordnance: secondary weapons. No range bonuses (those are for primary attacks); one charge per shot.
  'proton-torpedoes': {
    id: 'proton-torpedoes', name: 'Proton Torpedoes', slot: 'torpedo', cost: 9, charges: 2,
    weapon: { attack: 4, minRange: 2, maxRange: 3, requires: 'lock', effect: 'proton' },
    text: 'Attack 4, range 2-3, needs a lock. Change 1 hit to a crit.',
  },
  'ion-torpedoes': {
    id: 'ion-torpedoes', name: 'Ion Torpedoes', slot: 'torpedo', cost: 6, charges: 2,
    weapon: { attack: 4, minRange: 2, maxRange: 3, requires: 'lock', effect: 'ion' },
    text: 'Attack 4, range 2-3, needs a lock. If it hits: 1 damage, and every other hit is an ion token instead.',
  },
  'concussion-missiles': {
    id: 'concussion-missiles', name: 'Concussion Missiles', slot: 'missile', cost: 6, charges: 3,
    weapon: { attack: 3, minRange: 2, maxRange: 3, requires: 'lock' },
    text: 'Attack 3, range 2-3, needs a lock.',
  },
  'rocket-pods': {
    id: 'rocket-pods', name: 'Rocket Pods', slot: 'missile', cost: 5, charges: 2,
    weapon: { attack: 3, minRange: 1, maxRange: 2 },
    text: 'Attack 3, range 1-2. No lock needed.',
  },
  // Turrets: secondary weapons firing through a turret arc the ship can turn with the Rotate action.
  'dorsal-turret': {
    id: 'dorsal-turret', name: 'Dorsal Turret', slot: 'turret', cost: 4,
    weapon: { attack: 2, minRange: 1, maxRange: 2, arc: 'turret' },
    text: 'Attack 2, range 1-2, through your turret arc. Adds the Rotate action to turn the arc.',
  },
  'ion-turret': {
    id: 'ion-turret', name: 'Ion Cannon Turret', slot: 'turret', cost: 6,
    weapon: { attack: 3, minRange: 1, maxRange: 2, arc: 'turret', effect: 'ion' },
    text: 'Attack 3, range 1-2, through your turret arc. If it hits: 1 damage, every other hit is an ion token. Adds the Rotate action.',
  },
  // Devices: dropped behind the ship in the System phase (one charge each). Bombs hit everything nearby.
  'proton-bomb': {
    id: 'proton-bomb', name: 'Proton Bomb', slot: 'device', cost: 5, charges: 2, device: { kind: 'bomb', effect: 'proton' },
    text: 'Drop behind you in the System phase. At the end of the Activation phase it detonates: each ship within 10 cm (yours too) takes 1 crit.',
  },
  'ion-bomb': {
    id: 'ion-bomb', name: 'Ion Bomb', slot: 'device', cost: 4, charges: 2, device: { kind: 'bomb', effect: 'ion' },
    text: 'Drop behind you in the System phase. At the end of the Activation phase it detonates: each ship within 10 cm (yours too) gains 3 ion tokens.',
  },
  'proximity-mine': {
    id: 'proximity-mine', name: 'Proximity Mine', slot: 'device', cost: 6, charges: 2, device: { kind: 'mine', effect: 'proximity' },
    text: 'Drop behind you in the System phase. It stays until a ship moves through or onto it: that ship rolls 2 attack dice and takes 1 damage per hit or crit.',
  },
  // Modifications (stat boosts).
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
    effects: [
      { kind: 'dice', when: 'defending', dice: 'defense', delta: 1, needsCharge: true },
      { kind: 'trigger', on: 'damaged', needsCharge: true, do: [{ op: 'loseCharges' }], log: 'spent' },
    ],
  },
};
