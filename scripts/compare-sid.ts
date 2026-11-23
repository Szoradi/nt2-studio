// Compares an original NinjaTracker 2 .sid with (a) the same tune imported and exported again as
// a .sid, and (b) the imported song as the editor plays it.
// Usage: node scripts/compare-sid.ts <file.sid> [minutes]
import { readFileSync } from 'node:fs';
import { importPacked } from '../src/core/sidimport.ts';
import { packNormal, makeSid, buildEditorSid } from '../src/core/packer.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';
import { WebSid, type EmscriptenModule } from '../src/audio/websid.ts';
import { Engine } from '../src/audio/engine.ts';

const path = process.argv[2] ?? '../Hi_Five_tune_1.sid';
const minutes = Number(process.argv[3] ?? 4);
const frames = Math.round(50 * 60 * minutes);
const original = new Uint8Array(readFileSync(path));
const imported = importPacked(original, path);

function parseSid(sid: Uint8Array) {
  const off = (sid[6] << 8) | sid[7];
  let load = (sid[8] << 8) | sid[9];
  let body = sid.subarray(off);
  if (!load) { load = body[0] | (body[1] << 8); body = body.subarray(2); }
  return { load, body, init: (sid[10] << 8) | sid[11], play: (sid[12] << 8) | sid[13], flags: (sid[0x76] << 8) | sid[0x77] };
}
const o = parseSid(original);
// Export exactly as the editor would: same address; zeropage FC like the Export dialog default
const exported = makeSid(packNormal(imported.song, o.load, 0xfc).bytes, o.load, 1,
  { name: 'x', author: '', released: '', model: (o.flags >> 4 & 3) === 1 ? '6581' : '8580', ntsc: false });
const x = parseSid(exported);
console.log(`Original: load $${o.load.toString(16)}, init $${o.init.toString(16)}, play $${o.play.toString(16)}, ${o.body.length} bytes, flags $${o.flags.toString(16)}`);
console.log(`Exported: load $${x.load.toString(16)}, init $${x.init.toString(16)}, play $${x.play.toString(16)}, ${x.body.length} bytes`);
console.log(`Imported song: HR param $${imported.song.hrParam.toString(16)}, first wave $${imported.song.firstWave.toString(16)}`);

// ---------------------------------------------------------------- 1. register level, in the 6502 core
interface Trace { perFrame: string[]; state: Uint8Array[]; cycles: number[]; initWrites: string }
function trace(s: ReturnType<typeof parseSid>): Trace {
  const mem = new Uint8Array(0x10000);
  mem.set(s.body, s.load);
  const cpu = new CPU6502(mem);
  const regs = new Uint8Array(25);
  let cur: string[] = [];
  cpu.onWrite = (addr, v) => {
    if (addr >= 0xd400 && addr < 0xd419) { regs[addr - 0xd400] = v; cur.push(`${(addr - 0xd400).toString(16)}=${v.toString(16)}`); }
  };
  cpu.a = 0;
  cpu.call(s.init);
  const initWrites = cur.join(' ');
  const t: Trace = { perFrame: [], state: [], cycles: [], initWrites };
  for (let f = 0; f < frames; f++) {
    cur = [];
    const c0 = cpu.cycles;
    cpu.call(s.play);
    t.perFrame.push(cur.join(' '));
    t.state.push(regs.slice());
    t.cycles.push(cpu.cycles - c0);
  }
  return t;
}
const ta = trace(o), tb = trace(x);
let firstSeq = -1, firstState = -1, cycleDiff = 0, maxCycleDiff = 0;
for (let f = 0; f < frames; f++) {
  if (firstSeq < 0 && ta.perFrame[f] !== tb.perFrame[f]) firstSeq = f;
  if (firstState < 0 && !ta.state[f].every((v, i) => v === tb.state[f][i])) firstState = f;
  const d = Math.abs(ta.cycles[f] - tb.cycles[f]);
  if (d) cycleDiff++;
  maxCycleDiff = Math.max(maxCycleDiff, d);
}
console.log(`\n1. SID registers, original vs imported-and-exported, ${frames} frames (${minutes} min):`);
console.log(`   writes during init: original "${ta.initWrites || 'none'}", exported "${tb.initWrites || 'none'}"`);
console.log(`   sequence of register writes per frame: ${firstSeq < 0 ? 'IDENTICAL on every frame' : `first differs at frame ${firstSeq}`}`);
console.log(`   all 25 register values after each frame: ${firstState < 0 ? 'IDENTICAL on every frame' : `first differ at frame ${firstState}`}`);
console.log(`   CPU time of the play call: differs on ${cycleDiff} frames, by at most ${maxCycleDiff} cycles`);
if (firstSeq >= 0) for (let f = firstSeq; f < firstSeq + 3; f++) console.log(`   f${f}\n     orig ${ta.perFrame[f]}\n     ours ${tb.perFrame[f]}`);

// The editor does not play the exported file: it uses its own fixed memory layout. Trace that too.
{
  const ed = parseSid(buildEditorSid(imported.song, '8580').sid);
  const tc = trace(ed);
  let seq = -1, st = -1;
  for (let f = 0; f < frames; f++) {
    if (seq < 0 && ta.perFrame[f] !== tc.perFrame[f]) seq = f;
    if (st < 0 && !ta.state[f].every((v, i) => v === tc.state[f][i])) st = f;
  }
  console.log(`\n1b. SID registers, original vs the editor's playback layout:`);
  console.log(`   sequence of register writes per frame: ${seq < 0 ? 'IDENTICAL on every frame' : `first differs at frame ${seq}`}`);
  console.log(`   all 25 register values after each frame: ${st < 0 ? 'IDENTICAL on every frame' : `first differ at frame ${st}`}`);
  if (seq >= 0) for (let f = seq; f < seq + 3; f++) console.log(`   f${f}\n     orig ${ta.perFrame[f]}\n     edit ${tc.perFrame[f]}`);
}

// ---------------------------------------------------------------- 2. sound level, in WebSid
const g = globalThis as any;
g.window = g;
g.document = { currentScript: null };
g.__wasm = readFileSync('public/websid/websid.wasm');
const src = readFileSync('public/websid/backend_websid.js', 'utf8').replace('notReady: true,', 'notReady: true, wasmBinary: globalThis.__wasm,');
new Function(src + ';globalThis.backend_SID = backend_SID;')();
await new Promise<void>(res => { if (!g.spp_backend_state_SID.notReady) res(); else g.spp_backend_state_SID.adapterCallback = res; });
const mod: EmscriptenModule = g.backend_SID.Module;

const audioFrames = Math.min(frames, 50 * 90);
/** Loudness (rms) of each video frame, and the peak sample. */
function render(next: () => Int16Array, keep?: number[]): { rms: number[]; peak: number } {
  const rms: number[] = [];
  let peak = 0;
  for (let f = 0; f < audioFrames; f++) {
    const b = next();
    let sum = 0;
    for (let i = 0; i < b.length; i++) { sum += b[i] * b[i]; if (Math.abs(b[i]) > peak) peak = Math.abs(b[i]); if (keep) keep.push(b[i]); }
    rms.push(Math.sqrt(sum / Math.max(1, b.length)));
  }
  return { rms, peak };
}
/** Best alignment of two loudness curves and how closely they then agree. */
function compare(a: number[], b: number[]): { lag: number; corr: number; ratio: number } {
  let best = { lag: 0, corr: -2, ratio: 0 };
  for (let lag = -20; lag <= 20; lag++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let i = 100; i < a.length - 100; i++) {
      const x = a[i], y = b[i + lag];
      if (y === undefined) continue;
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; n++;
    }
    const corr = (n * sab - sa * sb) / Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
    if (corr > best.corr) best = { lag, corr, ratio: sb / sa };
  }
  return best;
}
const emuA = new WebSid(mod);
emuA.load(original, 48000);
const pcmA: number[] = [];
const A = render(() => emuA.frame(), pcmA);
const emuB = new WebSid(mod);
emuB.load(exported, 48000);
const pcmB: number[] = [];
const B = render(() => emuB.frame(), pcmB);
const eng = new Engine(new WebSid(mod), 48000);
eng.model = (o.flags >> 4 & 3) === 1 ? '6581' : '8580';
eng.setSong(imported.song);
for (let i = 0; i < 25; i++) eng.frame(); // the editor idles before you press play
eng.play(0);
const C = render(() => eng.frame());

console.log(`\n2. Sound from the WebSid emulator, first ${audioFrames / 50} s (loudness per frame):`);
const ab = compare(A.rms, B.rms), ac = compare(A.rms, C.rms);
console.log(`   original            : peak ${A.peak}`);
console.log(`   imported + exported : peak ${B.peak}, matches the original with correlation ${ab.corr.toFixed(4)} at ${ab.lag} frames offset, level ${(ab.ratio * 100).toFixed(1)}%`);
console.log(`   editor playback     : peak ${C.peak}, matches the original with correlation ${ac.corr.toFixed(4)} at ${ac.lag} frames offset, level ${(ac.ratio * 100).toFixed(1)}%`);
console.log(`   editor output gain is 1.8: peak after gain ${Math.round(C.peak * 1.8)} of 32767 ${C.peak * 1.8 > 32767 ? '-> CLIPS' : '(no clipping)'}`);

// Sample by sample: original vs imported + exported
{
  let maxDiff = 0, sumSq = 0, sig = 0;
  const n = Math.min(pcmA.length, pcmB.length);
  for (let i = 0; i < n; i++) { const d = pcmA[i] - pcmB[i]; if (Math.abs(d) > maxDiff) maxDiff = Math.abs(d); sumSq += d * d; sig += pcmA[i] * pcmA[i]; }
  const db = sumSq ? 10 * Math.log10(sumSq / sig) : -Infinity;
  console.log(`   sample by sample, original vs imported + exported: largest difference ${maxDiff} of 32767, difference level ${Number.isFinite(db) ? db.toFixed(1) + ' dB relative to the music' : 'zero (bit-identical)'}`);
}

// Waveforms differ sample by sample as soon as an oscillator starts a few cycles earlier or later,
// without sounding different. So also compare the spectrum (what the ear hears), and use a second
// run of the unchanged original as the yardstick for "no difference".
{
  const N = 4096;
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  function spectrum(pcm: number[], start: number): Float64Array {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (pcm[start + i * 2] ?? 0) * win[i]; // left channel
    for (let i = 1, j = 0; i < N; i++) { // bit reversal
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          const a = i + k, b = a + len / 2;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
    const mag = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }
  /** Average spectral difference, as a percentage of the spectrum's size, in third-octave-like bands. */
  function spectralDiff(a: number[], b: number[]): number {
    let diff = 0, total = 0;
    for (let start = 48000 * 2 * 3; start + N * 2 < Math.min(a.length, b.length); start += N * 2 * 4) {
      const sa = spectrum(a, start), sb = spectrum(b, start);
      for (let lo = 4; lo < N / 2; lo = Math.ceil(lo * 1.26)) {
        const hi = Math.min(N / 2, Math.ceil(lo * 1.26));
        let ea = 0, eb = 0;
        for (let i = lo; i < hi; i++) { ea += sa[i] * sa[i]; eb += sb[i] * sb[i]; }
        diff += Math.abs(Math.sqrt(ea) - Math.sqrt(eb));
        total += Math.sqrt(ea);
      }
    }
    return (100 * diff) / total;
  }
  const emuA2 = new WebSid(mod);
  emuA2.load(original, 48000);
  const pcmA2: number[] = [];
  render(() => emuA2.frame(), pcmA2);
  let same = pcmA.length === pcmA2.length;
  for (let i = 0; same && i < pcmA.length; i++) if (pcmA[i] !== pcmA2[i]) same = false;
  const pcmC: number[] = [];
  const eng2 = new Engine(new WebSid(mod), 48000);
  eng2.model = eng.model;
  eng2.setSong(imported.song);
  for (let i = 0; i < 25; i++) eng2.frame();
  eng2.play(0);
  eng2.frame(); // the editor's first frame only initialises the player
  render(() => eng2.frame(), pcmC);
  console.log(`\n3. Spectrum (tone colour), averaged over the first ${audioFrames / 50} s:`);
  console.log(`   original played twice           : ${same ? 'bit-identical waveforms' : 'waveforms differ'}, spectral difference ${spectralDiff(pcmA, pcmA2).toFixed(2)}%`);
  console.log(`   original vs imported + exported : spectral difference ${spectralDiff(pcmA, pcmB).toFixed(2)}%`);
  console.log(`   original vs editor playback     : spectral difference ${spectralDiff(pcmA, pcmC).toFixed(2)}%`);
  // Other chip model, for scale: how big is a difference you would certainly hear?
  const emuM = new WebSid(mod);
  emuM.load(original, 48000);
  emuM.setModel(eng.model === '8580' ? '6581' : '8580');
  const pcmM: number[] = [];
  render(() => emuM.frame(), pcmM);
  console.log(`   for scale, original on the other SID model (${eng.model === '8580' ? '6581' : '8580'}): spectral difference ${spectralDiff(pcmA, pcmM).toFixed(2)}%`);
}
