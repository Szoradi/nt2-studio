// Renders a song one channel at a time and prints the loudness of each channel in every block of
// bars, to catch a part that turns out silent (wrong command, filter swallowing it, note too low).
// Usage: node scripts/section-levels.ts <song.nt2> <bar frames> <total bars> [bars per block = 4]
import { readFileSync } from 'node:fs';
import { loadSongFile } from '../src/core/songfile.ts';
import { WebSid, type EmscriptenModule } from '../src/audio/websid.ts';
import { Engine } from '../src/audio/engine.ts';

const song = loadSongFile(new Uint8Array(readFileSync(process.argv[2])));
const bar = Number(process.argv[3]), bars = Number(process.argv[4]), block = Number(process.argv[5] ?? 4);

const g = globalThis as any;
g.window = g;
g.document = { currentScript: null };
g.__wasm = readFileSync('public/websid/websid.wasm');
const src = readFileSync('public/websid/backend_websid.js', 'utf8').replace('notReady: true,', 'notReady: true, wasmBinary: globalThis.__wasm,');
new Function(src + ';globalThis.backend_SID = backend_SID;')();
await new Promise<void>(res => { if (!g.spp_backend_state_SID.notReady) res(); else g.spp_backend_state_SID.adapterCallback = res; });
const mod: EmscriptenModule = g.backend_SID.Module;

const levels: number[][] = [];
for (let solo = 0; solo < 4; solo++) { // 3 = all channels
  const eng = new Engine(new WebSid(mod), 48000);
  eng.setSong(song);
  for (let v = 0; v < 3; v++) eng.setMute(v, solo < 3 && v !== solo);
  eng.play(0);
  eng.frame();
  const out: number[] = [];
  let peak = 0;
  for (let b = 0; b < bars; b += block) {
    let sum = 0, n = 0;
    for (let f = 0; f < bar * block; f++) {
      const pcm = eng.frame();
      for (let i = 0; i < pcm.length; i += 2) { sum += pcm[i] * pcm[i]; n++; if (Math.abs(pcm[i]) > peak) peak = Math.abs(pcm[i]); }
    }
    out.push(Math.round(Math.sqrt(sum / n)));
  }
  levels.push(out);
  console.log(`${solo < 3 ? `channel ${solo + 1}` : 'all      '} peak ${String(peak).padStart(5)}  rms per ${block} bars: ${out.map(v => String(v).padStart(5)).join('')}`);
}
