// Tells whether two kit instruments sound the same, or so nearly the same that a kit needs only
// one of them. Each is played alone on two notes and the values it writes to the SID are compared
// frame by frame, so two instruments built from different table rows that come out the same are
// caught, and two that drift apart (another sweep speed, another arpeggio) are not.
import { CPU6502 } from '../src/core/cpu6502.ts';
import { type Song, type Table, newSong, KEYOFF } from '../src/core/song.ts';
import { buildEditorSid, EDIT_PLAYER } from '../src/core/packer.ts';

export interface Prog { rows: [number, number][]; start: number }
export interface Sound { ad: number; sr: number; legatoOnly: boolean; wave: Prog; pulse: Prog; filter: Prog }

/** Frames played per note: the note is held for the first HOLD of them, then released. */
const HOLD = 240, FRAMES = 300;
const NOTES = [40, 59];

export interface Render { key: string; exact: string; notes: number[]; frames: Uint8Array[][] }

const toTable = (p: Prog): Table => ({ left: p.rows.map(r => r[0]), right: p.rows.map(r => r[1]) });
const signed = (v: number) => (v < 0x40 ? v : v - 0x80);

function play(s: Sound, note: number): Uint8Array[] {
  const song: Song = newSong();
  song.tables = [toTable(s.wave), toTable(s.pulse), toTable(s.filter)];
  song.commands[0] = { ad: s.ad, sr: s.sr, wave: s.wave.start, pulse: s.pulse.start, filt: s.filter.start, name: '' };
  song.patterns[0] = [{ note: note * 2, cmd: 1, dur: 40 }, { note: KEYOFF, cmd: 0, dur: 40 }];
  song.patterns[1] = [{ note: KEYOFF, cmd: 0, dur: 40 }, { note: KEYOFF, cmd: 0, dur: 40 }];
  song.tracks[0] = [[0xc0, 1, 0, 0], [0xc0, 2, 0, 0], [0xc0, 2, 0, 0]];
  const { sid } = buildEditorSid(song, '8580');
  const mem = new Uint8Array(0x10000);
  mem.set(sid.subarray(0x7e), EDIT_PLAYER);
  const cpu = new CPU6502(mem);
  const reg = new Uint8Array(25);
  cpu.onWrite = (a, v) => { if (a >= 0xd400 && a < 0xd419) reg[a - 0xd400] = v; };
  cpu.a = 0;
  cpu.call(EDIT_PLAYER);
  const out: Uint8Array[] = [];
  for (let f = 0; f < FRAMES; f++) { cpu.call(EDIT_PLAYER + 3); out.push(reg.slice()); }
  return out;
}

/** Play the instrument on the comparison notes (moved where its own pitch steps would leave the note range). */
export function render(s: Sound): Render {
  const steps = s.wave.rows.filter(r => r[0] < 0xc0 && r[1] < 0x80).map(r => signed(r[1]));
  const notes = NOTES.map(n => Math.max(12 - Math.min(0, ...steps), Math.min(95 - Math.max(0, ...steps), n)));
  const frames = notes.map(n => play(s, n));
  // Only instruments with the same waveform, gate, sync and ring bits on every frame can be alike
  const key = [s.legatoOnly, notes, frames.map(fr => fr.map(r => r[4]).join(','))].join('|');
  const exact = frames.map(fr => fr.map(r => r.join(',')).join(';')).join('|');
  return { key, exact, notes, frames };
}

// Envelope times in ms for the 16 attack values; decay and release take three times as long
const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
/** Two envelope rates are alike when their times are within a quarter of each other, or both are too short to tell apart. */
const rateAlike = (a: number, b: number, scale: number) => {
  const x = ATTACK_MS[a] * scale, y = ATTACK_MS[b] * scale;
  return a === b || Math.abs(x - y) <= 20 || Math.max(x, y) / Math.min(x, y) <= 1.25;
};

export interface Limits { cents: number; pulse: number; cutoff: number; resonance: number; sustain: number }
/** How far apart two instruments may be and still count as one. */
export const NEAR: Limits = { cents: 8, pulse: 0x30, cutoff: 3, resonance: 1, sustain: 1 };
export const EXACT: Limits = { cents: 0, pulse: 0, cutoff: 0, resonance: 0, sustain: 0 };

/** Same sound within the limits: every frame of both notes is compared. */
export function alike(a: Render, b: Render, lim: Limits = NEAR): boolean {
  if (a.key !== b.key) return false;
  if (a.exact === b.exact) return true;
  const exactOnly = lim === EXACT;
  for (let n = 0; n < a.frames.length; n++) {
    for (let f = 0; f < FRAMES; f++) {
      const x = a.frames[n][f], y = b.frames[n][f];
      const ctrl = x[4];
      if (exactOnly) return false;
      // Pitch
      const fx = x[0] | x[1] << 8, fy = y[0] | y[1] << 8;
      if (fx !== fy) {
        if (!fx || !fy) return false;
        if (Math.abs(1200 * Math.log2(fx / fy)) > lim.cents) return false;
      }
      // Pulse width matters only while the pulse waveform sounds
      if (ctrl & 0x40) {
        const px = (x[2] | x[3] << 8) & 0xfff, py = (y[2] | y[3] << 8) & 0xfff;
        // widths mirror around the middle: 0x400 and 0xc00 sound the same
        const wx = Math.abs(px - 0x800), wy = Math.abs(py - 0x800);
        if (Math.abs(wx - wy) > lim.pulse) return false;
      }
      // Envelope
      if (x[5] !== y[5] || x[6] !== y[6]) {
        if (!rateAlike(x[5] >> 4, y[5] >> 4, 1) || !rateAlike(x[5] & 15, y[5] & 15, 3) || !rateAlike(x[6] & 15, y[6] & 15, 3)) return false;
        const sx = x[6] >> 4, sy = y[6] >> 4;
        if (Math.abs(sx - sy) > lim.sustain || (!sx) !== (!sy)) return false;
      }
      // Filter: routing, type and volume must match; cutoff and resonance may be a little apart.
      // The cutoff is compared whatever the routing: a program may filter another channel than
      // the one played here, or move the cutoff of a filter that another instrument switched on.
      if ((x[23] & 15) !== (y[23] & 15) || x[24] !== y[24]) return false;
      if (Math.abs((x[23] >> 4) - (y[23] >> 4)) > lim.resonance) return false;
      if (Math.abs(x[22] - y[22]) > lim.cutoff) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The same program with slightly different numbers
// ---------------------------------------------------------------------------

/** Two amounts are alike when they are within a quarter of each other (or one step, for small ones). */
const near = (a: number, b: number) => a === b || Math.abs(a - b) <= 1 || (a > 0 && b > 0 && Math.max(a, b) / Math.min(a, b) <= 1.25);
const speed = (v: number) => (v < 0x80 ? v : v - 0x100);
const nearSpeed = (a: number, b: number) => Math.sign(speed(a)) === Math.sign(speed(b)) && near(Math.abs(speed(a)), Math.abs(speed(b)));

function sameShape(a: Prog, b: Prog, row: (x: [number, number], y: [number, number]) => boolean): boolean {
  if (a.start !== b.start || a.rows.length !== b.rows.length) return false;
  return a.rows.every((x, k) => {
    const y = b.rows[k];
    if (x[0] === 0xff || y[0] === 0xff) return x[0] === y[0] && x[1] === y[1];
    return row(x, y);
  });
}

function waveRow(x: [number, number], y: [number, number]): boolean {
  const [l, r] = x, [m, s] = y;
  if (l < 0x90 || m < 0x90) return l === m && r === s;                              // waveform and note: exact
  if (l < 0xc0) return m < 0xc0 && r === s && (l - 0x90 >= 6 ? near(l - 0x90, m - 0x90) && m - 0x90 >= 5 : l === m); // short delays are arpeggio speeds
  if (l < 0xe0) return l === m && near(r, s);                                        // vibrato: same speed, depth alike
  return m >= 0xe0 && near((l - 0xe0) << 8 | r, (m - 0xe0) << 8 | s);               // slide speed
}
const mirror = (v: number) => Math.abs(v - 0x80);
function pulseRow(x: [number, number], y: [number, number]): boolean {
  if (x[0] >= 0x80 || y[0] >= 0x80) return x[0] === y[0] && Math.abs(mirror(x[1]) - mirror(y[1])) <= 3;
  return near(x[0], y[0]) && nearSpeed(x[1], y[1]);
}
function filterRow(x: [number, number], y: [number, number]): boolean {
  if (x[0] >= 0x80 || y[0] >= 0x80) return x[0] === y[0] && Math.abs(x[1] - y[1]) <= 3;
  return near(x[0], y[0]) && nearSpeed(x[1], y[1]);
}

/** The same envelope, give or take: rates one step apart at most, sustain one level apart and silent in both or neither. */
function envelopeAlike(a: Sound, b: Sound): boolean {
  const step = (x: number, y: number) => Math.abs(x - y) <= 1;
  const sa = a.sr >> 4, sb = b.sr >> 4;
  return rateAlike(a.ad >> 4, b.ad >> 4, 1) && step(a.ad & 15, b.ad & 15) && step(a.sr & 15, b.sr & 15) && step(sa, sb) && !sa === !sb;
}

/** Built the same way row for row, with every amount (delay, depth, speed, width, cutoff, envelope) close. */
export function alikeShape(a: Sound, b: Sound): boolean {
  return a.legatoOnly === b.legatoOnly && envelopeAlike(a, b) &&
    sameShape(a.wave, b.wave, waveRow) && sameShape(a.pulse, b.pulse, pulseRow) && sameShape(a.filter, b.filter, filterRow);
}
