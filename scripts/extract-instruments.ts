// Builds an instrument kit from NinjaTracker 2 .sid files.
//
// Every subtune of every file is played in the 6502 emulator. The playroutine's tables are read
// out of its own instructions (scripts/nt2locate.ts), and its note-start code is watched to learn
// which commands (instruments) are really used, on which notes and channels. Each used command is
// then lifted out with just the table rows it can reach, so it stands alone, is given a name from
// how it behaves, and is checked: played alone it must write the same values to the SID as it does
// inside the original tables.
//
// Usage: node scripts/extract-instruments.ts [folder with .sid files, default ../c64music]
//          [folder for the report, default kit] [kit file, default public/kit/instruments.json]
//          [folder for the songs that match their .sid, default public/examples]
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CPU6502 } from '../src/core/cpu6502.ts';
import { type Song, type Table, newSong, unpackPattern, unpackTracks, trackProblem, KEYOFF, MAX_CMD, MAX_TBLLEN, MAX_CMDNAMELEN, MAX_SONGS, hex2, noteName } from '../src/core/song.ts';
import { buildEditorSid, EDIT_PLAYER, packNormal } from '../src/core/packer.ts';
import { saveSongFile, loadSongFile } from '../src/core/songfile.ts';
import { locatePlayers, find, X, type Player } from './nt2locate.ts';
import { render, alike, alikeShape, EXACT, type Render } from './kit-similar.ts';

const SRC = process.argv[2] ?? '../c64music';
const OUT = process.argv[3] ?? 'kit';
/** The kit file itself goes where the app serves it from. */
const KIT_FILE = process.argv[4] ?? 'public/kit/instruments.json';
/** The songs that check out against their .sid are also put where the app's Examples browser reads them. */
const EXAMPLES = process.argv[5] ?? 'public/examples';
const FRAMES = 50 * 60 * 4; // per subtune

// ---------------------------------------------------------------------------
// Running a .sid
// ---------------------------------------------------------------------------

interface SidFile {
  path: string; title: string; author: string; released: string;
  load: number; body: Uint8Array; init: number; play: number; songs: number; model: string;
}

const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) { if (!c) break; s += String.fromCharCode(c); } return s.trim(); };

function readSid(path: string): SidFile {
  const d = new Uint8Array(readFileSync(path));
  const off = (d[6] << 8) | d[7];
  let load = (d[8] << 8) | d[9];
  let body = d.subarray(off);
  if (!load) { load = body[0] | (body[1] << 8); body = body.subarray(2); }
  const version = (d[4] << 8) | d[5];
  const modelBits = version >= 2 ? (d[0x77] >> 4) & 3 : 0;
  return {
    path, title: latin1(d.subarray(0x16, 0x36)), author: latin1(d.subarray(0x36, 0x56)), released: latin1(d.subarray(0x56, 0x76)),
    load, body, init: (d[10] << 8) | d[11], play: (d[12] << 8) | d[13], songs: Math.max(1, (d[14] << 8) | d[15]),
    model: modelBits === 1 ? '6581' : modelBits === 2 ? '8580' : modelBits === 3 ? '6581/8580' : '',
  };
}

/** Run a subroutine with just enough hardware for game rips that wait for the raster beam. */
function run(cpu: CPU6502, addr: number, max: number): boolean {
  const mem = cpu.mem;
  mem[0x1ff] = 0xff; mem[0x1fe] = 0xfe;
  cpu.sp = 0xfd;
  cpu.pc = addr;
  for (let k = 0; k < max; k++) {
    if (cpu.pc === 0xffff) return true;
    const line = Math.floor(cpu.cycles / 63) % 312;
    mem[0xd012] = line & 0xff;
    mem[0xd011] = (mem[0xd011] & 0x7f) | (line > 255 ? 0x80 : 0);
    mem[0xd41b] = (cpu.cycles * 37) & 0xff;
    cpu.step();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Modules: one set of tables, as found in memory while a subtune plays
// ---------------------------------------------------------------------------

interface Use { count: number; legato: number; notes: Map<number, number>; channels: Set<number>; subtunes: Set<number> }
interface Module {
  key: string;
  tables: [Table, Table, Table];
  cmds: { ad: number; sr: number; wave: number; pulse: number; filt: number; hasAdsr: boolean }[];
  hrParam: number; firstWave: number;
  use: Map<number, Use>; // by command number (1-based)
  subtunes: Set<number>;
  /** The whole tune with these tables, or the reason it could not be read. */
  song: Song | string;
  /** The kit instrument each used command became (for its name). */
  insOf: Map<number, Instrument>;
}

/** Read the patterns and tracks that go with a set of tables. */
function moduleSong(mem: Uint8Array, p: Player, tables: [Table, Table, Table], cmds: Module['cmds']): Song | string {
  if (p.pattLo < 0) return 'pattern table not found in the player';
  if (p.songTbl < 0) return 'song table not found in the player';
  const patterns = p.pattHi - p.pattLo;
  if (patterns < 1 || patterns > 127) return `pattern table size ${patterns}`;
  const song = newSong();
  song.hrParam = p.hrParam; song.firstWave = p.firstWave;
  song.tables = structuredClone(tables);
  cmds.forEach((c, i) => { song.commands[i] = { ad: c.ad, sr: c.sr, wave: c.wave, pulse: c.pulse, filt: c.filt, name: '' }; });
  song.patterns[0] = [];
  song.tracks[0] = [[], [], []];
  const addr: number[] = [];
  for (let i = 0; i < patterns; i++) addr.push((((mem[p.pattLo + i] | (mem[p.pattHi + i] << 8)) | p.pattOr) + p.pattReloc) & 0xffff);
  for (let i = 0; i < patterns; i++) {
    // An empty pattern takes no bytes: it shares its address with the next one
    if (!(i + 1 < patterns && addr[i + 1] === addr[i])) song.patterns[i] = unpackPattern(mem, addr[i]);
  }
  // One subtune: its three tracks in editor form, or null when the table entry makes no sense
  const readTracks = (s: number): number[][] | null => {
    const e = p.songTbl + s * 5;
    const at = (((mem[e] | (mem[e + 1] << 8)) | p.trackOr) + p.trackReloc) & 0xffff;
    const len0 = mem[e + 3], len01 = mem[e + 4];
    if (mem[e + 2] !== 0 || len01 < len0) return null;
    const isEnd = (v: number) => (p.oldTracks ? v >= 0xc0 : v === 0);
    // The third track runs to its loop command and the loop position. A track cannot start with
    // a loop, so that means the track is empty.
    let q = at + len01;
    while (!isEnd(mem[q]) && q - at < 256) q++;
    const lens = [len0, len01 - len0, q === at + len01 ? 0 : q + 2 - (at + len01)];
    if (lens.some(n => n === 1 || n === 2) || lens[0] + lens[1] + lens[2] > 256) return null;
    let tracks: number[][];
    if (p.oldTracks) {
      tracks = [];
      let base = 0;
      for (const n of lens) {
        const t: number[] = [];
        for (let i = 0; i < n; i++) {
          const v = mem[at + base + i];
          if (i === n - 1) t.push((v - base) & 0xff); // loop position, counted over all three tracks
          else if (v >= 0xc0) t.push(0);
          else if (v >= 0x80) t.push((0xc0 + (v & 0x7f) - 0x20) & 0xff);
          else t.push(v);
        }
        tracks.push(t);
        base += n;
      }
    } else tracks = unpackTracks(mem.subarray(at, at + lens[0] + lens[1] + lens[2]), lens);
    // A loop position counts over all three tracks, so a track may "loop" into another one (to
    // end on a shared silent pattern, say). The editor keeps each track's loop inside the track:
    // such a track gets its own copy of the part it jumps to.
    const bases = [0, lens[0], lens[0] + lens[1]];
    const orig = tracks.map(t => t.slice());
    for (let c = 0; c < 3; c++) {
      const t = tracks[c];
      if (!t.length) continue;
      const abs = (t[t.length - 1] + bases[c]) & 0xff;
      if (abs >= bases[c] && abs < bases[c] + t.length - 2) continue;
      const k = orig.findIndex((o, i) => o.length && abs >= bases[i] && abs < bases[i] + o.length - 2);
      if (k < 0) return null;
      const loopAbs = orig[k][orig[k].length - 1] + bases[k];
      if (loopAbs < abs) return null;
      const own = t.length - 2;
      tracks[c] = t.slice(0, own).concat(orig[k].slice(abs - bases[k], orig[k].length - 2), [0, own + loopAbs - abs]);
    }
    if (tracks[0].length + tracks[1].length + tracks[2].length > 256) return null;
    if (tracks.some(t => trackProblem(t))) return null;
    if (tracks.some(t => t.slice(0, -2).some(v => v < 0x80 && (v === 0 || v > patterns)))) return null;
    return tracks;
  };
  // Normally the patterns start right after the song table, which gives the number of subtunes.
  // Game players that keep the table elsewhere are read entry by entry for as long as it makes sense.
  const adjacent = (Math.min(...addr) - p.songTbl) / 5;
  const known = Number.isInteger(adjacent) && adjacent >= 1 && adjacent <= MAX_SONGS;
  for (let s = 0; s < (known ? adjacent : MAX_SONGS); s++) {
    const tracks = readTracks(s);
    if (!tracks || (!known && tracks.every(t => !t.length))) {
      if (s === 0) return 'the tracks of the first subtune could not be read';
      if (!known) break;
      continue; // an unused subtune slot
    }
    song.tracks[s] = tracks;
  }
  return song;
}

function unconvertPulseRight(time: number, stored: number): number {
  if (time === 0xff) return stored;
  let v = ((stored << 4) | (stored >> 4)) & 0xff;
  if (time < 0x80 && v >= 0x80) v = (v + 1) & 0xff;
  return v;
}

function readModule(mem: Uint8Array, p: Player): Module | null {
  if (p.missing.length) return null;
  const len = (a: number, b: number) => (a < 0 || b < 0 ? 0 : b - a);
  const waveLen = len(p.wave, p.note), pulseLen = len(p.pulseTime, p.pulseSpd), filtLen = len(p.filtTime, p.filtSpd);
  const cmds = len(p.cmdAd, p.cmdSr), legato = len(p.cmdWave, p.cmdPulse);
  if (waveLen < 1 || waveLen > MAX_TBLLEN || pulseLen < 0 || pulseLen > MAX_TBLLEN || filtLen < 0 || filtLen > MAX_TBLLEN) return null;
  if (cmds < 1 || cmds > MAX_CMD || legato < cmds || legato > MAX_CMD) return null;
  const slice = (a: number, n: number) => Array.from(mem.subarray(a, a + n));
  const pt = slice(p.pulseTime, pulseLen);
  const tables: [Table, Table, Table] = [
    { left: slice(p.wave, waveLen).map(v => (v >= 0xc0 && v < 0xe0 ? v ^ 0x1f : v)), right: slice(p.note, waveLen) },
    { left: pt, right: slice(p.pulseSpd, pulseLen).map((v, i) => unconvertPulseRight(pt[i], v)) },
    { left: slice(p.filtTime, filtLen), right: slice(p.filtSpd, filtLen) },
  ];
  const list: Module['cmds'] = [];
  for (let i = 0; i < legato; i++) {
    list.push({
      ad: i < cmds ? mem[p.cmdAd + i] : 0, sr: i < cmds ? mem[p.cmdSr + i] : 0,
      wave: mem[p.cmdWave + i], pulse: mem[p.cmdPulse + i], filt: p.cmdFilt < 0 || !filtLen ? 0 : mem[p.cmdFilt + i],
      hasAdsr: i < cmds,
    });
  }
  const song = moduleSong(mem, p, tables, list);
  // Two tunes can share their tables: the music is part of what makes a module
  const key = JSON.stringify([tables, list, p.hrParam, p.firstWave, typeof song === 'string' ? song : [song.patterns, song.tracks]]);
  return { key, tables, cmds: list, hrParam: p.hrParam, firstWave: p.firstWave, use: new Map(), subtunes: new Set(), song, insOf: new Map() };
}

function useOf(m: Module, cmd: number): Use {
  let u = m.use.get(cmd);
  if (!u) { u = { count: 0, legato: 0, notes: new Map(), channels: new Set(), subtunes: new Set() }; m.use.set(cmd, u); }
  return u;
}

/** Play every subtune of a file and collect its modules with their command usage. */
function scanFile(sid: SidFile, notes: string[]): Module[] {
  const modules = new Map<string, Module>();
  let playing = 0;
  for (let tune = 0; tune < sid.songs; tune++) {
    const mem = new Uint8Array(0x10000);
    mem.set(sid.body.subarray(0, 0x10000 - sid.load), sid.load);
    const cpu = new CPU6502(mem);
    cpu.a = tune;
    if (!run(cpu, sid.init, 3000000)) notes.push(`subtune ${tune + 1}: init did not return`);
    let play = sid.play;
    if (!play) {
      // No play address (the tune installs its own interrupt): call the playroutine itself
      const entry = find(mem, [0xa2, 0x00, 0xa9, X, X, X, 0xa0], 0, mem.length);
      const alt = entry < 0 ? find(mem, [0xa2, 0x00, 0xa9, X], 0, mem.length) : entry;
      if (alt < 0) { notes.push('no play address and no playroutine entry found'); continue; }
      mem[alt + 3] = tune;
      play = alt;
    }
    const step = () => run(cpu, play, 400000);
    step(); step();
    const players = locatePlayers(mem).filter(p => p.chnNote >= 0);
    if (!players.length) continue;
    // The same variables can belong to several copies of a player: keep one per variable block
    const byVars = new Map<number, Player[]>();
    for (const p of players) byVars.set(p.chnNote, [...(byVars.get(p.chnNote) ?? []), p]);
    const active = new Map<number, Module | null>(); // chnNote -> module, read on first use
    const moduleFor = (copies: Player[]): Module | null => {
      const p0 = copies[0];
      if (active.has(p0.chnNote)) return active.get(p0.chnNote)!;
      let m: Module | null = null;
      let p = p0;
      for (const c of copies) { m = readModule(mem, c); if (m) { p = c; break; } }
      if (m) {
        const known = modules.get(m.key);
        if (known) m = known; else modules.set(m.key, m);
        m.subtunes.add(tune + 1);
        // Commands named in the patterns count as used even if playback never reaches them
        const patterns = p.pattLo < 0 ? 0 : p.pattHi - p.pattLo;
        if (patterns > 0 && patterns <= 127) {
          for (let i = 0; i < patterns; i++) {
            const addr = mem[p.pattLo + i] | (mem[p.pattHi + i] << 8);
            for (const r of unpackPattern(mem, addr)) {
              const n = r.cmd & 0x7f;
              if (n && n <= m.cmds.length) useOf(m, n);
            }
          }
        }
      }
      active.set(p0.chnNote, m);
      return m;
    };
    cpu.onWrite = (addr, value) => {
      for (const copies of byVars.values()) {
        const p = copies[0];
        const dn = addr - p.chnNote;
        if (dn === 0 || dn === 7 || dn === 14) {
          const m = moduleFor(copies);
          if (!m) return;
          const c = mem[p.chnCmd + dn];
          const n = c & 0x7f;
          if (!n || n > m.cmds.length) return;
          const u = useOf(m, n);
          u.count++;
          if (c & 0x80) u.legato++;
          u.notes.set(value >> 1, (u.notes.get(value >> 1) ?? 0) + 1);
          u.channels.add(dn / 7 + 1);
          u.subtunes.add(tune + 1);
          return;
        }
        const dc = addr - p.chnCmd;
        if (dc === 0 || dc === 7 || dc === 14) {
          const m = moduleFor(copies);
          const n = value & 0x7f;
          if (m && n && n <= m.cmds.length) useOf(m, n);
        }
      }
    };
    for (let f = 0; f < FRAMES; f++) if (!step()) { notes.push(`subtune ${tune + 1}: play did not return at frame ${f}`); break; }
    cpu.onWrite = null;
    if ([...active.values()].some(Boolean)) playing++;
    else if (active.size) notes.push(`player found but not understood (${players.flatMap(p => p.missing).join(', ') || 'table sizes'})`);
  }
  if (playing < sid.songs) notes.push(`${playing} of ${sid.songs} subtunes play notes through a NinjaTracker 2 player`);
  return [...modules.values()];
}

// ---------------------------------------------------------------------------
// Lifting one command out of its tables
// ---------------------------------------------------------------------------

type Rows = [number, number][];
/** A relative pitch step: the player adds it modulo 128, so 7F is one semitone down. */
const signed = (v: number) => (v < 0x40 ? v : v - 0x80);
interface Program { rows: Rows; start: number }

/** The rows a table program can reach from `start` (1-based), renumbered so the program stands alone. */
function liftProgram(table: Table, start: number, kind: 0 | 1 | 2): Program {
  if (!start) return { rows: [], start: 0 };
  const seen = new Set<number>();
  let fellOff = false;
  const todo = [start];
  while (todo.length) {
    let p = todo.pop()!;
    for (;;) {
      if (p < 1 || p > table.left.length) { fellOff = true; break; }
      if (seen.has(p)) break;
      seen.add(p);
      const l = table.left[p - 1], r = table.right[p - 1];
      if (l === 0xff) { if (r) todo.push(r); break; }
      if (kind === 0 ? l >= 0xc0 : l === 0) break; // vibrato and slide rows, or a modulation that never ends
      p++;
    }
  }
  const order = [...seen].sort((a, b) => a - b);
  const index = new Map(order.map((p, i) => [p, i + 1]));
  const rows: Rows = order.map(p => {
    const l = table.left[p - 1], r = table.right[p - 1];
    return [l, l === 0xff && r ? index.get(r) ?? 0 : r];
  });
  // A program that ran past the end of its table is closed with a stop
  if (fellOff) {
    const last = rows[rows.length - 1];
    if (!last || (last[0] !== 0xff && !(kind === 0 && last[0] >= 0xc0))) rows.push([0xff, 0]);
  }
  return { rows, start: index.get(start) ?? 1 };
}

interface Instrument {
  name: string; category: string; description: string;
  ad: number; sr: number; legatoOnly: boolean;
  wave: Program; pulse: Program; filter: Program;
  sources: Source[];
  verified: boolean;
}
interface Source {
  file: string; song: string; released: string; model: string; cmd: number; hrParam: number; firstWave: number;
  uses: number; legatoUses: number; lowNote: number; highNote: number; typicalNote: number; channels: number[]; subtunes: number[];
  /** The tune used a near-duplicate of this instrument, not exactly this one. */
  variant?: boolean;
}

const identity = (i: Instrument) => JSON.stringify([i.ad, i.sr, i.legatoOnly, i.wave, i.pulse, i.filter]);

// ---------------------------------------------------------------------------
// Playing an instrument on its own (for naming and for the check)
// ---------------------------------------------------------------------------

function testSong(tables: [Table, Table, Table], cmds: { ad: number; sr: number; wave: number; pulse: number; filt: number }[], cmd: number, note: number, hr: number, fw: number): Song {
  const s = newSong();
  s.hrParam = hr; s.firstWave = fw;
  s.tables = structuredClone(tables);
  cmds.forEach((c, i) => { s.commands[i] = { ...c, name: '' }; });
  s.patterns[0] = [{ note: note * 2, cmd, dur: 60 }, { note: KEYOFF, cmd: 0, dur: 60 }];
  s.patterns[1] = [{ note: KEYOFF, cmd: 0, dur: 60 }, { note: KEYOFF, cmd: 0, dur: 60 }];
  s.tracks[0] = [[0xc0, 1, 0, 0], [0xc0, 2, 0, 0], [0xc0, 2, 0, 0]];
  return s;
}

/** SID registers after each of `frames` play calls. */
function play(song: Song, frames: number): Uint8Array[] {
  const { sid } = buildEditorSid(song, '8580');
  const mem = new Uint8Array(0x10000);
  mem.set(sid.subarray(0x7e), EDIT_PLAYER);
  const cpu = new CPU6502(mem);
  const reg = new Uint8Array(25);
  cpu.onWrite = (a, v) => { if (a >= 0xd400 && a < 0xd419) reg[a - 0xd400] = v; };
  cpu.a = 0;
  cpu.call(EDIT_PLAYER);
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) { cpu.call(EDIT_PLAYER + 3); out.push(reg.slice()); }
  return out;
}

const toTable = (p: Program): Table => ({ left: p.rows.map(r => r[0]), right: p.rows.map(r => r[1]) });
const aloneSong = (i: Instrument, note: number, hr: number, fw: number) =>
  testSong([toTable(i.wave), toTable(i.pulse), toTable(i.filter)], [{ ad: i.ad, sr: i.sr, wave: i.wave.start, pulse: i.pulse.start, filt: i.filter.start }], 1, note, hr, fw);

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const WAVE_NAME: Record<number, string> = { 1: 'Tri', 2: 'Saw', 4: 'Pul', 8: 'Noi', 3: 'TS', 5: 'TP', 6: 'SP', 7: 'TSP' };
const CHORDS: Record<string, [string, string]> = {
  '0,4,7': ['Maj', 'major chord'], '0,3,7': ['Min', 'minor chord'], '0,7': ['5th', 'root and fifth'], '0': ['Oct', 'octaves'],
  '0,5,7': ['Sus4', 'sus4 chord'], '0,2,7': ['Sus2', 'sus2 chord'], '0,4,7,10': ['Dom7', 'dominant seventh'], '0,3,7,10': ['Min7', 'minor seventh'],
  '0,4,7,11': ['Maj7', 'major seventh'], '0,3,6': ['Dim', 'diminished chord'], '0,4,8': ['Aug', 'augmented chord'],
  '0,5,9': ['Maj64', 'major chord, second inversion'], '0,3,8': ['Maj6', 'major chord, first inversion'],
  '0,4,9': ['Min6', 'minor chord, first inversion'], '0,5,8': ['Min64', 'minor chord, second inversion'],
  '0,5': ['4th', 'root and fourth'], '0,3': ['m3', 'minor third'], '0,4': ['M3', 'major third'], '0,3,6,9': ['Dim7', 'diminished seventh'],
  '0,4,7,9': ['Maj6th', 'major sixth chord'], '0,3,7,9': ['Min6th', 'minor sixth chord'], '0,2,4,7': ['Add9', 'major add 9'],
};

/**
 * `base` is a list of spellings from longest to shortest; the longest that fits the 9 letters of a
 * command name together with its number is used.
 */
function describe(i: Instrument, typicalNote: number, used: boolean): { base: string[]; category: string; text: string } {
  const d = describe1(i, typicalNote, used);
  return { ...d, base: typeof d.base === 'string' ? [d.base] : d.base };
}

function describe1(i: Instrument, typicalNote: number, used: boolean): { base: string | string[]; category: string; text: string } {
  const w = i.wave.rows, attack = i.ad >> 4, decay = i.ad & 15, sustain = i.sr >> 4, release = i.sr & 15;
  const sets = w.filter(r => r[0] < 0x90);
  const hasVib = w.some(r => r[0] >= 0xc0 && r[0] < 0xe0 && r[1]);
  const hasSlide = w.some(r => r[0] >= 0xe0 && r[0] < 0xff);
  const pwm = i.pulse.rows.some(r => r[0] > 0 && r[0] < 0x80 && r[1]);
  const filtSet = i.filter.rows.find(r => r[0] >= 0x80 && r[0] < 0xff);
  const filtMove = i.filter.rows.some(r => r[0] > 0 && r[0] < 0x80 && r[1]);
  const extras: string[] = [];
  if (hasVib) extras.push('vibrato');
  if (hasSlide) extras.push('slide');
  if (pwm) extras.push('pulse width modulation');
  if (filtSet) {
    const type = (filtSet[0] >> 4) & 7;
    const kind = ({ 1: 'low-pass', 2: 'band-pass', 4: 'high-pass' } as Record<number, string>)[type] ?? 'combined';
    extras.push(type ? `${kind} filter${filtMove ? ' sweep' : ''}` : 'switches the filter off');
  } else if (filtMove) extras.push('filter sweep');
  const tail = extras.length ? ', ' + extras.join(', ') : '';

  if (!w.length) {
    if (i.filter.rows.length && !i.pulse.rows.length) return { base: 'Filter', category: 'modifier', text: `filter program only${tail}` };
    if (i.pulse.rows.length && !i.filter.rows.length) return { base: 'Pulse', category: 'modifier', text: `pulse program only${tail}` };
    if (i.pulse.rows.length) return { base: 'PulFlt', category: 'modifier', text: `pulse and filter programs only${tail}` };
    return { base: 'Env', category: 'modifier', text: 'envelope only: restarts the note without changing the running programs' };
  }
  if (!sets.length) {
    const base = hasVib ? 'Vib' : hasSlide ? 'Slide' : 'Hold';
    const what = hasVib ? 'vibrato' : hasSlide ? 'slide to the note' : 'holds the pitch';
    return { base, category: 'modifier', text: `${what}, keeps the waveform that is playing${tail.replace(', vibrato', '').replace(', slide', '')}` };
  }

  // Pitch steps: absolute ones ignore the note, as drums do
  const pitched = w.filter(r => r[0] < 0xc0);
  const abs = pitched.filter(r => r[1] >= 0x80), rel = pitched.filter(r => r[1] < 0x80);
  const noise = sets.filter(r => r[0] & 0x80).length;
  const mainSet = [...sets].reverse().find(r => (r[0] & 0xf0) && !(r[0] & 0x80)) ?? sets[sets.length - 1];
  const mainWave = WAVE_NAME[mainSet[0] >> 4] ?? 'Wav';
  const waveWord = ({ Tri: 'triangle', Saw: 'sawtooth', Pul: 'pulse', Noi: 'noise' } as Record<string, string>)[mainWave] ?? 'mixed waveform';

  const short = sustain === 0 ? decay <= 6 : release <= 6;
  if (noise === sets.length) {
    // Noise only: a hi-hat when high and short, a cymbal when high and long
    const fixed = abs.length > 0 && !rel.length;
    const pitch = abs.length ? abs[0][1] & 0x7f : typicalNote + signed(rel[0]?.[1] ?? 0);
    const how = fixed ? 'at a fixed pitch' : 'following the note';
    if (pitch >= 0x48 && short && (sustain === 0 ? decay <= 4 : release <= 4)) return { base: 'HiHat', category: 'drum', text: `closed hi-hat: short high noise ${how}${tail}` };
    if (pitch >= 0x48 && !short) return { base: 'OpenHat', category: 'drum', text: `open hi-hat or cymbal: long high noise ${how}${tail}` };
    return { base: 'Noise', category: 'drum', text: `noise hit ${how}${tail}` };
  }
  if (abs.length && !rel.length) {
    const last = abs[abs.length - 1][1] & 0x7f, first = abs[0][1] & 0x7f;
    if (noise * 2 >= sets.length || (noise && (sets[sets.length - 1][0] & 0x80))) return { base: 'Snare', category: 'drum', text: `snare: noise mixed with a ${waveWord} tone, fixed pitch${tail}` };
    if (last <= 0x26) return { base: 'Kick', category: 'drum', text: `kick drum: ${waveWord} falling to ${noteName(last * 2)}${noise ? ' with a noise click' : ''}${tail}` };
    if (first > last) return { base: 'Tom', category: 'drum', text: `tom: ${waveWord} falling from ${noteName(first * 2)} to ${noteName(last * 2)}${noise ? ' with a noise click' : ''}${tail}` };
    return { base: 'Blip', category: 'drum', text: `fixed-pitch ${waveWord} hit at ${noteName(last * 2)}${tail}` };
  }

  // Arpeggio: the relative steps the program keeps cycling through
  const loopBack = w.find((r, k) => r[0] === 0xff && r[1] && r[1] <= k + 1);
  const cycle = loopBack ? w.slice(loopBack[1] - 1).filter(r => r[0] < 0xc0 && r[1] < 0x80) : [];
  const offsets = [...new Set(cycle.map(r => signed(r[1])))];
  const hit = abs.length ? (abs.some(r => sets.includes(r) && (r[0] & 0x80)) ? 'noise hit, then ' : 'fixed-pitch hit, then ') : '';
  if (offsets.length >= 2) {
    const low = Math.min(...offsets);
    const classes = [...new Set(offsets.map(o => (o - low) % 12))].sort((a, b) => a - b);
    const chord = CHORDS[classes.join(',')];
    const steps = offsets.map(o => (o < 0 ? '' : '+') + o).join(' ');
    return { base: 'Arp' + (chord ? chord[0] : classes.map(c => c.toString(16).toUpperCase()).join('')), category: 'chord', text: `${hit}${waveWord} arpeggio, ${chord ? chord[1] : 'steps'} (${steps})${tail}` };
  }

  const pad = attack >= 6, pluck = sustain <= 2 && !pad;
  const lowRole = typicalNote < 36;
  // Feature letters after the name: v vibrato, w pulse width modulation, f filter
  const flags = (hasVib ? 'v' : '') + (pwm ? 'w' : '') + (filtSet || filtMove ? 'f' : '');
  const spell = (long: string, short: string) => [long + mainWave + flags, short + mainWave + flags, short + mainWave[0] + flags];
  if (abs.length && lowRole && used) return { base: spell('KBass', 'KB'), category: 'bass', text: `${hit}${waveWord} bass note${tail}` };
  const role = lowRole && used ? 'Bass' : pad ? 'Pad' : hasVib ? 'Lead' : pluck ? 'Pluck' : used ? 'Lead' : 'Tone';
  const word = { Bass: 'bass', Pad: 'slow-attack pad', Lead: 'lead', Pluck: 'short plucked note', Tone: 'tone' }[role];
  const abbr = { Bass: 'Bs', Pad: 'Pd', Lead: 'Ld', Pluck: 'Pk', Tone: 'Tn' }[role];
  return { base: spell(role, abbr), category: role === 'Bass' ? 'bass' : role === 'Pad' ? 'pad' : 'lead', text: `${hit}${waveWord} ${word}${tail}` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir).sort()) {
    const p = dir + '/' + f;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.toLowerCase().endsWith('.sid')) out.push(p);
  }
  return out;
}

interface Musician { id: string; name: string; instruments: Instrument[]; songs: Set<string> }
const musicians = new Map<string, Musician>();
const handleOf = (author: string) => (author.match(/\(([^)]+)\)\s*$/)?.[1] ?? author).trim();

const files = walk(SRC);
const sids = files.map(readSid);
// Files in a musician's folder are theirs; the rest are matched by the author's name
const folderOf = (path: string) => path.match(/MUSICIANS\/[^/]+\/([^/]+)\//i)?.[1];
const folderByAuthor = new Map<string, string>();
for (const s of sids) { const f = folderOf(s.path); if (f && !folderByAuthor.has(s.author)) folderByAuthor.set(s.author, f); }

const report: string[] = [];
const scanned: { sid: SidFile; rel: string; modules: Module[]; musician: string; line: number }[] = [];
let total = 0, unverified = 0, skippedEmpty = 0;
for (const sid of sids) {
  const rel = sid.path.replace(SRC + '/', '');
  const notes: string[] = [];
  const modules = scanFile(sid, notes);
  const unknown = !sid.author || sid.author === '<?>';
  const id = folderOf(sid.path) ?? folderByAuthor.get(sid.author) ?? (unknown ? 'Unknown' : handleOf(sid.author).replace(/[^A-Za-z0-9]+/g, '_'));
  let mus = musicians.get(id);
  if (!mus) { mus = { id, name: unknown && !folderOf(sid.path) ? 'Unknown' : sid.author, instruments: [], songs: new Set() }; musicians.set(id, mus); }
  let found = 0;
  for (const m of modules) {
    for (const [cmd, u] of [...m.use].sort((a, b) => a[0] - b[0])) {
      const c = m.cmds[cmd - 1];
      const legatoOnly = !c.hasAdsr || (u.count > 0 && u.legato === u.count);
      const ins: Instrument = {
        name: '', category: '', description: '',
        ad: legatoOnly ? 0 : c.ad, sr: legatoOnly ? 0 : c.sr, legatoOnly,
        wave: liftProgram(m.tables[0], c.wave, 0), pulse: liftProgram(m.tables[1], c.pulse, 1), filter: liftProgram(m.tables[2], c.filt, 2),
        sources: [], verified: false,
      };
      if (!ins.wave.rows.length && !ins.pulse.rows.length && !ins.filter.rows.length && !ins.ad && !ins.sr) { skippedEmpty++; continue; }
      const ns = [...u.notes].sort((a, b) => a[0] - b[0]);
      let typical = 48;
      if (ns.length) { let half = u.count / 2; for (const [n, k] of ns) { half -= k; if (half <= 0) { typical = n; break; } } }
      // Check: alone, it must sound exactly as it does inside the original tables
      // (an unused one is tried on a note its own pitch steps keep inside the note range)
      const steps = ins.wave.rows.filter(r => r[0] < 0xc0 && r[1] < 0x80).map(r => signed(r[1]));
      const note = Math.max(12 - Math.min(0, ...steps), Math.min(95 - Math.max(0, ...steps), typical));
      const a = play(testSong(m.tables, m.cmds.map(k => (legatoOnly && k === c ? { ...k, ad: 0, sr: 0 } : k)), cmd, note, m.hrParam, m.firstWave), 150);
      const b = play(aloneSong(ins, note, m.hrParam, m.firstWave), 150);
      ins.verified = a.every((r, f) => r.every((v, k) => v === b[f][k]));
      const src: Source = {
        file: rel, song: sid.title, released: sid.released, model: sid.model, cmd, hrParam: m.hrParam, firstWave: m.firstWave,
        uses: u.count, legatoUses: u.legato, lowNote: ns.length ? ns[0][0] : 0, highNote: ns.length ? ns[ns.length - 1][0] : 0, typicalNote: ns.length ? typical : 0,
        channels: [...u.channels].sort(), subtunes: [...u.subtunes].sort((x, y) => x - y),
      };
      const same = mus.instruments.find(k => identity(k) === identity(ins));
      m.insOf.set(cmd, same ?? ins);
      if (same) {
        // The same command of the same file, met again in another of its tunes, stays one source
        const again = same.sources.find(s => s.file === rel && s.cmd === cmd);
        if (again) {
          if (src.uses > again.uses) { again.typicalNote = src.typicalNote; }
          again.lowNote = again.uses && src.uses ? Math.min(again.lowNote, src.lowNote) : again.lowNote || src.lowNote;
          again.highNote = Math.max(again.highNote, src.highNote);
          again.uses += src.uses; again.legatoUses += src.legatoUses;
          again.channels = [...new Set([...again.channels, ...src.channels])].sort();
          again.subtunes = [...new Set([...again.subtunes, ...src.subtunes])].sort((x, y) => x - y);
        } else same.sources.push(src);
        same.verified &&= ins.verified;
      } else { ins.sources.push(src); mus.instruments.push(ins); }
      found++;
    }
  }
  if (found) mus.songs.add(sid.title);
  scanned.push({ sid, rel, modules, musician: id, line: report.length });
  report.push(`${found ? 'ok  ' : 'NONE'} ${rel}: ${found} instruments from ${modules.length} table set${modules.length === 1 ? '' : 's'}, ${sid.songs} subtune${sid.songs === 1 ? '' : 's'}${notes.length ? '  [' + [...new Set(notes)].slice(0, 3).join('; ') + ']' : ''}`);
}

// Names: describe each instrument, then number the ones that share a name within a musician
const prog = (p: Program) => p.rows.map(r => hex2(r[0]) + hex2(r[1])).join(' ');
const usesOf = (i: Instrument) => i.sources.reduce((n, s) => n + s.uses, 0);
const line = (i: Instrument) => `${hex2(i.ad)}${hex2(i.sr)} W ${prog(i.wave) || '-'} | P ${prog(i.pulse) || '-'} | F ${prog(i.filter) || '-'}`;
const mergeReport: string[] = [];
let mergedSame = 0, mergedNear = 0;
for (const mus of musicians.values()) {
  const groups = new Map<string, Instrument[]>();
  const baseOf = new Map<Instrument, string>();
  for (const i of mus.instruments) {
    const uses = i.sources.reduce((n, s) => n + s.uses, 0);
    const best = [...i.sources].sort((a, b) => b.uses - a.uses)[0];
    const d = describe(i, best.typicalNote || 48, uses > 0);
    i.category = d.category;
    i.description = d.text + (i.legatoOnly ? ' (used tied to the previous note: no envelope of its own)' : '');
    // A jump that lands on another jump row is run by the player as a very fast slide whose speed is
    // that row's target number, so it cannot be renumbered without changing it a little
    const w = i.wave.rows;
    if (!i.verified && w.some(r => r[0] === 0xff && r[1] && w[r[1] - 1]?.[0] === 0xff)) {
      i.description += ' (its program jumps onto a jump row, which the player runs as a very fast slide: the stand-alone copy differs by a frame or two)';
    }
    baseOf.set(i, d.base.join('|'));
  }
  // A musician's kit needs each sound once. Of instruments that sound the same (the same values
  // written to the SID, whatever rows they are built from) or nearly the same (in the same
  // category, either the same output within a small margin or the same program row for row with
  // close numbers), the most used one stays and the tunes of the others are listed with it.
  // This is done within a musician only: a sound two musicians share stays in both lists.
  const kept: { ins: Instrument; r: Render }[] = [];
  const absorbed = new Map<Instrument, Instrument>();
  const lines: string[] = [];
  for (const i of [...mus.instruments].sort((a, b) => usesOf(b) - usesOf(a))) {
    const r = render(i);
    let how = '=';
    let rep = i.verified ? kept.find(k => k.ins.verified && alike(k.r, r, EXACT)) : undefined;
    if (!rep && i.verified) { how = '~'; rep = kept.find(k => k.ins.verified && k.ins.category === i.category && (alike(k.r, r) || alikeShape(k.ins, i))); }
    if (!rep) { kept.push({ ins: i, r }); continue; }
    absorbed.set(i, rep.ins);
    if (how === '=') mergedSame++; else mergedNear++;
    lines.push(`${how} ${line(i)}  (${usesOf(i)} notes; ${[...new Set(i.sources.map(s => s.song))].join(', ')})\n      kept: ${line(rep.ins)}`);
    rep.ins.sources.push(...i.sources.map(s => ({ ...s, variant: true })));
  }
  if (lines.length) mergeReport.push('', `${mus.name}: ${lines.length} of ${mus.instruments.length}`, ...lines.map(l => '  ' + l));
  mus.instruments = mus.instruments.filter(i => !absorbed.has(i));
  for (const i of mus.instruments) {
    const key = baseOf.get(i)!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(i);
  }
  for (const [base, list] of groups) {
    // most used first, so the plain numbers go to the instruments heard most
    list.sort((a, b) => b.sources.reduce((n, s) => n + s.uses, 0) - a.sources.reduce((n, s) => n + s.uses, 0));
    list.forEach((i, k) => {
      const suffix = list.length > 1 ? String(k + 1) : '';
      const spellings = base.split('|');
      const fit = spellings.find(b => b.length + suffix.length <= MAX_CMDNAMELEN) ?? spellings[spellings.length - 1].slice(0, MAX_CMDNAMELEN - suffix.length);
      i.name = fit + suffix;
    });
  }
  // The commands of the songs that used a merged instrument carry the name of the one that stayed
  for (const [gone, rep] of absorbed) { gone.name = rep.name; gone.category = rep.category; }
  const order = ['drum', 'bass', 'lead', 'pad', 'chord', 'modifier'];
  mus.instruments.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name, 'en', { numeric: true }));
  total += mus.instruments.length;
  unverified += mus.instruments.filter(i => !i.verified).length;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const sorted = [...musicians.values()].filter(m => m.instruments.length).sort((a, b) => a.id.localeCompare(b.id));
const jsonIns = (i: Instrument) => {
  const o: Record<string, unknown> = { name: i.name, category: i.category, description: i.description, ad: hex2(i.ad), sr: hex2(i.sr) };
  if (i.legatoOnly) o.legatoOnly = true;
  o.wave = prog(i.wave); o.pulse = prog(i.pulse); o.filter = prog(i.filter);
  if (i.wave.start > 1) o.waveStart = i.wave.start;
  if (i.pulse.start > 1) o.pulseStart = i.pulse.start;
  if (i.filter.start > 1) o.filterStart = i.filter.start;
  if (!i.verified) o.verified = false;
  o.sources = i.sources;
  return o;
};
const kit = {
  format: 'nt2-instrument-kit', version: 1,
  about: 'Instruments lifted from NinjaTracker 2 tunes. Each has its own table rows: "wave", "pulse" and "filter" are rows of left+right bytes in editor form; ' +
    'an FF row jumps to a row of the same program, counted from 1 (00 stops). waveStart / pulseStart / filterStart give the row the command points at when it is not row 1. ' +
    'Names and categories are worked out from how each instrument behaves; the tunes do not store names.',
  musicians: sorted.map(m => ({ id: m.id, name: m.name, songs: [...m.songs].sort(), instruments: m.instruments.map(jsonIns) })),
};
// One instrument per line keeps the file readable and diffable
const text = JSON.stringify(kit, (k, v) => (k === 'instruments' ? (v as unknown[]).map(x => '\u0001' + JSON.stringify(x)) : v), 1)
  .replace(/"\\u0001(.*)"(,?)$/gm, (_, s: string, comma: string) => JSON.parse('"' + s + '"') + comma);
mkdirSync(dirname(KIT_FILE), { recursive: true });
writeFileSync(KIT_FILE, text);

// One song file per source tune, in a folder per musician, with that tune's instruments as named
// commands, to try them in the editor. A song holds 127 commands and 255 rows per table and has
// one hard restart setting, so a big soundtrack is split into numbered files.
const nt2: string[] = [];
let fileMismatch = 0;

// Whole songs. Where the patterns and tracks could be read, the file is the complete tune with
// its instruments named; a file with several separate tunes (a game soundtrack) gives one song
// file per tune. Each is then read back and played against the .sid it came from.
function startTune(sid: SidFile, tune: number): { cpu: CPU6502; play: number } | null {
  const mem = new Uint8Array(0x10000);
  mem.set(sid.body.subarray(0, 0x10000 - sid.load), sid.load);
  const cpu = new CPU6502(mem);
  cpu.a = tune;
  run(cpu, sid.init, 3000000);
  let play = sid.play;
  if (!play) {
    const entry = find(mem, [0xa2, 0x00, 0xa9, X, X, X, 0xa0], 0, mem.length);
    play = entry < 0 ? find(mem, [0xa2, 0x00, 0xa9, X], 0, mem.length) : entry;
    if (play < 0) return null;
    mem[play + 3] = tune;
  }
  return { cpu, play };
}
const COMPARE_FRAMES = 50 * 90;
interface Capture { regs: Uint8Array[]; events: string[][] }
/** Play and record the SID registers after each frame, and every note start: channel, frames since the last, note, command. */
function capture(cpu: CPU6502, play: number, frames: number): Capture {
  const reg = new Uint8Array(25);
  const regs: Uint8Array[] = [];
  const events: string[][] = [[], [], []];
  const last = [0, 0, 0];
  let players: Player[] = [];
  let frame = 0;
  cpu.onWrite = (a, v) => {
    if (a >= 0xd400 && a < 0xd419) { reg[a - 0xd400] = v; return; }
    for (const p of players) {
      const d = a - p.chnNote;
      if (d === 0 || d === 7 || d === 14) {
        const c = d / 7;
        // the wait before a channel's first note depends on how the tune is started, so it is left out
        events[c].push(`${events[c].length ? frame - last[c] : 0}:${v >> 1}/${cpu.mem[p.chnCmd + d]}`);
        last[c] = frame;
        return;
      }
    }
  };
  for (; frame < frames; frame++) {
    run(cpu, play, 400000);
    regs.push(reg.slice());
    if (frame === 0) players = locatePlayers(cpu.mem).filter(p => p.chnNote >= 0);
  }
  cpu.onWrite = null;
  return { regs, events };
}
/** The same notes with the same commands at the same distances, on all three channels. */
function sameEvents(a: string[][], b: string[][]): boolean {
  let total = 0;
  for (let c = 0; c < 3; c++) {
    const n = Math.min(a[c].length, b[c].length);
    if (Math.abs(a[c].length - b[c].length) > 2) return false;
    for (let k = 0; k < n; k++) if (a[c][k] !== b[c][k]) return false;
    total += n;
  }
  return total > 0;
}
/** 'same' when every register matches each frame, 'notes' when only filter and volume differ, else ''. */
function compare(a: Uint8Array[], b: Uint8Array[]): string {
  let best = '';
  for (let shift = -3; shift <= 3; shift++) {
    let all = true, voices = true;
    for (let f = 8; f < a.length - 8 && voices; f++) {
      const x = a[f + shift], y = b[f];
      for (let k = 0; k < 25; k++) if (x[k] !== y[k]) { all = false; if (k < 21) { voices = false; break; } }
    }
    if (all) return 'same';
    if (voices) best = 'notes';
  }
  return best;
}
const fullFiles = new Set<string>();
interface ExampleEntry { file: string; title: string; author: string; released: string; model: string; subtunes: number; check: 'exact' | 'close' }
const examples = new Map<string, ExampleEntry[]>(); // by musician id
const dropped: string[] = [];
let tunesSame = 0, tunesNotes = 0, tunesEvents = 0, tunesCompared = 0, songFiles = 0;
for (const f of scanned) {
  if (!f.modules.length) continue;
  const bad = f.modules.find(m => typeof m.song === 'string');
  if (bad) { report[f.line] += `  {instruments only: ${bad.song}}`; continue; }
  fullFiles.add(f.rel);
  let same = 0, notesOnly = 0, eventsOnly = 0, compared = 0;
  const differ: number[] = [];
  for (const m of f.modules) {
    const song = structuredClone(m.song as Song);
    for (const [cmd, ins] of m.insOf) song.commands[cmd - 1].name = ins.name;
    const first = Math.min(...m.subtunes);
    const name = `${f.musician}/${f.rel.split('/').pop()!.replace(/\.sid$/i, '')}${f.modules.length > 1 ? '_t' + String(first).padStart(2, '0') : ''}.nt2`;
    nt2.push(name);
    songFiles++;
    // Read it back as the editor does, pack it with the V2.03 player and play it against the original
    const back = loadSongFile(saveSongFile(song));
    let packed: Uint8Array;
    const before = { differ: differ.length, close: notesOnly + eventsOnly };
    try { packed = packNormal(back, 0x1000, 0xfc).bytes; } catch { for (const t of m.subtunes) { compared++; differ.push(t); } dropped.push(`${name} (does not pack)`); continue; }
    const ours = new Map<number, Capture>();
    const oursFor = (s: number) => {
      if (!ours.has(s)) {
        const mem = new Uint8Array(0x10000);
        mem.set(packed, 0x1000);
        const cpu = new CPU6502(mem);
        cpu.a = s;
        cpu.call(0x1000);
        ours.set(s, capture(cpu, 0x1003, COMPARE_FRAMES));
      }
      return ours.get(s)!;
    };
    const songsIn = back.tracks.map((t, s) => (t[0].length ? s : -1)).filter(s => s >= 0);
    for (const tune of m.subtunes) {
      compared++;
      const orig = startTune(f.sid, tune - 1);
      if (!orig) { differ.push(tune); continue; }
      const a = capture(orig.cpu, orig.play, COMPARE_FRAMES);
      let result = '';
      for (const s of songsIn) { const r = compare(a.regs, oursFor(s).regs); if (r === 'same') { result = r; break; } if (r) result = r; }
      if (!result && songsIn.some(s => sameEvents(a.events, oursFor(s).events))) result = 'events';
      if (result === 'same') same++; else if (result === 'notes') notesOnly++; else if (result === 'events') eventsOnly++; else differ.push(tune);
    }
    // An example must play like its .sid: a song with a subtune that does not is left out
    if (differ.length > before.differ) { dropped.push(`${name} (subtune ${differ.slice(before.differ).join(', ')} differs from the .sid)`); continue; }
    mkdirSync(`${EXAMPLES}/${f.musician}`, { recursive: true });
    writeFileSync(`${EXAMPLES}/${name}`, saveSongFile(song));
    if (!examples.has(f.musician)) examples.set(f.musician, []);
    examples.get(f.musician)!.push({
      file: name, title: f.sid.title + (f.modules.length > 1 ? ` (tune ${first})` : ''), author: f.sid.author, released: f.sid.released,
      model: f.sid.model, subtunes: songsIn.length, check: notesOnly + eventsOnly > before.close ? 'close' : 'exact',
    });
  }
  tunesSame += same; tunesNotes += notesOnly; tunesEvents += eventsOnly; tunesCompared += compared;
  report[f.line] += `  {song data in ${f.modules.length} file${f.modules.length === 1 ? '' : 's'}: ${same} of ${compared} subtune${compared === 1 ? '' : 's'} play identically to the .sid` +
    `${notesOnly ? `, ${notesOnly} more with identical notes but different filter or volume` : ''}` +
    `${eventsOnly ? `, ${eventsOnly} more with the same notes, commands and timing (the original player is not the standard V2.03 one, so the registers cannot match)` : ''}${differ.length ? `, differing: ${differ.sort((x, y) => x - y).join(' ')}` : ''}}`;
}

for (const m of sorted) for (const file of [...new Set(m.instruments.flatMap(i => i.sources.map(s => s.file)))].sort()) {
  if (fullFiles.has(file)) continue; // already written as a whole song
  const from = (i: Instrument) => i.sources.find(s => s.file === file);
  const mine = m.instruments.filter(from);
  const chunks: { song: Song; list: Instrument[] }[] = [];
  const settings = [...new Set(mine.map(i => from(i)!.hrParam * 256 + from(i)!.firstWave))];
  for (const setting of settings) {
    let cur: { song: Song; list: Instrument[] } | null = null;
    for (const i of mine) {
      if (from(i)!.hrParam * 256 + from(i)!.firstWave !== setting) continue;
      const progs = [i.wave, i.pulse, i.filter];
      if (!cur || cur.list.length >= MAX_CMD || progs.some((p, t) => cur!.song.tables[t].left.length + p.rows.length > MAX_TBLLEN)) {
        const song = newSong();
        song.hrParam = setting >> 8; song.firstWave = setting & 0xff;
        cur = { song, list: [] };
        chunks.push(cur);
      }
      const s = cur.song;
      const ptr = progs.map((p, t) => {
        if (!p.rows.length) return 0;
        const base = s.tables[t].left.length;
        for (const [l, r] of p.rows) { s.tables[t].left.push(l); s.tables[t].right.push(l === 0xff && r ? r + base : r); }
        return base + p.start;
      });
      s.commands[cur.list.length] = { ad: i.ad, sr: i.sr, wave: ptr[0], pulse: ptr[1], filt: ptr[2], name: i.name };
      cur.list.push(i);
    }
  }
  chunks.forEach((c, k) => {
    const name = `${m.id}/${file.split('/').pop()!.replace(/\.sid$/i, '')}_instruments${chunks.length > 1 ? '_' + (k + 1) : ''}.nt2`;
    nt2.push(`${name} (${c.list.length})`);
    // Read the file back the way the editor does and play every command: it must match the instrument alone
    const back = loadSongFile(saveSongFile(c.song));
    c.list.forEach((i, n) => {
      if (back.commands[n].name.trim() !== i.name) fileMismatch++;
      if (!i.verified) return;
      const note = Math.min(83, Math.max(24, from(i)!.typicalNote || 48));
      const steps = i.wave.rows.filter(r => r[0] < 0xc0 && r[1] < 0x80).map(r => signed(r[1]));
      const safe = Math.max(12 - Math.min(0, ...steps), Math.min(95 - Math.max(0, ...steps), note));
      const s = structuredClone(back);
      s.patterns = testSong(s.tables, [], n + 1, safe, 0, 0).patterns;
      s.tracks = testSong(s.tables, [], n + 1, safe, 0, 0).tracks;
      const a = play(s, 120), b = play(aloneSong(i, safe, back.hrParam, back.firstWave), 120);
      if (!a.every((r, f) => r.every((v, x) => v === b[f][x]))) fileMismatch++;
    });
  });
}

const exampleIndex = {
  format: 'nt2-examples',
  about: 'Songs rebuilt from NinjaTracker 2 .sid files, each checked against the .sid it came from. check "exact": every SID register matches on every frame; ' +
    '"close": same notes, commands and timing, but the original was made with a modified player.',
  musicians: sorted.filter(m => examples.has(m.id)).map(m => ({ id: m.id, name: m.name, tunes: examples.get(m.id)!.sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true })) })),
};
writeFileSync(`${EXAMPLES}/index.json`, JSON.stringify(exampleIndex, null, 1));
if (dropped.length) report.push('', 'Left out of the examples:', ...dropped.map(d => '  ' + d));
if (mergeReport.length) {
  report.push('', `Merged within a musician: ${mergedSame} that sound the same (=) and ${mergedNear} that sound nearly the same (~).`,
    'Each line is envelope, wave, pulse and filter program of the instrument left out, then the one kept in its place.', ...mergeReport);
}
writeFileSync(`${OUT}/report.txt`, report.join('\n') + '\n');
console.log(report.join('\n'));
console.log('');
for (const m of sorted) {
  const by = new Map<string, number>();
  for (const i of m.instruments) by.set(i.category, (by.get(i.category) ?? 0) + 1);
  console.log(`${m.id.padEnd(20)} ${String(m.instruments.length).padStart(4)}  ${[...by].map(([c, k]) => `${c} ${k}`).join(', ')}`);
}
console.log(`\n${total} instruments from ${sids.length} files, ${musicians.size} musicians; ${unverified} failed the stand-alone check; ${skippedEmpty} empty commands skipped`);
console.log(`${[...examples.values()].reduce((n, l) => n + l.length, 0)} examples in ${EXAMPLES}; left out: ${dropped.join('; ') || 'none'}`);
console.log(`merged within a musician: ${mergedSame} that sound the same, ${mergedNear} nearly the same`);
console.log(`${songFiles} whole songs rebuilt (of ${tunesCompared} subtunes: ${tunesSame} play identically to their .sid, ${tunesNotes} with identical notes but other filter or volume, ` +
  `${tunesEvents} with the same notes, commands and timing on a non-standard player, ${tunesCompared - tunesSame - tunesNotes - tunesEvents} differ); ` +
  `${nt2.length - songFiles} instrument-only sets, ${fileMismatch} commands in them differ from their instrument`);
