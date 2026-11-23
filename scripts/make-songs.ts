// Rebuilds the songs composed in the editor from their note lists and writes them to songs/:
//   claude2.nt2    - new song on the MW4TITLE instruments (with breakdown and build-up)
//   bubblegum.nt2  - original bubblegum-Eurodance tune with its own instruments
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { d64Directory, d64ReadFile } from '../src/core/d64.ts';
import { loadSongFile, saveSongFile } from '../src/core/songfile.ts';
import {
  type Song, type Row, newSong, KEYON, KEYOFF, packedPatternSize, patternDuration, trackProblem, songTrackBytes, MAX_PATTLEN,
} from '../src/core/song.ts';
import { buildEditorSid, EDIT_PLAYER, packNormal } from '../src/core/packer.ts';
import { CPU6502 } from '../src/core/cpu6502.ts';

type R = [number | 'on' | 'off', string?, string?];
const rows = (list: R[]): Row[] => list.map(([n, cmd, dur]) => ({
  note: n === 'on' ? KEYON : n === 'off' ? KEYOFF : n * 2,
  cmd: cmd ? parseInt(cmd, 16) : 0,
  dur: dur ? parseInt(dur, 10) : 0,
}));
const hex = (s: string) => s.trim().split(/\s+/).map(b => parseInt(b, 16));
const rep = (a: R[], n: number): R[] => Array.from({ length: n }, () => a).flat();
const table = (s: string) => {
  const v = s.trim().split(/\s+/);
  return { left: v.map(x => parseInt(x.slice(0, 2), 16)), right: v.map(x => parseInt(x.slice(2), 16)) };
};

function finish(song: Song, name: string, bar: number, patterns: Record<number, R[]>, tracks: string[]) {
  for (const [n, list] of Object.entries(patterns)) song.patterns[Number(n) - 1] = rows(list);
  song.tracks[0] = tracks.map(hex);
  let ok = true;
  const fail = (m: string) => { console.log(`FAIL  ${name}: ${m}`); ok = false; };
  song.patterns.forEach((p, i) => {
    if (!p.length) return;
    if (packedPatternSize(p) > MAX_PATTLEN) fail(`pattern ${i + 1} too big`);
    if (patternDuration(p) % bar) fail(`pattern ${i + 1} is ${patternDuration(p)} frames, not whole bars`);
  });
  song.tracks[0].forEach((t, c) => { const p = trackProblem(t); if (p) fail(`track ${c + 1}: ${p}`); });

  // Run the player and time each channel's loop; every loop must be a whole number of bars
  const { sid, player } = buildEditorSid(song, '8580');
  const mem = new Uint8Array(0x10000);
  mem.set(sid.subarray(0x7e), EDIT_PLAYER);
  const cpu = new CPU6502(mem);
  cpu.a = 0;
  cpu.call(EDIT_PLAYER);
  const loops: number[][] = [[], [], []];
  const prev = [0, 0, 0];
  for (let f = 0; f < 50 * 60 * 4; f++) {
    cpu.call(EDIT_PLAYER + 3);
    [0, 7, 14].forEach((x, c) => { const p = mem[player.symbols.vchnsongpos + x]; if (p < prev[c]) loops[c].push(f); prev[c] = p; });
  }
  const period = loops.map(l => l[1] - l[0]);
  const longest = Math.max(...period);
  if (period.some(p => !(p > 0) || p % bar || longest % p)) fail(`loop lengths ${period} do not fit together`);
  mkdirSync('songs', { recursive: true });
  writeFileSync(`songs/${name}.nt2`, saveSongFile(song));
  const packed = packNormal(song, 0x1000, 0xfc);
  console.log(`${ok ? 'OK   ' : 'CHECK'} ${name}: loops of ${period.map(p => p / bar).join(' / ')} bars (${(longest / 50).toFixed(1)} s), ` +
    `${Object.keys(patterns).length} patterns, ${songTrackBytes(song.tracks[0])} track bytes, packed ${packed.stats.totalBytes} bytes`);
  return ok;
}

// ---------------------------------------------------------------------------
// claude2: MW4TITLE's instruments, E minor, 96 frames per bar
// ---------------------------------------------------------------------------
const d64 = new Uint8Array(readFileSync('public/examples.d64'));
const claude2 = loadSongFile(d64ReadFile(d64, d64Directory(d64).find(e => e.name === 'MW4TITLE')!));
claude2.patterns = claude2.patterns.map(() => []);
claude2.tracks = claude2.tracks.map(() => [[], [], []]);
const r = 28, o = 40;
const groove: R[] = [[r, '0C', '06'], [o], [r, '0B'], [r, '0C'], [r], [o], [r, '0B'], ['on'], [r, '0C'], [o], [r, '0B'], [r, '0C']];
const ok1 = finish(claude2, 'claude2', 96, {
  0x01: [['off', '', '48'], ['off']],
  0x02: [...groove, [r], [o], [r, '0B'], [31, '0C']],
  0x03: [...groove, [r, '0B'], [o, '13'], [35], [31]],
  0x04: [[40, '02', '06'], [28, '03'], [28], [40], [28], [43], [28], [40], [28], [28], [45], [28], [43], [28], [40], [38]],
  0x05: [[40, '02', '06'], [28, '03'], [28], [40], [28], [43], [28], [40], [47], [45], [43], [40], [43], [45], [47], [50]],
  0x06: [[64, '15', '06'], [59], [55], [59], [64], [59], [55], [59], [66], [59], [55], [59], [64], [59], [55], [59]],
  0x07: [[64, '15', '06'], [59], [56], [59], [64], [59], [56], [59], [66], [59], [56], [59], [64], [59], [56], [59]],
  0x08: [[52, '0E', '36'], [52], [52, '', '24']],
  0x09: [[52, '10', '36'], [52], [52, '', '24']],
  0x0a: [[64, '05', '24'], [67, '', '12'], [64], [60, '', '24'], [62], [66], [69, '', '12'], [66], [62, '', '24'], [64],
    [67, '', '36'], [66, '', '12'], [64, '', '24'], [59], [64, '', '48'], ['off', '', '24'], [59, '', '12'], [62]],
  0x0b: [[64, '05', '12'], [67], [72, '', '24'], [71], [67], [66, '', '12'], [69], [74, '', '24'], [72], [69],
    [71, '', '36'], [69, '', '12'], [66, '', '24'], [63], [66], [63], [59, '', '48']],
  // Breakdown and build-up
  0x0c: [[28, '01', '48'], ['on', '', '48']],
  0x0d: [[64, '05', '48'], [67], [66], [62]],
  0x0e: [[28, '0C', '12'], [28], [28], [28], [28], [28], [28], [28]],
  0x0f: [[28, '0B', '12'], [28], [28], [28], [28, '', '06'], [28], [28], [28], [40, '13'], [35], [31], [28]],
}, [
  '01 01  C0 02 BC 02 BE 02 C0 03 02 BC 02 BE 02 BB 03  BC 02 BE 02 C0 02 03 BC 02 BE 02 BB 02 03  C0 0C 0C BC 0C BE 0C  C0 0E BC 0E BE 02 BB 0F  00 02',
  '01 01  C0 04 BC 04 BE 04 C0 05 04 BC 04 BE 04 BB 05  C0 0A 0B  01 01 0D  01 BC 04 BE 04 BB 05  00 02',
  'C0 06 06  C0 06 BC 07 BE 07 C0 06 06 BC 07 BE 07 BB 07  BC 09 BE 09 C0 08 08 BC 09 BE 09 BB 09 09  C0 06 06 BC 07 BE 07  C0 08 BC 09 BE 09 BB 09  00 03',
]);

// ---------------------------------------------------------------------------
// bubblegum: own instruments, C major, 96 frames per bar (about 125 BPM)
// ---------------------------------------------------------------------------
const bg = newSong();
bg.patterns[0] = [];
bg.tables[0] = table('81D8 41AC 41A6 41A0 409A FF00  4100 FF00  81DC 81DE 80DC FF00  81D4 41B0 81D2 81D0 80CE FF00  4100 9600 C414  2100 FF00  4100 9004 9007 900C FF18  4100 9003 9007 900C FF1D');
bg.tables[1] = table('8080 FF00  8030 4010 40F0 FF04  8018 FF00');
const cmds: [string, string][] = [['00F8010100', 'kick'], ['00C7070100', 'bass'], ['0400090000', 'hat'], ['00F90D0100', 'clap'],
  ['019A130300', 'girl'], ['028A160000', 'guy'], ['0168180700', 'chord maj'], ['01681D0700', 'chord min']];
cmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  bg.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const kb: R[] = [[24, '01'], [24, '02'], [36], [24]];
const first = (list: R[], dur: string): R[] => [[list[0][0], list[0][1], dur], ...list.slice(1)];
const ok2 = finish(bg, 'bubblegum', 96, {
  0x01: [['off', '', '48'], ['off']],
  0x02: first(rep(kb, 4), '06'),
  0x03: first([...rep(kb, 3), [24, '04'], [24], [24], [24]], '06'),
  0x04: first(rep([[48, '07'], [48, '03'], [48, '04'], [48, '03']], 2), '12'),
  0x05: first(rep([[48, '08'], [48, '03'], [48, '04'], [48, '03']], 2), '12'),
  0x06: first(rep([[48, '07'], [48, '03']], 4), '12'),
  0x07: first(rep([[48, '08'], [48, '03']], 4), '12'),
  0x08: [[64, '05', '12'], [67], [64], [60], [62, '', '24'], ['off'], [62, '05', '12'], [67], [62], [59], [62, '', '24'], ['off'],
    [45, '06', '12'], [48], [45], [40], [43, '', '24'], [45], [41, '', '12'], [45], [48], [45], [43, '', '36'], ['off', '', '12']],
  0x09: [[67, '05', '12'], [64], [60], [64], [67, '', '24'], [69], [67, '', '12'], [62], [59], [62], [67, '', '36'], ['off', '', '12'],
    [45, '06'], [45], [48], [52], [50, '', '24'], [48], [41, '', '12'], [41], [45], [48], [50, '', '24'], [52, '', '12'], [55]],
  0x0a: [[60, '05', '06'], [60], [64, '', '12'], [67], [64], [60], [64], [67, '', '24'], [59, '', '06'], [59], [62, '', '12'], [67], [62], [59], [62], [67, '', '24'],
    [57, '', '06'], [57], [60, '', '12'], [64], [60], [57], [60], [64, '', '24'], [65, '', '12'], [64], [62], [60], [62, '', '24'], [55]],
  0x0b: [[64, '05', '06'], [64], [67, '', '12'], [72], [67], [64], [67], [72, '', '24'], [62, '', '06'], [62], [67, '', '12'], [71], [67], [62], [67], [71, '', '24'],
    [60, '', '06'], [60], [64, '', '12'], [69], [64], [60], [64], [69, '', '24'], [69, '', '12'], [67], [65], [64], [62, '', '24'], [60]],
}, [
  '01 01 BD 02 B9 02  C0 02 BB 02 BD 02 B9 02 C0 02 BB 02 BD 02 B9 03  00 06',
  'C0 01 01 01 01  08 09 0A 0B  00 05',
  'C0 06 BB 06 BD 07 B9 06  C0 04 BB 04 BD 05 B9 04  00 08',
]);

// ---------------------------------------------------------------------------
// processional: slow hymn-like piece, G major, 192 frames per bar (4/4, quarter = 48 frames)
// ---------------------------------------------------------------------------
const pr = newSong();
pr.patterns[0] = [];
//                 lead (delayed vibrato)  bass       harp       pad major            pad minor
pr.tables[0] = table('4100 9C00 C310      2100 FF00  1100 FF00  4100 9004 9007 FF08  4100 9003 9007 FF0C');
pr.tables[1] = table('8020 6008 60F8 FF02  8080 FF00');
pr.tables[2] = table('9130 FF00');
const prCmds: [string, string][] = [['6AA9010100', 'lead'], ['2ACA040001', 'bass'], ['0909060000', 'harp'],
  ['888A080500', 'pad maj'], ['888A0C0500', 'pad min']];
prCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  pr.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const on: R = ['on'];
const harp = (root: number, third: number): R[] =>
  [[root, '03', '24'], [root + 7], [root + 12], [root + 12 + third], [root + 19], [root + 12 + third], [root + 12], [root + 7]];
const ok3 = finish(pr, 'processional', 192, {
  // Bass: G Em C D, then G Em Am D
  0x01: [[31, '02', '48'], on, on, [35], [28], on, on, [28], [24], on, on, [26], [26], on, on, [30]],
  0x02: [[31, '02', '48'], on, on, [31], [28], on, on, [33], [33], on, on, [33], [26], on, [30], [26]],
  // Melody, two four-bar phrases
  0x03: [[59, '01', '48'], on, on, [62], [64], on, [62], [59], [60], on, on, [64], [62], on, on, [57]],
  0x04: [[59, '01', '48'], on, on, [62], [67], on, [66], [64], [64], on, [60], [57], [57], on, [59], [57]],
  // Broken chords in eighths (major on G, minor on E), and sustained pads for the second pass
  0x05: harp(43, 4),
  0x06: harp(40, 3),
  0x07: [[55, '04', '48'], on, on, on],
  0x08: [[52, '05', '48'], on, on, on],
  0x09: [['off', '', '48'], ['off'], ['off'], ['off']],
}, [
  '01  01 02  00 01',
  'C0 09 09 09 09  C0 03 04  CC 03 04  00 05',
  'C0 05 06 B9 05 BB 05  C0 05 06 B9 05 BB 05 C0 05 06 B9 06 BB 05  C0 07 08 B9 07 BB 07 C0 07 08 B9 08 BB 07  00 07',
]);

// ---------------------------------------------------------------------------
// machine age: sequencer bass, mechanical percussion and an Eastern-flavoured lead.
// E Phrygian dominant (E F G# A B C D), 96 frames per bar (about 125 BPM)
// ---------------------------------------------------------------------------
const ma = newSong();
ma.patterns[0] = [];
//                 seq bass   kick                      snare                     metal                     lead (fast vibrato)  drone (root-5th-octave)  slide
ma.tables[0] = table('4100 FF00  81D8 41AC 41A4 409C FF00  81D4 41B4 81D0 80CC FF00  41D7 81DA 41D0 80D8 FF00  2100 9400 C518 FF00  4100 9007 900C FF16      E100');
ma.tables[1] = table('8040 2020 20E0 FF02  8080 FF00');
ma.tables[2] = table('9120 3003 30FD FF02');
const maCmds: [string, string][] = [['0804010100', 'seq bass'], ['0804010101', 'seq start'], ['00F8030500', 'kick'], ['00F9080500', 'snare'],
  ['04000D0500', 'metal'], ['3A8A120000', 'lead'], ['888A160100', 'drone'], ['00001A0000', 'slide']];
maCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  ma.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const off: R = ['off'];
const ok4 = finish(ma, 'machine-age', 96, {
  // 01: the bass sequence alone (its first note starts the filter sweep); 02: with kick on beats 1 and 3
  0x01: [[28, '02', '06'], [40, '01'], [28], [28], [40], [28], [29], [28], [28], [40], [28], [38], [40], [28], [35], [38]],
  0x02: [[28, '03', '06'], [40, '01'], [28], [28], [40], [28], [29], [28], [28, '03'], [40, '01'], [28], [38], [40], [28], [35], [38]],
  // 03 / 04: metal ticks with snare on beats 2 and 4, and the same bar ending in a snare roll
  0x03: [[60, '05', '06'], off, [60], [60], [60, '04'], off, [60, '05'], off, [60], off, [60], [60], [60, '04'], off, [60, '05'], [60]],
  0x04: [[60, '05', '06'], off, [60], [60], [60, '04'], off, [60, '05'], off, [60], off, [60], [60], [60, '04'], [60], [60], [60]],
  // 05: one bar of drone; 06: one bar of silence
  0x05: [[40, '07', '48'], ['on']],
  0x06: [['off', '', '48'], off],
  // 08 / 09: the lead, four bars each. "88" is the slide command in legato mode: a grace note bends into the next
  0x08: [
    [64, '06', '24'], [65, '', '12'], [64], [62], [64, '', '36'],
    [65, '06', '03'], [68, '88', '09'], [65, '06', '12'], [64, '', '24'], [60, '', '12'], [59, '', '36'],
    [57, '', '12'], [60], [65, '', '24'], [64, '', '12'], [60], [62, '', '24'],
    [60, '', '12'], [59], [56, '', '24'], [59, '', '12'], [56], [52, '', '24'],
  ],
  0x09: [
    [59, '06', '12'], [60], [62], [64], [65, '', '24'], [64],
    [68, '', '36'], [65, '', '12'], [64, '', '24'], [62, '', '12'], [60],
    [62], [65], [69, '', '24'], [65, '', '12'], [62], [60, '', '24'],
    [59, '06', '03'], [60, '88', '09'], [59, '06', '12'], [56, '', '24'], [53, '', '12'], [52, '', '36'],
  ],
}, [
  // Intro (4): bass alone, then with kick | theme (8): E E F E / E E D E | interlude (4) | loop to the theme
  'C0 01 01 02 02  C0 02 02 C1 02 C0 02 02 02 BE 02 C0 02  02 02 02 02  00 05',
  'C0 06 06 06 06  08 09  05 05 05 05  00 05',
  'C0 05 05 03 03  03 03 03 04 03 03 03 04  03 03 03 04  00 05',
]);

// ---------------------------------------------------------------------------
// machine age 2: the long version. Same theme and instruments plus three new ones (chord stab,
// bright lead, tom); adds a driving variation, a breakdown, a build-up and a second theme.
// ---------------------------------------------------------------------------
const ma2 = structuredClone(ma);
{
  //            chord (major)        bright lead (octave blip)   tom
  const more = table('4100 9004 9007 FF1B  410C 2100 9400 C518 FF00    4118 410C 4106 4100 FF00');
  ma2.tables[0].left.push(...more.left);
  ma2.tables[0].right.push(...more.right);
  const extra: [string, string][] = [['04641B0500', 'chord'], ['1A8A1F0500', 'bright lead'], ['00F8240500', 'tom']];
  extra.forEach(([h, name], i) => {
    const b = hex(h.match(/../g)!.join(' '));
    ma2.commands[8 + i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
  });
}
const ok4b = finish(ma2, 'machine-age-2', 96, {
  // 0A: the bass sequence with a kick on every beat; 0B: the same using only root, fifth and octave,
  // so it can be moved to A, F and D for the second theme
  0x0a: [[28, '03', '06'], [40, '01'], [28], [28], [28, '03'], [28, '01'], [29], [28], [28, '03'], [40, '01'], [28], [38], [28, '03'], [28, '01'], [35], [38]],
  0x0b: [[28, '03', '06'], [40, '01'], [28], [28], [28, '03'], [28, '01'], [35], [28], [28, '03'], [40, '01'], [28], [40], [28, '03'], [28, '01'], [35], [40]],
  // 0C-0E: build-up kicks: on one, on one and three, on every beat
  0x0c: [[28, '03', '48'], ['off', '', '48']],
  0x0d: [[28, '03', '48'], [28, '03', '48']],
  0x0e: [[28, '03', '24'], [28, '03'], [28, '03'], [28, '03']],
  // 0F: sparse ticks; 10: busier percussion; 11 / 12: snare roll in eighths, then sixteenths into toms
  0x0f: [[60, '05', '24'], off, [60], [60, '', '12'], [60]],
  0x10: [[60, '05', '06'], [60], off, [60], [60, '04'], off, [60, '05'], [60], [60], off, [60], [60], [60, '04'], off, [60, '05'], [60, '04']],
  0x11: rep([[60, '04', '12']], 8),
  0x12: [...rep([[60, '04', '06']], 12), [48, '0B', '06'], [45, '0B'], [43, '0B'], [40, '0B']],
  // 14: chord stabs, E major with an F major push at the end of the bar
  0x14: [[52, '09', '06'], off, off, [52], off, off, [52], off, off, [52], off, [52], off, off, [53], off],
  // 15 / 16: second theme on the bright lead, over A A F E / A A D E
  0x15: [
    [69, '0A', '24'], [72, '', '12'], [71], [69, '', '24'], [64],
    [69, '', '12'], [71], [72], [74], [76, '', '36'], [72, '', '12'],
    [77, '', '24'], [76, '', '12'], [72], [69, '', '24'], [72, '', '12'], [69],
    [68, '', '36'], [71, '', '12'], [76, '', '24'], [74, '', '12'], [71],
  ],
  0x16: [
    [76, '0A', '12'], [72], [69], [72], [76], [81, '', '24'], [80, '', '12'],
    [81, '', '36'], [76, '', '12'], [72, '', '24'], [71, '', '12'], [69],
    [77, '', '24'], [74, '', '12'], [69], [74, '', '24'], [77, '', '12'], [81],
    [80, '', '48'], [76, '', '24'], [71, '', '12'], [68],
  ],
  // 17: breakdown melody, slow, with two bends
  0x17: [
    [64, '06', '48'], [65, '', '24'], [68],
    [68, '06', '03'], [69, '88', '09'], [69, '06', '36'], [68, '', '24'], [65],
    [64, '', '36'], [62, '', '12'], [60, '', '24'], [59],
    [59, '06', '03'], [60, '88', '09'], [59, '06', '36'], [56, '', '48'],
  ],
}, [
  // intro 4 | theme 8 (loop starts here) | interlude 4 | theme, driving, lead an octave up 8 | breakdown 4 | build-up 4
  // | second theme 8 | theme 8 | interlude with stabs 4
  'C0 01 01 02 02  C0 02 02 C1 02 C0 02 02 02 BE 02 C0 02  02 02 02 02  C0 0A 0A C1 0A C0 0A 0A 0A BE 0A C0 0A' +
  '  0C 0C 0C 0C  0C 0D 0E 01  C5 0B 0B C1 0B C0 0B C5 0B 0B BE 0B C0 0B  C0 0A 0A C1 0A C0 0A 0A 0A BE 0A C0 0A  0A 0A 0A 0A  00 05',
  'C0 06 06 06 06  08 09  05 05 05 05  CC 08 09  C0 17  C0 05 C1 05 C4 05 C7 05  C0 15 16  08 09  14 14 14 14  00 05',
  'C0 05 05 03 03  03 03 03 04 03 03 03 04  03 03 03 04  10 10 10 04 10 10 10 04  0F 0F 0F 0F  0F 0F 11 12' +
  '  10 03 10 04 10 03 10 04  10 10 10 04 10 10 10 04  03 03 03 04  00 05',
]);

// ---------------------------------------------------------------------------
// long autumn: power ballad. D major, 144 frames per bar (4/4, quarter = 36 frames, about 83 BPM)
// ---------------------------------------------------------------------------
const la = newSong();
la.patterns[0] = [];
//                 piano           kick+bass            bass       snare                     voice           guitar          bend
la.tables[0] = table('410C 4100 FF00  81D0 41A8 2100 FF00  2100 FF00  81D4 41B0 81D0 80CC FF00  1100 9800 C30C FF00  2100 9400 C520 FF00  E0C0');
la.tables[1] = table('8060 30FE FF00  8080 FF00');
la.tables[2] = table('9138 FF00');
const laCmds: [string, string][] = [['0A0A010100', 'piano'], ['00C9040401', 'kick+bass'], ['00C9080000', 'bass'], ['00F90A0400', 'snare'],
  ['5AA90F0000', 'voice'], ['1ACA130000', 'guitar'], ['0000170000', 'bend']];
laCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  la.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const piano = (root: number, third: number): R[] =>
  [[root, '01', '18'], [root + 7], [root + 12], [root + 12 + third], [root + 12], [root + 7], [root + 12], [root + 12 + third]];
const ok5 = finish(la, 'long-autumn', 144, {
  // 01: one long bass note; 02: half-time beat (kick on 1, snare on 3) with bass between; 0A: the same with a snare fill
  0x01: [[26, '03', '36'], on, on, on],
  0x02: [[26, '02', '18'], on, [26, '03'], on, [26, '04'], [26, '03'], [33], [26]],
  0x0a: [[26, '02', '18'], on, [26, '03'], on, [26, '04'], [26, '04', '09'], [26], [26], [26], [26], [26]],
  // 03 / 04: piano arpeggio, major on D and minor on B
  0x03: piano(38, 4),
  0x04: piano(35, 3),
  0x05: [['off', '', '36'], off, off, off],
  // 06 / 07: verse melody (D G Bm A, then D G Em A)
  0x06: [
    [66, '05', '36'], [64, '', '18'], [62], [57, '', '36'], on,
    [59], [62, '', '18'], [64], [62, '', '36'], on,
    [66], [64, '', '18'], [62], [59, '', '36'], [62],
    [61], on, [64], off,
  ],
  0x07: [
    [66, '05', '36'], [69, '', '18'], [66], [62, '', '36'], on,
    [67], [66, '', '18'], [64], [62, '', '36'], [59],
    [64], [67, '', '18'], [64], [59, '', '36'], [64],
    [61], [64], [57], on,
  ],
  // 08 / 09: guitar solo over the same chords. "87" is the bend command in legato mode
  0x08: [
    [64, '06', '06'], [66, '87', '30'], [69, '06', '18'], [74], [73], [69], [66, '', '36'],
    [71], [74, '', '18'], [71], [67], [69], [71, '', '36'],
    [73, '06', '06'], [74, '87', '30'], [71, '06', '18'], [69], [66], [69], [71, '', '36'],
    [69, '', '18'], [73], [76], [73], [69, '', '36'], on,
  ],
  0x09: [
    [74, '06', '18'], [73], [74], [78], [76], [74], [69, '', '36'],
    [71, '', '18'], [74], [79], [78], [74], [71], [67, '', '36'],
    [76, '06', '06'], [79, '87', '30'], [76, '06', '18'], [74], [71], [67], [64, '', '36'],
    [69], [73], [76], on,
  ],
}, [
  // Intro (4): piano over long bass | verse (8) | solo (8) | loop to the verse
  'C0 01 C5 01 BD 01 BB 01  C0 02 C5 02 BD 02 BB 02 C0 02 C5 02 C2 02 BB 0A  00 08',
  'C0 05 05 05 05  06 07 08 09  00 05',
  'C0 03 C5 03 C0 04 C7 03  C0 03 C5 03 C0 04 C7 03 C0 03 C5 03 C5 04 C7 03  00 08',
]);

// ---------------------------------------------------------------------------
// thin air: bubbling sequence, phasing pads and a gliding lead. E minor, 96 frames per bar
// ---------------------------------------------------------------------------
const ta = newSong();
ta.patterns[0] = [];
//                 blip       soft thump                tick            lead (delayed vibrato)  pad minor            pad major            glide
ta.tables[0] = table('1100 FF00  81D0 11A4 11A0 109C FF00  81DE 80DE FF00  4100 9800 C30E FF00     4100 9003 9007 FF0F  4100 9004 9007 FF13  E100' +
  //  hard kick (18)                 snare (1E)
  '  81D8 41AC 41A4 419E 4098 FF00  81D4 41B4 81D0 81CE 80CC FF00');
ta.tables[1] = table('8010 7F02 7FFE FF02  8040 FF00');
// Filter: 01 resonant low+band-pass sweep on channel 1; 05 takes channel 1 out of the filter so the beat hits hard
ta.tables[2] = table('A110 6001 60FF FF02  9000 FF00');
const taCmds: [string, string][] = [['0700010001', 'seq start'], ['0700010000', 'seq'], ['0800030000', 'thump'], ['0200080000', 'tick'],
  ['2AAA0B0500', 'lead'], ['AA8C0F0100', 'pad min'], ['AA8C130100', 'pad maj'], ['0000170000', 'glide'],
  ['00F8180500', 'kick'], ['00F91E0500', 'snare'], ['0800030001', 'thump swp'], ['00F8180505', 'kick open']];
taCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  ta.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const seq = (third: number): R[] => [[40, '03', '06'], [52, '02'], [47], [52], [40, '04'], [52, '02'], [47], [52 + third],
  [40], [52], [47], [52], [40, '04'], [52, '02'], [59], [52 + third]];
// A bar of the sequence with drum hits replacing some steps: { step: command }
const seqNotes = (third: number) => [40, 52, 47, 52, 40, 52, 47, 52 + third, 40, 52, 47, 52, 40, 52, 59, 52 + third];
const drumBar = (third: number, hits: Record<number, string>): R[] => {
  let cmd = '';
  return seqNotes(third).map((n, i): R => {
    const want = hits[i] ?? '02';
    const row: R = want === cmd ? [n] : [n, want];
    cmd = want;
    return i === 0 ? [n, want, '06'] : row;
  });
};
const K = '09', S = '0A';
const punchy = { 0: K, 4: S, 7: K, 8: K, 10: K, 12: S };
const ok6 = finish(ta, 'thin-air', 96, {
  // 0C: first theme bar, restarting the filter sweep after the beat section
  0x0c: drumBar(3, { 0: '0B', 4: '04', 12: '04' }),
  // 0D-10: build-up. The kick opens the filter, then doubles each bar until a snare roll
  0x0d: drumBar(3, { 0: '0C' }),
  0x0e: drumBar(3, { 0: K, 8: K }),
  0x0f: drumBar(3, { 0: K, 4: K, 8: K, 12: K }),
  0x10: drumBar(3, { 0: K, 2: S, 4: K, 6: S, 8: S, 9: S, 10: S, 11: S, 12: S, 13: S, 14: S, 15: S }),
  // 11 / 12: the punchy beat, minor and major
  0x11: drumBar(3, punchy),
  0x12: drumBar(4, punchy),
  // 01: the sequence alone (its first note starts the filter sweep); 02 / 03: minor and major with thump and ticks
  0x01: [[40, '01', '06'], [52, '02'], [47], [52], [40], [52], [47], [55], [40], [52], [47], [52], [40], [52], [59], [55]],
  0x02: seq(3),
  0x03: seq(4),
  // 04 / 05: one bar of pad, minor and major; 09: one bar of silence
  0x04: [[52, '06', '48'], on],
  0x05: [[52, '07', '48'], on],
  0x09: [['off', '', '48'], off],
  // 0A / 0B: the lead. "88" is the glide command in legato mode: the note slides up from the previous one
  0x0a: [
    [59, '05', '24'], [64, '88', '24'], [62, '05', '12'], [64], [59, '', '24'],
    [55, '', '48'], ['on', '', '24'], [57, '', '12'], [59],
    [60, '', '24'], [64, '88', '24'], [62, '05', '12'], [60], [55, '', '24'],
    [57, '', '48'], [54, '', '24'], [57],
  ],
  0x0b: [
    [59, '05', '24'], [64, '88', '24'], [66, '05', '12'], [67], [66, '', '24'],
    [64, '', '48'], ['on', '', '24'], [62, '', '12'], [59],
    [60, '', '24'], [67, '88', '24'], [64, '05', '24'], [60],
    [62, '', '36'], [57, '', '12'], [54, '', '24'], [50],
  ],
}, [
  // Intro (4) | theme (8): Em Em C D twice | bridge (4): Am Am C D | build-up (4): Em | theme over the beat (8), lead an octave up | loop
  'C0 01 01 02 02  C0 0C 02 BC 03 BE 03 C0 02 02 BC 03 BE 03  C5 02 02 BC 03 BE 03  C0 0D 0E 0F 10  11 11 BC 12 BE 12 C0 11 11 BC 12 BE 12  00 05',
  'C0 09 09 09 09  C0 0A 0B  09 09 09 09  09 09 09 09  CC 0A 0B  00 05',
  'C0 09 09 04 04  C0 04 04 BC 05 BE 05 C0 04 04 BC 05 BE 05  C5 04 04 BC 05 BE 05  C0 04 04 04 04  04 04 BC 05 BE 05 C0 04 04 BC 05 BE 05  00 05',
]);

// ---------------------------------------------------------------------------
// back alley strut: blues-based hard rock. E blues, 112 frames per bar (16th = 7 frames, about 107 BPM)
// ---------------------------------------------------------------------------
const bs = newSong();
bs.patterns[0] = [];
//                 bass/riff  kick+bass                 snare                          crunch (root+5th)  lead guitar          bend  tom
bs.tables[0] = table('4100 FF00  81D4 41AC 41A4 4100 FF00  81D4 41B4 81D0 81CE 80CC FF00  2100 9007 FF0E     2100 9400 C51C FF00  E0A0  81C8 410C 4108 4004 4000 FF00');
bs.tables[1] = table('8080 FF00  8020 1804 18FC FF04');
const bsCmds: [string, string][] = [['00C8010100', 'bass'], ['00C8030100', 'kick+bass'], ['00F9080100', 'snare'], ['00C90E0000', 'crunch'],
  ['00A8010300', 'riff gtr'], ['0ACA110000', 'lead gtr'], ['0000150000', 'bend'], ['00A9160100', 'tom']];
bsCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  bs.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const ok7 = finish(bs, 'back-alley-strut', 112, {
  // Drums and bass on one channel: 01 / 02 two grooves, 03 with a tom fill, 04 pumping kick, 05 snare roll
  0x01: [[28, '02', '14'], [28, '01'], [28, '03'], [28, '01'], [28, '02'], [31, '01'], [28, '03'], [35, '01']],
  0x02: [[28, '02', '14'], [28, '01'], [28, '03'], [28, '02'], [28], [33, '01'], [28, '03'], [34, '01']],
  0x03: [[28, '02', '14'], [28, '01'], [28, '03'], [28, '01'], [40, '08', '07'], [40], [38], [38], [35], [35], [31], [31]],
  0x04: rep([[28, '02', '14']], 8).map((r, i): R => (i ? [28] : r)),
  0x05: [[28, '03', '14'], [28], [28], [28], [28, '', '07'], [28], [28], [28], [28], [28], [28], [28]],
  // The riff and its answer
  0x06: [[40, '05', '14'], [40, '', '07'], [43], [45, '', '14'], [43, '', '07'], [45], [46], [47], [50, '', '14'], [47], [43, '', '07'], [40]],
  0x07: [[40, '05', '14'], [40, '', '07'], [43], [45, '', '14'], [43, '', '07'], [45], [52, '', '14'], [50], [47, '', '07'], [45], [43, '', '14']],
  // Solo, four bars each (E E A A, then E E B A). "87" is the bend command in legato mode
  0x08: [
    [62, '06', '07'], [64, '87', '21'], [67, '06', '14'], [64], [62], [64, '', '42'],
    [67, '', '14'], [69], [67], [64], [62, '', '28'], [59],
    [60, '', '14'], [61], [64, '', '28'], [69, '', '14'], [67], [64, '', '28'],
    [69, '06', '07'], [71, '87', '21'], [69, '06', '14'], [67], [64], [61], [57, '', '28'],
  ],
  0x09: [
    [76, '06', '28'], [74, '', '14'], [71], [74], [71], [69], [67],
    [69, '06', '07'], [71, '87', '35'], [67, '06', '14'], [64], [62], [64, '', '28'],
    [66, '', '14'], [63], [66], [71], [69, '', '28'], [66],
    [64, '', '14'], [61], [57], [61], [64], [62], [59, '', '28'],
  ],
  // Build-up lead: long rising notes over four bars
  0x0a: [[64, '06', '56'], on, [67], on, [69], on, [71], [74]],
  // Power chords: two rhythms, and straight eighth-note chugging for the build-up
  0x0b: [[40, '04', '28'], ['off', '', '14'], [40, '04', '14'], [40, '', '28'], [43, '', '14'], [45]],
  0x0c: [[40, '04', '42'], [40, '', '14'], [38, '', '28'], [40]],
  0x0d: rep([[40, '04', '14']], 8).map((r, i): R => (i ? [40] : r)),
  0x0e: [['off', '', '56'], off],
}, [
  // Intro (4): riff alone, then the band | verse (8): E E A E / E E B A | build-up (4): E G A B | solo (8): E E A A / E E B A | loop to the verse
  '0E 0E C0 01 02  C0 01 02 C5 01 C0 02 01 02 C7 01 C5 03  C0 04 C3 04 C5 04 C7 05  C0 01 02 C5 01 02 C0 01 02 C7 01 C5 03  00 05',
  'C0 06 07 06 07  C0 06 07 C5 06 C0 07 06 07 C7 06 C5 07  C0 0A  08 09  00 05',
  'C0 0E 0E 0B 0C  C0 0B 0C C5 0B C0 0C 0B 0C C7 0B C5 0C  C0 0D C3 0D C5 0D C7 0D  C0 0B 0C C5 0B 0C C0 0B 0C C7 0B C5 0C  00 05',
]);

// ---------------------------------------------------------------------------
// side-step: Hi Five's instruments (tables and commands), all-new music. D minor, 96 frames per
// bar, swung drum+bass on channel 1 (7+5 frames), kick + chord stabs on 2, leads on 3.
// Each instrument stays on the channel Hi Five uses it on, because its commands set the filter.
// ---------------------------------------------------------------------------
// The instruments come from the imported Hi Five tune, which is not part of the repository; an
// existing side-step.nt2 holds the same tables and commands. Without either, side-step is skipped.
const ssSource = ['../Hi_Five_tune_1.nt2', 'songs/side-step.nt2'].find(f => existsSync(f));
const ss = ssSource ? loadSongFile(new Uint8Array(readFileSync(ssSource))) : newSong();
const skipSideStep: typeof finish = () => { console.log('skip  side-step: needs ../Hi_Five_tune_1.nt2 or songs/side-step.nt2 for its instruments'); return true; };
ss.patterns = ss.patterns.map(() => []);
ss.tracks = ss.tracks.map(() => [[], [], []]);
const DRUM = 36; // drums have absolute pitches, any note works
// channel 1: sixteen swung steps
const swing = (list: R[]): R[] => list.map(([n, c], i) => [n, c, i % 2 ? '05' : '07']);
const D1 = 14; // D-1, the groove's root; the track transposes it to the other chords
const ssGroove = (end: R[]): R[] => swing([
  [DRUM, '07'], [D1, '01'], [D1 + 12, '89'], [D1 + 12, '81'], [DRUM, '08'], ['off'], [D1, '09'], [D1 + 12, '81'],
  [DRUM, '07'], [D1, '01'], [D1 + 12, '89'], [D1, '81'], ...end]);
const longBass = (root: number): R[] => [[root, '0E', '24'], ['on'], ['on'], ['off']];
// channel 2: sixteen straight steps, kick on every beat, chord stabs between (x = stab, a = accent)
const stabs = (note: number, cmd: string, mask: string, snare = false): R[] => {
  const leg = (parseInt(cmd, 16) | 0x80).toString(16);
  return [...mask].map((m, i): R => {
    const r: R = m === 'K' ? [DRUM, snare && i === 12 ? '16' : '28'] : m === 'x' ? [note, leg] : m === 'a' ? [note, cmd] : ['off'];
    if (i === 0) r[2] = '06';
    return r;
  });
};
const VERSE = 'K.xxK.x.Kx.aK.x.', CHORUS = 'Kx.xK.xaKx.xK.xx';
const pluck = (note: number, cmd: string): R[] => [[note, cmd, '12'], [note], ['off'], [note], [note], ['off'], [note], [note]];
// channel 3
const fig = (hi: number, lo: number, top: number, end: number): R[] =>
  [[hi, '05', '06'], ['off'], [lo], [hi], ['off'], [lo], [hi], [hi], ['off'], [top], ['off'], [hi], [lo], ['on'], [end], ['off']];
const phrase = (notes: number[]): R[] => notes.map((n, i): R => i === 0 ? [n, '12', '06'] : n ? [n] : ['on']);
const arp = (a: number, b: number, c: number, d: number): R[] =>
  [a, b, c, d, c, b, a, b, c, d, c, b, a, b, c, d].map((n, i): R => i === 0 ? [n, '31', '06'] : i === 1 ? [n, 'B1'] : [n]);
/** A melody as [note, length in sixteenths] on one command; note 0 is a rest. Long notes are held with key-on rows. */
const tune = (cmd: string, list: [number, number][]): R[] => list.flatMap(([n, len], i): R[] => {
  const out: R[] = [];
  for (let left = len * 6, first = true; left > 0; first = false) {
    const d = Math.min(48, left);
    out.push([n ? (first ? n : 'on') : 'off', first && i === 0 ? cmd : '', String(d).padStart(2, '0')]);
    left -= d;
  }
  return out;
});

const ok8 = (ssSource ? finish : skipSideStep)(ss, 'side-step', 96, {
  // --- channel 1
  0x01: [...longBass(26), ...longBass(22), ...longBass(24), ...longBass(21)],
  0x02: [...longBass(26), ...longBass(22), ...longBass(24),
    [21, '0E', '24'], ['on'], [DRUM, '08', '12'], [DRUM], [DRUM, '', '06'], [DRUM], [DRUM], [DRUM]],
  0x03: ssGroove([[DRUM, '08'], [D1 + 12, '01'], [D1 + 7, '89'], [D1 + 12, '81']]),
  0x04: ssGroove([[DRUM, '08'], [D1, '01'], [DRUM, '08'], [DRUM, '08']]),
  // --- channel 2
  0x06: [[55, '14', '36'], [55], ['off', '', '24'], [53, '18', '36'], [53], ['off', '', '24'],
    [62, '19', '36'], [62], ['off', '', '24'], [57, '1D', '36'], [57], ['off', '', '24']],
  0x07: stabs(62, '03', VERSE), // Dm
  0x08: stabs(58, '02', VERSE), // Bb (sus2)
  0x09: stabs(60, '02', VERSE), // C (sus2)
  0x0a: stabs(57, '03', VERSE), // Am
  0x0b: stabs(55, '06', VERSE, true), // A7, snare on four
  0x0c: stabs(55, '0D', CHORUS), // Bb
  0x0d: stabs(57, '0D', CHORUS), // C
  0x0e: stabs(55, '0C', CHORUS), // Dm
  0x0f: stabs(62, '0D', CHORUS), // F
  0x10: stabs(54, '0D', CHORUS, true), // A
  0x11: pluck(62, '1C'), 0x12: pluck(55, '1B'), 0x13: pluck(57, '1B'), 0x14: pluck(54, '1B'),
  // --- channel 3
  0x15: [['off', '', '48'], ['off']],
  0x16: [...arp(62, 65, 69, 74), ...arp(58, 62, 65, 70), ...arp(60, 64, 67, 72), ...arp(57, 61, 64, 69)],
  0x17: [...phrase([62, 0, 0, 65, 0, 64, 0, 62, 0, 0, 57, 0, 60, 0, 62, 0]), ...fig(57, 53, 62, 50)],
  0x18: [...phrase([65, 0, 0, 62, 0, 58, 0, 62, 0, 0, 65, 0, 67, 0, 65, 0]), ...fig(58, 53, 62, 53)],
  0x19: [...phrase([64, 0, 0, 67, 0, 64, 0, 60, 0, 0, 64, 0, 62, 0, 60, 0]), ...fig(60, 55, 64, 52)],
  0x1a: [...phrase([64, 0, 0, 60, 0, 57, 0, 60, 0, 64, 0, 0, 69, 0, 0, 0]),
    ...phrase([61, 0, 0, 64, 0, 69, 0, 0, 73, 0, 0, 0, 0, 0]), ['off'], ['off']],
  // chorus: Bb C Dm Dm | Bb C F A
  0x1b: tune('38', [[65, 4], [62, 2], [65, 2], [70, 4], [69, 2], [65, 2], [67, 4], [64, 2], [67, 2], [72, 4], [70, 2], [67, 2],
    [69, 6], [65, 2], [62, 4], [65, 2], [69, 2], [74, 8], [0, 4], [69, 2], [72, 2]]),
  0x1c: tune('38', [[74, 4], [70, 2], [74, 2], [77, 4], [74, 2], [70, 2], [72, 4], [67, 2], [72, 2], [76, 4], [74, 2], [72, 2],
    [69, 2], [72, 2], [77, 4], [76, 2], [72, 2], [69, 4], [73, 6], [69, 2], [64, 4], [69, 2], [73, 2]]),
  // second verse: a singing lead over Dm Dm Bb Bb | C C Am A
  0x1d: tune('04', [[62, 8], [65, 4], [69, 4], [67, 6], [65, 2], [64, 4], [62, 4], [65, 8], [70, 4], [74, 4], [72, 6], [70, 2], [69, 8]]),
  0x1e: tune('04', [[67, 8], [64, 4], [60, 4], [64, 4], [67, 4], [72, 6], [67, 2], [69, 8], [64, 4], [60, 4], [61, 4], [64, 4], [69, 4], [73, 4]]),
  // breakdown: slow lead with the deep vibrato
  0x1f: tune('2F', [[69, 16], [70, 8], [74, 8], [72, 12], [67, 4], [69, 8], [64, 8]]),
  0x20: tune('2F', [[74, 16], [77, 8], [74, 8], [76, 8], [79, 8], [81, 12], [0, 4]]),
}, [
  // intro | verse (loop starts here) | chorus | verse 2 | breakdown | chorus x2
  'C0 01 02  C0 03 03 C8 03 03 CA 03 03 C7 03 04  C8 03 CA 03 C0 03 03 C8 03 CA 03 C3 03 C7 04  C0 03 03 C8 03 03 CA 03 03 C7 03 04' +
  '  C0 01 02  C8 03 CA 03 C0 03 03 C8 03 CA 03 C3 03 C7 04  C8 03 CA 03 C0 03 03 C8 03 CA 03 C3 03 C7 04  00 03',
  'C0 06 06  C0 07 07 08 08 09 09 0A 0B  0C 0D 0E 0E 0C 0D 0F 10  07 07 08 08 09 09 0A 0B' +
  '  11 12 13 14 11 12 13 14  0C 0D 0E 0E 0C 0D 0F 10  0C 0D 0E 0E 0C 0D 0F 10  00 03',
  'C0 15 15 15 15 16  C0 17 18 19 1A  1B 1C  1D 1E  1F 20  1B 1C 1B 1C  00 06',
]);

// ---------------------------------------------------------------------------
// moon bazaar: goa-trance style. A Phrygian (A Bb C D E F G), 80 frames per bar (16th = 5 frames,
// 150 BPM). Channel 1: kick + rolling bass with a hat tick on the off-beat; channel 2: acid sequence
// through a resonant filter sweep that takes two bars; channel 3: percussion, then the lead.
// ---------------------------------------------------------------------------
const mb = newSong();
mb.patterns[0] = [];
//                 kick (01)                      bass (07)  hat+bass (09)   acid accent (0C)  snare (0F)                     hat (15)        ring lead (18)          glide (1C)  drone (1D)
mb.tables[0] = table('81D8 41AC 41A4 419E 4098 FF00  2100 FF00  81DE 2100 FF00  210C 2100 FF00    81D4 41B4 81D0 81CE 80CC FF00  81DE 80DE FF00  1500 FF00 FF00 FF00  E100        4100 9007 900C FF1D');
mb.tables[1] = table('8040 2020 20E0 FF02  8080 FF00');
// Filter, channel 2 only: 01 resonant low+band-pass sweep, one bar up and one bar down; 05 the same, brighter
mb.tables[2] = table('B218 5001 50FF FF02  B240 5001 50FF FF06');
const mbCmds: [string, string][] = [['00F8010500', 'kick'], ['00C8070000', 'bass'], ['00C8090000', 'hat+bass'], ['00E8070001', 'acid start'],
  ['00E8070000', 'acid'], ['00C90C0000', 'acid accent'], ['00F90F0500', 'snare'], ['0400150000', 'hat'],
  ['06A8180100', 'lead'], ['00001C0000', 'glide'], ['888A1D0100', 'drone'], ['00E8070005', 'acid bright']];
mbCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  mb.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const A2 = 33;
const beat: R[] = [[A2, '01'], [A2, '02'], [A2, '03'], [A2, '02']];
/** A bar of kick + three bass notes per beat; offs are the twelve bass notes as semitones above the root. */
const bassBar = (offs: number[]): R[] => first([0, 1, 2, 3].flatMap((b): R[] =>
  [[A2, '01'], [A2 + offs[b * 3], '02'], [A2 + offs[b * 3 + 1], '03'], [A2 + offs[b * 3 + 2], '02']]), '05');
/** A bar of sixteen acid notes; accents are step numbers, start is the command of the first note. */
// A note of 0 is a rest; ties are steps played legato (command 85), so the note changes without a new attack.
const acid = (notes: number[], accents: number[], start = '05', ties: number[] = []): R[] => {
  let cur = '';
  return notes.map((n, i): R => {
    if (!n) return i === 0 ? ['off', '', '05'] : ['off'];
    const want = i === 0 ? start : ties.includes(i) ? '85' : accents.includes(i) ? '06' : '05';
    const row: R = want === cur ? [n] : [n, want];
    cur = want;
    if (i === 0) row[2] = '05';
    return row;
  });
};
const acid1 = [45, 45, 57, 45, 46, 45, 57, 45, 45, 55, 45, 57, 48, 45, 46, 52];
const acid2 = [45, 57, 45, 52, 45, 53, 52, 45, 57, 45, 55, 45, 53, 52, 48, 46];
const acid3 = [57, 57, 69, 57, 58, 57, 64, 57, 60, 57, 69, 65, 64, 60, 58, 57];
/** The lead as [note, sixteenths] (0 = rest) or ['b', from, to, sixteenths]: a 3-frame grace note gliding into the target. */
type M = [number, number] | ['b', number, number, number];
const mel = (list: M[]): R[] => list.flatMap((m): R[] => {
  const d = (f: number) => String(f).padStart(2, '0');
  if (m[0] === 'b') return [[m[1], '09', '03'], [m[2], '8A', d(m[3] * 5 - 3)]];
  const out: R[] = [];
  for (let left = m[1] * 5, start = true; left > 0; start = false) {
    const len = Math.min(60, left);
    out.push([m[0] ? (start ? m[0] : 'on') : 'off', start ? '09' : '', d(len)]);
    left -= len;
  }
  return out;
});
const HT: R = [60, '08'], SN: R = [60, '07'];
const ok9 = finish(mb, 'moon-bazaar', 80, {
  // --- channel 1. 01: kick on every beat; 02: kick, bass, hat+bass, bass; 03: the same with a bass fill
  0x01: [[A2, '01', '20'], [A2, '01'], [A2, '01'], [A2, '01']],
  0x02: first(rep(beat, 4), '05'),
  0x03: first([...rep(beat, 3), [A2, '01'], [A2 + 12, '02'], [A2 + 10, '03'], [A2 + 12, '02']], '05'),
  // 04 / 05: build-up kicks on one, then on one and three; 06: a long bass note for the breakdown
  0x04: [[A2, '01', '40'], ['off', '', '40']],
  0x05: [[A2, '01', '40'], [A2, '01', '40']],
  0x06: [[A2, '02', '30'], [A2 + 12, '02', '10'], [A2 + 7, '', '20'], [A2, '', '20']],
  // Bass variations. 18 and 1B use only root, fifth and octave, so they can move to Bb, C and G;
  // 19 and 1A walk through the Phrygian scale and stay on A
  0x18: bassBar([0, 12, 0, 0, 12, 7, 0, 12, 0, 7, 12, 7]),
  0x19: bassBar([0, 0, 1, 0, 0, 3, 0, 1, 0, 3, 1, 0]),
  0x1a: bassBar([0, 0, 0, 3, 3, 3, 5, 5, 5, 7, 8, 7]),
  0x1b: bassBar([0, 0, 12, 0, 0, 12, 0, 7, 12, 12, 7, 0]),
  // --- channel 2. 07: first acid bar, starting the filter sweep; 08 / 09: the two-bar acid figure;
  // 0A: the high figure; 0B: the same, starting the brighter sweep; 0C: drone through the sweep
  0x07: acid(acid1, [2, 6, 11], '04'),
  0x08: acid(acid1, [2, 6, 11]),
  0x09: acid(acid2, [1, 8, 13]),
  0x0a: acid(acid3, [2, 10]),
  0x0b: acid(acid3, [2, 10], '0C'),
  0x0c: [[45, '0B', '40'], ['on', '', '40']],
  // Acid variations. 1C: syncopated, with rests; 1D: a run up and down the scale with tied notes;
  // 1E: octave hammer climbing A, Bb, C; 1F / 20: two more high figures, the second with rests
  0x1c: acid([45, 0, 57, 45, 0, 46, 45, 0, 57, 45, 0, 55, 53, 52, 0, 48], [2, 8]),
  0x1d: acid([45, 48, 50, 52, 53, 52, 50, 48, 45, 57, 55, 53, 52, 50, 48, 46], [9], '05', [3, 7, 11, 15]),
  0x1e: acid([45, 45, 57, 57, 45, 45, 58, 57, 45, 45, 60, 57, 55, 57, 58, 60], [2, 6, 10]),
  0x1f: acid([57, 69, 57, 64, 57, 65, 64, 57, 0, 69, 57, 67, 65, 64, 60, 58], [1, 9], '05', [6, 14]),
  0x20: acid([57, 0, 69, 57, 60, 0, 58, 57, 64, 65, 0, 64, 60, 58, 57, 0], [2]),
  // --- channel 3. 0D: silence; 0E: hats with a snare on two and four; 0F: the same ending in a roll
  0x0d: [['off', '', '40'], off],
  0x0e: first([off, off, HT, [60], SN, off, HT, off, off, HT, [60], [60], SN, off, HT, [60]], '05'),
  0x0f: first([off, off, HT, [60], SN, off, HT, off, off, HT, [60], [60], SN, [60], [60], [60]], '05'),
  // 10 / 11: snare roll in eighths, then sixteenths; 12: sparse off-beat hats
  0x10: first(rep([SN], 8), '10'),
  0x11: first(rep([SN], 16), '05'),
  0x12: first(rep([off, HT], 4), '10'),
  // 13 / 14: first theme, mostly quarter notes, over A A A A / A A Bb G
  0x13: mel([
    [57, 4], [64, 4], [65, 4], [58, 2], [57, 2],
    ['b', 57, 58, 4], [57, 4], [64, 4], [60, 4],
    [57, 4], [64, 4], [65, 4], [69, 4],
    [69, 4], [65, 4], [64, 4], [58, 2], [57, 2],
  ]),
  0x14: mel([
    [64, 4], [69, 4], [65, 4], [62, 4],
    ['b', 64, 65, 4], [64, 4], [60, 4], [57, 4],
    [58, 4], [65, 4], [70, 4], [65, 4],
    [67, 4], [70, 4], [69, 4], [64, 4],
  ]),
  // 15 / 16: second theme, higher, each bar opening with a two-note pickup, over A A C C / Bb Bb G A
  0x15: mel([
    [69, 2], [64, 2], [70, 4], [72, 4], [64, 4],
    ['b', 69, 70, 4], [69, 4], [64, 4], [67, 4],
    [72, 2], [67, 2], [72, 4], [76, 4], [72, 4],
    [76, 4], [72, 4], [67, 4], [64, 4],
  ]),
  0x16: mel([
    [70, 2], [65, 2], [70, 4], [74, 4], [70, 4],
    [74, 4], [70, 4], [65, 4], [62, 4],
    [67, 2], [62, 2], [67, 4], [70, 4], [69, 4],
    ['b', 68, 69, 4], [64, 4], [72, 4], [69, 4],
  ]),
  // 17: breakdown melody, slow, over A A Bb G
  0x17: mel([
    [64, 8], [65, 4], [64, 4],
    ['b', 68, 69, 8], [67, 4], [65, 4],
    [65, 6], [62, 2], [58, 8],
    [62, 6], [67, 2], [70, 4], [69, 4],
  ]),
}, [
  // intro 4 + 4 | theme 8 (loop starts here) | interlude 4 | second theme 8 | breakdown 4 | build-up 4 | theme, lead an octave up 8 (the lead is written an octave high: B4 brings it down)
  'C0 01 01 01 01  02 02 18 03  C0 02 18 19 03 02 1B C1 18 BE 03  C0 1A 18 1A 03  02 19 C3 18 1B C1 02 18 BE 1B C0 1A' +
  '  06 06 C1 06 BE 06  C0 04 05 01 01  1B 18 19 1A 02 1B C1 18 BE 03  00 09',
  'C0 07 09 08 1C  08 09 1E 1D  C0 07 09 1C 1D 08 1E C1 08 BE 09  C0 0B 1F 20 0A  07 1C C3 08 09 C1 08 09 BE 08 C0 1D' +
  '  0C 0C C1 0C BE 0C  C0 08 C1 08 C3 0A C5 0A  C0 0B 1F 0A 20 1F 0A C1 0A BE 0A  00 09',
  'C0 0D 0D 0D 0D  0E 0E 0E 0F  B4 13 14  0E 0E 0E 0F  15 16  17  12 12 10 11  C0 13 14  00 09',
]);

// ---------------------------------------------------------------------------
// rainy window: lo-fi jazz. C major / D dorian, seventh chords, 168 frames per bar (quarter = 42
// frames, about 71 BPM) with swung eighths (28 + 14 frames). Channel 1: soft drums and a triangle
// bass; channel 2: electric-piano seventh chords through a slowly moving low-pass; channel 3: a
// triangle lead with a late, gentle vibrato.
// ---------------------------------------------------------------------------
const rw = newSong();
rw.patterns[0] = [];
//                 kick+bass (01)            bass (06)  snare (08)                hat (0D)        maj7 (10)                 m7 (15)                   dom7 (1A)                 lead (1F)            glide (23)
rw.tables[0] = table('81D0 41A8 41A0 1100 FF00  1100 FF00  81D0 41B0 81CC 80C8 FF00  81DE 80DE FF00  4100 9004 9007 900B FF10  4100 9003 9007 900A FF15  4100 9004 9007 900A FF1A  1100 9C00 C320 FF00  E100');
rw.tables[1] = table('8050 3010 30F0 FF02  8080 FF00');
// Filter: low-pass on channels 2 and 3 (chords and lead), drifting slowly up and down
rw.tables[2] = table('9620 3001 30FF FF02');
const rwCmds: [string, string][] = [['00A8010500', 'kick+bass'], ['02A8060000', 'bass'], ['0087080500', 'snare'], ['03000D0000', 'hat'],
  ['3879100100', 'keys maj7'], ['3879150100', 'keys m7'], ['38791A0100', 'keys dom7'], ['3879150101', 'keys start'],
  ['58791F0000', 'lead'], ['0000230000', 'glide']];
rwCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  rw.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
/** A swung line: [note, eighths] (0 = rest) or ['b', from, to, eighths]. On-beat eighths last 28 frames, off-beat ones 14. */
const rwLine = (list: M[]): R[] => {
  let pos = 0;
  const d = (f: number) => String(f).padStart(2, '0');
  return list.flatMap((m): R[] => {
    const slots = m[0] === 'b' ? m[3] : m[1];
    let frames = 0;
    for (let i = 0; i < slots; i++, pos++) frames += pos % 2 ? 14 : 28;
    if (m[0] === 'b') return [[m[1], '09', '03'], [m[2], '8A', d(Math.min(60, frames - 3))],
      ...(frames - 3 > 60 ? [['on', '', d(frames - 63)] as R] : [])];
    const out: R[] = [];
    for (let left = frames, start = true; left > 0; start = false) {
      const len = left > 60 ? 56 : left;
      out.push([m[0] ? (start ? m[0] : 'on') : 'off', start ? '09' : '', d(len)]);
      left -= len;
    }
    return out;
  });
};
const comp = (cmd: string, again = cmd): R[] => [[48, cmd, '56'], ['off', '', '14'], [48, again, '56'], ['off', '', '42']];
const held = (cmd: string): R[] => [[48, cmd, '56'], ['on', '', '56'], ['on', '', '56']];
const ok10 = finish(rw, 'rainy-window', 168, {
  // --- channel 1 (root C). 01: long bass notes, no drums; 02 / 03: two grooves; 04: groove ending in a snare fill
  0x01: [[24, '02', '56'], ['on', '', '28'], [31, '02', '42'], [24, '02', '42']],
  0x02: [[24, '01', '28'], [60, '04', '14'], [60, '03', '28'], [24, '02', '14'], [31, '01', '28'], [60, '04', '14'], [60, '03', '28'], [36, '02', '14']],
  0x03: [[24, '01', '28'], [24, '02', '14'], [60, '03', '28'], [60, '04', '14'], [36, '01', '28'], [31, '02', '14'], [60, '03', '28'], [60, '04', '14']],
  0x04: [[24, '01', '28'], [60, '04', '14'], [60, '03', '28'], [24, '02', '14'], [31, '01', '28'], [60, '04', '14'], [60, '03', '14'], [60, '03', '14'], [60, '03', '14']],
  // --- channel 2 (root C). 05-07: chord on one and on the "and" of two (maj7, m7, dom7);
  // 08-0B: chord held for the bar (m7 starting the filter, dom7, maj7, m7)
  0x05: comp('05'), 0x06: comp('06'), 0x07: comp('07'),
  0x08: held('08'), 0x09: held('07'), 0x0a: held('05'), 0x0b: held('06'),
  // --- channel 3. 0C: silence; 0D / 0E: first tune over Dm7 G7 Cmaj7 Am7 / Dm7 G7 Em7 A7
  0x0c: [['off', '', '56'], off, off],
  0x0d: rwLine([
    [0, 1], [65, 1], [69, 2], [72, 1], [69, 3],
    [71, 3], [69, 1], [67, 2], [65, 2],
    [64, 4], [0, 1], [67, 1], [71, 2],
    ['b', 68, 69, 3], [67, 1], [64, 4],
  ]),
  0x0e: rwLine([
    [0, 1], [65, 1], [69, 1], [72, 1], [76, 3], [74, 1],
    [74, 2], [71, 1], [67, 1], [65, 3], [64, 1],
    [67, 3], [71, 1], [74, 2], [71, 2],
    [73, 3], [69, 1], [67, 2], [64, 1], [61, 1],
  ]),
  // 0F / 10: second tune, higher, over Fmaj7 Em7 Dm7 G7 / Fmaj7 Em7 Am7 A7
  0x0f: rwLine([
    [69, 2], [72, 1], [76, 3], [0, 2],
    [74, 1], [71, 1], [67, 2], [64, 1], [67, 3],
    [65, 2], [69, 1], [72, 2], [74, 1], [77, 2],
    ['b', 75, 76, 3], [74, 1], [71, 2], [67, 2],
  ]),
  0x10: rwLine([
    [69, 1], [72, 1], [76, 1], [79, 3], [76, 2],
    [74, 3], [71, 1], [67, 2], [0, 2],
    [72, 2], [76, 1], [81, 3], [79, 1], [76, 1],
    [73, 4], [76, 1], [79, 1], [81, 2],
  ]),
  // 11: breakdown, a few long notes over Dm7 G7 Cmaj7 A7
  0x11: rwLine([
    [0, 2], [69, 2], [65, 4],
    [0, 2], [67, 2], [62, 4],
    [0, 1], [64, 1], [67, 2], [71, 4],
    [69, 4], [73, 2], [0, 2],
  ]),
}, [
  // Transposes: C2 = D, BB = G, C0 = C, BD = A, C4 = E, C5 = F
  // intro 4 (no drums) | first tune 8 (loop starts here) | second tune 8 | breakdown 4 (no drums)
  'C2 01 BB 01 C0 01 BD 01  C2 02 BB 03 C0 02 BD 03 C2 02 BB 03 C4 02 BD 04  C5 02 C4 03 C2 02 BB 03 C5 02 C4 03 BD 02 04  C2 01 BB 01 C0 01 BD 01  00 08',
  'C2 08 BB 09 C0 0A BD 09  C2 06 BB 07 C0 05 BD 06 C2 06 BB 07 C4 06 BD 07  C5 05 C4 06 C2 06 BB 07 C5 05 C4 06 BD 06 07  C2 0B BB 09 C0 0A BD 09  00 08',
  'C0 0C 0C 0C 0C  C0 0D 0E  0F 10  11  00 05',
]);

// ---------------------------------------------------------------------------
// rainy window (tech): the same notes as rainy window with harder, more electronic instruments.
// Patterns and tracks are copied; only the tables and commands differ (same command numbers).
// ---------------------------------------------------------------------------
const rwt = structuredClone(rw);
//                  kick+saw bass (01)        saw bass (06)  snare (08)                     hat (0E)        maj7 saw (11)             m7 saw (16)               dom7 saw (1B)             lead, octave blip (20)    glide (25)
rwt.tables[0] = table('81D8 41AC 41A4 2100 FF00  2100 FF00      81D4 41B4 81D0 81CE 80CC FF00  81DE 80DE FF00  2100 9004 9007 900B FF11  2100 9003 9007 900A FF16  2100 9004 9007 900A FF1B  410C 4100 9600 C418 FF00  E100');
rwt.tables[1] = table('8040 1030 10D0 FF02  8080 FF00');
// Filter: resonant low+band-pass on channel 2 (the chord stabs), sweeping up and down about once a beat
rwt.tables[2] = table('B220 2002 20FE FF02');
const rwtCmds: [string, string][] = [['00C8010500', 'kick+bass'], ['00C8060000', 'saw bass'], ['00F9080500', 'snare'], ['04000E0000', 'hat'],
  ['0868110000', 'stab maj7'], ['0868160000', 'stab m7'], ['08681B0000', 'stab dom7'], ['0868160001', 'stab start'],
  ['074A200100', 'pulse lead'], ['0000250000', 'glide']];
rwtCmds.forEach(([h, name], i) => {
  const b = hex(h.match(/../g)!.join(' '));
  rwt.commands[i] = { ad: b[0], sr: b[1], wave: b[2], pulse: b[3], filt: b[4], name };
});
const ok11 = finish(rwt, 'rainy-window-tech', 168, {}, rw.tracks[0].map(t => t.map(b => b.toString(16).padStart(2, '0')).join(' ')));

process.exit(ok1 && ok2 && ok3 && ok4 && ok4b && ok5 && ok6 && ok7 && ok8 && ok9 && ok10 && ok11 ? 0 : 1);
