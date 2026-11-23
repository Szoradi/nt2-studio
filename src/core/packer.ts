// Packer / relocator: turns a Song into the data the playroutine reads.
// - packNormal:    player + music at any address (runnable .prg / .sid)
// - packGamemusic: music data only, for use with nt2play.s in a game
// - buildEditorImage: fixed-layout memory image for live playback in the editor

import { assemble } from './asm6502.ts';
import { PLAYER_SOURCE } from './playersrc.ts';
import {
  type Song, packPattern, packTracks, scanUsage, convertWaveLeft, convertPulseRight, FIRSTNOTE,
  MAX_PATT, MAX_PATTLEN, MAX_SONGS, MAX_SONGLEN, MAX_CMD,
} from './song.ts';

const SECTIONS = [
  'vwavetbl', 'vnotetbl', 'vpulsetimetbl', 'vpulsespdtbl', 'vfilttimetbl', 'vfiltspdtbl',
  'vcmdad', 'vcmdsr', 'vcmdwavepos', 'vcmdpulsepos', 'vcmdfiltpos',
  'vpatttbllo', 'vpatttblhi', 'vsongtbl', 'vpatterns', 'vsong',
] as const;
type Section = (typeof SECTIONS)[number];
export type Layout = Record<Section, number>;

function assemblePlayer(origin: number, zp: number, layout: Layout, song: Song) {
  return assemble(PLAYER_SOURCE, origin, {
    ...layout,
    vtemp1: zp & 0xff,
    vtemp2: (zp + 1) & 0xff,
    FIRSTNOTE,
    HRPARAM: song.hrParam,
    FIRSTWAVE: song.firstWave,
  });
}

const DUMMY_LAYOUT = Object.fromEntries(SECTIONS.map((s, i) => [s, 0x4000 + i * 0x400])) as Layout;
let playerSizeCache = 0;
export function playerSize(): number {
  if (!playerSizeCache) {
    const dummy = { hrParam: 0, firstWave: 9 } as Song;
    playerSizeCache = assemblePlayer(0x1000, 0xfc, DUMMY_LAYOUT, dummy).bytes.length;
  }
  return playerSizeCache;
}

export interface PackStats {
  start: number;
  end: number;
  playerBytes: number;
  dataBytes: number;
  totalBytes: number;
}

interface MusicData { blocks: Uint8Array[]; header: number[] }

/** Build the music data sections in save order; `dataStart` is the address of the wavetable. */
function buildMusic(song: Song, dataStart: number): { layout: Layout; bytes: Uint8Array; header: number[] } {
  const u = scanUsage(song);
  const wave = song.tables[0], pulse = song.tables[1], filt = song.tables[2];
  const cmds = song.commands;
  const col = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i));

  const packedPatterns: Uint8Array[] = [];
  for (let i = 0; i <= u.lastPatt; i++) {
    packedPatterns.push(song.patterns[i].length ? packPattern(song.patterns[i]) : new Uint8Array(0));
  }
  const packedTracks: Uint8Array[] = [];
  const lens: number[][] = [];
  for (let s = 0; s <= u.lastSong; s++) {
    const t = packTracks(song.tracks[s]);
    packedTracks.push(t.data);
    lens.push(t.lens);
  }
  const pattBytes = packedPatterns.reduce((a, p) => a + p.length, 0);

  const sizes: number[] = [
    wave.left.length, wave.left.length, pulse.left.length, pulse.left.length, filt.left.length, filt.left.length,
    u.lastCmd, u.lastCmd, u.lastLegatoCmd, u.lastLegatoCmd, u.lastLegatoCmd,
    u.lastPatt + 1, u.lastPatt + 1, (u.lastSong + 1) * 5, pattBytes,
  ];
  const layout = {} as Layout;
  let addr = dataStart;
  SECTIONS.forEach((name, i) => {
    layout[name] = addr;
    addr += sizes[i] ?? 0;
  });

  const pattLo: number[] = [], pattHi: number[] = [];
  let pa = layout.vpatterns;
  for (const p of packedPatterns) {
    pattLo.push(pa & 0xff);
    pattHi.push((pa >> 8) & 0xff);
    pa += p.length;
  }
  const songTbl: number[] = [];
  let ta = layout.vsong;
  for (let s = 0; s <= u.lastSong; s++) {
    songTbl.push(ta & 0xff, (ta >> 8) & 0xff, 0, lens[s][0] & 0xff, (lens[s][0] + lens[s][1]) & 0xff);
    ta += packedTracks[s].length;
  }

  const music: MusicData = {
    header: [wave.left.length, pulse.left.length, filt.left.length, u.lastCmd, u.lastLegatoCmd, u.lastPatt + 1],
    blocks: [
      Uint8Array.from(wave.left, convertWaveLeft),
      Uint8Array.from(wave.right),
      Uint8Array.from(pulse.left),
      Uint8Array.from(pulse.left, (t, i) => convertPulseRight(t, pulse.right[i])),
      Uint8Array.from(filt.left),
      Uint8Array.from(filt.right),
      col(u.lastCmd, i => cmds[i].ad),
      col(u.lastCmd, i => cmds[i].sr),
      col(u.lastLegatoCmd, i => cmds[i].wave),
      col(u.lastLegatoCmd, i => cmds[i].pulse),
      col(u.lastLegatoCmd, i => cmds[i].filt),
      Uint8Array.from(pattLo),
      Uint8Array.from(pattHi),
      Uint8Array.from(songTbl),
      ...packedPatterns,
      ...packedTracks,
    ],
  };
  const total = music.blocks.reduce((a, b) => a + b.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const b of music.blocks) { bytes.set(b, o); o += b.length; }
  return { layout, bytes, header: music.header };
}

/** Player + music, without a load address. Init = start (A = subtune), play = start + 3. */
export function packNormal(song: Song, start: number, zp: number): { bytes: Uint8Array; stats: PackStats } {
  const pSize = playerSize();
  const music = buildMusic(song, start + pSize);
  const player = assemblePlayer(start, zp, music.layout, song).bytes;
  const bytes = new Uint8Array(player.length + music.bytes.length);
  bytes.set(player, 0);
  bytes.set(music.bytes, player.length);
  if (start + bytes.length > 0x10000) throw new Error('Packed tune does not fit in memory at this address');
  return {
    bytes,
    stats: { start, end: start + bytes.length, playerBytes: player.length, dataBytes: music.bytes.length, totalBytes: bytes.length },
  };
}

/** Gamemusic data (6 byte header + music), without a load address. Must be loaded at `start`. */
export function packGamemusic(song: Song, start: number): { bytes: Uint8Array; stats: PackStats } {
  const music = buildMusic(song, start + 6);
  const bytes = new Uint8Array(6 + music.bytes.length);
  bytes.set(music.header, 0);
  bytes.set(music.bytes, 6);
  if (start + bytes.length > 0x10000) throw new Error('Packed tune does not fit in memory at this address');
  return {
    bytes,
    stats: { start, end: start + bytes.length, playerBytes: 0, dataBytes: bytes.length, totalBytes: bytes.length },
  };
}

export function withLoadAddress(bytes: Uint8Array, addr: number): Uint8Array {
  const out = new Uint8Array(bytes.length + 2);
  out[0] = addr & 0xff;
  out[1] = (addr >> 8) & 0xff;
  out.set(bytes, 2);
  return out;
}

export interface SidInfo { name: string; author: string; released: string; model: '6581' | '8580'; ntsc: boolean }

/** Wrap a normal-mode tune in a PSID v2 header. */
export function makeSid(prg: Uint8Array, start: number, songs: number, info: SidInfo): Uint8Array {
  const h = new Uint8Array(0x7c);
  const w16 = (o: number, v: number) => { h[o] = (v >> 8) & 0xff; h[o + 1] = v & 0xff; };
  const text = (o: number, s: string) => {
    for (let i = 0; i < 31 && i < s.length; i++) {
      const c = s.charCodeAt(i);
      h[o + i] = c < 256 ? c : 0x3f;
    }
  };
  h.set([0x50, 0x53, 0x49, 0x44], 0); // "PSID"
  w16(4, 2);
  w16(6, 0x7c);
  w16(8, 0); // load address is taken from the data
  w16(10, start);
  w16(12, start + 3);
  w16(14, songs);
  w16(16, 1);
  text(0x16, info.name);
  text(0x36, info.author);
  text(0x56, info.released);
  w16(0x76, ((info.ntsc ? 2 : 1) << 2) | ((info.model === '8580' ? 2 : 1) << 4));
  const out = new Uint8Array(h.length + 2 + prg.length);
  out.set(h, 0);
  out.set(withLoadAddress(prg, start), h.length);
  return out;
}

// ---------------------------------------------------------------------------
// Editor playback image: everything at fixed addresses with maximum sizes, so
// song data can be replaced while the player keeps running.
// ---------------------------------------------------------------------------

export const EDIT_PLAYER = 0x1000;
export const EDIT_ZP = 0xfc;
export const EDIT_DATA = 0x2000;
export const EDIT_LAYOUT: Layout = {
  vwavetbl: 0x2000, vnotetbl: 0x2100, vpulsetimetbl: 0x2200, vpulsespdtbl: 0x2300,
  vfilttimetbl: 0x2400, vfiltspdtbl: 0x2500,
  vcmdad: 0x2600, vcmdsr: 0x2680, vcmdwavepos: 0x2700, vcmdpulsepos: 0x2780, vcmdfiltpos: 0x2800,
  vpatttbllo: 0x2880, vpatttblhi: 0x2900, vsongtbl: 0x2980,
  vpatterns: 0x2a00, vsong: 0x8a00,
};
export const EDIT_DATA_END = EDIT_LAYOUT.vsong + MAX_SONGS * MAX_SONGLEN;

export interface EditorPlayer { bytes: Uint8Array; symbols: Record<string, number> }

export function buildEditorPlayer(song: Song): EditorPlayer {
  const r = assemblePlayer(EDIT_PLAYER, EDIT_ZP, EDIT_LAYOUT, song);
  return { bytes: r.bytes, symbols: r.symbols };
}

/** Song data for the editor layout, covering EDIT_DATA..EDIT_DATA_END. */
export function buildEditorImage(song: Song): Uint8Array {
  const L = EDIT_LAYOUT;
  const img = new Uint8Array(EDIT_DATA_END - EDIT_DATA);
  const put = (addr: number, i: number, v: number) => { img[addr - EDIT_DATA + i] = v; };
  const wave = song.tables[0], pulse = song.tables[1], filt = song.tables[2];
  wave.left.forEach((v, i) => { put(L.vwavetbl, i, convertWaveLeft(v)); put(L.vnotetbl, i, wave.right[i]); });
  pulse.left.forEach((v, i) => { put(L.vpulsetimetbl, i, v); put(L.vpulsespdtbl, i, convertPulseRight(v, pulse.right[i])); });
  filt.left.forEach((v, i) => { put(L.vfilttimetbl, i, v); put(L.vfiltspdtbl, i, filt.right[i]); });
  for (let i = 0; i < MAX_CMD; i++) {
    const c = song.commands[i];
    put(L.vcmdad, i, c.ad);
    put(L.vcmdsr, i, c.sr);
    put(L.vcmdwavepos, i, c.wave);
    put(L.vcmdpulsepos, i, c.pulse);
    put(L.vcmdfiltpos, i, c.filt);
  }
  for (let i = 0; i < MAX_PATT; i++) {
    const a = L.vpatterns + i * MAX_PATTLEN;
    put(L.vpatttbllo, i, a & 0xff);
    put(L.vpatttblhi, i, a >> 8);
    if (song.patterns[i].length) img.set(packPattern(song.patterns[i]).subarray(0, MAX_PATTLEN), a - EDIT_DATA);
  }
  for (let s = 0; s < MAX_SONGS; s++) {
    const a = L.vsong + s * MAX_SONGLEN;
    const t = packTracks(song.tracks[s]);
    img.set(t.data.subarray(0, MAX_SONGLEN), a - EDIT_DATA);
    const e = L.vsongtbl + s * 5;
    put(e, 0, a & 0xff);
    put(e, 1, a >> 8);
    put(e, 2, 0);
    put(e, 3, t.lens[0] & 0xff);
    put(e, 4, (t.lens[0] + t.lens[1]) & 0xff);
  }
  return img;
}

/** The editor layout (player + full size data area) as a PSID file for the SID emulator. */
export function buildEditorSid(song: Song, model: '6581' | '8580'): { sid: Uint8Array; player: EditorPlayer; image: Uint8Array } {
  const player = buildEditorPlayer(song);
  const image = buildEditorImage(song);
  const prg = new Uint8Array(EDIT_DATA_END - EDIT_PLAYER);
  prg.set(player.bytes, 0);
  prg.set(image, EDIT_DATA - EDIT_PLAYER);
  const sid = makeSid(prg, EDIT_PLAYER, 1, { name: 'NT2 Studio', author: '', released: '', model, ntsc: false });
  return { sid, player, image };
}
