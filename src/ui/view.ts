// DOM rendering of the four editor panels.

import {
  type Row, noteName, hex2, patternDuration, packedPatternSize, patternRowOffsets, songTrackBytes, trackProblem,
  KEYOFF, KEYON, MAX_PATTLEN, MAX_SONGLEN, MAX_TBLLEN, MAX_CMD, MAX_CMDNAMELEN, FIRSTNOTE,
} from '../core/song.ts';
import { S, selectionRange, curTracks, patternUsed, CMD_NAME_COL } from './editor.ts';
import type { PlayState } from '../audio/engine.ts';
import { renderInstruments } from './instrument.ts';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cell(text: string, cls: string, col: number, cursorCol: number): string {
  return `<span class="c ${cls}${col === cursorCol ? ' cursor' : ''}" data-k="${col}">${text}</span>`;
}

function rowClass(r: number, cur: number, range: [number, number] | null, extra = ''): string {
  let c = 'row';
  if (r === cur) c += ' cur';
  if (range && r >= range[0] && r <= range[1]) c += ' sel';
  return c + extra;
}

// ---------------------------------------------------------------------------

function describeTrackByte(t: number[], r: number): string {
  const v = t[r];
  const last = t.length - 1;
  if (r === last && r > 0 && t[r - 1] === 0) return `<span class="desc lp">to ${hex2(v)}</span>`;
  if (v === 0) return '<span class="desc lp">loop</span>';
  if (v < 0x80) return '';
  const tr = v - 0xc0;
  return `<span class="desc tr">${tr >= 0 ? '+' : ''}${tr}</span>`;
}

function renderTracks() {
  const tracks = curTracks();
  const cols: string[] = [];
  for (let c = 0; c < 3; c++) {
    const t = tracks[c];
    const active = S.focus === 'tracks' && S.trkCh === c;
    const cur = S.trkRow[c];
    const range = selectionRange('tracks', c, cur);
    const problem = trackProblem(t);
    let html = `<div class="col${active ? ' active' : ''}" data-i="${c}"><div class="col-head">Ch ${c + 1}<span class="grow"></span>` +
      `<span class="warn" title="${problem ?? ''}">${problem ? '!' : ''}</span></div><div class="list">`;
    for (let r = 0; r <= t.length && r < MAX_SONGLEN; r++) {
      const end = r === t.length;
      const cc = active && r === cur ? S.trkNib : -1;
      const h = end ? '..' : hex2(t[r]);
      const cls = end ? 'z' : t[r] === 0 ? 'lp' : t[r] >= 0x80 ? 'tr' : 'n';
      html += `<div class="${rowClass(r, cur, range, end ? ' end' : '')}" data-r="${r}">` +
        `<span class="rn">${hex2(r)}</span>${cell(h[0], cls, 0, cc)}${cell(h[1], cls, 1, cc)}${end ? '' : describeTrackByte(t, r)}</div>`;
    }
    cols.push(html + '</div></div>');
  }
  setColumns('tracks', cols);
  const used = songTrackBytes(tracks);
  const info = $('tracks-info');
  info.textContent = `${used}/${MAX_SONGLEN} bytes`;
  info.classList.toggle('warn', used > MAX_SONGLEN);
}

// ---------------------------------------------------------------------------

function playRowOf(rows: Row[], pattPos: number): number {
  if (!rows.length) return -1;
  if (pattPos === 0) return rows.length - 1;
  const offs = patternRowOffsets(rows);
  let row = 0;
  for (let i = 0; i < offs.length; i++) if (offs[i] < pattPos) row = i;
  return row;
}

function renderPatterns() {
  const cols: string[] = [];
  for (let c = 0; c < 3; c++) {
    const num = S.pattNum[c];
    const rows = S.song.patterns[num - 1];
    const active = S.focus === 'pattern' && S.pattCh === c;
    const cur = S.pattRow[c];
    const range = selectionRange('pattern', c, cur);
    const size = packedPatternSize(rows);
    const bar = S.barFrames, beat = bar / 4;
    const total = patternDuration(rows);
    const bars = total / bar;
    const barText = total ? ` \u00b7 ${Number.isInteger(bars) ? bars : bars.toFixed(2)} bar${bars === 1 ? '' : 's'}` : '';
    let html = `<div class="col${active ? ' active' : ''}" data-i="${c}"><div class="col-head">` +
      `<button data-act="pattprev" title="Previous pattern (Ctrl+Left)">&#9664;</button><span class="num">${hex2(num)}</span>` +
      `<button data-act="pattnext" title="Next pattern (Ctrl+Right)">&#9654;</button>` +
      `<button data-act="follow" class="fol${S.follow[c] ? ' on' : ''}" title="${S.follow[c] ? 'This channel follows the play position. Click to keep it where it is' : 'This channel stays where it is. Click to follow the play position'}" aria-label="Follow the play position" aria-pressed="${S.follow[c]}">${ICON_FOLLOW}</button>` +
      `<button data-act="mute" class="mut${S.mute[c] ? ' on' : ''}" title="${S.mute[c] ? `Channel ${c + 1} is muted. Click to hear it again` : `Mute channel ${c + 1}`} (Shift+click: solo)" aria-label="Mute channel ${c + 1}" aria-pressed="${S.mute[c]}">${S.mute[c] ? ICON_MUTED : ICON_SOUND}</button>` +
      `<span class="grow"></span>` +
      `${rows.length && !patternUsed(num) ? '<span class="warn" title="No track plays this pattern">unused</span> ' : ''}` +
      `<span class="meta" title="Packed size ${size} of ${MAX_PATTLEN} bytes, length ${total} frames (set the bar length in the toolbar)">${size}b \u00b7 ${total}f${barText}</span></div><div class="list">`;
    let dur = 0, time = 0, cmd = 0;
    for (let r = 0; r <= rows.length && r < MAX_PATTLEN; r++) {
      const end = r === rows.length;
      const cc = active && r === cur ? S.pattCol : -1;
      if (end) {
        html += `<div class="${rowClass(r, cur, range, ' end')}" data-r="${r}"><span class="rn">${hex2(r)}</span>` +
          `${cell('...', 'z', 0, cc)}<span class="gap"></span>${cell('.', 'z', 1, cc)}${cell('.', 'z', 2, cc)}<span class="gap"></span>${cell('.', 'z', 3, cc)}${cell('.', 'z', 4, cc)}</div>`;
        break;
      }
      const row = rows[r];
      const ch = row.cmd ? hex2(row.cmd) : '..';
      // An empty duration keeps the previous one: show it dimmed so every row's length is visible
      const shown = row.dur || dur;
      const dh = shown ? String(shown).padStart(2, '0') : '..';
      const durCls = row.dur ? 'd' : shown ? 'e' : 'z';
      const line = time % bar === 0 ? ' bar' : Number.isInteger(beat) && time % beat === 0 ? ' beat' : '';
      const noteCls = row.note < FIRSTNOTE ? (row.note === KEYOFF ? 'n off' : 'n') : 'n';
      let desc = '';
      if (row.cmd) {
        cmd = row.cmd;
        const name = S.song.commands[(row.cmd & 0x7f) - 1]?.name ?? '';
        desc = `<span class="desc${row.cmd & 0x80 ? ' lg' : ''}">${row.cmd & 0x80 ? '~' : ''}${esc(name)}</span>`;
      }
      html += `<div class="${rowClass(r, cur, range, line)}" data-r="${r}" title="bar ${Math.floor(time / bar) + 1}, beat ${(Math.floor((time % bar) / beat * 100) / 100 + 1)}, frame ${time}${cmd ? `, command ${hex2(cmd)}` : ''}"><span class="rn">${hex2(r)}</span>` +
        `${cell(noteName(row.note), noteCls, 0, cc)}<span class="gap"></span>` +
        `${cell(ch[0], row.cmd ? 'k' : 'z', 1, cc)}${cell(ch[1], row.cmd ? 'k' : 'z', 2, cc)}<span class="gap"></span>` +
        `${cell(dh[0], durCls, 3, cc)}${cell(dh[1], durCls, 4, cc)}${desc}</div>`;
      if (row.dur) dur = row.dur;
      time += dur;
    }
    cols.push(html + '</div></div>');
  }
  setColumns('patterns', cols);
  shownPatterns = S.pattNum.join(',');
  $('pattern-info').textContent = `octave ${S.octave}  ${S.keyMode ? 'DMC' : 'ProTracker'} keys`;
}

// ---------------------------------------------------------------------------

const TABLE_NAMES = ['Wave', 'Pulse', 'Filter'];

// Icons of the two switches in each pattern column header (drawn in the button's text colour)
const svg = (body: string) => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">${body}</svg>`;
const LINE = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"';
/** Follow: a target, as on a map that keeps your position in view. */
const ICON_FOLLOW = svg(`<circle cx="8" cy="8" r="4.25" ${LINE}/><circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15" ${LINE}/>`);
const SPEAKER = '<path d="M1.5 6h2.7L8 3v10L4.2 10H1.5z" fill="currentColor"/>';
/** Channel audible: a speaker with sound waves. */
const ICON_SOUND = svg(`${SPEAKER}<path d="M10.4 5.8a3.2 3.2 0 0 1 0 4.4M12.4 3.9a6 6 0 0 1 0 8.2" ${LINE}/>`);
/** Channel muted: the speaker crossed out. */
const ICON_MUTED = svg(`${SPEAKER}<path d="M10.5 5.8l4 4.4M14.5 5.8l-4 4.4" ${LINE}/>`);

export function describeTableRow(t: number, l: number, r: number): string {
  if (l === 0xff) return r ? `jump ${hex2(r)}` : 'stop';
  if (t === 0) {
    if (l >= 0xe0) return `slide ${hex2(l - 0xe0)}${hex2(r)}`;
    if (l >= 0xc0) return `vib spd ${hex2(l - 0xc0)} depth ${hex2(r)}`;
    const arp = r >= 0x80 ? `abs ${noteName((r & 0x7f) * 2)}` : `+${r}`;
    if (l >= 0x90) return `delay ${l - 0x90} ${arp}`;
    return `wave ${hex2(l)} ${arp}`;
  }
  if (l < 0x80) {
    const spd = r < 0x80 ? `+${hex2(r)}` : `-${hex2(0x100 - r)}`;
    return l === 0 ? '' : `mod ${l}f ${spd}`;
  }
  if (t === 1) return `set pulse ${hex2(r)}`;
  const types = ['off', 'low', 'band', 'low+band', 'high', 'low+high', 'band+high', 'all'];
  return `${types[(l >> 4) & 7]} ch${l & 0x0f} cut ${hex2(r)}`;
}

function renderTables() {
  let html = '';
  for (let t = 0; t < 3; t++) {
    const tbl = S.song.tables[t];
    const active = S.focus === 'tables' && S.tblNum === t;
    const cur = S.tblRow[t];
    const range = selectionRange('tables', t, cur);
    html += `<div class="col${active ? ' active' : ''}" data-i="${t}"><div class="col-head">${TABLE_NAMES[t]}<span class="grow"></span>` +
      `<span>${tbl.left.length}/${MAX_TBLLEN}</span></div><div class="list">`;
    for (let r = 0; r <= tbl.left.length && r < MAX_TBLLEN; r++) {
      const end = r === tbl.left.length;
      const cc = active && r === cur ? S.tblCol : -1;
      const l = end ? '..' : hex2(tbl.left[r]), rt = end ? '..' : hex2(tbl.right[r]);
      const cls = end ? 'z' : tbl.left[r] === 0xff ? 'lp' : 'k';
      html += `<div class="${rowClass(r, cur, range, end ? ' end' : '')}" data-r="${r}"><span class="rn">${hex2(r + 1)}</span>` +
        `${cell(l[0], cls, 0, cc)}${cell(l[1], cls, 1, cc)}<span class="gap"></span>${cell(rt[0], end ? 'z' : 'n', 2, cc)}${cell(rt[1], end ? 'z' : 'n', 3, cc)}` +
        `${end ? '' : `<span class="desc">${esc(describeTableRow(t, tbl.left[r], tbl.right[r]))}</span>`}</div>`;
    }
    html += '</div></div>';
  }
  setHtml('tables', html);
}

function renderCommands() {
  const active = S.focus === 'commands';
  // Column titles, laid out like a row so each sits over its column
  const titles = ['AD', 'SR', 'Wv', 'Pu', 'Fl'].map(t => `<span class="hc">${t}</span><span class="gap"></span>`).join('');
  let html = `<div class="col active"><div class="cmd-head"><span class="rn">&nbsp;&nbsp;</span>${titles}<span class="name">Name</span></div><div class="list">`;
  for (let i = 0; i < MAX_CMD; i++) {
    const c = S.song.commands[i];
    const cc = active && i === S.cmdNum ? S.cmdCol : -1;
    const used = c.ad || c.sr || c.wave || c.pulse || c.filt || c.name;
    const vals = [c.ad, c.sr, c.wave, c.pulse, c.filt];
    let cells = '';
    vals.forEach((v, f) => {
      const h = hex2(v);
      const cls = used ? (f < 2 ? 'n' : v ? 'k' : 'z') : 'z';
      cells += `${cell(h[0], cls, f * 2, cc)}${cell(h[1], cls, f * 2 + 1, cc)}<span class="gap"></span>`;
    });
    let name = esc(c.name.padEnd(MAX_CMDNAMELEN, ' '));
    if (cc === CMD_NAME_COL) {
      const raw = c.name.padEnd(MAX_CMDNAMELEN, ' ');
      name = esc(raw.slice(0, S.namePos)) + `<span class="caret">${esc(raw[S.namePos] ?? ' ')}</span>` + esc(raw.slice(S.namePos + 1));
    }
    html += `<div class="${rowClass(i, S.cmdNum, null)}" data-r="${i}"><span class="rn">${hex2(i + 1)}</span>${cells}` +
      `<span class="c name" data-k="${CMD_NAME_COL}">${name}</span></div>`;
  }
  html += '</div></div>';
  setHtml('commands', html);
}

// ---------------------------------------------------------------------------

function scrollListToCursor(list: HTMLElement) {
  const row = list.querySelector<HTMLElement>('.row.cur');
  if (!row) return;
  const top = row.offsetTop - list.offsetTop;
  const margin = 54;
  if (top < list.scrollTop + margin) list.scrollTop = Math.max(0, top - margin);
  else if (top + row.offsetHeight > list.scrollTop + list.clientHeight - margin) list.scrollTop = top + row.offsetHeight - list.clientHeight + margin;
}

function scrollToCursor(container: HTMLElement) {
  container.querySelectorAll<HTMLElement>('.list').forEach(scrollListToCursor);
}

/** Keep each list's scroll position across a re-render. */
function preserving(id: string, fn: () => void) {
  const el = $(id);
  const tops = Array.from(el.querySelectorAll<HTMLElement>('.list'), l => l.scrollTop);
  fn();
  el.querySelectorAll<HTMLElement>('.list').forEach((l, i) => { if (tops[i] !== undefined) l.scrollTop = tops[i]; });
}

/**
 * Replace a panel's content, but only if it changed. Rebuilding a panel of a big song takes longer
 * than the sound output can wait (it runs on the same thread), so untouched panels are left alone.
 */
const shownHtml: Record<string, string> = {};
function setHtml(id: string, html: string) {
  if (shownHtml[id] === html) return;
  shownHtml[id] = html;
  preserving(id, () => { $(id).innerHTML = html; });
}

/** The same for a panel of three channel columns, one column at a time. */
function setColumns(id: string, cols: string[]) {
  const el = $(id);
  if (el.children.length !== cols.length) {
    el.innerHTML = cols.join('');
    cols.forEach((h, c) => { shownHtml[`${id}.${c}`] = h; });
    return;
  }
  cols.forEach((h, c) => {
    if (shownHtml[`${id}.${c}`] === h) return;
    shownHtml[`${id}.${c}`] = h;
    const top = el.children[c].querySelector<HTMLElement>('.list')?.scrollTop ?? 0;
    el.children[c].outerHTML = h;
    const list = el.children[c].querySelector<HTMLElement>('.list');
    if (list) list.scrollTop = top;
  });
}

/** Pattern numbers the pattern columns were last built for. */
let shownPatterns = '';

/** The playing row of each channel in the track lists and in the pattern columns (-1 = none shown). */
function playRows(play: PlayState | null): { tracks: number[]; patterns: number[] } {
  const tracks = [-1, -1, -1], patterns = [-1, -1, -1];
  if (!play?.playing) return { tracks, patterns };
  let base = 0;
  for (let c = 0; c < 3; c++) {
    // A looped pattern plays from a scratch track, so there is no track position to show
    if (!play.loop) tracks[c] = play.channels[c].songPos - base - 1;
    base += curTracks()[c].length;
    const num = S.pattNum[c];
    if (play.channels[c].pattNum === num) patterns[c] = playRowOf(S.song.patterns[num - 1], play.channels[c].pattPos);
  }
  return { tracks, patterns };
}

/**
 * Mark the playing rows and scroll the three channel lists of both panels: a channel that follows
 * playback is centred on the playing row, the others keep the cursor in view (unless only the play
 * position changed). Touches only the rows whose mark changes, so it is cheap enough to run on
 * every row of a playing song.
 */
function applyPlay(play: PlayState | null, playOnly: boolean) {
  const rows = playRows(play);
  for (const id of ['tracks', 'patterns'] as const) {
    $(id).querySelectorAll<HTMLElement>('.list').forEach((list, c) => {
      const old = list.querySelector<HTMLElement>(':scope > .row.play');
      const next = rows[id][c] >= 0 ? (list.children[rows[id][c]] as HTMLElement | undefined) ?? null : null;
      if (old !== next) {
        old?.classList.remove('play');
        next?.classList.add('play');
      }
      if (play?.playing && S.follow[c]) {
        if (next && (old !== next || !playOnly)) list.scrollTop = Math.max(0, next.offsetTop - list.offsetTop - list.clientHeight / 2);
      } else if (!playOnly) scrollListToCursor(list);
    });
  }
}

const HINTS: Record<string, string> = {
  tracks: 'Hex: pattern 01-7F, transpose 80-FF (C0 = none), end with 00 xx to loop  |  Enter: open pattern  Shift+Enter: new pattern  F6: play from here',
  pattern: 'Notes: piano keys  Space: key off  Shift+Space: key on  Enter: play row and step  |  Shift+Q/A: transpose  Shift+L: legato  Shift+O: optimize  -/+: command',
  tables: 'Hex edit  |  Enter: follow jump  Shift+Space: test command  Space: key off  Ins/Del: insert/delete row',
  inst: 'Piano keys: try the instrument  Shift+Space: test note  Space: key off  Up/Down: other instrument  Del: remove it  |  Drag the points in the graphs, or use the controls',
  commands: 'ADSR + table pointers  |  Enter: go to table  Shift+Enter: new table row  Shift+Space: test  Tab into Name to type',
};

// ---------------------------------------------------------------------------
// Hiding panels: each of the three columns can be folded down to a strip with its title
// ---------------------------------------------------------------------------

export type Fold = 'tracks' | 'pattern' | 'side';
export const FOLDS: Fold[] = ['tracks', 'pattern', 'side'];
const FOLD_KEY = 'nt2studio.folded';

/** Which columns are folded away. Remembered between sessions; one always stays open. */
export const folded: Record<Fold, boolean> = { tracks: false, pattern: false, side: false };
try {
  for (const g of JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]) if (g in folded) folded[g as Fold] = true;
  if (FOLDS.every(g => folded[g])) folded.pattern = false;
} catch { /* storage unavailable */ }

/** The column a panel is in: the tables, the commands and the instrument editor share the last one. */
export const foldOf = (panel: string): Fold => (panel === 'tracks' || panel === 'pattern' ? panel : 'side');

export function setFolded(g: Fold, on: boolean) {
  folded[g] = on;
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(FOLDS.filter(f => folded[f]))); } catch { /* storage unavailable */ }
}

/** Columns in the order they were last worked in: when the window is too narrow, the last ones give way first. */
const recent: Fold[] = ['pattern', 'side', 'tracks'];
/** The least width a column is useful at (the same as in the style sheet), and the width of a strip. */
const MIN_WIDTH = { inst: { tracks: 200, pattern: 440, side: 600 }, classic: { tracks: 230, pattern: 480, side: 420 } };
const STRIP = 28, GAP = 6;

function applyFolds() {
  // The panel with the keyboard is never hidden: jumping to a folded panel opens it
  const focus = foldOf(S.focus);
  if (folded[focus]) setFolded(focus, false);
  recent.splice(recent.indexOf(focus), 1);
  recent.unshift(focus);
  // A narrow window shows two columns or one, never a squeezed or stacked three: the ones not
  // used for longest become strips too, and come back when there is room again
  const min = MIN_WIDTH[S.sideMode === 'inst' ? 'inst' : 'classic'];
  const room = $('main').clientWidth - 2 * GAP - (FOLDS.length - 1) * GAP;
  const shown: Fold[] = [];
  const need = (open: Fold[]) => FOLDS.reduce((sum, g) => sum + (open.includes(g) ? min[g] : STRIP), 0);
  // The column in use always shows; each of the others does if it still fits beside those before it
  for (const g of recent) if (!folded[g] && (!shown.length || need([...shown, g]) <= room)) shown.push(g);
  for (const g of FOLDS) $('main').classList.toggle(`fold-${g}`, !shown.includes(g));
  const open = FOLDS.filter(g => !folded[g]).length;
  document.querySelectorAll<HTMLButtonElement>('button[data-fold]').forEach(b => { b.disabled = open === 1 && !folded[b.dataset.fold as Fold]; });
}

export function renderAll(play: PlayState | null, opts: { playOnly?: boolean } = {}) {
  if (opts.playOnly) {
    // Playback moved on: nothing but the play marks changes, unless a following column now shows
    // another pattern
    if (shownPatterns !== S.pattNum.join(',')) renderPatterns();
    applyPlay(play, true);
    return;
  }
  const inst = S.sideMode === 'inst';
  $('panel-inst').classList.toggle('hidden', !inst);
  $('panel-tables').classList.toggle('hidden', inst);
  $('panel-commands').classList.toggle('hidden', inst);
  $('panel-inst').parentElement!.classList.toggle('one', inst);
  $('main').classList.toggle('inst-mode', inst);
  // Before the panels are drawn: the instrument editor measures the room it has
  applyFolds();
  $('btn-mode-inst').classList.toggle('on', inst);
  $('btn-mode-classic').classList.toggle('on', !inst);
  renderTracks();
  renderPatterns();
  renderTables();
  renderCommands();
  renderInstruments();
  scrollToCursor($('tables'));
  scrollToCursor($('commands'));
  applyPlay(play, false);
  document.querySelectorAll<HTMLElement>('.panel').forEach(p => p.classList.toggle('focus', p.dataset.panel === S.focus));
  $('subtune').textContent = hex2(S.subtune);
  $('octave').textContent = String(S.octave);
  $('btn-keymode').textContent = S.keyMode ? 'DMC' : 'PT';
  $('status-hint').textContent = HINTS[S.focus];
  document.title = `${S.dirty ? '* ' : ''}${S.fileName} - NT2 Studio`;
}

export function showStatus(msg: string, error = false) {
  const el = $('status-msg');
  el.textContent = msg;
  el.classList.toggle('err', error);
}

export function renderTime(frames: number) {
  const sec = Math.floor(frames / 50);
  $('time').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export const HELP_HTML = `
<h4>Playback</h4>
<table>
<tr><td>F1</td><td>Play from the beginning</td></tr>
<tr><td>F6</td><td>Play from the cursor: the cursor row in a pattern, or the track cursor. All three channels start at that moment</td></tr>
<tr><td>F9</td><td>Loop the current pattern on its own; edits are heard as you make them. Showing another pattern in that column (Ctrl+Left/Right) switches the loop to it at once, from its start</td></tr>
<tr><td>F3 / Esc</td><td>Stop</td></tr>
<tr><td>F7</td><td>Toggle fast forward</td></tr>
<tr><td>Follow</td><td>Each pattern column has a <b>follow</b> switch (the target icon): when lit, that channel's track and pattern column keep the playing pattern on screen. Moving or editing in a channel while the song plays switches its follow off, so you can work on what you see; it stays off until you click it again</td></tr>
<tr><td>Mute</td><td>Each pattern column has a <b>mute</b> switch (the speaker icon) that silences its channel while you listen. Shift+click solos the channel, and Shift+click again brings the others back. Muting is not saved with the song</td></tr>
<tr><td>/</td><td>Silence test notes</td></tr>
</table>
<h4>General</h4>
<table>
<tr><td>Tab / Shift+Tab</td><td>Next / previous panel (hidden panels are skipped)</td></tr>
<tr><td>Shift+1 2 3</td><td>Tracks 1-3</td></tr>
<tr><td>Shift+4</td><td>Patterns</td></tr>
<tr><td>Shift+5 6 7</td><td>Wave, pulse, filter table (switches Sounds to Tables)</td></tr>
<tr><td>Shift+8</td><td>Commands, or the Instruments panel</td></tr>
<tr><td>Arrows, PgUp/PgDn, Home/End</td><td>Move around</td></tr>
<tr><td>Shift+Up/Down</td><td>Select rows</td></tr>
<tr><td>Ctrl+C / X / V</td><td>Copy, cut, paste (paste overwrites from the cursor)</td></tr>
<tr><td>Insert / Delete</td><td>Insert / delete rows</td></tr>
<tr><td>Ctrl+Z / Ctrl+Y</td><td>Undo / redo</td></tr>
<tr><td>, . or [ ]</td><td>Octave down / up</td></tr>
<tr><td>F4</td><td>Switch note entry (ProTracker / DMC)</td></tr>
<tr><td>Ctrl+O / Ctrl+S</td><td>Open / save song (Ctrl+Shift+S: save as)</td></tr>
<tr><td>F8</td><td>This help</td></tr>
</table>
<p><b>Hiding panels</b> - the small arrow at the right of a panel title folds that column (Tracks, Patterns, or the sounds column) down to a strip with its title; click the strip to bring it back. Jumping to a hidden panel with Shift+1-8, or choosing Instruments or Tables in the toolbar, opens it too. One column always stays open, and the choice is remembered. When the window is too narrow for all three, the columns you used least recently become strips by themselves and come back when there is room.</p>
<h4>Tracks</h4>
<table>
<tr><td>0-9 A-F</td><td>Edit hexadecimal data</td></tr>
<tr><td>Enter</td><td>Open the pattern under the cursor</td></tr>
<tr><td>Shift+Enter</td><td>Insert the next unused pattern and open it</td></tr>
<tr><td>Ctrl+Left/Right</td><td>Previous / next subtune</td></tr>
</table>
<p>00 = loop (followed by the loop position), 01-7F = pattern, 80-BF = transpose down, C0-FF = transpose up (C0 = none). A transpose cannot be followed by a loop. The three tracks of a subtune share 256 bytes.</p>
<h4>Patterns</h4>
<table>
<tr><td>Z S X D C V G B H N J M</td><td>Notes, lower octave (ProTracker keys)</td></tr>
<tr><td>Q 2 W 3 E R 5 T 6 Y 7 U ...</td><td>Notes, upper octaves</td></tr>
<tr><td>A W S E D F T G Y H U J ...</td><td>Notes (DMC keys); 1-7 select the octave</td></tr>
<tr><td>Space</td><td>Key off, or clear the command / duration column</td></tr>
<tr><td>Shift+Space</td><td>Key on</td></tr>
<tr><td>- / +</td><td>Previous / next command number</td></tr>
<tr><td>Enter</td><td>Play the row under the cursor and move down: press repeatedly to step through the pattern by ear, or hold it to play on at the pattern's own speed (while stopped)</td></tr>
<tr><td>Ctrl+Enter</td><td>Note column: fill with the note above. Command column: go to the command</td></tr>
<tr><td>Shift+Q / Shift+A</td><td>Transpose up / down a halfstep (selection or whole pattern)</td></tr>
<tr><td>Shift+L</td><td>Toggle command legato</td></tr>
<tr><td>Shift+O</td><td>Optimize the pattern</td></tr>
<tr><td>Ctrl+Left/Right</td><td>Previous / next pattern</td></tr>
<tr><td>Ctrl+D</td><td>Duplicate the pattern to the first unused one</td></tr>
</table>
<p>A dimmed duration is the one carried over from the row above. A line marks each bar and a shaded row each beat, counted from the start of the pattern using the <b>Bar</b> length (in frames) from the toolbar. The bar length is remembered for each song in this browser and guessed from the patterns the first time. Shift+click a Mute button to solo that channel.</p>
<p>Columns: note / key off (---) / key on (+++), command 01-7F (81-FF = the same command in legato mode: no hard restart, no ADSR), duration in frames (3-65, decimal). An empty command or duration keeps the previous one. Positions use physical key locations, so the piano layout is the same on every keyboard.</p>
<h4>Tables</h4>
<table>
<tr><td>Enter</td><td>Follow a jump</td></tr>
<tr><td>Shift+Space / Space</td><td>Test the current command / key off</td></tr>
</table>
<p><b>Wave</b> - 00-8F: set waveform, right = arpeggio (00-7F relative, 8C-DF absolute note). 90-BF: no waveform change, delay 00-2F frames. C0-DF: vibrato, speed 00-1F, right = depth. E0-FE: slide, speed high byte 00-1E, right = low byte. FF: jump to right (00 stops).</p>
<p><b>Pulse</b> - 01-7F: modulate for that many frames, right = signed speed. 80-FE: set pulse to right. FF: jump.</p>
<p><b>Filter</b> - 01-7F: modulate cutoff for that many frames, right = signed speed. 80-FE: set passband (left nybble - 8) and filtered channels (right nybble), right = cutoff. FF: jump.</p>
<h4>Instruments</h4>
<p>The <b>Sounds</b> switch in the toolbar chooses how sounds are edited. <b>Instruments</b> shows each command as an instrument: a name, an envelope with four sliders, and its waveform, pulse and filter programs as lists of steps, each with a graph of the program frame by frame. Drag a point in a graph to change its step: a round point is a set value, a diamond is the end of a sweep (sideways for its length, up or down for its speed), a pitch step moves by semitones. The shaded part is the program repeating. Pulse width is shown in per cent and filter cutoff as 0-255, on the sliders and in the graphs alike. <b>Tables</b> shows the same data as in NinjaTracker: the three tables and the command list in hex. Both edit the same song, so you can switch at any time and nothing is converted.</p>
<table>
<tr><td>Piano keys</td><td>Try the instrument (while the Instruments panel is active). With the cursor in a number field the letter keys still play, so a value can be changed and heard without leaving it; the digit keys type</td></tr>
<tr><td>Shift+Space / Space</td><td>Test note / key off</td></tr>
<tr><td>Hold Test</td><td>Hear the instrument with the mouse; the name and the Test button stay in view while the sections scroll</td></tr>
<tr><td>Up / Down</td><td>Previous / next instrument</td></tr>
<tr><td>Enter / Esc</td><td>Leave a number or name field</td></tr>
<tr><td>Delete</td><td>Remove the selected instrument from the song (same as Clear)</td></tr>
</table>
<p>The instrument number is the command number to type in a pattern. <b>+</b> adds a step after a step (a copy of it) and <b>&times;</b> removes one. <b>Drag a step by its number</b> to change the order; to put a new step first, add it and drag it up. A repeat keeps naming the same step number when steps move. <b>Then</b> says what happens after the last step: stop, or repeat from a step. A vibrato or slide ends a waveform program, so only the last step can be one and it cannot be moved.</p>
<p>If two instruments use the same steps the section says <i>Shared</i>; <b>Make own copy</b> separates them. <b>Remove</b> stops using a table and deletes its steps unless something else still uses them. A new filter is switched on for the channel the track cursor is in, where test notes play: tick the channels the instrument is used on. There is one filter for all three channels, and the instrument that set it last controls it.</p>
<p>Warnings: <i>Not heard</i> on Pulse width means no waveform step uses the pulse waveform. <i>wraps round</i> on a sweep (and <i>wraps</i> in its graph) means it runs past the end of the range and jumps to the other side: use fewer frames or a smaller change. A typed number past its limit is set to the limit, and the status bar says so. Vibrato depth and slide speed are in SID frequency steps per frame, so the same number is a smaller change on a higher note.</p>
<p><b>Kit</b> in the toolbar opens a browser of instruments taken from existing NinjaTracker 2 tunes: hold the mouse on one to hear it, and Enter or double-click adds it to the song.</p>
<h4>Commands</h4>
<table>
<tr><td>Enter</td><td>On Wv/Pu/Fl: go to that table position</td></tr>
<tr><td>Shift+Enter</td><td>Point to the end of the table and go there</td></tr>
<tr><td>Shift+Space / Space</td><td>Test the command / key off</td></tr>
<tr><td>Insert / Delete</td><td>Insert / delete a command (patterns are renumbered)</td></tr>
</table>
<p>A command is an instrument when used with a note and a sound change when used alone: attack/decay, sustain/release and pointers into the wave, pulse and filter tables. Pointer 00 leaves that table running.</p>
<h4>Files</h4>
<p>Open reads NinjaTracker 2 song files and .d64 disk images. It also imports packed NinjaTracker 2 tunes (.sid, packed .prg, gamemusic data) back into an editable song; command names are not stored in those, so the commands come back unnamed. Save writes the original song format, so songs move freely between this editor and the C64 editor. Export packs the song as a .sid, a .prg (init = start, play = start + 3) or gamemusic data for nt2play.s. The 4k intro format writes KickAssembler source instead: one subtune of at most 255 pattern rows with a player that only contains what the song uses (call nt_init once, then nt_play once per frame). Before saving, the editor plays it against the normal export and warns if any SID write differs. Where the browser allows it (Chrome, Edge), Save writes back to the file you opened; elsewhere it downloads a copy. You can also drop a file onto the window. Work is kept in this browser between sessions, and whenever New, Open or Examples replaces a song, the old one goes into <b>Recent</b>.</p>
<p>The Pattern buttons clear or duplicate the current pattern; <b>Clear music</b> removes all patterns and tracks but keeps the instruments. A pattern marked <i>unused</i> is not played by any track.</p>
<h4>Credits</h4>
<p>NinjaTracker V2.03 playroutine and song format by Cadaver (Lasse &Ouml;&ouml;rni), covertbitops.c64.org. SID emulation by WebSid / Tiny'R'Sid, &copy; Juergen Wothke, licensed CC BY-NC-SA 4.0.</p>
`;
