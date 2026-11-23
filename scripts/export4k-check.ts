// Checks the 4k intro export: the cut-down player must write exactly the same values to the SID,
// in the same order, as the normal packed tune, and KickAssembler must produce the same bytes as
// the built-in assembler.
// Usage: node scripts/export4k-check.ts [--kickass path/to/KickAss.jar] [--minutes n] [--out dir] [song.nt2 ...]
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { assemble } from '../src/core/asm6502.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import { loadSongFile } from '../src/core/songfile.ts';
import { packNormal } from '../src/core/packer.ts';
import { export4k, seedTable, seedInit, FREQ, type SeedTable } from '../src/core/export4k.ts';
import { verify4k } from '../src/core/verify4k.ts';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const kickass = opt('--kickass');
const outDir = opt('--out');
const frames = Math.round(50 * 60 * Number(opt('--minutes') ?? 10));
const files = args.length ? args : readdirSync('songs').filter(f => f.endsWith('.nt2')).map(f => join('songs', f));
const ORG = 0x1000;
let failures = 0;

function trace(mem: Uint8Array, play: number, init: number | null, setup: number | null = null): string[] {
  const cpu = new CPU6502(mem);
  let cur: string[] = [];
  cpu.onWrite = (addr, v) => { if (addr >= 0xd400 && addr < 0xd419) cur.push(`${(addr - 0xd400).toString(16)}=${v.toString(16)}`); };
  if (setup !== null) cpu.call(setup); // nt_init of the 4k export: builds the frequency table, writes nothing to the SID
  if (init !== null) {
    cpu.a = 0;
    cpu.call(init);
    cpu.call(play); // the normal player sets the song up during its first play call
  }
  const out: string[] = [];
  for (let f = 0; f < frames; f++) {
    cur = [];
    if (!cpu.call(play)) throw new Error(`play did not return in frame ${f}`);
    out.push(cur.join(' '));
  }
  return out;
}

for (const file of files) {
  const song = loadSongFile(new Uint8Array(readFileSync(file)));
  const name = basename(file, '.nt2');
  const normal = packNormal(song, ORG, 0xfc);

  // The export as it is written, then the fallback paths: every feature with the column layout and
  // the full frequency table, and every feature with the generated frequency table forced on
  const variants: Parameters<typeof export4k>[1][] = [{}, { allFeatures: true, layout: 'columns', freqTable: 'full' }, { allFeatures: true, freqTable: 'seed' }];
  for (const variant of variants) {
    const allFeatures = !!variant!.allFeatures;
    let ex;
    try { ex = export4k(song, { name, ...variant }); }
    catch (err) { if (!allFeatures) console.log(`skip  ${name}: ${(err as Error).message}`); break; }
    const asm = assemble(ex.dasm, ORG);
    const v = verify4k(song, ex, 0, frames);
    const bad = v.ok ? -1 : v.frame!;
    const shape = `${ex.layout}, ${ex.needsInit ? `seed table with ${ex.freqFixups} fixups` : 'full table'}`;
    const what = allFeatures ? `all features forced on, ${shape}` : `${shape}; features: ${Object.entries(ex.features).filter(e => e[1]).map(e => e[0]).join(' ') || 'none'}`;
    if (bad >= 0) {
      failures++;
      console.log(`FAIL  ${name} (${what}): frame ${bad}\n      normal: ${v.normal}\n      4k:     ${v.exported}`);
    } else {
      console.log(`PASS  ${name} (${what}): ${frames} frames identical${v.silentFrames ? ` (${v.silentFrames} with a never-keyed voice's frequency differing)` : ''}; ${normal.stats.totalBytes} -> ${ex.totalBytes} bytes (code ${ex.codeBytes}, data ${ex.dataBytes}), ${ex.rows} rows, ${ex.freqEntries} freqs`);
    }
    if (allFeatures) continue;
    if (outDir) {
      writeFileSync(join(outDir, `${name}.asm`), ex.source);
      writeFileSync(join(outDir, `${name}.bin`), asm.bytes);
    }
    if (kickass) {
      const dir = mkdtempSync(join(tmpdir(), 'nt2-4k-'));
      writeFileSync(join(dir, 'tune.asm'), ex.source);
      writeFileSync(join(dir, 'main.asm'), `* = $${ORG.toString(16)} "music"\n#import "tune.asm"\n`);
      let log = '';
      try { log = execFileSync('java', ['-jar', kickass, join(dir, 'main.asm'), '-o', join(dir, 'main.prg')], { encoding: 'utf8' }); }
      catch (err) { log = String((err as { stdout?: string }).stdout ?? err); }
      if (!existsSync(join(dir, 'main.prg'))) {
        failures++;
        console.log(`FAIL  ${name}: KickAssembler did not assemble it\n${log}`);
      } else {
        const prg = new Uint8Array(readFileSync(join(dir, 'main.prg'))).subarray(2);
        const same = prg.length === asm.bytes.length && prg.every((v, i) => v === asm.bytes[i]);
        if (!same) failures++;
        console.log(`${same ? 'PASS' : 'FAIL'}  ${name}: KickAssembler output ${same ? 'is byte-identical to the built-in assembler' : `differs (${prg.length} vs ${asm.bytes.length} bytes)`}`);
      }
    }
  }
}
// ---------------------------------------------------------------- nt_init on its own
// Builds the table for a set of used notes, runs nt_init in the 6502 core and reads the table back.
function runSeed(seed: SeedTable): number[] {
  const src = [...seedInit(seed), 'nt_freqtbl:',
    ...Array.from({ length: seed.row * 12 }, () => '                dc.w 0'),
    ...seed.values.map(v => `                dc.w ${v}`)].join('\n');
  const asm = assemble(src, ORG);
  const mem = new Uint8Array(0x10000);
  mem.set(asm.bytes, ORG);
  if (!new CPU6502(mem).call(asm.symbols.nt_init)) throw new Error('nt_init did not return');
  const t = asm.symbols.nt_freqtbl;
  return Array.from({ length: (seed.row + 1) * 12 }, (_, e) => mem[t + e * 2] | (mem[t + e * 2 + 1] << 8));
}
let seedBad = 0, seedRuns = 0;
let rnd = 12345;
const random = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
for (let i = 0; i < 400; i++) {
  const used = new Set<number>();
  const top = 12 + Math.floor(random() * 72), count = 1 + Math.floor(random() * 40);
  used.add(top);
  for (let k = 0; k < count; k++) used.add(Math.floor(random() * (top + 1)));
  const seed = seedTable(used);
  if (!seed) continue;
  seedRuns++;
  const table = runSeed(seed);
  if ([...used].some(e => table[e] !== FREQ[e])) seedBad++;
}
if (seedBad) failures++;
console.log(`${seedBad ? 'FAIL' : 'PASS'}  nt_init: ${seedRuns} random note sets, every used entry ${seedBad ? `wrong in ${seedBad} sets` : 'correct'}`);

// Corrections that are not a single step up or down: stores instead of INC / DEC
{
  const row = 6, values = FREQ.slice(72, 84);
  const fixups = [
    { entry: 0, got: FREQ[72] >> 6, want: (FREQ[72] >> 6) + 5 },        // low byte only
    { entry: 13, got: FREQ[73] >> 5, want: (FREQ[73] >> 5) ^ 0x0300 },  // high byte only
    { entry: 26, got: FREQ[74] >> 4, want: ((FREQ[74] >> 4) + 0x0107) & 0xffff }, // both
    { entry: 39, got: 0x12ff, want: 0x1300 },                           // +1 that carries into the high byte
  ];
  values[3] = 0x12ff << 3; // entry 39 is three octaves below entry 75
  const table = runSeed({ row, values, fixups });
  const ok = fixups.every(f => table[f.entry] === f.want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  nt_init: corrections written as stores (low byte, high byte, both, carry)`);
}

// ---------------------------------------------------------------- the check the Export dialog runs
{
  const song = loadSongFile(new Uint8Array(readFileSync(files.find(f => f.includes('4kstuff')) ?? files[0])));
  const good = verify4k(song, export4k(song));
  const broken = export4k(song);
  broken.dasm = broken.dasm.replace('nt_cmdad:', 'nt_cmdad:       dc.b 0\nnt_cmdadx:');
  const bad = verify4k(song, broken);
  const ok = good.ok && !bad.ok;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  verify4k: accepts a good export (${good.frames} frames) and catches a damaged one (frame ${bad.frame})`);
}

console.log(failures ? `${failures} failure(s)` : 'All checks passed');
process.exit(failures ? 1 : 0);
