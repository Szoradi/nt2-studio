// Runs the editor engine with the real WebSid WASM under Node and checks that sound comes out.
import { readFileSync } from 'node:fs';
import { WebSid, type EmscriptenModule } from '../src/audio/websid.ts';
import { Engine } from '../src/audio/engine.ts';
import { d64Directory, d64ReadFile } from '../src/core/d64.ts';
import { loadSongFile } from '../src/core/songfile.ts';
import { newSong } from '../src/core/song.ts';
import { packNormal, makeSid } from '../src/core/packer.ts';

const g = globalThis as any;
g.window = g;
g.document = { currentScript: null };
g.__wasm = readFileSync('public/websid/websid.wasm');
const src = readFileSync('public/websid/backend_websid.js', 'utf8').replace('notReady: true,', 'notReady: true, wasmBinary: globalThis.__wasm,');
new Function(src + ';globalThis.backend_SID = backend_SID;')();
await new Promise<void>(res => { if (!g.spp_backend_state_SID.notReady) res(); else g.spp_backend_state_SID.adapterCallback = res; });
const mod: EmscriptenModule = g.backend_SID.Module;

const rms = (eng: Engine, frames: number) => {
  let sum = 0, n = 0, peak = 0;
  for (let f = 0; f < frames; f++) {
    const b = eng.frame();
    for (let i = 0; i < b.length; i++) { sum += b[i] * b[i]; n++; peak = Math.max(peak, Math.abs(b[i])); }
  }
  return { rms: Math.round(Math.sqrt(sum / Math.max(1, n))), peak, n };
};
let fail = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fail++; };

const d64 = new Uint8Array(readFileSync('public/examples.d64'));
const eng = new Engine(new WebSid(mod), 48000);
for (const e of d64Directory(d64).slice(1)) {
  const song = loadSongFile(d64ReadFile(d64, e));
  eng.setSong(song);
  const idle = rms(eng, 50);
  eng.play(0);
  const t0 = performance.now();
  const p = rms(eng, 500);
  const ms = performance.now() - t0;
  const st = JSON.stringify(eng.state.channels.map(c => [c.songPos, c.pattNum, c.pattPos]));
  eng.stop();
  rms(eng, 150);
  const after = rms(eng, 50);
  check(idle.rms < 300 && p.rms > 500 && after.rms < p.rms / 4,
    `${e.name}: idle rms ${idle.rms}, playing rms ${p.rms} peak ${p.peak}, after stop ${after.rms}; ${(ms / 100).toFixed(1)}% of real time; pos ${st}; rate ${eng.outputRate}, ${p.n / 500 / 2} samples/frame`);

  // Test note with the first command while stopped
  eng.testNote(0, 0x18 + 48 * 2, 1);
  const tn = rms(eng, 25);
  eng.testKeyOff(0);
  check(tn.rms > 100, `${e.name}: test note with command 1 sounds (rms ${tn.rms})`);
}
// Live edit: an empty song stays silent, then a poked-in instrument and note play
const song = newSong();
eng.setSong(song);
eng.play(0);
const silent = rms(eng, 100);
song.tables[0] = { left: [0x21, 0xff], right: [0x00, 0x00] };
song.commands[0] = { ad: 0x09, sr: 0xa9, wave: 1, pulse: 0, filt: 0, name: 'saw' };
song.patterns[0] = [{ note: 0x18 + 36 * 2, cmd: 1, dur: 20 }, { note: 0x18 + 43 * 2, cmd: 0, dur: 0 }];
eng.updateSong(song);
const edited = rms(eng, 150);
check(silent.rms < 300 && edited.rms > 500, `live edit: silent rms ${silent.rms}, after editing rms ${edited.rms}`);

// Pattern loop: one channel plays the pattern, the others the borrowed silent pattern; stop restores everything
{
  const s2 = loadSongFile(d64ReadFile(d64, d64Directory(d64)[1]));
  eng.setSong(s2);
  eng.playPattern(2, 1);
  const lp = rms(eng, 200);
  const pn = eng.state.channels.map(c => c.pattNum);
  check(lp.rms > 300 && pn[1] === 2 && pn[0] === 0x7f && pn[2] === 0x7f && eng.patternLoop === 2,
    `pattern loop: pattern 2 on channel 2 sounds (rms ${lp.rms}), channel patterns ${pn}`);
  eng.stop();
  rms(eng, 100);
  eng.play(0);
  const full = rms(eng, 300);
  check(full.rms > 1500 && eng.patternLoop === 0, `after a pattern loop the full song plays normally (rms ${full.rms})`);
  // Start in the middle of the tracks with a transpose in effect
  eng.stop();
  eng.play(0, [3, 2, 2], [0xc5, 0xc0, 0xc0]);
  const mid = rms(eng, 100);
  const pos = eng.state.channels.map(c => c.songPos);
  check(mid.rms > 500 && pos[0] > 3, `play from a track position works (rms ${mid.rms}, song positions ${pos})`);
  eng.stop();
}

// Stepping rows while stopped: a note sounds, a key off releases it, a key on with a command changes the sound
{
  const s5 = loadSongFile(d64ReadFile(d64, d64Directory(d64)[1]));
  eng.setSong(s5);
  rms(eng, 30);
  eng.testRow(0, 0x18 + 40 * 2, 4);
  const noteOn = rms(eng, 40);
  eng.testRow(0, 0x08, 0);
  rms(eng, 150);
  const released = rms(eng, 40);
  check(noteOn.rms > 300 && released.rms < noteOn.rms / 3, `stepping a note row sounds (rms ${noteOn.rms}) and a key off row releases it (rms ${released.rms})`);
  eng.testRow(0, 0x18 + 40 * 2, 4);
  rms(eng, 20);
  eng.testRow(0, 0x04, 0x81);
  const legato = rms(eng, 40);
  check(legato.rms > 100 && !eng.state.playing, `a key on row with a legato command keeps sounding and does not start playback (rms ${legato.rms})`);
  eng.testRow(0, 0x08, 0);
  rms(eng, 60);
}

// Switching the looped pattern restarts on the new one; an empty pattern keeps the loop running silently
{
  const s4 = loadSongFile(d64ReadFile(d64, d64Directory(d64)[1]));
  eng.setSong(s4);
  eng.playPattern(2, 0);
  rms(eng, 60);
  eng.playPattern(3, 0);
  const sw = rms(eng, 100);
  check(sw.rms > 300 && eng.state.channels[0].pattNum === 3 && eng.patternLoop === 3 && eng.loopChannel === 0,
    `switching the looped pattern plays the new one (rms ${sw.rms}, channel 1 pattern ${eng.state.channels[0].pattNum})`);
  eng.playPattern(0x40, 0, true);
  rms(eng, 150);
  const quiet = rms(eng, 100);
  check(quiet.rms < 60 && eng.state.playing && eng.loopSilent, `an empty pattern loops silently (rms ${quiet.rms})`);
  eng.playPattern(2, 0);
  const back = rms(eng, 100);
  check(back.rms > 300, `and sound returns on a pattern with notes (rms ${back.rms})`);
  eng.stop();
}

// Starting in the middle of a pattern: skipping N frames must land exactly where normal play is after N frames
{
  const s3 = loadSongFile(d64ReadFile(d64, d64Directory(d64)[2]));
  const snap = () => JSON.stringify(eng.state.channels.map(c => [c.songPos, c.pattNum, c.pattPos]));
  eng.setSong(s3);
  eng.play(0);
  for (let f = 0; f < 302; f++) eng.frame();
  const normal = snap();
  eng.stop();
  for (let f = 0; f < 20; f++) eng.frame();
  eng.play(0, [0, 0, 0], [0xc0, 0xc0, 0xc0], 300);
  eng.frame();
  check(snap() === normal && eng.state.frames === 301, `play with a 300 frame skip lands on the same position as normal play (${snap()} vs ${normal})`);
  eng.stop();
}

// Exported .sid files (relocated player + packed music) must play in WebSid as a normal SID tune
for (const [addr, zp] of [[0x1000, 0xfc], [0xc000, 0x02], [0x0801, 0x80]]) {
  for (const e of d64Directory(d64).slice(1)) {
    const s = loadSongFile(d64ReadFile(d64, e));
    const packed = packNormal(s, addr, zp);
    const emu = new WebSid(mod);
    emu.load(makeSid(packed.bytes, addr, 1, { name: e.name, author: '', released: '', model: '8580', ntsc: false }), 48000);
    let sum = 0, n = 0;
    for (let f = 0; f < 300; f++) { const b = emu.frame(); for (let i = 0; i < b.length; i++) { sum += b[i] * b[i]; n++; } }
    const r = Math.round(Math.sqrt(sum / n));
    check(r > 500, `${e.name}: exported .sid at $${addr.toString(16)} (zp $${zp.toString(16)}) plays, rms ${r}`);
  }
}
process.exit(fail ? 1 : 0);
