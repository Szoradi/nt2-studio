// Builds "second strike": a new tune that reuses the instruments (tables and commands) of the
// MW4TITLE example song, with all-new patterns and tracks. Writes songs/second-strike.nt2.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { d64Directory, d64ReadFile } from '../src/core/d64.ts';
import { loadSongFile, saveSongFile } from '../src/core/songfile.ts';
import {
  type Row, KEYON, KEYOFF, packedPatternSize, patternDuration, trackProblem, songTrackBytes, MAX_PATTLEN,
} from '../src/core/song.ts';
import { buildEditorSid, EDIT_PLAYER, packNormal } from '../src/core/packer.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';

const d64 = new Uint8Array(readFileSync('public/examples.d64'));
const song = loadSongFile(d64ReadFile(d64, d64Directory(d64).find(e => e.name === 'MW4TITLE')!));

// Keep the sounds, drop the music
song.patterns = song.patterns.map(() => []);
song.tracks = song.tracks.map(() => [[], [], []]);

type R = [number | 'on' | 'off', string?, number?];
const rows = (list: R[]): Row[] => list.map(([n, cmd, dur]) => ({
  note: n === 'on' ? KEYON : n === 'off' ? KEYOFF : n * 2,
  cmd: cmd ? parseInt(cmd, 16) : 0,
  dur: dur ?? 0,
}));
// Note numbers: octave * 12 + semitone (C-1 = 12)
const E1 = 16, A1 = 21, C2 = 24, E2 = 28, A2 = 33, E3 = 40, G3 = 43, A3 = 45, B3 = 47, C4 = 48;
const A4 = 57, B4 = 59, C5 = 60, D5 = 62, E5 = 64, F5 = 65, G5 = 67, GS5 = 68, A5 = 69;
void E1;

const P: Record<number, R[]> = {
  // 01: intro bass, one long filtered note per bar
  0x01: [[A1, '01', 64], ['on', '', 64]],
  // 02: one bar of silence
  0x02: [['off', '', 64], ['off']],
  // 03 / 04: rhythm guitar riff and its turnaround
  0x03: [[A3, '02', 8], [A2, '03'], [A2], [A3], [A2], [A2], [G3], [A2], [A2], [A3], [A2], [A2], [E3], [G3], [A3], ['on']],
  0x04: [[A3, '02', 8], [A2, '03'], [A2], [A3], [A2], [A2], [G3], [A2], [C4], [B3], [A3], [G3], [E3], [G3], [A3], [B3]],
  // 05 / 06: bass + bass drum + snare on one channel, and the same bar ending in a tom fill
  0x05: [[A1, '0C', 8], [A1], [A1, '0B'], [A1, '0C'], ['on'], [A2], [A1, '0B'], [A1, '0C'], ['on'], [A1], [A1, '0B'], [A1, '0C'], [E2], [A2], [A1, '0B'], [C2, '0C']],
  0x06: [[A1, '0C', 8], [A1], [A1, '0B'], [A1, '0C'], ['on'], [A2], [A1, '0B'], [A1, '0C'], ['on'], [A1], [A1, '0B'], [A1, '0C'], [A2, '0B'], [A2, '13'], [E2], [C2]],
  // 07 / 08: minor and major chord, one stab per bar (attack command, then the sustained variant)
  0x07: [[A3, '06', 8], [A3, '16', 64], ['on', '', 56]],
  0x08: [[A3, '08', 8], [A3, '18', 64], ['on', '', 56]],
  // 09 / 0A: the same chords with two stabs per bar
  0x09: [[A3, '06', 8], [A3, '16', 40], ['off', '', 16], [A3, '06', 8], [A3, '16', 56]],
  0x0a: [[A3, '08', 8], [A3, '18', 40], ['off', '', 16], [A3, '08', 8], [A3, '18', 56]],
  // 0B / 0C: lead melody, four bars each (F G Am Am, then F G Am E)
  0x0b: [
    [C5, '14', 32], [A4, '', 16], [C5], [F5, '', 48], [E5, '', 16],
    [D5, '', 32], [B4, '', 16], [D5], [G5, '', 32], [D5, '', 16], [B4],
    [B4, '14', 3], [C5, '9E', 13], [E5, '14', 16], [A5, '', 48], [G5, '', 16], [E5, '', 32],
    [D5, '', 16], [C5], [A4, '', 64], ['off', '', 32],
  ],
  0x0c: [
    [F5, '14', 32], [E5, '', 16], [C5], [A4, '', 32], [C5],
    [G5, '', 32], [F5, '', 16], [D5], [B4, '', 32], [D5],
    [A4, '', 8], [C5], [E5], [A5], [G5], [E5], [C5], [E5], [A5, '', 48], [G5, '', 16],
    [GS5, '', 32], [E5], [B4], [E5],
  ],
};
for (const [n, list] of Object.entries(P)) song.patterns[Number(n) - 1] = rows(list);

const hex = (s: string) => s.trim().split(/\s+/).map(b => parseInt(b, 16));
song.tracks[0] = [
  // Intro: Am Am F G | verse: Am Am F G Am Am F E | lead: F G Am Am F G Am E | loop to the verse
  hex('C0 01 01 BC 01 BE 01  C0 05 05 BC 05 BE 06 C0 05 05 BC 05 BB 06  BC 05 BE 05 C0 05 06 BC 05 BE 05 C0 05 BB 06  00 07'),
  hex('02 02 BC 03 BE 03     C0 03 03 BC 03 BE 03 C0 03 03 BC 03 BB 04  C0 0B 0C  00 06'),
  hex('C0 07 07 BC 08 BE 08  C0 07 07 BC 08 BE 08 C0 07 07 BC 08 BB 08  BC 0A BE 0A C0 09 09 BC 0A BE 0A C0 09 BB 0A  00 07'),
];

// --- Checks ---------------------------------------------------------------
let ok = true;
const fail = (m: string) => { console.log('FAIL  ' + m); ok = false; };
song.patterns.forEach((p, i) => {
  if (!p.length) return;
  if (packedPatternSize(p) > MAX_PATTLEN) fail(`pattern ${i + 1} too big`);
  if (patternDuration(p) % 128) fail(`pattern ${i + 1} is ${patternDuration(p)} frames, not whole bars`);
});
song.tracks[0].forEach((t, c) => { const p = trackProblem(t); if (p) fail(`track ${c + 1}: ${p}`); });
if (songTrackBytes(song.tracks[0]) > 256) fail('tracks too long');

// Run it in the 6502 core and time each channel's loop
const { sid, player } = buildEditorSid(song, '8580');
const mem = new Uint8Array(0x10000);
mem.set(sid.subarray(0x7e), EDIT_PLAYER);
const cpu = new CPU6502(mem);
cpu.a = 0;
cpu.call(EDIT_PLAYER);
const loops: number[][] = [[], [], []];
const prev = [0, 0, 0];
for (let f = 0; f < 50 * 60 * 3; f++) {
  cpu.call(EDIT_PLAYER + 3);
  [0, 7, 14].forEach((x, c) => { const p = mem[player.symbols.vchnsongpos + x]; if (p < prev[c]) loops[c].push(f); prev[c] = p; });
}
// A track is read when the last row of its last pattern starts, so add that row's length to get
// the moment the loop actually begins; that must be the same frame on all three channels.
const lastRow = [8, 32, 56];
const first = loops.map((l, c) => l[0] + lastRow[c]), period = loops.map(l => l[1] - l[0]);
if (!first.every(v => v === first[0]) || !period.every(v => v === period[0])) fail(`channels do not loop together: ${first} / ${period}`);

const packed = packNormal(song, 0x1000, 0xfc);
mkdirSync('songs', { recursive: true });
writeFileSync('songs/second-strike.nt2', saveSongFile(song));
console.log(`${ok ? 'OK' : 'PROBLEMS'}: intro+first pass ${first[0]} frames (${(first[0] / 50).toFixed(1)} s), loop ${period[0]} frames (${(period[0] / 50).toFixed(1)} s), ` +
  `${Object.keys(P).length} patterns, ${songTrackBytes(song.tracks[0])} track bytes, packed ${packed.stats.totalBytes} bytes`);
process.exit(ok ? 0 : 1);
