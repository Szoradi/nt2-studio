// Checks editor logic that needs no browser: where "play from cursor" starts.
import { readFileSync, readdirSync } from 'node:fs';
import { loadSongFile } from '../src/core/songfile.ts';
import { S, replaceSong, cursorStart, trackTimeline } from '../src/ui/editor.ts';
import { patternDuration } from '../src/core/song.ts';

let fail = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) fail++; };

for (const file of readdirSync('songs').filter(f => f.endsWith('.nt2'))) {
  const name = file.replace('.nt2', '');
  replaceSong(loadSongFile(new Uint8Array(readFileSync('songs/' + file))), name);
  const longest = Math.max(...S.song.patterns.map(patternDuration));
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
process.exit(fail ? 1 : 0);
