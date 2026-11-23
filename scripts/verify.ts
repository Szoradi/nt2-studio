// Checks the core against the original NinjaTracker V2.03 distribution.
// Usage: node scripts/verify.ts [path to an unpacked ninjatr203 folder]
// Without the folder it uses the copies in this repository: the example disk the app ships with
// (public/examples.d64 is ninjatr2.d64) and scripts/fixtures/gamemusic.bin (src/gamemusic.bin).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble } from '../src/core/asm6502.ts';
import { PLAYER_SOURCE } from '../src/core/playersrc.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import { d64Directory, d64ReadFile } from '../src/core/d64.ts';
import { loadSongFile, saveSongFile, decodeSongImage, isSongFile } from '../src/core/songfile.ts';
import { packGamemusic, packNormal, playerSize } from '../src/core/packer.ts';
import { scanUsage } from '../src/core/song.ts';

const dist = process.argv[2];
const SECTION_NAMES = ['vwavetbl', 'vnotetbl', 'vpulsetimetbl', 'vpulsespdtbl', 'vfilttimetbl', 'vfiltspdtbl', 'vcmdad', 'vcmdsr',
  'vcmdwavepos', 'vcmdpulsepos', 'vcmdfiltpos', 'vpatttbllo', 'vpatttblhi', 'vsongtbl', 'vpatterns', 'vsong'];
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log(`Player size: ${playerSize()} bytes`);

// 2. Song files on the example disk ----------------------------------------
const d64 = new Uint8Array(readFileSync(dist ? join(dist, 'ninjatr2.d64') : 'public/examples.d64'));
const gamemusic = new Uint8Array(readFileSync(dist ? join(dist, 'src', 'gamemusic.bin') : 'scripts/fixtures/gamemusic.bin'));
let gamemusicMatched = false;

for (const entry of d64Directory(d64)) {
  const file = d64ReadFile(d64, entry);
  if (!isSongFile(file)) { console.log(`      ${entry.name}: not a song (${entry.type}, ${entry.blocks} blocks)`); continue; }
  const song = loadSongFile(file);
  const u = scanUsage(song);
  const names = song.commands.filter(c => c.name).slice(0, 4).map(c => c.name).join(', ');
  console.log(`      ${entry.name}: ${u.lastPatt + 1} patterns, ${u.lastSong + 1} subtunes, ${u.lastLegatoCmd} commands, tables ${song.tables.map(t => t.left.length).join('/')}, names: ${names}`);
  const saved = saveSongFile(song);
  // Original files can hold stale bytes past the end of tables and patterns, so compare the parsed songs
  check(JSON.stringify(loadSongFile(saved)) === JSON.stringify(song), `${entry.name}: load -> save -> load gives the same song`);
  const stale = decodeSongImage(saved).reduce((n, v, i) => n + (v !== decodeSongImage(file)[i] ? 1 : 0), 0);
  console.log(`      ${entry.name}: saved file ${same(saved, file) ? 'is byte-identical to the original' : `differs only in ${stale} unused bytes`}`);

  const gm = packGamemusic(song, 0x1000).bytes;
  if (same(gm, gamemusic)) gamemusicMatched = true;

  // 3. Play it: packed tune through the CPU and SID --------------------------
  const packed = packNormal(song, 0x1000, 0xfc);
  const mem = new Uint8Array(0x10000);
  mem.set(packed.bytes, 0x1000);
  const cpu = new CPU6502(mem);
  const regs = new Uint8Array(32);
  let regWrites = 0, gates = 0, stray = 0;
  cpu.onWrite = (addr, v) => {
    if (addr >= 0xd400 && addr < 0xd419) {
      const reg = addr - 0xd400;
      if (reg < 21 && reg % 7 === 4 && (v & 1) && !(regs[reg] & 1)) gates++;
      regs[reg] = v;
      regWrites++;
    } else if (addr >= 0x100 && (addr < 0x1000 || addr >= 0x1000 + playerSize())) stray++;
  };
  cpu.a = 0;
  let ok = cpu.call(0x1000);
  // Follow each channel's track position to time its loops: all three must loop together
  const songPos = assemble(PLAYER_SOURCE, 0x1000, { ...Object.fromEntries(SECTION_NAMES.map(n => [n, 0x4000])), vtemp1: 0xfc, vtemp2: 0xfd, FIRSTNOTE: 0x18, HRPARAM: 0, FIRSTWAVE: 9 }).symbols.vchnsongpos;
  const loops: number[][] = [[], [], []];
  const prev = [0, 0, 0];
  for (let f = 0; f < 50 * 60 * 12 && ok; f++) {
    ok = cpu.call(0x1003);
    [0, 7, 14].forEach((x, c) => { const p = mem[songPos + x]; if (p < prev[c]) loops[c].push(f); prev[c] = p; });
  }
  const periods = loops.map(l => l[1] - l[0]);
  check(periods.every(p => p > 0 && p === periods[0]), `${entry.name}: the three channels loop together (every ${periods.join(' / ')} frames)`);
  check(ok && gates > 500 && stray === 0,
    `${entry.name}: packed tune runs 12 min in the 6502 core (${regWrites} SID writes, ${gates} note starts, ${stray} stray writes, ${packed.stats.totalBytes} bytes)`);
}
check(gamemusicMatched, 'gamemusic export of CONSULTANT is byte-identical to src/gamemusic.bin');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
