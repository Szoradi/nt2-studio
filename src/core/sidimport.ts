// Import packed NinjaTracker 2 tunes (.sid, packed .prg, gamemusic data) back into an editable Song.
//
// A packed tune has no index of its tables, so their addresses are read out of the playroutine's
// own instructions. The instructions are found by their opcode patterns rather than at fixed
// offsets, which also copes with player builds that differ slightly from V2.03.

import {
  type Song, newSong, unpackPattern, unpackTracks, MAX_PATT, MAX_CMD, MAX_SONGS, MAX_TBLLEN,
} from './song.ts';

export interface ImportResult {
  song: Song;
  name: string;
  author: string;
  /** SID chip model the file asks for, if it says (.sid files only). */
  model?: '6581' | '8580';
  /** Human readable notes about what was found. */
  report: string[];
}

const X = -1; // wildcard byte in a pattern

function find(code: Uint8Array, pattern: number[], from = 0): number {
  outer: for (let i = from; i + pattern.length <= code.length; i++) {
    for (let k = 0; k < pattern.length; k++) if (pattern[k] !== X && code[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

const word = (code: Uint8Array, o: number) => code[o] | (code[o + 1] << 8);

/** Undo the packer's pulse speed conversion (nybbles swapped, negative modulation decremented). */
function unconvertPulseRight(time: number, stored: number): number {
  if (time === 0xff) return stored;
  let v = ((stored << 4) | (stored >> 4)) & 0xff;
  if (time < 0x80 && v >= 0x80) v = (v + 1) & 0xff;
  return v;
}

interface Layout {
  wave: number; note: number; pulseTime: number; pulseSpd: number; filtTime: number; filtSpd: number;
  cmdAd: number; cmdSr: number; cmdWave: number; cmdPulse: number; cmdFilt: number;
  pattLo: number; pattHi: number; songTbl: number;
}

/** Rebuild a song from the music data once the table addresses are known. `mem` is indexed by C64 address. */
function buildSong(mem: Uint8Array, end: number, L: Layout, report: string[]): Song {
  const song = newSong();
  song.patterns[0] = [];
  song.tracks[0] = [[], [], []];
  const slice = (a: number, n: number) => Array.from(mem.subarray(a, a + n));
  const sane = (n: number, max: number, what: string) => {
    if (!(n >= 0 && n <= max)) throw new Error(`This does not look like a NinjaTracker 2 tune (${what} size ${n})`);
    return n;
  };

  const waveLen = sane(L.note - L.wave, MAX_TBLLEN, 'wave table');
  const pulseLen = sane(L.pulseSpd - L.pulseTime, MAX_TBLLEN, 'pulse table');
  const filtLen = sane(L.filtSpd - L.filtTime, MAX_TBLLEN, 'filter table');
  song.tables[0] = { left: slice(L.wave, waveLen).map(v => (v >= 0xc0 && v < 0xe0 ? v ^ 0x1f : v)), right: slice(L.note, waveLen) };
  const pt = slice(L.pulseTime, pulseLen);
  song.tables[1] = { left: pt, right: slice(L.pulseSpd, pulseLen).map((v, i) => unconvertPulseRight(pt[i], v)) };
  song.tables[2] = { left: slice(L.filtTime, filtLen), right: slice(L.filtSpd, filtLen) };

  const cmds = sane(L.cmdSr - L.cmdAd, MAX_CMD, 'command');
  const legato = sane(L.cmdPulse - L.cmdWave, MAX_CMD, 'legato command');
  for (let i = 0; i < legato; i++) {
    song.commands[i] = {
      ad: i < cmds ? mem[L.cmdAd + i] : 0, sr: i < cmds ? mem[L.cmdSr + i] : 0,
      wave: mem[L.cmdWave + i], pulse: mem[L.cmdPulse + i], filt: mem[L.cmdFilt + i], name: '',
    };
  }

  const patterns = sane(L.pattHi - L.pattLo, MAX_PATT, 'pattern table');
  const pattAddr: number[] = [];
  for (let i = 0; i < patterns; i++) pattAddr.push(mem[L.pattLo + i] | (mem[L.pattHi + i] << 8));
  if (!patterns) throw new Error('The tune has no patterns');
  const firstPattern = Math.min(...pattAddr);
  for (let i = 0; i < patterns; i++) {
    // An empty pattern takes no bytes: it shares its address with the next one
    const empty = i + 1 < patterns && pattAddr[i + 1] === pattAddr[i];
    if (!empty) song.patterns[i] = unpackPattern(mem, pattAddr[i]);
  }

  const songs = sane((firstPattern - L.songTbl) / 5, MAX_SONGS, 'song table');
  if (!Number.isInteger(songs) || songs < 1) throw new Error('Could not work out the number of subtunes');
  const trackAddr: number[] = [];
  for (let s = 0; s < songs; s++) trackAddr.push(word(mem, L.songTbl + s * 5));
  for (let s = 0; s < songs; s++) {
    const e = L.songTbl + s * 5;
    const len0 = mem[e + 3], len01 = mem[e + 4];
    const total = (s + 1 < songs ? trackAddr[s + 1] : end) - trackAddr[s];
    const lens = [len0, len01 - len0, total - len01];
    if (lens.some(n => n < 0 || n > 256)) throw new Error(`Subtune ${s} has impossible track lengths`);
    song.tracks[s] = unpackTracks(mem.subarray(trackAddr[s], trackAddr[s] + total), lens);
  }
  report.push(`${songs} subtune${songs === 1 ? '' : 's'}, ${patterns} patterns, ${legato} commands, tables ${waveLen}/${pulseLen}/${filtLen}`);
  return song;
}

/** Player + music: find the table addresses in the player code. `mem` is the C64 memory image. */
function importWithPlayer(mem: Uint8Array, start: number, end: number, report: string[]): Song {
  const code = mem.subarray(start, end);
  const need = (pattern: number[], what: string): number => {
    const i = find(code, pattern);
    if (i < 0) throw new Error(`Not a NinjaTracker 2 tune, or an unknown player version (${what} not found)`);
    return i;
  };
  // Each pattern is a run of opcodes from the playroutine with the operands left open.
  // Indexed table accesses are written "table-1,y", hence the +1.
  const iSong = need([0xb9, X, X, 0x8d, X, X, 0xb9, X, X, 0x8d, X, X, 0x8a, 0x8d], 'song table');
  const iFilt = need([0xb9, X, X, 0x10, X, 0xc9, 0xff, 0xb0, X, 0x8d, 0x17, 0xd4, 0x29, 0x70, 0x8d, X, X, 0xb9, X, X], 'filter table');
  const iPatt = need([0xbc, X, X, 0xb9, X, X, 0x85, X, 0xb9, X, X, 0x85, X, 0xbc, X, X, 0xb1], 'pattern table');
  const iAdsr = need([0xb9, X, X, 0x9d, 0x05, 0xd4, 0xb9, X, X, 0x9d, 0x06, 0xd4], 'command ADSR');
  const iPtrs = need([0xb9, X, X, 0xf0, X, 0x9d, X, X, 0xa9, 0x00, 0x9d, X, X, 0xb9, X, X, 0xf0, X, 0x9d, X, X, 0xa9, 0x00, 0x9d, X, X, 0xb9, X, X, 0xf0, X, 0x8d], 'command pointers');
  const iPulseT = need([0xbc, X, X, 0xf0, X, 0xb9, X, X, 0x30], 'pulse table');
  const iPulseS = need([0x79, X, X, 0x69, 0x00], 'pulse speed table');
  const iWave = need([0xbc, X, X, 0xf0, X, 0xb9, X, X, 0xc9, 0xc0], 'wave table');
  const iNote = need([0xb9, X, X, 0x0a, 0xb0], 'note table');
  const L: Layout = {
    songTbl: word(code, iSong + 1),
    filtTime: word(code, iFilt + 1) + 1, filtSpd: word(code, iFilt + 18) + 1,
    pattLo: word(code, iPatt + 4) + 1, pattHi: word(code, iPatt + 9) + 1,
    cmdAd: word(code, iAdsr + 1) + 1, cmdSr: word(code, iAdsr + 7) + 1,
    cmdWave: word(code, iPtrs + 1) + 1, cmdPulse: word(code, iPtrs + 14) + 1, cmdFilt: word(code, iPtrs + 27) + 1,
    pulseTime: word(code, iPulseT + 6) + 1, pulseSpd: word(code, iPulseS + 1) + 1,
    wave: word(code, iWave + 6) + 1, note: word(code, iNote + 1) + 1,
  };
  const song = buildSong(mem, end, L, report);

  // Hard restart parameters are immediate operands in the player
  const iHr = find(code, [0xa9, 0xfe, 0x9d, X, X, 0x9d, 0x05, 0xd4, 0xa9, X, 0x9d, 0x06, 0xd4]);
  const iFw = find(code, [0xa9, 0xff, 0x9d, X, X, 0xa9, X, 0x9d, 0x04, 0xd4]);
  if (iHr >= 0) song.hrParam = code[iHr + 9];
  if (iFw >= 0) song.firstWave = code[iFw + 6];

  // V2.03 starts a note when the duration counter reaches 2; earlier 2.x players differ, and their
  // durations are numbered differently
  const iReload = find(code, [0xbd, X, X, 0xc9, X, 0xd0, X, 0xbd, X, X, 0x9d]);
  if (iReload >= 0 && code[iReload + 4] !== 0x02) {
    report.push(`Older player (note start at counter ${code[iReload + 4]}): durations may be one frame off; check the timing`);
  }
  report.push(`Player at $${start.toString(16).toUpperCase()}, music data $${L.wave.toString(16).toUpperCase()}-$${(end - 1).toString(16).toUpperCase()}`);
  return song;
}

/** Gamemusic data: a six byte header with the table sizes, then the music. */
function importGamemusic(data: Uint8Array, report: string[]): Song | null {
  for (const skip of [0, 2]) {
    const d = data.subarray(skip);
    if (d.length < 12) continue;
    const [waveLen, pulseLen, filtLen, cmds, legato, patterns] = d;
    if (!patterns || patterns > MAX_PATT || cmds > legato || legato > MAX_CMD) continue;
    const off = {
      wave: 6, note: 6 + waveLen, pulseTime: 6 + 2 * waveLen, pulseSpd: 6 + 2 * waveLen + pulseLen,
      filtTime: 6 + 2 * waveLen + 2 * pulseLen, filtSpd: 6 + 2 * waveLen + 2 * pulseLen + filtLen,
    };
    const cmdAd = off.filtSpd + filtLen, cmdSr = cmdAd + cmds, cmdWave = cmdSr + cmds;
    const cmdPulse = cmdWave + legato, cmdFilt = cmdPulse + legato;
    const pattLo = cmdFilt + legato, pattHi = pattLo + patterns, songTbl = pattHi + patterns;
    if (songTbl + 5 > d.length) continue;
    // Pattern and track pointers are absolute: the base address follows from where the track data must be
    const trackPtr = word(d, songTbl);
    const firstPatt = Math.min(...Array.from({ length: patterns }, (_, i) => d[pattLo + i] | (d[pattHi + i] << 8)));
    const lastPatt = Math.max(...Array.from({ length: patterns }, (_, i) => d[pattLo + i] | (d[pattHi + i] << 8)));
    // The number of subtunes is not stored. Try each count: the first pattern starts right after
    // the song table, and the right count is the one where the tracks begin exactly where the
    // last pattern ends.
    for (let n = 1; n <= MAX_SONGS; n++) {
      const base = firstPatt - (songTbl + n * 5);
      if (base < 0 || base + d.length > 0x10000 || trackPtr < base || trackPtr - base >= d.length) continue;
      let pattEnd = lastPatt - base;
      while (pattEnd < d.length && d[pattEnd] !== 0) pattEnd++;
      if (pattEnd + 1 !== trackPtr - base) continue;
      const mem = new Uint8Array(0x10000);
      mem.set(d, base);
      const L: Layout = {
        wave: base + off.wave, note: base + off.note, pulseTime: base + off.pulseTime, pulseSpd: base + off.pulseSpd,
        filtTime: base + off.filtTime, filtSpd: base + off.filtSpd,
        cmdAd: base + cmdAd, cmdSr: base + cmdSr, cmdWave: base + cmdWave, cmdPulse: base + cmdPulse, cmdFilt: base + cmdFilt,
        pattLo: base + pattLo, pattHi: base + pattHi, songTbl: base + songTbl,
      };
      try {
        const local: string[] = [];
        const song = buildSong(mem, base + d.length, L, local);
        report.push(...local, `Gamemusic data for address $${base.toString(16).toUpperCase()}`);
        return song;
      } catch { /* try the next subtune count */ }
    }
  }
  return null;
}

const latin1 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) { if (!b) break; s += String.fromCharCode(b); }
  return s.trim();
};

/** Import a packed NinjaTracker 2 tune. Throws with an explanation if the file is not one. */
export function importPacked(data: Uint8Array, fileName: string): ImportResult {
  const report: string[] = [];
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const isSid = data.length > 0x7c && (latin1(data.subarray(0, 4)) === 'PSID' || latin1(data.subarray(0, 4)) === 'RSID');
  if (isSid) {
    const dataOffset = (data[6] << 8) | data[7];
    let load = (data[8] << 8) | data[9];
    let body = data.subarray(dataOffset);
    if (load === 0) { load = word(body, 0); body = body.subarray(2); }
    const mem = new Uint8Array(0x10000);
    mem.set(body.subarray(0, 0x10000 - load), load);
    const title = latin1(data.subarray(0x16, 0x36)), author = latin1(data.subarray(0x36, 0x56));
    report.push(`SID file: "${title}"${author ? ` by ${author}` : ''}`);
    const song = importWithPlayer(mem, load, load + body.length, report);
    // PSID v2+ flags: bits 4-5 give the intended SID model (1 = 6581, 2 = 8580), bits 2-3 the video standard
    const version = (data[4] << 8) | data[5];
    const flags = version >= 2 ? (data[0x76] << 8) | data[0x77] : 0;
    const modelBits = (flags >> 4) & 3;
    const model = modelBits === 1 ? '6581' : modelBits === 2 ? '8580' : undefined;
    if (model) report.push(`made for the ${model}`);
    if (((flags >> 2) & 3) === 2) report.push('NTSC tune: the editor plays at PAL speed, so it will sound slower');
    return { song, name: baseName, author, model, report };
  }
  // Packed .prg: load address, then the player
  if (data.length > 64) {
    const load = word(data, 0);
    const body = data.subarray(2);
    if (body[0] === 0x4c && load + body.length <= 0x10000) {
      const mem = new Uint8Array(0x10000);
      mem.set(body, load);
      try {
        const song = importWithPlayer(mem, load, load + body.length, report);
        report.unshift('Packed program (player + music)');
        return { song, name: baseName, author: '', report };
      } catch { /* fall through to gamemusic */ }
    }
  }
  const game = importGamemusic(data, report);
  if (game) return { song: game, name: baseName, author: '', report };
  throw new Error(`${fileName} is not a NinjaTracker 2 song, disk image, or packed NinjaTracker 2 tune`);
}
