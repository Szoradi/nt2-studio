// Does a tune still play the same after import, save as .nt2, and load again?
// Usage: node scripts/drift-check.ts <file.sid> [file.nt2] [minutes]
import { readFileSync } from 'node:fs';
import { importPacked } from '../src/core/sidimport.ts';
import { buildEditorSid } from '../src/core/packer.ts';
import { loadSongFile, saveSongFile } from '../src/core/songfile.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import type { Song } from '../src/core/song.ts';

const sidPath = process.argv[2] ?? '../Hi_Five_tune_1.sid';
const nt2Path = process.argv[3] ?? '../Hi_Five_tune_1.nt2';
const frames = Math.round(50 * 60 * Number(process.argv[4] ?? 12));

function parseSid(sid: Uint8Array) {
  const off = (sid[6] << 8) | sid[7];
  let load = (sid[8] << 8) | sid[9];
  let body = sid.subarray(off);
  if (!load) { load = body[0] | (body[1] << 8); body = body.subarray(2); }
  return { load, body, init: (sid[10] << 8) | sid[11], play: (sid[12] << 8) | sid[13] };
}
function trace(sid: Uint8Array): string[] {
  const s = parseSid(sid);
  const mem = new Uint8Array(0x10000);
  mem.set(s.body, s.load);
  const cpu = new CPU6502(mem);
  let cur: string[] = [];
  cpu.onWrite = (addr, v) => { if (addr >= 0xd400 && addr < 0xd419) cur.push(`${(addr - 0xd400).toString(16)}=${v.toString(16)}`); };
  cpu.a = 0;
  cpu.call(s.init);
  const out: string[] = [];
  for (let f = 0; f < frames; f++) { cur = []; cpu.call(s.play); out.push(cur.join(' ')); }
  return out;
}
function firstDiff(a: string[], b: string[]): number {
  for (let f = 0; f < frames; f++) if (a[f] !== b[f]) return f;
  return -1;
}
const say = (label: string, d: number) =>
  console.log(`${label}: ${d < 0 ? `identical for ${frames} frames` : `FIRST DIFFERS at frame ${d} (${(d / 50).toFixed(1)} s)`}`);

const original = new Uint8Array(readFileSync(sidPath));
const imported = importPacked(original, sidPath).song;
const ta = trace(original);
const ed = (song: Song) => trace(buildEditorSid(song, '8580').sid);
say('original vs imported            ', firstDiff(ta, ed(imported)));
const again = loadSongFile(saveSongFile(imported));
say('original vs imported+saved+loaded', firstDiff(ta, ed(again)));
try {
  const disk = loadSongFile(new Uint8Array(readFileSync(nt2Path)));
  say(`original vs ${nt2Path}`, firstDiff(ta, ed(disk)));
} catch (e) { console.log('no .nt2 file to compare:', (e as Error).message); }

// Where do the two songs differ as data?
function diffSongs(a: Song, b: Song) {
  const ja = JSON.parse(JSON.stringify(a)), jb = JSON.parse(JSON.stringify(b));
  let shown = 0;
  const walk = (x: any, y: any, path: string) => {
    if (shown > 25) return;
    if (typeof x !== 'object' || x === null || typeof y !== 'object' || y === null) {
      if (x !== y) { console.log(`  ${path}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`); shown++; }
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${path}.${k}`);
  };
  walk(ja, jb, 'song');
  if (!shown) console.log('  no differences in the song data');
}
console.log('imported vs saved+loaded:');
diffSongs(imported, again);
