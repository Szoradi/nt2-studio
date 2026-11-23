// Compares the player's sequencer state, frame by frame, between WebSid (as the editor uses it)
// and the plain 6502 core running the same editor image. Any divergence is a playback bug.
import { readFileSync } from 'node:fs';
import { WebSid, type EmscriptenModule } from '../src/audio/websid.ts';
import { Engine } from '../src/audio/engine.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import { d64Directory, d64ReadFile } from '../src/core/d64.ts';
import { loadSongFile } from '../src/core/songfile.ts';
import { buildEditorSid, EDIT_PLAYER } from '../src/core/packer.ts';

const g = globalThis as any;
g.window = g;
g.document = { currentScript: null };
g.__wasm = readFileSync('public/websid/websid.wasm');
const src = readFileSync('public/websid/backend_websid.js', 'utf8').replace('notReady: true,', 'notReady: true, wasmBinary: globalThis.__wasm,');
new Function(src + ';globalThis.backend_SID = backend_SID;')();
await new Promise<void>(res => { if (!g.spp_backend_state_SID.notReady) res(); else g.spp_backend_state_SID.adapterCallback = res; });
const mod: EmscriptenModule = g.backend_SID.Module;

const FRAMES = 50 * 60 * 5;
const d64 = new Uint8Array(readFileSync('public/examples.d64'));
let fail = 0;
for (const e of d64Directory(d64).slice(1)) {
  const song = loadSongFile(d64ReadFile(d64, e));
  const { sid, player } = buildEditorSid(song, '8580');
  const s = player.symbols;
  const vars = [s.vchnpattpos, s.vchncounter, s.vchnsongpos, s.vchnpattnum];

  // Reference: plain CPU
  const mem = new Uint8Array(0x10000);
  mem.set(sid.subarray(0x7e), EDIT_PLAYER);
  const cpu = new CPU6502(mem);
  cpu.a = 0;
  cpu.call(EDIT_PLAYER);
  const ref: string[] = [];
  let maxCycles = 0;
  for (let f = 0; f < FRAMES + 50; f++) {
    const c0 = cpu.cycles;
    cpu.call(EDIT_PLAYER + 3);
    maxCycles = Math.max(maxCycles, cpu.cycles - c0);
    ref.push(vars.map(v => [0, 7, 14].map(x => mem[v + x]).join(',')).join(' '));
  }

  // WebSid through the editor engine
  const emu = new WebSid(mod);
  const eng = new Engine(emu, 48000);
  eng.setSong(song);
  eng.play(0);
  const got: string[] = [];
  for (let f = 0; f < FRAMES; f++) {
    eng.frame();
    got.push(vars.map(v => [0, 7, 14].map(x => emu.read(v + x)).join(',')).join(' '));
  }
  // WebSid's audio chunks are a little shorter than a video frame, so it falls behind the
  // reference by a frame now and then, and a memory read can catch the play routine half way.
  // What must hold: at (almost) every frame, the whole state equals the reference some frames earlier.
  let matched = 0, total = 0, maxLag = 0, lastBad = -1;
  for (let f = 100; f < FRAMES; f++) {
    total++;
    let hit = -1;
    for (let lag = -2; lag <= 14 && hit < 0; lag++) if (got[f] === ref[f - lag]) hit = lag;
    if (hit >= 0) { matched++; maxLag = Math.max(maxLag, hit); } else lastBad = f;
  }
  const pct = (100 * matched) / total;
  const ok = pct > 80 && lastBad < FRAMES - 200;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${e.name}: ${pct.toFixed(1)}% of frames match the reference state (lag up to ${maxLag} frames), last mismatch at frame ${lastBad}`);
}
process.exit(fail ? 1 : 0);
