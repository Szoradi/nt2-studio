// Does the editor's engine (WebSid) keep the three channels in step with a plain 6502 run of the
// same image, whatever moment Play is pressed at?
// Usage: node scripts/drift-engine.ts [file.sid] [minutes]
import { readFileSync } from 'node:fs';
import { importPacked } from '../src/core/sidimport.ts';
import { buildEditorSid } from '../src/core/packer.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import { WebSid, type EmscriptenModule } from '../src/audio/websid.ts';
import { Engine } from '../src/audio/engine.ts';

const sidPath = process.argv[2] ?? '../Hi_Five_tune_1.sid';
const frames = Math.round(50 * 60 * Number(process.argv[3] ?? 3));
const song = importPacked(new Uint8Array(readFileSync(sidPath)), sidPath).song;

const g = globalThis as any;
g.window = g;
g.document = { currentScript: null };
g.__wasm = readFileSync('public/websid/websid.wasm');
const src = readFileSync('public/websid/backend_websid.js', 'utf8').replace('notReady: true,', 'notReady: true, wasmBinary: globalThis.__wasm,');
new Function(src + ';globalThis.backend_SID = backend_SID;')();
await new Promise<void>(res => { if (!g.spp_backend_state_SID.notReady) res(); else g.spp_backend_state_SID.adapterCallback = res; });
const mod: EmscriptenModule = g.backend_SID.Module;

const built = buildEditorSid(song, '8580');
const sym = built.player.symbols;
const CH = [0, 7, 14];
const vars = ['vchnsongpos', 'vchnpattnum', 'vchnpattpos'];
type Ev = [number, string];

/** Frame number and new position of every row change on one channel. */
function events(snap: string[][], c: number): Ev[] {
  const out: Ev[] = [];
  for (let f = 1; f < snap.length; f++) if (snap[f][c] !== snap[f - 1][c]) out.push([f, snap[f][c]]);
  return out;
}

// Reference: plain CPU, one play call per frame
const sid = built.sid;
const off = (sid[6] << 8) | sid[7];
const load = sid[off] | (sid[off + 1] << 8);
const mem = new Uint8Array(0x10000);
mem.set(sid.subarray(off + 2), load);
const cpu = new CPU6502(mem);
cpu.a = 0;
cpu.call((sid[10] << 8) | sid[11]);
const refSnap: string[][] = [];
for (let f = 0; f < frames; f++) {
  cpu.call((sid[12] << 8) | sid[13]);
  refSnap.push(CH.map(x => vars.map(v => mem[sym[v] + x]).join(',')));
}
const ref = [0, 1, 2].map(c => events(refSnap, c));

let failures = 0;
function run(idle: number) {
  const emu = new WebSid(mod);
  const eng = new Engine(emu, 48000);
  eng.setSong(song);
  for (let i = 0; i < idle; i++) eng.frame();
  eng.play(0);
  const snap: string[][] = [];
  for (let f = 0; f < frames; f++) {
    eng.frame();
    snap.push(CH.map(x => vars.map(v => emu.read(sym[v] + x)).join(',')));
  }
  const res: string[] = [];
  const lagAt: number[] = [];
  for (let c = 0; c < 3; c++) {
    const a = events(snap, c), b = ref[c];
    let bad = -1;
    for (let i = 0; i < Math.min(a.length, b.length) && bad < 0; i++) if (a[i][1] !== b[i][1]) bad = i;
    // lag of the last row change before a common moment of the song
    const limit = frames - 200;
    let n = 0;
    while (n + 1 < Math.min(a.length, b.length) && b[n + 1][0] < limit) n++;
    lagAt.push(a[n][0] - b[n][0]);
    res.push(bad < 0 ? `late ${a[n][0] - b[n][0]}` : `WRONG ROW at frame ${a[bad][0]} (${a[bad][1]} for ${b[bad][1]})`);
  }
  const spread = Math.max(...lagAt) - Math.min(...lagAt);
  const ok = res.every(r => r.startsWith('late')) && spread <= 1;
  if (!ok) failures++;
  console.log(`play pressed after ${String(idle).padStart(5)} idle frames: ch1 ${res[0]}, ch2 ${res[1]}, ch3 ${res[2]}  ${ok ? 'ok' : '<-- OUT OF STEP'}`);
}
for (const idle of [25, 700, 1300, 1480, 1495, 1510, 1560, 2500]) run(idle);
console.log(failures ? `${failures} runs out of step` : 'all runs in step');
process.exitCode = failures ? 1 : 0;
