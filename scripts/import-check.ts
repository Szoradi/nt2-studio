// Checks the packed-tune importer: pack -> import -> pack must give identical bytes, and an
// imported real-world .sid must play exactly like the original.
// Usage: node scripts/import-check.ts [path to a NinjaTracker 2 .sid ...]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { d64Directory, d64ReadFile } from '../src/core/d64.ts';
import { loadSongFile } from '../src/core/songfile.ts';
import { packNormal, packGamemusic, makeSid, withLoadAddress } from '../src/core/packer.ts';
import { importPacked } from '../src/core/sidimport.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import type { Song } from '../src/core/song.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fail++; };
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const songs: [string, Song][] = [];
const d64 = new Uint8Array(readFileSync('public/examples.d64'));
for (const e of d64Directory(d64).slice(1)) songs.push([e.name.toLowerCase(), loadSongFile(d64ReadFile(d64, e))]);
for (const f of readdirSync('songs').filter(f => f.endsWith('.nt2'))) songs.push([f.replace('.nt2', ''), loadSongFile(new Uint8Array(readFileSync('songs/' + f)))]);

for (const [name, song] of songs) {
  const results: string[] = [];
  let ok = true;
  for (const [addr, zp] of [[0x1000, 0xfc], [0xc000, 0x02]]) {
    const packed = packNormal(song, addr, zp).bytes;
    const sid = makeSid(packed, addr, 1, { name, author: 'test', released: '', model: '8580', ntsc: false });
    const fromSid = importPacked(sid, name + '.sid').song;
    const fromPrg = importPacked(withLoadAddress(packed, addr), name + '.prg').song;
    ok &&= same(packNormal(fromSid, addr, zp).bytes, packed) && same(packNormal(fromPrg, addr, zp).bytes, packed);
  }
  results.push('sid/prg');
  const game = packGamemusic(song, 0x4000).bytes;
  for (const data of [game, withLoadAddress(game, 0x4000)]) {
    const back = importPacked(data, name + '.bin').song;
    ok &&= same(packGamemusic(back, 0x4000).bytes, game);
  }
  results.push('gamemusic');
  check(ok, `${name}: pack -> import -> pack is byte-identical (${results.join(', ')})`);
}

// A file that is not a tune must be refused, not turned into a garbled song
let refused = false;
try { importPacked(new Uint8Array(3000).map((_, i) => (i * 37) & 0xff), 'noise.bin'); } catch { refused = true; }
check(refused, 'random data is refused');

// Real .sid files: the imported song, packed with our V2.03 player at the same address, must write
// the same values to the SID as the original file does
function sidWrites(mem: Uint8Array, init: number, play: number, frames: number): string[] {
  const cpu = new CPU6502(mem);
  const out: string[] = [];
  let cur: number[] = [];
  cpu.onWrite = (addr, v) => { if (addr >= 0xd400 && addr < 0xd419) cur.push((addr - 0xd400) * 256 + v); };
  cpu.a = 0;
  cpu.call(init);
  for (let f = 0; f < frames; f++) { cur = []; cpu.call(play); out.push(cur.join(',')); }
  return out;
}
for (const path of process.argv.slice(2).length ? process.argv.slice(2) : ['../Hi_Five_tune_1.sid']) {
  if (!existsSync(path)) { console.log(`      (${path} not found, skipped)`); continue; }
  const data = new Uint8Array(readFileSync(path));
  let res;
  try { res = importPacked(data, path); } catch (err) { check(false, `${path}: ${(err as Error).message}`); continue; }
  console.log('      ' + res.report.join('\n      '));
  const dataOffset = (data[6] << 8) | data[7];
  const load = data[dataOffset] | (data[dataOffset + 1] << 8);
  const init = (data[10] << 8) | data[11], play = (data[12] << 8) | data[13];
  const orig = new Uint8Array(0x10000);
  orig.set(data.subarray(dataOffset + 2), load);
  const ours = new Uint8Array(0x10000);
  ours.set(packNormal(res.song, load, 0xfc).bytes, load);
  const frames = 50 * 60 * 4;
  const a = sidWrites(orig, init, play, frames), b = sidWrites(ours, load, load + 3, frames);
  let first = -1;
  for (let f = 0; f < frames; f++) if (a[f] !== b[f]) { first = f; break; }
  check(first < 0, `${path}: the imported song plays identically to the original for 4 minutes` + (first < 0 ? '' : ` (first difference at frame ${first})`));
  if (first >= 0) for (let f = first; f < first + 3; f++) console.log(`      f${f} orig ${a[f]}\n      f${f} ours ${b[f]}`);
}
process.exit(fail ? 1 : 0);
