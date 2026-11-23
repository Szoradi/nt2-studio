// Editor state and editing operations (no DOM here). The behaviour of each
// operation follows the original NinjaTracker V2.03 editor.

import {
  type Song, type Row, type Command, newSong, cloneSong, emptyCommand, packedPatternSize, songTrackBytes,
  KEYON, KEYOFF, FIRSTNOTE, LASTNOTE, MINDUR, MAXDUR, MAX_PATT, MAX_PATTLEN, MAX_SONGLEN, MAX_TBLLEN, MAX_CMD,
  MAX_CMDNAMELEN, MAX_SONGS,
} from '../core/song.ts';

export type Panel = 'tracks' | 'pattern' | 'tables' | 'commands';
export const PANELS: Panel[] = ['tracks', 'pattern', 'tables', 'commands'];

/** Command editor columns: 10 hex nybbles (AD SR Wv Pu Fl) and the name. */
export const CMD_NAME_COL = 10;

export interface Selection { panel: Panel; idx: number; anchor: number }

export const S = {
  song: newSong(),
  fileName: 'untitled',
  dirty: false,
  subtune: 0,
  focus: 'pattern' as Panel,
  trkCh: 0,
  trkRow: [0, 0, 0],
  trkNib: 0,
  pattCh: 0,
  pattNum: [1, 1, 1],
  pattRow: [0, 0, 0],
  pattCol: 0,
  tblNum: 0,
  tblRow: [0, 0, 0],
  tblCol: 0,
  cmdNum: 0,
  cmdCol: 0,
  namePos: 0,
  octave: 3,
  /** Frames per bar (4 beats), used only to draw bar and beat lines. */
  barFrames: 96,
  keyMode: 0 as 0 | 1,
  /** Per channel: does its track and pattern column follow the play position? */
  follow: [true, true, true],
  /** Per channel: silenced in the editor (playback only, not part of the song). */
  mute: [false, false, false],
  testCmd: 1,
  sel: null as Selection | null,
};

type Listener = (songChanged: boolean) => void;
let listener: Listener = () => {};
let onError: (msg: string) => void = () => {};
export function setListeners(l: Listener, err: (msg: string) => void) { listener = l; onError = err; }

const undoStack: Song[] = [];
const redoStack: Song[] = [];
const MAX_UNDO = 300;

/** Run an edit. Return false from `fn` to reject it (the song is restored). */
export function edit(fn: () => boolean | void): boolean {
  const before = cloneSong(S.song);
  if (fn() === false) {
    S.song = before;
    listener(false);
    return false;
  }
  undoStack.push(before);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  S.dirty = true;
  clampCursors();
  if (S.focus === 'tracks') syncPatternsFromTracks(S.trkCh);
  listener(true);
  return true;
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(S.song);
  S.song = prev;
  S.sel = null;
  clampCursors();
  if (S.focus === 'tracks') syncPatternsFromTracks();
  listener(true);
}

export function redo() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(S.song);
  S.song = next;
  S.sel = null;
  clampCursors();
  if (S.focus === 'tracks') syncPatternsFromTracks();
  listener(true);
}

export function replaceSong(song: Song, fileName: string) {
  S.song = song;
  S.fileName = fileName;
  S.dirty = false;
  undoStack.length = 0;
  redoStack.length = 0;
  S.subtune = 0;
  S.trkRow = [0, 0, 0];
  S.pattRow = [0, 0, 0];
  S.pattNum = [1, 1, 1];
  S.tblRow = [0, 0, 0];
  S.cmdNum = 0;
  S.sel = null;
  syncPatternsFromTracks();
  clampCursors();
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

export const curTracks = () => S.song.tracks[S.subtune];
export const curPattern = (ch = S.pattCh) => S.song.patterns[S.pattNum[ch] - 1];

export function clampCursors() {
  for (let c = 0; c < 3; c++) {
    S.trkRow[c] = Math.max(0, Math.min(S.trkRow[c], Math.min(curTracks()[c].length, MAX_SONGLEN - 1)));
    S.pattRow[c] = Math.max(0, Math.min(S.pattRow[c], Math.min(curPattern(c).length, MAX_PATTLEN - 1)));
    S.tblRow[c] = Math.max(0, Math.min(S.tblRow[c], Math.min(S.song.tables[c].left.length, MAX_TBLLEN - 1)));
  }
  S.cmdNum = Math.max(0, Math.min(S.cmdNum, MAX_CMD - 1));
}

/**
 * The pattern columns show the patterns under the track cursors. On a transpose that is the
 * pattern it applies to; on the loop rows or past the end it is the last pattern above.
 */
export function syncPatternsFromTracks(only?: number) {
  for (let c = 0; c < 3; c++) {
    if (only !== undefined && only !== c) continue;
    const t = curTracks()[c];
    const isPattern = (i: number) =>
      i >= 0 && i < t.length && t[i] >= 1 && t[i] <= 0x7f && !(i === t.length - 1 && i > 0 && t[i - 1] === 0);
    let r = S.trkRow[c];
    while (r < t.length - 1 && t[r] >= 0x80) r++;
    if (!isPattern(r)) {
      r = Math.min(r, t.length) - 1;
      while (r >= 0 && !isPattern(r)) r--;
    }
    if (r >= 0 && t[r] !== S.pattNum[c]) {
      S.pattNum[c] = t[r];
      S.pattRow[c] = 0;
    }
  }
}

export function selectionRange(panel: Panel, idx: number, cursor: number): [number, number] | null {
  const s = S.sel;
  if (!s || s.panel !== panel || s.idx !== idx) return null;
  return [Math.min(s.anchor, cursor), Math.max(s.anchor, cursor)];
}

export function setSubtune(n: number) {
  S.subtune = (n + MAX_SONGS) % MAX_SONGS;
  S.trkRow = [0, 0, 0];
  S.sel = null;
  syncPatternsFromTracks();
  clampCursors();
  listener(false);
}

export function setPatternNumber(ch: number, n: number) {
  S.pattNum[ch] = ((n - 1 + MAX_PATT) % MAX_PATT) + 1;
  S.pattRow[ch] = 0;
  S.sel = null;
  listener(false);
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

function tracksFit(): boolean {
  if (songTrackBytes(curTracks()) > MAX_SONGLEN) {
    onError('The three tracks of a subtune cannot exceed 256 bytes together');
    return false;
  }
  return true;
}

export function trackHex(digit: number) {
  const c = S.trkCh, r = S.trkRow[c];
  if (r >= MAX_SONGLEN - 1) return;
  const ok = edit(() => {
    const t = curTracks()[c];
    if (r === t.length) t.push(0);
    t[r] = S.trkNib === 0 ? (t[r] & 0x0f) | (digit << 4) : (t[r] & 0xf0) | digit;
    return tracksFit();
  });
  if (!ok) return;
  if (S.trkNib === 0) S.trkNib = 1;
  else {
    S.trkNib = 0;
    S.trkRow[c] = Math.min(S.trkRow[c] + 1, curTracks()[c].length);
  }
  syncPatternsFromTracks(c);
  listener(false);
}

function trackDeleteAt(t: number[], r: number) {
  if (r >= t.length) return;
  t.splice(r, 1);
  const last = t.length - 1;
  if (last >= 0 && t[last] > r) t[last]--;
}

export function trackDelete() {
  const c = S.trkCh;
  const range = selectionRange('tracks', c, S.trkRow[c]);
  edit(() => {
    const t = curTracks()[c];
    if (range) {
      for (let r = Math.min(range[1], t.length - 1); r >= range[0]; r--) trackDeleteAt(t, r);
      S.trkRow[c] = range[0];
      S.sel = null;
    } else if (S.trkRow[c] < t.length) trackDeleteAt(t, S.trkRow[c]);
    else return false;
  });
}

export function trackInsert() {
  const c = S.trkCh, r = S.trkRow[c];
  edit(() => {
    const t = curTracks()[c];
    if (r >= t.length || t.length >= MAX_SONGLEN - 1) return false;
    t.splice(r, 0, t[r]);
    const last = t.length - 1;
    if (t[last] > r) t[last]++;
    return tracksFit();
  });
}

/** Shift+Enter: put the first unused pattern at the cursor and open it. */
export function trackNewPattern(): boolean {
  const c = S.trkCh, r = S.trkRow[c];
  const free = S.song.patterns.findIndex(p => p.length === 0);
  if (free < 0 || r >= MAX_SONGLEN - 1) return false;
  const ok = edit(() => {
    const t = curTracks()[c];
    if (r === t.length) t.push(0);
    t[r] = free + 1;
    return tracksFit();
  });
  if (ok) { S.pattNum[c] = free + 1; S.pattRow[c] = 0; }
  return ok;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

function patternFits(rows: Row[]): boolean {
  if (rows.length > MAX_PATTLEN || packedPatternSize(rows) > MAX_PATTLEN) {
    onError('Pattern is full (192 bytes packed)');
    return false;
  }
  return true;
}

function rowAt(rows: Row[], r: number): Row {
  if (r === rows.length) rows.push({ note: KEYOFF, cmd: 0, dur: 0 });
  return rows[r];
}

/** Command in effect at a row (last one set at or above it). */
export function commandAt(rows: Row[], r: number): number {
  let cmd = 0;
  for (let i = 0; i <= r && i < rows.length; i++) if (rows[i].cmd) cmd = rows[i].cmd;
  return cmd;
}

function pattDown() {
  const c = S.pattCh;
  if (S.pattRow[c] < curPattern().length && S.pattRow[c] < MAX_PATTLEN - 1) S.pattRow[c]++;
}

export function patternSetNote(note: number): boolean {
  const c = S.pattCh, r = S.pattRow[c];
  const ok = edit(() => {
    const rows = curPattern();
    rowAt(rows, r).note = note;
    return patternFits(rows);
  });
  if (ok) { pattDown(); listener(false); }
  return ok;
}

export function patternCmdHex(digit: number) {
  const c = S.pattCh, r = S.pattRow[c], hi = S.pattCol === 1;
  const ok = edit(() => {
    const rows = curPattern();
    const row = rowAt(rows, r);
    row.cmd = hi ? (row.cmd & 0x0f) | (digit << 4) : (row.cmd & 0xf0) | digit;
    return patternFits(rows);
  });
  if (!ok) return;
  if (hi) S.pattCol = 2;
  else { S.pattCol = 1; pattDown(); }
  listener(false);
}

export function patternDurDigit(digit: number) {
  const c = S.pattCh, r = S.pattRow[c], tens = S.pattCol === 3;
  const ok = edit(() => {
    const rows = curPattern();
    const row = rowAt(rows, r);
    let d = tens ? digit * 10 + (row.dur % 10) : Math.floor(row.dur / 10) * 10 + digit;
    if (d !== 0) d = Math.max(MINDUR, Math.min(MAXDUR, d));
    row.dur = d;
    return patternFits(rows);
  });
  if (!ok) return;
  if (tens) S.pattCol = 4;
  else { S.pattCol = 3; pattDown(); }
  listener(false);
}

/** Space in the command or duration columns clears that field. */
export function patternClearField() {
  const c = S.pattCh, r = S.pattRow[c];
  const isCmd = S.pattCol === 1 || S.pattCol === 2;
  const ok = edit(() => {
    const rows = curPattern();
    const row = rowAt(rows, r);
    if (isCmd) row.cmd = 0; else row.dur = 0;
    return patternFits(rows);
  });
  if (ok) { pattDown(); listener(false); }
}

export function patternStepCmd(delta: number) {
  const c = S.pattCh, r = S.pattRow[c];
  edit(() => {
    const rows = curPattern();
    const row = rowAt(rows, r);
    row.cmd = (row.cmd & 0x80) | ((row.cmd + delta) & 0x7f);
    return patternFits(rows);
  });
}

export function patternToggleLegato() {
  const c = S.pattCh, r = S.pattRow[c];
  edit(() => {
    const rows = curPattern();
    if (r >= rows.length || !rows[r].cmd) return false;
    rows[r].cmd ^= 0x80;
  });
}

export function patternInsert() {
  const c = S.pattCh, r = S.pattRow[c];
  edit(() => {
    const rows = curPattern();
    if (rows.length >= MAX_PATTLEN) return false;
    const keyon = r < rows.length && rows[r].note === KEYON;
    rows.splice(r, 0, { note: keyon ? KEYON : KEYOFF, cmd: 0, dur: 0 });
    return patternFits(rows);
  });
}

export function patternDelete() {
  const c = S.pattCh;
  const range = selectionRange('pattern', c, S.pattRow[c]);
  edit(() => {
    const rows = curPattern();
    if (range) {
      rows.splice(range[0], range[1] - range[0] + 1);
      S.pattRow[c] = range[0];
      S.sel = null;
    } else if (S.pattRow[c] < rows.length) rows.splice(S.pattRow[c], 1);
    else return false;
  });
}

/** Enter in the note column: replace this run of equal notes with the note above. */
export function patternFillFromAbove() {
  const c = S.pattCh, r = S.pattRow[c];
  edit(() => {
    const rows = curPattern();
    if (r === 0 || r >= rows.length) return false;
    const above = rows[r - 1].note, old = rows[r].note;
    for (let i = r; i < rows.length && rows[i].note === old; i++) rows[i].note = above;
  });
}

export function patternTranspose(up: boolean) {
  const c = S.pattCh;
  const range = selectionRange('pattern', c, S.pattRow[c]);
  edit(() => {
    const rows = curPattern();
    const from = range ? range[0] : 0, to = range ? range[1] : rows.length - 1;
    for (let i = from; i <= to && i < rows.length; i++) {
      const n = rows[i].note;
      if (n < FIRSTNOTE) continue;
      rows[i].note = up ? Math.min(LASTNOTE, n + 2) : Math.max(FIRSTNOTE, n - 2);
    }
  });
}

/** Empty the current pattern. */
export function patternClear() {
  const c = S.pattCh;
  edit(() => {
    if (!curPattern().length) return false;
    S.song.patterns[S.pattNum[c] - 1] = [];
    S.pattRow[c] = 0;
    S.sel = null;
  });
}

/** Copy the current pattern to the first unused one and show it. Returns the new pattern number, or 0. */
export function patternDuplicate(): number {
  const c = S.pattCh;
  const src = curPattern();
  const free = S.song.patterns.findIndex(p => p.length === 0);
  if (free < 0 || !src.length) return 0;
  edit(() => { S.song.patterns[free] = src.map(r => ({ ...r })); });
  S.pattNum[c] = free + 1;
  S.sel = null;
  listener(false);
  return free + 1;
}

/** Remove all patterns and tracks but keep the tables and commands (the instruments). */
export function clearMusic() {
  edit(() => {
    const fresh = newSong();
    S.song.patterns = fresh.patterns;
    S.song.tracks = fresh.tracks;
  });
  S.subtune = 0;
  S.trkRow = [0, 0, 0];
  S.pattRow = [0, 0, 0];
  S.pattNum = [1, 1, 1];
  S.sel = null;
  listener(false);
}

/** Is this pattern number referenced by any track of any subtune? */
export function patternUsed(n: number): boolean {
  return S.song.tracks.some(sub => sub.some(t =>
    t.some((v, i) => v === n && !(i === t.length - 1 && i > 0 && t[i - 1] === 0))));
}

function canJoin(rows: Row[], x: number): boolean {
  let cmd = 0xff;
  for (let i = x; i >= 0; i--) if (rows[i].cmd) { cmd = rows[i].cmd; break; }
  const a = rows[x], b = rows[x + 1];
  // A hard restarted note followed by a plain keyon
  if (a.note >= FIRSTNOTE && cmd < 0x80 && b.cmd === 0 && b.note === KEYON) return true;
  // Two keyoffs or keyons in a row
  return a.note < FIRSTNOTE && a.note === b.note && b.cmd === 0;
}

/** Shift+O: join steps and drop repeated durations/commands to shrink the pattern. */
export function patternOptimize() {
  const c = S.pattCh;
  edit(() => {
    const rows = curPattern();
    let x = rows.findIndex(r => r.dur !== 0);
    if (x < 0) return false;
    const start = x;
    let dur = rows[x].dur;
    for (let i = x; i < rows.length; i++) {
      if (rows[i].dur) dur = rows[i].dur;
      rows[i].dur = dur;
    }
    x = start;
    while (x < rows.length - 1) {
      if (!canJoin(rows, x)) { x++; continue; }
      const left = rows.length - x;
      let join = left < 3;
      let skipTo = x + 1;
      if (!join) {
        if (x > 0 && rows[x].dur + rows[x + 1].dur === rows[x - 1].dur) join = true;
        else if (rows[x].note === rows[x + 1].note) join = true;
        else if (rows[x + 2].dur !== rows[x + 1].dur || rows[x + 2].dur !== rows[x].dur) join = true;
        else if (canJoin(rows, x + 1)) join = true;
        else if (left >= 4) {
          if (canJoin(rows, x + 2)) join = true;
          else skipTo = x + 3;
        } else skipTo = x + 2;
      }
      if (join && rows[x].dur + rows[x + 1].dur <= MAXDUR) {
        rows[x].dur += rows[x + 1].dur;
        rows.splice(x + 1, 1);
      } else x = join ? x + 1 : skipTo;
    }
    let lastDur = 0, lastCmd = 0;
    for (const r of rows) {
      if (r.dur) {
        if (r.dur === lastDur) r.dur = 0; else lastDur = r.dur;
      }
      if (r.cmd) {
        if (r.cmd === lastCmd) { if (r.note >= FIRSTNOTE) r.cmd = 0; }
        else lastCmd = r.cmd;
      }
    }
    S.pattRow[c] = Math.min(S.pattRow[c], rows.length);
  });
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function adjustTableRefs(song: Song, t: number, row0: number, delta: number) {
  const tbl = song.tables[t];
  for (let i = 0; i < tbl.left.length; i++) {
    if (tbl.left[i] === 0xff && tbl.right[i] > row0) tbl.right[i] = (tbl.right[i] + delta) & 0xff;
  }
  const key = (['wave', 'pulse', 'filt'] as const)[t];
  for (const c of song.commands) if (c[key] > row0) c[key] = (c[key] + delta) & 0xff;
}

export function tableHex(digit: number) {
  const t = S.tblNum, r = S.tblRow[t];
  const ok = edit(() => {
    const tbl = S.song.tables[t];
    if (r === tbl.left.length) {
      if (tbl.left.length >= MAX_TBLLEN) return false;
      tbl.left.push(0);
      tbl.right.push(0);
    }
    const side = S.tblCol < 2 ? tbl.left : tbl.right;
    side[r] = S.tblCol % 2 === 0 ? (side[r] & 0x0f) | (digit << 4) : (side[r] & 0xf0) | digit;
    // Keep absolute arpeggio notes in the valid range
    if (t === 0 && tbl.left[r] < 0xc0 && tbl.right[r] >= 0x80 && S.tblCol === 3) {
      tbl.right[r] = Math.max(0x8c, Math.min(0xdf, tbl.right[r]));
    }
  });
  if (!ok) return;
  if (S.tblCol < 3) S.tblCol++;
  else {
    S.tblCol = 0;
    S.tblRow[t] = Math.min(S.tblRow[t] + 1, S.song.tables[t].left.length);
  }
  listener(false);
}

export function tableInsert() {
  const t = S.tblNum, r = S.tblRow[t];
  edit(() => {
    const tbl = S.song.tables[t];
    if (r >= tbl.left.length || tbl.left.length >= MAX_TBLLEN) return false;
    tbl.left.splice(r, 0, 0);
    tbl.right.splice(r, 0, 0);
    adjustTableRefs(S.song, t, r, 1);
  });
}

export function tableDelete() {
  const t = S.tblNum;
  const range = selectionRange('tables', t, S.tblRow[t]);
  edit(() => {
    const tbl = S.song.tables[t];
    const from = range ? range[0] : S.tblRow[t];
    const to = range ? Math.min(range[1], tbl.left.length - 1) : S.tblRow[t];
    if (from >= tbl.left.length) return false;
    for (let r = to; r >= from; r--) {
      tbl.left.splice(r, 1);
      tbl.right.splice(r, 1);
      adjustTableRefs(S.song, t, r + 1, -1);
    }
    S.tblRow[t] = from;
    S.sel = null;
  });
}

/** Enter on a jump row: go to its destination. */
export function tableFollowJump() {
  const t = S.tblNum, r = S.tblRow[t], tbl = S.song.tables[t];
  if (r < tbl.left.length && tbl.left[r] === 0xff && tbl.right[r] >= 1 && tbl.right[r] - 1 <= tbl.left.length) {
    S.tblRow[t] = tbl.right[r] - 1;
    listener(false);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CMD_FIELDS = ['ad', 'sr', 'wave', 'pulse', 'filt'] as const;

export function commandHex(digit: number) {
  const col = S.cmdCol;
  if (col >= CMD_NAME_COL) return;
  edit(() => {
    const cmd = S.song.commands[S.cmdNum];
    const f = CMD_FIELDS[col >> 1];
    cmd[f] = col % 2 === 0 ? (cmd[f] & 0x0f) | (digit << 4) : (cmd[f] & 0xf0) | digit;
  });
  S.cmdCol = col < CMD_NAME_COL - 1 ? col + 1 : 0;
  listener(false);
}

export function commandNameType(ch: string) {
  edit(() => {
    const cmd = S.song.commands[S.cmdNum];
    const name = cmd.name.padEnd(MAX_CMDNAMELEN, ' ').split('');
    name[S.namePos] = ch;
    cmd.name = name.join('').replace(/\s+$/, '');
  });
  S.namePos = Math.min(S.namePos + 1, MAX_CMDNAMELEN - 1);
  listener(false);
}

export function commandNameBackspace() {
  if (S.namePos === 0) return;
  S.namePos--;
  edit(() => {
    const cmd = S.song.commands[S.cmdNum];
    const name = cmd.name.padEnd(MAX_CMDNAMELEN, ' ').split('');
    name.splice(S.namePos, 1);
    cmd.name = name.join('').replace(/\s+$/, '');
  });
}

function adjustPatternCmds(song: Song, above: number, delta: number) {
  for (const rows of song.patterns) {
    for (const r of rows) {
      const n = r.cmd & 0x7f;
      if (n > above) r.cmd = (r.cmd & 0x80) | ((n + delta) & 0x7f);
    }
  }
}

export function commandInsert() {
  edit(() => {
    const cmds = S.song.commands;
    cmds.splice(S.cmdNum, 0, emptyCommand());
    cmds.length = MAX_CMD;
    adjustPatternCmds(S.song, S.cmdNum, 1);
  });
}

export function commandDelete() {
  edit(() => {
    const cmds = S.song.commands;
    cmds.splice(S.cmdNum, 1);
    cmds.push(emptyCommand());
    adjustPatternCmds(S.song, S.cmdNum + 1, -1);
  });
}

/** Table (0-2) the command cursor is on, or -1. */
export function commandTableColumn(): number {
  return S.cmdCol >= 4 && S.cmdCol < CMD_NAME_COL ? (S.cmdCol >> 1) - 2 : -1;
}

/** Shift+Enter on a table pointer: point it at the end of the table and go there. */
export function commandPointToTableEnd(t: number) {
  const len = S.song.tables[t].left.length;
  if (len >= MAX_TBLLEN) return;
  edit(() => { S.song.commands[S.cmdNum][CMD_FIELDS[t + 2]] = len + 1; });
  S.tblNum = t;
  S.tblRow[t] = len;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

const clip = {
  pattern: [] as Row[],
  track: [] as number[],
  table: [] as [number, number][],
  command: null as Command | null,
};

export function copy(): boolean {
  if (S.focus === 'pattern') {
    const c = S.pattCh, rows = curPattern();
    const range = selectionRange('pattern', c, S.pattRow[c]) ?? [0, rows.length - 1];
    clip.pattern = rows.slice(range[0], range[1] + 1).map(r => ({ ...r }));
    return clip.pattern.length > 0;
  }
  if (S.focus === 'tracks') {
    const c = S.trkCh, t = curTracks()[c];
    const range = selectionRange('tracks', c, S.trkRow[c]) ?? [S.trkRow[c], S.trkRow[c]];
    clip.track = t.slice(range[0], range[1] + 1);
    return clip.track.length > 0;
  }
  if (S.focus === 'tables') {
    const t = S.tblNum, tbl = S.song.tables[t];
    const range = selectionRange('tables', t, S.tblRow[t]) ?? [S.tblRow[t], S.tblRow[t]];
    clip.table = [];
    for (let r = range[0]; r <= range[1] && r < tbl.left.length; r++) clip.table.push([tbl.left[r], tbl.right[r]]);
    return clip.table.length > 0;
  }
  clip.command = { ...S.song.commands[S.cmdNum] };
  return true;
}

export function cut() {
  if (!copy()) return;
  if (S.focus === 'pattern') {
    if (!S.sel) { S.sel = { panel: 'pattern', idx: S.pattCh, anchor: 0 }; S.pattRow[S.pattCh] = Math.max(0, curPattern().length - 1); }
    patternDelete();
  } else if (S.focus === 'tracks') trackDelete();
  else if (S.focus === 'tables') tableDelete();
  else edit(() => { S.song.commands[S.cmdNum] = emptyCommand(); });
}

/** Paste overwrites from the cursor on, extending the list if needed (as in the original). */
export function paste() {
  if (S.focus === 'pattern' && clip.pattern.length) {
    const c = S.pattCh, r = S.pattRow[c];
    edit(() => {
      const rows = curPattern();
      clip.pattern.forEach((row, i) => { rows[r + i] = { ...row }; });
      S.pattRow[c] = r + clip.pattern.length;
      return patternFits(rows);
    });
  } else if (S.focus === 'tracks' && clip.track.length) {
    const c = S.trkCh, r = S.trkRow[c];
    edit(() => {
      const t = curTracks()[c];
      clip.track.forEach((v, i) => { t[r + i] = v; });
      S.trkRow[c] = r + clip.track.length;
      return t.length < MAX_SONGLEN && tracksFit();
    });
  } else if (S.focus === 'tables' && clip.table.length) {
    const t = S.tblNum, r = S.tblRow[t];
    edit(() => {
      const tbl = S.song.tables[t];
      clip.table.forEach(([l, rt], i) => { tbl.left[r + i] = l; tbl.right[r + i] = rt; });
      S.tblRow[t] = r + clip.table.length;
      return tbl.left.length <= MAX_TBLLEN;
    });
  } else if (S.focus === 'commands' && clip.command) {
    const src = clip.command;
    edit(() => { S.song.commands[S.cmdNum] = { ...src }; });
  }
}

export interface TrackEntry { row: number; time: number; trans: number; patt: number }

/**
 * Pattern entries of a track with the frame at which each starts and the transpose in effect.
 * By default this is one pass, up to the loop. With `until`, the loop is followed as the player
 * does, until an entry starts after that time, so short looping tracks line up with longer ones.
 */
export function trackTimeline(channel: number, until = -1): TrackEntry[] {
  const t = curTracks()[channel];
  const out: TrackEntry[] = [];
  let time = 0, trans = 0xc0, dur = 0, i = 0, lastLoopTime = -1;
  for (let guard = 0; guard < 4096 && i < t.length; guard++) {
    const v = t[i];
    if (v === 0) {
      // Loop command: stop after one pass, or jump like the player (unless a pass takes no time)
      if (until < 0 || time > until || time === lastLoopTime || i + 1 >= t.length) break;
      lastLoopTime = time;
      i = t[i + 1];
      continue;
    }
    i++;
    if (v >= 0x80) { trans = v; continue; }
    out.push({ row: i - 1, time, trans, patt: v });
    if (until >= 0 && time > until) break;
    for (const r of S.song.patterns[v - 1]) {
      if (r.dur) dur = r.dur;
      time += dur;
    }
  }
  return out;
}

/** Frame, counted from the start of the pattern, at which a pattern row begins. */
function rowTime(rows: Row[], row: number): number {
  let time = 0, dur = 0;
  for (let i = 0; i < row && i < rows.length; i++) {
    if (rows[i].dur) dur = rows[i].dur;
    time += dur;
  }
  return time;
}

export interface CursorStart {
  /** Song time (frames) of the cursor. */
  time: number;
  /** Track positions and transposes of the nearest earlier moment where all three channels start a pattern. */
  starts: number[];
  trans: number[];
  /** Frames to run silently from there to reach the cursor. */
  skip: number;
}

/**
 * Where playback should begin for "play from cursor".
 * In the pattern panel it is the cursor row of the shown pattern, at the place the track plays it
 * (the track cursor's entry if that is this pattern, else its first use). Elsewhere it is the
 * track cursor. Returns null if the tracks are empty, or 'notInTrack' if the pattern is not played.
 */
export function cursorStart(): CursorStart | 'notInTrack' | null {
  const lines = [0, 1, 2].map(c => trackTimeline(c));
  if (lines.some(l => !l.length)) return null;
  let time: number;
  if (S.focus === 'pattern') {
    const c = S.pattCh, n = S.pattNum[c];
    const atCursor = lines[c].find(e => e.row >= S.trkRow[c]);
    const entry = atCursor && atCursor.patt === n ? atCursor : lines[c].find(e => e.patt === n);
    if (!entry) return 'notInTrack';
    time = entry.time + rowTime(curPattern(c), S.pattRow[c]);
  } else {
    const c = S.trkCh;
    const entry = lines[c].find(e => e.row >= S.trkRow[c]) ?? lines[c][lines[c].length - 1];
    time = entry.time;
  }
  // Latest moment at or before the cursor where every channel begins a pattern (time 0 always is
  // one). Loops are followed, so a short looping track still offers a start point near the cursor.
  const rolled = [0, 1, 2].map(c => trackTimeline(c, time));
  let from = 0;
  for (const e of rolled[0]) {
    if (e.time > time) break;
    if (rolled[1].some(x => x.time === e.time) && rolled[2].some(x => x.time === e.time)) from = e.time;
  }
  const picks = rolled.map(l => l.find(e => e.time === from)!);
  return { time, starts: picks.map(e => e.row), trans: picks.map(e => e.trans), skip: time - from };
}

export function notify() { listener(false); }
