// Editor state and editing operations (no DOM here). The behaviour of each
// operation follows the original NinjaTracker V2.03 editor.

import {
  type Song, type Row, type Command, newSong, cloneSong, emptyCommand, packedPatternSize, songTrackBytes,
  KEYON, KEYOFF, FIRSTNOTE, LASTNOTE, MINDUR, MAXDUR, MAX_PATT, MAX_PATTLEN, MAX_SONGLEN, MAX_TBLLEN, MAX_CMD,
  MAX_CMDNAMELEN, MAX_SONGS,
} from '../core/song.ts';

export type Panel = 'tracks' | 'pattern' | 'tables' | 'commands' | 'inst';
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
  /** What the right-hand side shows: the instrument editor, or the tables and the command list. */
  sideMode: 'inst' as 'inst' | 'classic',
  sel: null as Selection | null,
};

type Listener = (songChanged: boolean) => void;
let listener: Listener = () => {};
let onError: (msg: string) => void = () => {};
export function setListeners(l: Listener, err: (msg: string) => void) { listener = l; onError = err; }

/** Counts the edits that went through, so a caller can tell whether its edit was accepted. */
export let edits = 0;

const undoStack: Song[] = [];
const redoStack: Song[] = [];
const MAX_UNDO = 300;

/** Run an edit. Return false from `fn` to reject it (the song is restored). */
export function edit(fn: () => boolean | void, merge = false): boolean {
  const before = cloneSong(S.song);
  if (fn() === false) {
    S.song = before;
    listener(false);
    return false;
  }
  // A merged edit continues the previous one (a drag), so undo takes the whole gesture back
  if (!merge) undoStack.push(before);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  S.dirty = true;
  edits++;
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

/** Rewrite one existing row (dragging in the table graph). `merge` joins it to the previous edit. */
export function tableSetRow(t: number, r: number, left: number, right: number, merge = false) {
  edit(() => {
    const tbl = S.song.tables[t];
    if (r >= tbl.left.length) return false;
    tbl.left[r] = left & 0xff;
    tbl.right[r] = right & 0xff;
  }, merge);
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
// Instruments: a command together with the table programs it points at
// ---------------------------------------------------------------------------

const PTR = ['wave', 'pulse', 'filt'] as const;

export const commandUsed = (c: Command) => !!(c.ad || c.sr || c.wave || c.pulse || c.filt || c.name);

/** Rows `start`..`end` of a table program: steps up to row `last`, then its closing jump at row `jump` (or -1). */
export interface Program { start: number; end: number; last: number; jump: number }

/**
 * The program a table pointer starts: the rows up to and including the next jump. A wave program
 * also ends on a vibrato or slide row, since the player stays there.
 */
export function programAt(song: Song, t: number, ptr: number): Program | null {
  const left = song.tables[t].left;
  if (ptr < 1 || ptr > left.length) return null;
  for (let i = ptr - 1; i < left.length; i++) {
    if (left[i] === 0xff) return { start: ptr - 1, end: i, last: i - 1, jump: i };
    // A jump right after a vibrato or slide is never reached, but it still belongs to this program
    if (t === 0 && left[i] >= 0xc0) return { start: ptr - 1, end: left[i + 1] === 0xff ? i + 1 : i, last: i, jump: -1 };
  }
  return { start: ptr - 1, end: left.length - 1, last: left.length - 1, jump: -1 };
}

/**
 * The rows the player goes through when a command starts table `t` at row `at` (0-based): on to the
 * next row, along jumps, until it stops there. A sweep that runs for ever is never left. Neither,
 * as far as these rows go, is a vibrato or slide (a slide ends back on the waveform row played
 * before it, which is a row already passed or one of another instrument that cannot be known here).
 *
 * In the wave table a jump is only a jump on the row after a step: the player takes it at once
 * when it has played that step. Started on a jump row, or sent to one by a jump, it does not jump
 * again but treats the row as a slide, so the walk ends there.
 */
export function rowsPlayed(song: Song, t: number, at: number): Set<number> {
  const tbl = song.tables[t], seen = new Set<number>();
  for (let r = at; r >= 0 && r < tbl.left.length && !seen.has(r);) {
    seen.add(r);
    const l = tbl.left[r];
    if (t === 0) {
      if (l >= 0xc0) break;
      if (tbl.left[r + 1] === 0xff) {
        seen.add(r + 1);
        r = tbl.right[r + 1] - 1;
      } else r++;
    } else if (l === 0xff) r = tbl.right[r] - 1;
    else if (l === 0) break;
    else r++;
  }
  return seen;
}

/**
 * Who else uses the rows of a program: other commands whose own program gets to one of its rows
 * (by starting there, running on into it or jumping into it), and jumps into it from rows outside.
 */
export function programUsers(song: Song, t: number, p: Program, self: number): { cmds: number[]; jumps: number } {
  const cmds: number[] = [];
  song.commands.forEach((c, i) => {
    if (i === self || !c[PTR[t]]) return;
    for (const r of rowsPlayed(song, t, c[PTR[t]] - 1)) if (r >= p.start && r <= p.end) { cmds.push(i); break; }
  });
  const tbl = song.tables[t];
  let jumps = 0;
  for (let r = 0; r < tbl.left.length; r++) {
    if ((r < p.start || r > p.end) && tbl.left[r] === 0xff && tbl.right[r] - 1 >= p.start && tbl.right[r] - 1 <= p.end) jumps++;
  }
  return { cmds, jumps };
}

function tableRoom(tbl: { left: number[] }, rows: number): boolean {
  if (tbl.left.length + rows > MAX_TBLLEN) {
    onError('The table is full (255 rows)');
    return false;
  }
  return true;
}

function deleteRows(song: Song, t: number, from: number, to: number) {
  const tbl = song.tables[t];
  for (let r = to; r >= from; r--) {
    tbl.left.splice(r, 1);
    tbl.right.splice(r, 1);
    adjustTableRefs(song, t, r + 1, -1);
  }
}

export function instSetAdsr(i: number, field: 'ad' | 'sr', v: number, merge = false) {
  edit(() => { S.song.commands[i][field] = v & 0xff; }, merge);
}

export function instSetName(i: number, name: string, merge = false) {
  edit(() => { S.song.commands[i].name = name.slice(0, MAX_CMDNAMELEN).replace(/\s+$/, ''); }, merge);
}

/** Add a step after row `after` of a program, or as its first step when `after` is -1. */
export function instInsertStep(i: number, t: number, after: number, left: number, right: number) {
  edit(() => {
    const tbl = S.song.tables[t], cmd = S.song.commands[i];
    if (!tableRoom(tbl, 1)) return false;
    const at = after < 0 ? cmd[PTR[t]] - 1 : after + 1;
    tbl.left.splice(at, 0, left);
    tbl.right.splice(at, 0, right);
    adjustTableRefs(S.song, t, at, 1);
    // A new first step belongs to this instrument: keep its pointer on it
    if (after < 0) cmd[PTR[t]] = at + 1;
  });
}

export function instDeleteStep(t: number, r: number) {
  edit(() => {
    const tbl = S.song.tables[t];
    if (r >= tbl.left.length) return false;
    // A jump to the deleted step would end up on the row after it. When that row is the closing
    // jump the player would run a jump as a step, so repeat from the step before instead.
    if (tbl.left[r + 1] === 0xff) {
      const to = r > 0 && tbl.left[r - 1] !== 0xff ? r : 0;
      for (let i = 0; i < tbl.left.length; i++) if (tbl.left[i] === 0xff && tbl.right[i] === r + 1) tbl.right[i] = to;
    }
    deleteRows(S.song, t, r, r);
  });
}

/**
 * The rows a step of instrument `i` can be moved between: the steps of its program, without a
 * closing vibrato or slide, which stays the last step. Null when the step on row `r` cannot move.
 */
export function instStepRange(i: number, t: number, r: number): { first: number; last: number } | null {
  const p = programAt(S.song, t, S.song.commands[i][PTR[t]]);
  if (!p) return null;
  const last = t === 0 && S.song.tables[t].left[p.last] >= 0xc0 ? p.last - 1 : p.last;
  return r >= p.start && r <= last && last > p.start ? { first: p.start, last } : null;
}

/** Move the step on row `from` to row `to`; the steps between shift over. A repeat keeps naming the same step number. */
export function instMoveStep(i: number, t: number, from: number, to: number) {
  edit(() => {
    const range = instStepRange(i, t, from);
    if (!range || to < range.first || to > range.last || to === from) return false;
    const tbl = S.song.tables[t];
    tbl.left.splice(to, 0, tbl.left.splice(from, 1)[0]);
    tbl.right.splice(to, 0, tbl.right.splice(from, 1)[0]);
  });
}

/** What a program does after its last step: jump to a row (1-based), or 0 to stop. */
export function instSetEnd(i: number, t: number, dest: number) {
  edit(() => {
    const tbl = S.song.tables[t];
    const p = programAt(S.song, t, S.song.commands[i][PTR[t]]);
    if (!p) return false;
    if (p.jump >= 0) { tbl.right[p.jump] = dest; return; }
    if (!tableRoom(tbl, 1)) return false;
    tbl.left.splice(p.end + 1, 0, 0xff);
    tbl.right.splice(p.end + 1, 0, dest);
    adjustTableRefs(S.song, t, p.end + 1, 1);
  });
}

/**
 * Left side of a new "set filter" step: low pass, on the channel test notes play on (the track
 * cursor's). All three would put the whole song through the filter as soon as the note plays.
 */
export const newFilterSet = () => 0x90 | (1 << S.trkCh);

/** What a table gets when an instrument starts using it: one step, then stop. */
const NEW_PROGRAM: (() => [number, number][])[] = [
  () => [[0x21, 0x00], [0xff, 0x00]],
  () => [[0x80, 0x80], [0xff, 0x00]],
  () => [[newFilterSet(), 0x80], [0xff, 0x00]],
];

function appendProgram(song: Song, t: number, rows: [number, number][]): number {
  const tbl = song.tables[t];
  const at = tbl.left.length;
  for (const [l, r] of rows) { tbl.left.push(l); tbl.right.push(r); }
  return at + 1;
}

/** Give an instrument a fresh program in a table it does not use yet. */
export function instAddProgram(i: number, t: number) {
  edit(() => {
    const rows = NEW_PROGRAM[t]();
    if (!tableRoom(S.song.tables[t], rows.length)) return false;
    S.song.commands[i][PTR[t]] = appendProgram(S.song, t, rows);
  });
}

/** Copy of a program's rows, as they must read at the end of the table (jumps inside it follow). */
function copiedRows(song: Song, t: number, p: Program): [number, number][] {
  const tbl = song.tables[t], at = tbl.left.length;
  const rows: [number, number][] = [];
  for (let r = p.start; r <= p.end; r++) {
    let right = tbl.right[r];
    if (tbl.left[r] === 0xff && right - 1 >= p.start && right - 1 <= p.end) right = right - p.start + at;
    rows.push([tbl.left[r], right]);
  }
  return rows;
}

/** Stop sharing: move the instrument onto its own copy of the program. */
export function instOwnProgram(i: number, t: number) {
  edit(() => {
    const p = programAt(S.song, t, S.song.commands[i][PTR[t]]);
    if (!p || !tableRoom(S.song.tables[t], p.end - p.start + 1)) return false;
    S.song.commands[i][PTR[t]] = appendProgram(S.song, t, copiedRows(S.song, t, p));
  });
}

/**
 * Last row to delete with a program. A wave program that ends on a vibrato or slide with no jump
 * after it may be followed by rows the player can never reach (steps that were cut off when an
 * earlier step was made a vibrato or slide). They go with it, up to their closing jump, but only
 * when that jump leads back into the program: rows that end any other way may be a spare program
 * someone typed in the tables, and are left alone. Nor are they touched when a command or a jump
 * from elsewhere names one of them.
 */
function deadTailEnd(song: Song, t: number, p: Program): number {
  const tbl = song.tables[t];
  if (t !== 0 || p.jump >= 0 || tbl.left[p.last] < 0xc0 || tbl.left[p.end] === 0xff) return p.end;
  const end = tbl.left.indexOf(0xff, p.end + 1);
  if (end < 0) return p.end;
  const back = tbl.right[end] - 1;
  if (back < p.start || back > p.end) return p.end;
  const tail = (r: number) => r > p.end && r <= end;
  if (song.commands.some(c => tail(c.wave - 1))) return p.end;
  if (tbl.left.some((l, j) => l === 0xff && (j < p.start || j > end) && tail(tbl.right[j] - 1))) return p.end;
  return end;
}

/** Takes a table away from a command. Returns how many unreachable rows after its program went with it. */
function dropProgram(song: Song, i: number, t: number): number {
  const cmd = song.commands[i];
  const p = programAt(song, t, cmd[PTR[t]]);
  cmd[PTR[t]] = 0;
  if (!p) return 0;
  // Jumps out of the unreachable rows are not users: they go with the program
  const all = { ...p, end: deadTailEnd(song, t, p) };
  const users = programUsers(song, t, all, i);
  if (users.cmds.length || users.jumps) return 0;
  deleteRows(song, t, all.start, all.end);
  return all.end - p.end;
}

/** Take a table away from an instrument. Its rows are deleted unless something else uses them. */
export function instRemoveProgram(i: number, t: number): number {
  let extra = 0;
  edit(() => { extra = dropProgram(S.song, i, t); });
  return extra;
}

/** Set up an unused command as a plain new instrument. */
export function instCreate(i: number): boolean {
  return edit(() => {
    const rows = NEW_PROGRAM[0]();
    if (!tableRoom(S.song.tables[0], rows.length)) return false;
    const name = `inst ${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`;
    S.song.commands[i] = { ad: 0x09, sr: 0xa9, wave: appendProgram(S.song, 0, rows), pulse: 0, filt: 0, name };
  });
}

/** Copy an instrument, with its own copies of the programs, to the first unused command. Returns its index or -1. */
export function instDuplicate(i: number): number {
  const free = S.song.commands.findIndex(c => !commandUsed(c));
  if (free < 0) return -1;
  const ok = edit(() => {
    const src = S.song.commands[i];
    const copy: Command = { ...src };
    for (let t = 0; t < 3; t++) {
      const p = programAt(S.song, t, src[PTR[t]]);
      if (!p) continue;
      if (!tableRoom(S.song.tables[t], p.end - p.start + 1)) return false;
      copy[PTR[t]] = appendProgram(S.song, t, copiedRows(S.song, t, p));
    }
    S.song.commands[free] = copy;
  });
  return ok ? free : -1;
}

/** Empty an instrument, removing the programs nothing else uses. */
export function instClear(i: number): number {
  let extra = 0;
  edit(() => {
    for (let t = 0; t < 3; t++) extra += dropProgram(S.song, i, t);
    S.song.commands[i] = emptyCommand();
  });
  return extra;
}

/** Number of pattern rows that name a command (plain or legato). */
export function commandUseCount(n: number): number {
  let count = 0;
  for (const rows of S.song.patterns) for (const r of rows) if ((r.cmd & 0x7f) === n) count++;
  return count;
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
  } else if ((S.focus === 'commands' || S.focus === 'inst') && clip.command) {
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
