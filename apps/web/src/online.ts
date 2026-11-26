// Online play without a game server. The host's browser runs the real game (the same engine as a local
// game) and the guest's browser connects straight to it over WebRTC (PeerJS). The guest only ever receives
// `viewFor(state, guest)`: the host's dials and the dice seed stay on the host. The host could peek; that
// is the trade-off for needing no server, and is fine between friends.
//
// A free public PeerJS service only introduces the two browsers to each other; game traffic goes directly
// between them. For local testing, `?peer=localhost:9000` points at a PeerJS server of your own.
import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import type { Command, GameEvent, GameState, Pose, Squad } from '@xw/engine';

/** Messages between the two browsers. */
export type Msg =
  /** Guest → host: join (or rejoin, with the same seat token) with this squad. */
  | { t: 'join'; seat: string; squad: Squad | null }
  /** Host → guest: the squad is not accepted (over budget, …); the connection closes. */
  | { t: 'reject'; reason: string }
  /**
   * Host → guest: the guest's view of the game, without its log, plus the log events from `from` on.
   * `stage`: still placing ships, or fighting. `ready`: which players have finished deploying.
   */
  | { t: 'sync'; stage: 'deploy' | 'battle'; view: GameState; from: number; events: GameEvent[]; budget: number; ready: { host: boolean; guest: boolean } }
  /** Guest → host: its log no longer lines up; send everything again. */
  | { t: 'resync' }
  /** Guest → host: where its ships are placed, and that it is ready to start. */
  | { t: 'deploy'; poses: Record<string, Pose> }
  /** Guest → host: a game command (the host checks it is the guest's to give). */
  | { t: 'cmd'; cmd: Command }
  /** Host → guest: a command was refused (should not happen; the guest's view is resent with it). */
  | { t: 'refused'; reason: string }
  /** Either way: leaving the game for good. */
  | { t: 'bye' };

/** A connection to the other player. */
export interface Link {
  send(m: Msg): void;
  close(): void;
  onMessage: (m: Msg) => void;
  onClose: () => void;
}

// Codes: 5 letters from an alphabet without look-alikes (no I/L/O/0/1).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const newCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const newSeatToken = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const peerId = (code: string) => `squadron-tactics-${code.toLowerCase()}`;

/** PeerJS options: the public service by default, or `?peer=host:port` for a local PeerJS server (tests). */
function peerOptions(): PeerOptions {
  const custom = new URLSearchParams(location.search).get('peer');
  if (!custom) return { debug: 1 };
  const [host, port] = custom.split(':');
  return { host, port: Number(port || 9000), path: '/', secure: false, debug: 1 };
}

function wrap(conn: DataConnection): Link {
  const link: Link = {
    send: (m) => { if (conn.open) conn.send(m); },
    close: () => conn.close(),
    onMessage: () => {},
    onClose: () => {},
  };
  conn.on('data', (d) => link.onMessage(d as Msg));
  conn.on('close', () => link.onClose());
  conn.on('error', (e) => { console.warn('Connection error', e); link.onClose(); });
  return link;
}

/** Wait for a PeerJS peer to register with the signalling service; rejects with a readable reason. */
function opened(peer: Peer): Promise<void> {
  return new Promise((resolve, reject) => {
    peer.once('open', () => resolve());
    peer.once('error', (e: Error & { type?: string }) => reject(e));
  });
}

export interface Host {
  code: string;
  /** Stop hosting (closes the peer and any connection). */
  stop(): void;
}

/**
 * Host a game under `code`: every guest connection is handed to `onGuest`. Keeps the peer registered (it
 * reconnects to the signalling service if that drops). If the code is still held by a previous session
 * of ours (a reload), retries for a while until the service lets it go.
 */
export async function hostGame(code: string, onGuest: (link: Link) => void, retryForMs = 0): Promise<Host> {
  const started = Date.now();
  for (;;) {
    const peer = new Peer(peerId(code), peerOptions());
    try {
      await opened(peer);
    } catch (e) {
      peer.destroy();
      const type = (e as { type?: string }).type;
      if (type === 'unavailable-id' && Date.now() - started < retryForMs) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      throw new Error(type === 'unavailable-id' ? 'That game code is already in use.' : type === 'network' || type === 'server-error'
        ? 'Could not reach the matchmaking service. Check your connection and try again.' : `Could not start hosting (${type ?? (e as Error).message}).`);
    }
    peer.on('connection', (conn) => conn.on('open', () => onGuest(wrap(conn))));
    peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    return { code, stop: () => peer.destroy() };
  }
}

/** Connect to the game hosted under `code`. Resolves once the connection is open. */
/** Connection setup can take a while on slow networks: give it 30 s before giving up. */
export async function joinGame(code: string, timeoutMs = 30000): Promise<{ link: Link; stop: () => void }> {
  const peer = new Peer(peerOptions());
  try {
    await opened(peer);
  } catch {
    peer.destroy();
    throw new Error('Could not reach the matchmaking service. Check your connection and try again.');
  }
  return new Promise((resolve, reject) => {
    const conn = peer.connect(peerId(code), { reliable: true });
    const timer = setTimeout(() => { peer.destroy(); reject(new Error('No game answered on that code. Check it with your friend, or ask them to host again.')); }, timeoutMs);
    peer.on('error', (e: Error & { type?: string }) => {
      clearTimeout(timer);
      peer.destroy();
      reject(new Error(e.type === 'peer-unavailable' ? 'No game is being hosted with that code.' : `Could not connect (${e.type ?? e.message}).`));
    });
    conn.on('open', () => { clearTimeout(timer); resolve({ link: wrap(conn), stop: () => peer.destroy() }); });
  });
}

// ---------------------------------------------------------------------------
// Saved games: a reload (or closed tab) must not lose a game in progress.
// ---------------------------------------------------------------------------
const HOST_KEY = 'xw-online-host', GUEST_KEY = 'xw-online-guest';

/** Everything the host needs to resume: the game, the code, and the guest's seat token. */
export interface SavedHost {
  code: string; seat: string; budget: number; stage: 'deploy' | 'battle'; state: GameState;
  ready: { host: boolean; guest: boolean }; hints: boolean; savedAt: number;
}
/** What the guest needs to rejoin: the code and its seat token (the host has the game). */
export interface SavedGuest { code: string; seat: string; hints: boolean; savedAt: number }

const read = <T>(key: string): T | null => { try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };
const write = (key: string, v: unknown) => { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or unavailable */ } };
/** Saved games older than a day are dropped. */
const fresh = <T extends { savedAt: number }>(v: T | null) => (v && Date.now() - v.savedAt < 24 * 3600 * 1000 ? v : null);

export const savedHost = () => fresh(read<SavedHost>(HOST_KEY));
export const saveHost = (v: Omit<SavedHost, 'savedAt'> | null) => write(HOST_KEY, v && { ...v, savedAt: Date.now() });
export const savedGuest = () => fresh(read<SavedGuest>(GUEST_KEY));
export const saveGuest = (v: Omit<SavedGuest, 'savedAt'> | null) => write(GUEST_KEY, v && { ...v, savedAt: Date.now() });
