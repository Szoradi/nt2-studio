// Load and save the original NinjaTracker V2 editor song format: the letters
// "N2" followed by a run-length coded dump of the editor's song memory.

import {
  type Song, type Command, type Row, newSong, packPattern, unpackPattern, packTracks, unpackTracks,
  MAX_PATT, MAX_PATTLEN, MAX_SONGS, MAX_SONGLEN, MAX_CMD, MAX_CMDNAMELEN, MAX_TBLLEN, MINDUR,
} from './song.ts';

const ESC = 0xbf;
const TBL = MAX_TBLLEN + 1;

const OFF_TABLES = 0;
const OFF_PATTERNS = OFF_TABLES + 6 * TBL;
const OFF_TRACKS = OFF_PATTERNS + MAX_PATT * MAX_PATTLEN;
const OFF_CMDAD = OFF_TRACKS + MAX_SONGS * MAX_SONGLEN;
const OFF_CMDSR = OFF_CMDAD + MAX_CMD;
const OFF_CMDWAVE = OFF_CMDSR + MAX_CMD;
const OFF_CMDPULSE = OFF_CMDWAVE + MAX_CMD;
const OFF_CMDFILT = OFF_CMDPULSE + MAX_CMD;
const OFF_NAMES = OFF_CMDFILT + MAX_CMD;
const OFF_SONGLEN = OFF_NAMES + MAX_CMD * (MAX_CMDNAMELEN + 1);
const OFF_TBLLEN = OFF_SONGLEN + MAX_SONGS * 3;
const OFF_CMDLEN = OFF_TBLLEN + 3;
const OFF_HRPARAM = OFF_CMDLEN + 1;
const OFF_FIRSTWAVE = OFF_HRPARAM + 1;
export const SONG_IMAGE_SIZE = OFF_FIRSTWAVE + 1;

export function isSongFile(data: Uint8Array): boolean {
  return data.length > 2 && data[0] === 0x4e && data[1] === 0x32;
}

// Command names are stored as ASCII; shifted (upper case) letters are $A1-$BA
function screenToChar(c: number): string {
  if (c >= 0xa1 && c <= 0xba) return String.fromCharCode(c - 0x60);
  if (c >= 0x20 && c < 0x7f) return String.fromCharCode(c);
  return ' ';
}

function charToScreen(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x41 && c <= 0x5a) return c + 0x60;
  if (c >= 0x20 && c < 0x7f) return c;
  return 0x20;
}

// The song file keeps the duration numbering of NinjaTracker versions before V2.03: the editor
// adds one to every duration byte after loading and subtracts one before saving (see
// convertdurations in nt2pattern.s). In decoded terms a file duration is one frame longer.
const fileToDur = (d: number) => Math.max(MINDUR, d - 1);
const durToFile = (d: number) => d + 1;

function rleDecode(data: Uint8Array, start: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0, p = start;
  while (p < data.length && o < size) {
    const b = data[p++];
    if (b !== ESC) { out[o++] = b; continue; }
    const value = data[p++];
    let count = data[p++];
    if (count === 0) count = 256;
    while (count-- > 0 && o < size) out[o++] = value;
  }
  return out;
}

function rleEncode(img: Uint8Array): number[] {
  const out: number[] = [];
  let p = 0;
  while (p < img.length) {
    const v = img[p];
    if (p + 1 < img.length && img[p + 1] === v) {
      let n = 1;
      while (n < 255 && p + n < img.length && img[p + n] === v) n++;
      out.push(ESC, v, n);
      p += n;
    } else if (v === ESC) {
      out.push(ESC, ESC, 1);
      p++;
    } else {
      out.push(v);
      p++;
    }
  }
  return out;
}

export function loadSongFile(data: Uint8Array): Song {
  if (!isSongFile(data)) throw new Error('Not a NinjaTracker 2 song file (missing "N2" signature)');
  const img = rleDecode(data, 2, SONG_IMAGE_SIZE);
  const song = newSong();
  song.hrParam = img[OFF_HRPARAM];
  song.firstWave = img[OFF_FIRSTWAVE];

  for (let t = 0; t < 3; t++) {
    const len = Math.min(img[OFF_TBLLEN + t], MAX_TBLLEN);
    const l = OFF_TABLES + t * 2 * TBL, r = l + TBL;
    song.tables[t] = { left: Array.from(img.subarray(l, l + len)), right: Array.from(img.subarray(r, r + len)) };
  }
  for (let i = 0; i < MAX_PATT; i++) {
    const o = OFF_PATTERNS + i * MAX_PATTLEN;
    song.patterns[i] = unpackPattern(img.subarray(o, o + MAX_PATTLEN));
    for (const r of song.patterns[i]) if (r.dur) r.dur = fileToDur(r.dur);
  }
  for (let s = 0; s < MAX_SONGS; s++) {
    const o = OFF_TRACKS + s * MAX_SONGLEN;
    const lens = [img[OFF_SONGLEN + s * 3], img[OFF_SONGLEN + s * 3 + 1], img[OFF_SONGLEN + s * 3 + 2]];
    song.tracks[s] = unpackTracks(img.subarray(o, o + MAX_SONGLEN), lens);
  }
  for (let i = 0; i < MAX_CMD; i++) {
    const n = OFF_NAMES + i * (MAX_CMDNAMELEN + 1);
    let name = '';
    for (let k = 0; k < MAX_CMDNAMELEN; k++) name += screenToChar(img[n + k]);
    const cmd: Command = {
      ad: img[OFF_CMDAD + i], sr: img[OFF_CMDSR + i], wave: img[OFF_CMDWAVE + i],
      pulse: img[OFF_CMDPULSE + i], filt: img[OFF_CMDFILT + i], name: name.replace(/\s+$/, ''),
    };
    song.commands[i] = cmd;
  }
  return song;
}

function commandUsed(c: Command): boolean {
  return !!(c.ad || c.sr || c.wave || c.pulse || c.filt || c.name.trim());
}

export function saveSongFile(song: Song): Uint8Array {
  const img = new Uint8Array(SONG_IMAGE_SIZE);
  for (let t = 0; t < 3; t++) {
    const tbl = song.tables[t];
    const l = OFF_TABLES + t * 2 * TBL, r = l + TBL;
    img.set(tbl.left, l);
    img.set(tbl.right, r);
    img[OFF_TBLLEN + t] = tbl.left.length;
  }
  for (let i = 0; i < MAX_PATT; i++) {
    const rows: Row[] = song.patterns[i];
    if (rows.length) img.set(packPattern(rows.map(r => (r.dur ? { ...r, dur: durToFile(r.dur) } : r))), OFF_PATTERNS + i * MAX_PATTLEN);
  }
  for (let s = 0; s < MAX_SONGS; s++) {
    const { data, lens } = packTracks(song.tracks[s]);
    img.set(data.subarray(0, MAX_SONGLEN), OFF_TRACKS + s * MAX_SONGLEN);
    for (let c = 0; c < 3; c++) img[OFF_SONGLEN + s * 3 + c] = lens[c];
  }
  let cmdLen = 0;
  for (let i = 0; i < MAX_CMD; i++) {
    const c = song.commands[i];
    if (commandUsed(c)) cmdLen = i + 1;
    img[OFF_CMDAD + i] = c.ad;
    img[OFF_CMDSR + i] = c.sr;
    img[OFF_CMDWAVE + i] = c.wave;
    img[OFF_CMDPULSE + i] = c.pulse;
    img[OFF_CMDFILT + i] = c.filt;
    const n = OFF_NAMES + i * (MAX_CMDNAMELEN + 1);
    const name = c.name.padEnd(MAX_CMDNAMELEN, ' ');
    for (let k = 0; k < MAX_CMDNAMELEN; k++) img[n + k] = charToScreen(name[k]);
    img[n + MAX_CMDNAMELEN] = 0;
  }
  img[OFF_CMDLEN] = cmdLen;
  img[OFF_HRPARAM] = song.hrParam;
  img[OFF_FIRSTWAVE] = song.firstWave;
  return Uint8Array.from([0x4e, 0x32, ...rleEncode(img)]);
}

/** Raw decoded song image, used by tests to check round trips. */
export function decodeSongImage(data: Uint8Array): Uint8Array {
  return rleDecode(data, 2, SONG_IMAGE_SIZE);
}
