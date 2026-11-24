// Checks editor logic that needs no browser: where "play from cursor" starts.
import { readFileSync, readdirSync } from 'node:fs';
import { loadSongFile } from '../src/core/songfile.ts';
import {
  S, replaceSong, cursorStart, trackTimeline, undo, programAt, programUsers, rowsPlayed, carriedDur, instStepRange, instMoveStep, instRemoveProgram, instClear,
} from '../src/ui/editor.ts';
import { patternDuration, newSong, emptyCommand } from '../src/core/song.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fail++; };

for (const file of readdirSync('songs').filter(f => f.endsWith('.nt2'))) {
  const name = file.replace('.nt2', '');
  replaceSong(loadSongFile(new Uint8Array(readFileSync('songs/' + file))), name);
  const longest = Math.max(...S.song.patterns.map(p => patternDuration(p)));
  let wrongTime = 0, maxSkip = 0, entries = 0;
  for (let c = 0; c < 3; c++) {
    S.focus = 'tracks';
    S.trkCh = c;
    for (const e of trackTimeline(c)) {
      S.trkRow[c] = e.row;
      const at = cursorStart();
      entries++;
      if (!at || at === 'notInTrack' || at.time !== e.time) { wrongTime++; continue; }
      maxSkip = Math.max(maxSkip, at.skip);
    }
  }
  // The silent run-up is bounded by the longest pattern, however long the song or short a looping track is
  check(wrongTime === 0 && maxSkip < longest,
    `${name}: play from cursor finds the right moment for all ${entries} track entries (longest silent run-up ${maxSkip} frames, longest pattern ${longest})`);

  // In a pattern: the cursor row adds its offset inside the pattern
  S.focus = 'pattern';
  S.pattCh = 1;
  const line = trackTimeline(1);
  const last = line[line.length - 1];
  S.trkRow[1] = last.row;
  S.pattNum[1] = last.patt;
  S.pattRow[1] = 1;
  const rows = S.song.patterns[last.patt - 1];
  const at = cursorStart();
  check(!!at && at !== 'notInTrack' && at.time === last.time + rows[0].dur,
    `${name}: from row 1 of a pattern it starts one row into that track entry`);
}

// ---------------------------------------------------------------------------
// The instrument editor: table programs of made-up songs. Rows are written left:right in hex,
// pointers are 1-based as in the song.
// ---------------------------------------------------------------------------

const PTRS = ['wave', 'pulse', 'filt'] as const;
/** A song with one table filled in and commands 0.. pointing at the given rows (0 = no pointer). */
function tableSong(t: number, rows: string, ptrs: number[]) {
  const song = newSong();
  const pairs = rows.split(' ').map(r => r.split(':').map(v => parseInt(v, 16)));
  song.tables[t] = { left: pairs.map(r => r[0]), right: pairs.map(r => r[1]) };
  song.commands = song.commands.map(() => emptyCommand());
  ptrs.forEach((at, i) => { if (at) song.commands[i] = { ...emptyCommand(), ad: 0x09, sr: 0xa9, name: `i${i}`, [PTRS[t]]: at }; });
  replaceSong(song, 'check');
}
const table = (t: number) => S.song.tables[t].left.map((l, i) => `${l.toString(16)}:${S.song.tables[t].right[i].toString(16)}`).join(' ');
const ptrs = (t: number, n: number) => S.song.commands.slice(0, n).map(c => c[PTRS[t]]).join(',');
const users = (t: number, i: number) => {
  const u = programUsers(S.song, t, programAt(S.song, t, S.song.commands[i][PTRS[t]])!, i);
  return `${u.cmds.join('+') || '-'}/${u.jumps}`;
};

// Moving steps
tableSong(0, '21:0 41:4 11:7 ff:1', [1]);
check(JSON.stringify(instStepRange(0, 0, 0)) === '{"first":0,"last":2}' && instStepRange(0, 0, 3) === null,
  'steps: every step of a program can move, its closing jump cannot');
instMoveStep(0, 0, 0, 2);
check(table(0) === '41:4 11:7 21:0 ff:1', 'steps: moving the first step last shifts the others up and leaves the repeat on step 1');
instMoveStep(0, 0, 2, 0);
check(table(0) === '21:0 41:4 11:7 ff:1', 'steps: moving it back restores the order');
instMoveStep(0, 0, 0, 3);
check(table(0) === '21:0 41:4 11:7 ff:1', 'steps: a move onto the closing jump is refused and changes nothing');
instMoveStep(0, 0, 1, 2);
undo();
check(table(0) === '21:0 41:4 11:7 ff:1', 'steps: undo takes a move back');
tableSong(0, '21:0 41:4 c4:20', [1]);
check(instStepRange(0, 0, 2) === null && JSON.stringify(instStepRange(0, 0, 0)) === '{"first":0,"last":1}',
  'steps: a closing vibrato stays last, the steps before it move among themselves');
tableSong(0, '21:0 c4:20', [1]);
check(instStepRange(0, 0, 0) === null, 'steps: a single step before a vibrato has nowhere to move');

// The rows a command's program plays
const played = (t: number, at: number) => [...rowsPlayed(S.song, t, at)].join(',');
tableSong(0, '21:0 41:0 ff:1', []);
check(played(0, 0) === '0,1,2', 'walk: a wave program plays its steps and takes the jump after the last one');
tableSong(0, '21:0 ff:4 41:0 ff:1', []);
check(played(0, 0) === '0,1,3', 'walk: a wave jump that lands on a jump row is not followed again (the player slides there)');
tableSong(0, '21:0 ff:1', []);
check(played(0, 1) === '1', 'walk: a wave pointer on a jump row goes nowhere');
tableSong(0, '21:0 92:0 c4:20 41:0 ff:1', []);
check(played(0, 0) === '0,1,2', 'walk: a wave program stops on its vibrato');
tableSong(0, '21:0 ff:0 41:0', []);
check(played(0, 0) === '0,1' && played(0, 9) === '', 'walk: a jump to 00 stops, and a pointer past the end plays nothing');
tableSong(1, '80:80 10:4 ff:2 80:10 ff:0', []);
check(played(1, 0) === '0,1,2', 'walk: a pulse program follows its repeat and ends when it comes round');
tableSong(1, '80:80 ff:4 80:10 ff:5 80:20 ff:0', []);
check(played(1, 0) === '0,1,3,4,5', 'walk: in the pulse table a jump that lands on a jump is followed');
tableSong(2, '91:80 0:4 91:10 ff:0', []);
check(played(2, 0) === '0,1', 'walk: a filter sweep that runs for ever is never left');

// Who shares a program
tableSong(0, '21:0 ff:4 41:0 ff:5 11:0 ff:0', [1, 0, 5]);
check(users(0, 2) === '-/1', 'sharing: a wave instrument sent onto a jump row does not go on to the program that row names');
tableSong(0, '21:0 ff:4 41:0 ff:3', [1, 3]);
check(users(0, 1) === '0/1', 'sharing: it does use the jump row it lands on');
tableSong(0, '21:0 41:0 ff:1', [1, 2]);
check(users(0, 1) === '0/0' && users(0, 0) === '1/0', 'sharing: an instrument that starts inside another program shares it, both ways');
tableSong(0, '21:0 ff:0 41:0 ff:3', [1, 3]);
check(users(0, 0) === '-/0' && users(0, 1) === '-/0', 'sharing: two programs side by side are not shared');
tableSong(0, '21:0 ff:0 41:0 ff:1', [1, 3]);
check(users(0, 0) === '1/1', 'sharing: a program another one jumps into is shared');
tableSong(1, '0:4 80:80 ff:0', [1, 2]);
check(users(1, 1) === '-/0', 'sharing: rows after a sweep that runs for ever are not reached by its instrument');
tableSong(0, '21:0 41:0 21:0 ff:0', [0, 3]);
check(users(0, 1) === '-/0', 'sharing: rows nothing points at do not make the program after them shared');

// Taking a table away
tableSong(0, '21:0 ff:0 41:0 ff:3', [1, 3]);
let extra = instRemoveProgram(0, 0);
check(table(0) === '41:0 ff:1' && ptrs(0, 2) === '0,1' && extra === 0, 'remove: the rows go, and the pointer and the jump after them follow');
undo();
check(table(0) === '21:0 ff:0 41:0 ff:3' && ptrs(0, 2) === '1,3', 'remove: undo brings the rows and the pointers back');
tableSong(0, '21:0 41:0 ff:1', [1, 2]);
instRemoveProgram(1, 0);
check(table(0) === '21:0 41:0 ff:1' && ptrs(0, 2) === '1,0', 'remove: rows another instrument still plays are kept');
tableSong(0, '21:0 c4:20 41:0 ff:1', [1]);
extra = instRemoveProgram(0, 0);
check(table(0) === '' && extra === 2, 'remove: unreachable rows that repeat back into the program go with it, and are counted');
tableSong(0, '21:0 c4:20 11:0 11:3 ff:3 81:0 ff:0', [1, 6]);
extra = instRemoveProgram(0, 0);
check(table(0) === '11:0 11:3 ff:1 81:0 ff:0' && ptrs(0, 2) === '0,4' && extra === 0, 'remove: a spare program after a vibrato is left alone');
tableSong(0, '21:0 c4:20 41:0 ff:0', [1, 3]);
extra = instRemoveProgram(0, 0);
check(table(0) === '41:0 ff:0' && ptrs(0, 2) === '0,1' && extra === 0, 'remove: rows after a vibrato that another instrument starts at are kept');

tableSong(0, '21:0 c4:20 41:0 ff:0', [1]);
extra = instRemoveProgram(0, 0);
check(table(0) === '41:0 ff:0' && extra === 0, 'remove: rows after a vibrato that end in a stop may be a spare program and are left');
tableSong(1, '80:80 10:4 ff:2 80:10 ff:4', [1, 4]);
extra = instRemoveProgram(0, 1);
check(table(1) === '80:10 ff:1' && ptrs(1, 2) === '0,1' && extra === 0, 'remove: a pulse program goes and what follows is renumbered');
tableSong(0, '21:0 41:4 ff:1', [1, 2]);
instMoveStep(1, 0, 1, 0);
check(table(0) === '21:0 41:4 ff:1', 'steps: an instrument that starts inside a program cannot move its one step out past its own start');

// Clearing an instrument
tableSong(0, '21:0 ff:0 41:0 ff:3', [1, 3]);
S.song.tables[1] = { left: [0x80, 0xff], right: [0x80, 0x00] };
S.song.commands[0].pulse = 1;
instClear(0);
check(table(0) === '41:0 ff:1' && table(1) === '' && ptrs(0, 2) === '0,1' && !S.song.commands[0].name && !S.song.commands[0].ad,
  'clear: the instrument is emptied and its own programs are removed from every table');
undo();
check(table(0) === '21:0 ff:0 41:0 ff:3' && table(1) === '80:80 ff:0' && S.song.commands[0].name === 'i0' && S.song.commands[0].pulse === 1,
  'clear: undo brings the instrument and its programs back');
tableSong(0, '21:0 41:0 ff:1', [1, 1]);
instClear(0);
check(table(0) === '21:0 41:0 ff:1' && ptrs(0, 2) === '0,1', 'clear: a program a second instrument uses stays');

// A pattern that starts without a duration keeps the one its channel had
{
  const song = newSong();
  const row = (dur: number) => ({ note: 0x30, cmd: 0, dur });
  song.patterns[0] = [row(6), row(0), row(12)];   // 01: ends on duration 12
  song.patterns[1] = [row(0), row(0), row(4)];    // 02: starts without one
  song.patterns[2] = [row(0), row(0)];            // 03: has none at all
  song.patterns[3] = [row(0)];                    // 04: played by no track
  song.tracks[0] = [[2, 1, 2, 3, 0, 0], [3, 0, 0], [1, 0, 0]];
  replaceSong(song, 'check');
  const line = trackTimeline(0);
  check(line.map(e => `${e.time}/${e.dur}`).join(' ') === '0/3 10/4 34/12 62/4',
    'carried: a track gives each pattern the duration the one before it ended on, and 3 frames before any is set');
  S.pattCh = 0; S.pattNum = [2, 3, 4]; S.trkRow = [0, 0, 0];
  check(carriedDur(0) === 3, 'carried: the shown pattern takes the duration of its use at the track cursor');
  S.trkRow[0] = 2;
  check(carriedDur(0) === 12, 'carried: at a later use of the pattern it is the duration carried there');
  S.trkRow[0] = 1;
  check(carriedDur(0) === 3, 'carried: with the track cursor on another pattern it is the first use in the track');
  check(carriedDur(2) === 0, 'carried: a pattern no track plays has none');
  S.pattNum[2] = 3;
  check(carriedDur(2) === 4, 'carried: a pattern its own channel does not play takes the duration from the channel that does');
  check(patternDuration(song.patterns[1], 12) === 28 && patternDuration(song.patterns[1]) === 4,
    'carried: the length of a pattern counts its first rows with the carried duration');
  S.focus = 'pattern'; S.pattCh = 0; S.pattNum[0] = 2; S.trkRow[0] = 2; S.pattRow[0] = 2;
  const at = cursorStart();
  check(!!at && at !== 'notInTrack' && at.time === 34 + 24, 'carried: play from the cursor counts the rows above it with the carried duration');
}

process.exit(fail ? 1 : 0);
