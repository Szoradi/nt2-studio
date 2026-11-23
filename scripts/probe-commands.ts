// Shows what each command (instrument) of a song actually plays: the pitches and waveforms it goes
// through when triggered on one note. Useful before composing with someone else's instruments.
// Usage: node scripts/probe-commands.ts <song.nt2> [note number, default 60 = C-5] [commands in hex...]
import { readFileSync } from 'node:fs';
import { loadSongFile } from '../src/core/songfile.ts';
import { noteName, hex2 } from '../src/core/song.ts';
import { buildEditorSid, EDIT_PLAYER } from '../src/core/packer.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';

const song = loadSongFile(new Uint8Array(readFileSync(process.argv[2])));
const note = Number(process.argv[3] ?? 60);
const only = process.argv.slice(4).map(x => parseInt(x, 16));

// PAL frequency value of each note number (C-1 = 12)
const freqOf = (n: number) => Math.round(440 * 2 ** ((n - 69 + 12) / 12) * 16777216 / 985248);
function nearest(freq: number): string {
  if (!freq) return '0';
  const n = Math.round(69 - 12 + 12 * Math.log2(freq * 985248 / 16777216 / 440));
  const cents = Math.round(1200 * Math.log2(freq / freqOf(n)));
  return noteName(n * 2) + (Math.abs(cents) > 15 ? (cents > 0 ? '+' : '') + cents : '');
}

song.commands.forEach((c, i) => {
  const num = i + 1;
  if (!(c.ad || c.sr || c.wave || c.pulse || c.filt)) return;
  if (only.length && !only.includes(num)) return;
  const s = structuredClone(song);
  s.patterns = s.patterns.map(() => []);
  s.patterns[0] = [{ note: note * 2, cmd: num, dur: 48 }, { note: 8, cmd: 0, dur: 48 }];
  s.patterns[1] = [{ note: 8, cmd: 0, dur: 48 }, { note: 8, cmd: 0, dur: 48 }];
  s.tracks = s.tracks.map(() => [[], [], []]);
  s.tracks[0] = [[0xc0, 1, 0, 0], [0xc0, 2, 0, 0], [0xc0, 2, 0, 0]];
  const { sid } = buildEditorSid(s, '8580');
  const mem = new Uint8Array(0x10000);
  mem.set(sid.subarray(0x7e), EDIT_PLAYER);
  const cpu = new CPU6502(mem);
  const reg = new Uint8Array(25);
  cpu.onWrite = (a, v) => { if (a >= 0xd400 && a < 0xd419) reg[a - 0xd400] = v; };
  cpu.a = 0;
  cpu.call(EDIT_PLAYER);
  const seq: string[] = [];
  for (let f = 0; f < 40; f++) {
    cpu.call(EDIT_PLAYER + 3);
    if (f < 3) continue; // init and hard restart
    seq.push(`${hex2(reg[4])}:${nearest(reg[0] | (reg[1] << 8))}`);
  }
  // collapse repeats
  const out: string[] = [];
  let run = 0;
  for (let i = 0; i <= seq.length; i++) {
    if (i < seq.length && i > 0 && seq[i] === seq[i - 1]) { run++; continue; }
    if (i > 0) out.push(seq[i - 1] + (run ? `x${run + 1}` : ''));
    run = 0;
  }
  console.log(`${hex2(num)} AD ${hex2(c.ad)} SR ${hex2(c.sr)} W${hex2(c.wave)} P${hex2(c.pulse)} F${hex2(c.filt)}  ${out.slice(0, 14).join(' ')}${out.length > 14 ? ' ...' : ''}`);
});
