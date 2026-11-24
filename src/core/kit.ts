// The instrument kit: instruments lifted out of existing NinjaTracker 2 tunes by
// scripts/extract-instruments.ts, each with its own table rows, ready to be added to any song.

import { type Song, MAX_TBLLEN } from './song.ts';

export interface KitSource {
  file: string; song: string; released: string; model: string; cmd: number; hrParam: number; firstWave: number;
  uses: number; legatoUses: number; lowNote: number; highNote: number; typicalNote: number; channels: number[]; subtunes: number[];
}

/** An instrument as stored in the kit file: bytes as hex text, table rows as "LLRR LLRR ...". */
export interface KitInstrument {
  name: string; category: string; description: string;
  ad: string; sr: string; legatoOnly?: boolean;
  wave: string; pulse: string; filter: string;
  waveStart?: number; pulseStart?: number; filterStart?: number;
  verified?: boolean;
  sources: KitSource[];
}

export interface KitMusician { id: string; name: string; songs: string[]; instruments: KitInstrument[] }
export interface Kit { format: string; version: number; musicians: KitMusician[] }

export function parseKit(text: string): Kit {
  const kit = JSON.parse(text) as Kit;
  if (kit?.format !== 'nt2-instrument-kit' || !Array.isArray(kit.musicians)) throw new Error('This is not an instrument kit file');
  return kit;
}

/** Table rows of one program: [left, right] pairs. Jumps count rows of this program from 1. */
export function kitRows(text: string): [number, number][] {
  return text.trim() ? text.trim().split(/\s+/).map(w => [parseInt(w.slice(0, 2), 16), parseInt(w.slice(2, 4), 16)] as [number, number]) : [];
}

const PTR = ['wave', 'pulse', 'filt'] as const;
const TABLE_NAME = ['wave', 'pulse', 'filter'];

/** The source the instrument was used most in: the best guide to how it is meant to be played. */
export function kitMainSource(ins: KitInstrument): KitSource {
  return ins.sources.reduce((best, s) => (s.uses > best.uses ? s : best), ins.sources[0]);
}

/** A note (number, C-1 = 12) that suits the instrument and that its own pitch steps keep in range. */
export function kitTestNote(ins: KitInstrument): number {
  const steps = kitRows(ins.wave).filter(r => r[0] < 0xc0 && r[1] < 0x80).map(r => (r[1] < 0x40 ? r[1] : r[1] - 0x80));
  const typical = kitMainSource(ins).typicalNote || 48;
  return Math.max(12 - Math.min(0, ...steps), Math.min(95 - Math.max(0, ...steps), typical));
}

/**
 * Add a kit instrument to a song: its table rows go to the end of the three tables and the first
 * unused command points at them. Returns the command index, or a message saying why it does not fit.
 * The song is only changed when it fits.
 */
export function addKitInstrument(song: Song, ins: KitInstrument): number | string {
  const free = song.commands.findIndex(c => !(c.ad || c.sr || c.wave || c.pulse || c.filt || c.name));
  if (free < 0) return 'All 127 instruments are in use';
  const progs = [kitRows(ins.wave), kitRows(ins.pulse), kitRows(ins.filter)];
  const starts = [ins.waveStart ?? 1, ins.pulseStart ?? 1, ins.filterStart ?? 1];
  for (let t = 0; t < 3; t++) {
    const room = MAX_TBLLEN - song.tables[t].left.length;
    if (progs[t].length > room) return `The ${TABLE_NAME[t]} table is too full: ${progs[t].length} rows needed, ${room} free`;
  }
  const cmd = { ad: parseInt(ins.ad, 16), sr: parseInt(ins.sr, 16), wave: 0, pulse: 0, filt: 0, name: ins.name };
  for (let t = 0; t < 3; t++) {
    if (!progs[t].length) continue;
    const tbl = song.tables[t], base = tbl.left.length;
    for (const [l, r] of progs[t]) {
      tbl.left.push(l);
      tbl.right.push(l === 0xff && r ? r + base : r); // jumps move with the program
    }
    cmd[PTR[t]] = base + starts[t];
  }
  song.commands[free] = cmd;
  return free;
}
