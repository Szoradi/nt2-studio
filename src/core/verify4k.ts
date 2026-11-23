// Plays a 4k export next to the normal packed tune in the 6502 core and compares every SID
// write. The export leaves out player code, table rows and frequencies it decided the song does
// not need; this is the check that those decisions were right for this particular song.

import { assemble } from './asm6502.ts';
import { CPU6502 } from './cpu6502.ts';
import { packNormal } from './packer.ts';
import { type Song, patternDuration } from './song.ts';
import type { Export4k } from './export4k.ts';

export interface Verify4k {
  ok: boolean;
  /** Frames compared. */
  frames: number;
  /** Frames where only the frequency of a voice that had never been keyed on differed (see below). */
  silentFrames: number;
  /** First frame that differs, with the SID writes (register=value, hex) of both players. */
  frame?: number;
  normal?: string;
  exported?: string;
}

const ORG = 0x1000;

/** Enough frames to play every channel through its track and loop twice, within 1 to 10 minutes. */
export function verifyFrames(song: Song, subtune = 0): number {
  let longest = 0;
  for (const t of song.tracks[subtune] ?? []) {
    let len = 0;
    for (const v of t.slice(0, -2)) if (v > 0 && v < 0x80) len += patternDuration(song.patterns[v - 1] ?? []);
    longest = Math.max(longest, len);
  }
  return Math.min(30000, Math.max(3000, longest * 3));
}

function player(bytes: Uint8Array) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, ORG);
  const cpu = new CPU6502(mem);
  const writes: number[] = [];
  cpu.onWrite = (addr, v) => { if (addr >= 0xd400 && addr < 0xd419) writes.push(((addr - 0xd400) << 8) | v); };
  return { cpu, writes };
}

// A command can run on a keyoff row before the channel has played any note. The player then
// reads the two bytes below the frequency table, which are code bytes and differ between any
// two builds of the player. That voice has never been gated, so its envelope is at zero and the
// frequency cannot be heard; such differences are counted but not treated as failures.
const FREQ_REGS = new Set([0, 1, 7, 8, 14, 15]);

const show = (w: number[]) => w.map(x => `${(x >> 8).toString(16)}=${(x & 0xff).toString(16)}`).join(' ') || '(nothing)';

export function verify4k(song: Song, ex: Export4k, subtune = 0, frames = verifyFrames(song, subtune)): Verify4k {
  const a = player(packNormal(song, ORG, 0xfc).bytes);
  a.cpu.a = subtune;
  a.cpu.call(ORG);
  a.cpu.call(ORG + 3); // the normal player sets the song up during its first play call
  const asm = assemble(ex.dasm, ORG);
  const b = player(asm.bytes);
  b.cpu.call(asm.symbols.nt_init);
  const gated = [false, false, false];
  let silentFrames = 0;
  for (let f = 0; f < frames; f++) {
    a.writes.length = 0;
    b.writes.length = 0;
    const okA = a.cpu.call(ORG + 3), okB = b.cpu.call(asm.symbols.nt_play);
    let same = okA && okB && a.writes.length === b.writes.length, silent = false;
    for (let i = 0; same && i < a.writes.length; i++) {
      const wa = a.writes[i], wb = b.writes[i], reg = wa >> 8;
      if (reg < 21 && reg % 7 === 4 && (wa & 1)) gated[Math.floor(reg / 7)] = true;
      if (wa === wb) continue;
      if (reg === wb >> 8 && FREQ_REGS.has(reg) && !gated[Math.floor(reg / 7)]) silent = true;
      else same = false;
    }
    if (!same) {
      return { ok: false, frames, silentFrames, frame: f, normal: okA ? show(a.writes) : 'did not return', exported: okB ? show(b.writes) : 'did not return' };
    }
    if (silent) silentFrames++;
  }
  return { ok: true, frames, silentFrames };
}
