// NinjaTracker V2.03 song model and the conversions between the editable
// form and the byte formats the playroutine reads.

export const MAX_SONGS = 16;
export const MAX_PATT = 127;
export const MAX_CMD = 127;
export const MAX_CMDNAMELEN = 9;
export const MAX_PATTLEN = 192;
export const MAX_SONGLEN = 256;
export const MAX_TBLLEN = 255;

export const KEYON = 0x04;
export const KEYOFF = 0x08;
export const FIRSTNOTE = 0x18;
export const LASTNOTE = 0xbe;
export const DUR = 0xc0;
export const MINDUR = 3;
export const MAXDUR = 65;

export const TBL_WAVE = 0;
export const TBL_PULSE = 1;
export const TBL_FILTER = 2;

/** One pattern step. `note` is KEYON, KEYOFF or note number * 2; `cmd` 0 = none, bit 7 = legato; `dur` 0 = keep. */
export interface Row { note: number; cmd: number; dur: number }
export interface Command { ad: number; sr: number; wave: number; pulse: number; filt: number; name: string }
export interface Table { left: number[]; right: number[] }

export interface Song {
  hrParam: number;
  firstWave: number;
  /** Wave, pulse and filter tables in editor form (row 1 is index 0). */
  tables: [Table, Table, Table];
  /** Always MAX_CMD entries; command number n is index n-1. */
  commands: Command[];
  /** Always MAX_PATT entries; pattern number n is index n-1. */
  patterns: Row[][];
  /** [subtune][channel] track bytes in editor form, ending with 00 + loop position. */
  tracks: number[][][];
}

export function emptyCommand(): Command {
  return { ad: 0, sr: 0, wave: 0, pulse: 0, filt: 0, name: '' };
}

export function newSong(): Song {
  const patterns: Row[][] = [];
  for (let i = 0; i < MAX_PATT; i++) patterns.push([]);
  // Like the original: pattern 1 holds one long keyoff so an empty song is silent
  patterns[0] = [{ note: KEYOFF, cmd: 0, dur: 64 }];
  const tracks: number[][][] = [];
  for (let s = 0; s < MAX_SONGS; s++) tracks.push([[], [], []]);
  tracks[0] = [[1, 0, 0], [1, 0, 0], [1, 0, 0]];
  const commands: Command[] = [];
  for (let i = 0; i < MAX_CMD; i++) commands.push(emptyCommand());
  return {
    hrParam: 0x00,
    firstWave: 0x09,
    tables: [{ left: [], right: [] }, { left: [], right: [] }, { left: [], right: [] }],
    commands,
    patterns,
    tracks,
  };
}

export function cloneSong(song: Song): Song {
  return structuredClone(song);
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export function packedPatternSize(rows: Row[]): number {
  if (!rows.length) return 0;
  let n = 1;
  for (const r of rows) n += 1 + (r.cmd ? 1 : 0) + (r.dur ? 1 : 0);
  return n;
}

/** Pack a pattern to player format. An empty pattern packs to a single end mark. */
export function packPattern(rows: Row[]): Uint8Array {
  const out: number[] = [];
  for (const r of rows) {
    if (r.note >= FIRSTNOTE) {
      if (r.cmd) out.push(r.note | 0x01, r.cmd);
      else out.push(r.note & 0xfe);
    } else {
      if (r.cmd) out.push(r.note & 0xfc, r.cmd);
      else out.push((r.note & 0xfc) | 0x02);
    }
    if (r.dur) out.push((r.dur - 3) ^ 0xff);
  }
  out.push(0);
  return Uint8Array.from(out);
}

/** Byte offsets of each row inside the packed pattern (for the play position display). */
export function patternRowOffsets(rows: Row[]): number[] {
  const offs: number[] = [];
  let o = 0;
  for (const r of rows) {
    offs.push(o);
    o += 1 + (r.cmd ? 1 : 0) + (r.dur ? 1 : 0);
  }
  return offs;
}

export function unpackPattern(data: Uint8Array, start = 0): Row[] {
  const rows: Row[] = [];
  let p = start;
  while (p < data.length && data[p] !== 0 && rows.length < MAX_PATTLEN) {
    const b = data[p++];
    const row: Row = { note: KEYOFF, cmd: 0, dur: 0 };
    if (b >= FIRSTNOTE) {
      row.note = b & 0xfe;
      if (b & 1) row.cmd = data[p++];
    } else {
      row.note = b & 0xfc;
      if (!(b & 2)) row.cmd = data[p++];
    }
    if (p < data.length && data[p] >= DUR) row.dur = (data[p++] ^ 0xff) + 3;
    rows.push(row);
  }
  return rows;
}

/**
 * Total length of a pattern in frames. Rows before the first duration of the pattern last for
 * `carried`, the duration the channel had when the pattern began (none: they count as nothing).
 */
export function patternDuration(rows: Row[], carried = 0): number {
  let total = 0, dur = carried;
  for (const r of rows) {
    if (r.dur) dur = r.dur;
    total += dur;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** Convert the three editor tracks of a subtune to the stored/player form. */
export function packTracks(tracks: number[][]): { data: Uint8Array; lens: [number, number, number] } {
  const out: number[] = [];
  let base = 0;
  for (let c = 0; c < 3; c++) {
    const t = tracks[c];
    for (let i = 0; i < t.length; i++) {
      let v = t[i];
      if (i === t.length - 1) v = (v + base) & 0xff; // loop position becomes absolute
      else if (v >= 0x80) v = ((v - 0x41) & 0xff) | 0x80; // transpose: C0 = none -> FF
      out.push(v);
    }
    base += t.length;
  }
  return { data: Uint8Array.from(out), lens: [tracks[0].length, tracks[1].length, tracks[2].length] };
}

export function unpackTracks(data: Uint8Array, lens: number[]): number[][] {
  const tracks: number[][] = [];
  let base = 0;
  for (let c = 0; c < 3; c++) {
    const t: number[] = [];
    for (let i = 0; i < lens[c]; i++) {
      let v = data[base + i];
      if (i === lens[c] - 1) v = (v - base) & 0xff;
      else if (v >= 0x80) v = ((v + 0x41) & 0xff) | 0x80;
      t.push(v);
    }
    tracks.push(t);
    base += lens[c];
  }
  return tracks;
}

export function songTrackBytes(tracks: number[][]): number {
  return tracks[0].length + tracks[1].length + tracks[2].length;
}

/** A track is playable when it ends with a loop command (00) and a loop position inside the track. */
export function trackProblem(track: number[]): string | null {
  if (track.length === 0) return null;
  if (track.length < 3) return 'needs a pattern and a 00 xx loop';
  if (track[track.length - 2] !== 0) return 'must end with 00 xx (loop)';
  const pos = track[track.length - 1];
  if (pos >= track.length - 2) return 'loop position is outside the track';
  if (track[pos] === 0) return 'loop position points at a loop command';
  return null;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Wavetable left column as the player wants it (vibrato speed is reversed). */
export function convertWaveLeft(v: number): number {
  return v >= 0xc0 && v < 0xe0 ? v ^ 0x1f : v;
}

const swapNybbles = (v: number) => ((v << 4) | (v >> 4)) & 0xff;

/** Pulse table right column as the player wants it (nybbles swapped, see converttables). */
export function convertPulseRight(time: number, spd: number): number {
  if (time === 0xff) return spd;
  if (time >= 0x80) return swapNybbles(spd);
  if (spd >= 0x80) {
    spd = (spd - 1) & 0xff;
    if (spd < 0x80) spd = 0x80;
  }
  return swapNybbles(spd);
}

// ---------------------------------------------------------------------------
// Usage scan (what the packer needs to save)
// ---------------------------------------------------------------------------

export interface Usage { lastPatt: number; lastSong: number; lastCmd: number; lastLegatoCmd: number }

export function scanUsage(song: Song): Usage {
  let lastPatt = 0;
  for (let i = MAX_PATT - 1; i >= 0; i--) if (song.patterns[i].length) { lastPatt = i; break; }
  let lastCmd = 0, lastLegato = 0;
  for (let i = 0; i <= lastPatt; i++) {
    for (const r of song.patterns[i]) {
      if (!r.cmd) continue;
      if (r.cmd & 0x80) lastLegato = Math.max(lastLegato, r.cmd & 0x7f);
      else lastCmd = Math.max(lastCmd, r.cmd);
    }
  }
  if (lastLegato < lastCmd) lastLegato = lastCmd;
  let lastSong = 0;
  for (let s = MAX_SONGS - 1; s >= 0; s--) if (songTrackBytes(song.tracks[s]) > 0) { lastSong = s; break; }
  return { lastPatt, lastSong, lastCmd, lastLegatoCmd: lastLegato };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

export function noteName(note: number): string {
  if (note === KEYOFF) return '---';
  if (note === KEYON) return '+++';
  const n = note >> 1;
  return NOTE_NAMES[n % 12] + Math.floor(n / 12);
}

export const hex2 = (v: number) => (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
export const hex4 = (v: number) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');
