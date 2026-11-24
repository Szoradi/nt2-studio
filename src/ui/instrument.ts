// The instrument editor: one command and the table programs it points at, shown as an envelope and
// three lists of steps with ordinary controls instead of hex.
//
// It keeps no data of its own. Every control reads and rewrites the same command and table rows the
// classic panels show, so a song edited here is an ordinary NinjaTracker 2 song and the two modes
// can be mixed freely.

import { hex2, noteName } from '../core/song.ts';
import * as E from './editor.ts';
import { S } from './editor.ts';
import { graphHtml, wrapped } from './tablegraph.ts';
import { morphHtml } from './morph.ts';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const PTR = ['wave', 'pulse', 'filt'] as const;
const SECTION = ['Waveform and pitch', 'Pulse width', 'Filter'];
const SECTION_HELP = [
  'What the oscillator plays, one step per frame: the waveform and the pitch against the note. This is where arpeggios, drums and vibrato are made.',
  'The width of the pulse waveform over time. Only heard on steps that use the pulse waveform.',
  'The filter over time. There is one filter for all three channels: the instrument that set it last controls it.',
];
const WAVEFORMS: [number, string][] = [
  [1, 'triangle'], [2, 'saw'], [4, 'pulse'], [8, 'noise'], [5, 'tri + pulse'], [6, 'saw + pulse'],
  [3, 'tri + saw'], [7, 'tri + saw + pulse'], [0, 'none'],
];
const FILTER_TYPES: [number, string][] = [
  [1, 'low pass'], [2, 'band pass'], [4, 'high pass'], [3, 'low + band'], [5, 'low + high (notch)'], [6, 'band + high'],
  [7, 'all'], [0, 'off'],
];
const NOTES: [number, string][] = [];
for (let v = 0x8c; v <= 0xdf; v++) NOTES.push([v, noteName((v & 0x7f) * 2)]);

// SID envelope times in milliseconds for rates 0-15 (decay and release take three times as long)
const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
const ms = (v: number) => (v >= 1000 ? `${v / 1000} s` : `${v} ms`);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

type Data = Record<string, string | number>;
const data = (d: Data) => Object.entries(d).map(([k, v]) => ` data-${k}="${v}"`).join('');

function sel(d: Data, opts: [string | number, string][], value: string | number, title = ''): string {
  return `<select${data(d)} title="${esc(title)}">` +
    opts.map(([v, l]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('') + '</select>';
}
function num(d: Data, value: number, min: number, max: number, title = ''): string {
  return `<input type="number" class="nm"${data(d)} min="${min}" max="${max}" value="${value}" title="${esc(title)}">`;
}
function rng(d: Data, value: number, min: number, max: number, out: string, title = ''): string {
  return `<input type="range"${data(d)} min="${min}" max="${max}" value="${value}" title="${esc(title)}"><output>${esc(out)}</output>`;
}
function chk(d: Data, on: boolean, label: string, title = ''): string {
  return `<label class="ck" title="${esc(title)}"><input type="checkbox"${data(d)}${on ? ' checked' : ''}>${label}</label>`;
}
const lab = (text: string) => `<span class="lb">${text}</span>`;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Kind = 'set' | 'wait' | 'vib' | 'slide' | 'sweep';

function kindOf(t: number, l: number): Kind {
  if (t === 0) return l < 0x90 ? 'set' : l < 0xc0 ? 'wait' : l < 0xe0 ? 'vib' : 'slide';
  return l < 0x80 ? 'sweep' : 'set';
}

const KINDS: [Kind, string][][] = [
  [['set', 'Wave'], ['wait', 'Wait'], ['vib', 'Vibrato'], ['slide', 'Slide']],
  [['set', 'Set width'], ['sweep', 'Sweep']],
  [['set', 'Set filter'], ['sweep', 'Sweep']],
];

function pitchControls(d: Data, right: number): string {
  const abs = right > 0x80;
  return sel({ ...d, f: 'pm' }, [['rel', 'semitones'], ['abs', 'fixed note']], abs ? 'abs' : 'rel',
    'Semitones above the played note, or always the same note whatever is played (drums)') +
    (abs ? sel({ ...d, f: 'abs' }, NOTES, clamp(right, 0x8c, 0xdf)) : num({ ...d, f: 'rel' }, right, 0, 127));
}

/** A vibrato or slide ends a wave program: the player stays on that row, so only the last step can be one. */
const ENDS_PROGRAM = (k: Kind) => k === 'vib' || k === 'slide';

function stepControls(t: number, r: number, l: number, right: number, mid = false, wraps = false): string {
  const d = { t, r };
  const kind = kindOf(t, l);
  const kinds = t === 0 && mid ? KINDS[0].filter(k => !ENDS_PROGRAM(k[0])) : KINDS[t];
  let html = sel({ ...d, f: 'kind' }, kinds, kind,
    t === 0 && mid ? 'Vibrato and slide end the program, so only the last step can be one' : '');
  if (t === 0) {
    if (kind === 'set') {
      // The four switches are one group: in a narrow panel they take a line of their own
      html += sel({ ...d, f: 'wf' }, WAVEFORMS, l >> 4) + '<span class="bits">' +
        chk({ ...d, f: 'bit', b: 1 }, !!(l & 1), 'gate', 'Gate: on starts the envelope, off releases it') +
        chk({ ...d, f: 'bit', b: 2 }, !!(l & 2), 'sync', 'Hard sync with the previous channel') +
        chk({ ...d, f: 'bit', b: 4 }, !!(l & 4), 'ring', 'Ring modulation with the previous channel (triangle only)') +
        chk({ ...d, f: 'bit', b: 8 }, !!(l & 8), 'test', 'Test bit: stops the oscillator') +
        '</span>' + pitchControls(d, right);
    } else if (kind === 'wait') {
      html += num({ ...d, f: 'wait' }, l - 0x90, 0, 47, 'Frames to hold the sound as it is') + lab('frames, then') + pitchControls(d, right);
    } else if (kind === 'vib') {
      html += lab('speed') + rng({ ...d, f: 'vs' }, l - 0xc0, 0, 31, String(l - 0xc0), 'How quickly the pitch turns round, 0 to 31') +
        lab('depth') + rng({ ...d, f: 'vd' }, right, 0, 255, String(right),
          'How far the pitch moves each frame, in SID frequency steps (0 to 255). The same number is a smaller wobble on a higher note') +
        lab('steps/frame');
    } else {
      html += lab('speed') + num({ ...d, f: 'sl' }, ((l - 0xe0) << 8) | right, 0, 0x1eff,
        'How fast the pitch glides to the new note, in SID frequency steps per frame (0 to 7935). A semitone is more steps the higher the note: twice as many an octave up') +
        lab('steps/frame,') +
        lab('then back to the last waveform step');
    }
  } else if (kind === 'sweep') {
    html += lab('for') + num({ ...d, f: 'fr' }, l, 0, 127, 'Frames (0 = keeps going for ever)') + lab(l ? 'frames by' : '(for ever) by') +
      num({ ...d, f: 'sp' }, right < 0x80 ? right : right - 0x100, -128, 127,
        t === 1 ? 'Change per frame out of 255, negative to go down' : 'Change of the cutoff (0-255) per frame, negative to go down') +
      // A pulse sweep also in the unit of the width slider and the graph
      lab(t === 1 ? `per frame = ${((right < 0x80 ? right : right - 0x100) / 255 * 100).toFixed(1)}%` : 'per frame') +
      (wraps ? `<span class="lb wrap" title="The sweep runs past the ${t === 1 ? 'end of the pulse width range' : 'end of the cutoff range'} and comes round the other side: the sound jumps. Use fewer frames or a smaller change">wraps round</span>` : '');
  } else if (t === 1) {
    html += rng({ ...d, f: 'val' }, right, 0, 255, `${Math.round(right / 255 * 100)}%`, 'Pulse width: 50% is a square wave');
  } else {
    html += sel({ ...d, f: 'ft' }, FILTER_TYPES, (l >> 4) & 7, 'Filter type. The resonance follows the type in this player') +
      lab('on') + [0, 1, 2].map(c => chk({ ...d, f: 'bit', b: 1 << c }, !!(l & (1 << c)), `ch ${c + 1}`, `Filter channel ${c + 1}`)).join('') +
      lab('cutoff') + rng({ ...d, f: 'val' }, right, 0, 255, String(right), 'Cutoff, 0 (lowest) to 255');
  }
  return html;
}

/** Row a new step starts as: a copy of the one it follows, unless that one ends the program. */
function newStep(t: number, after: number): [number, number] {
  const tbl = S.song.tables[t];
  const l = after >= 0 ? tbl.left[after] : 0xff;
  if (l === 0xff || (t === 0 && l >= 0xc0)) return t === 0 ? [0x21, 0x00] : t === 1 ? [0x80, 0x80] : [E.newFilterSet(), 0x80];
  return [l, tbl.right[after]];
}

function sectionHtml(i: number, t: number, width: number): string {
  const cmd = S.song.commands[i];
  const ptr = cmd[PTR[t]];
  const head = `<h3 title="${esc(SECTION_HELP[t])}">${SECTION[t]}</h3>`;
  if (!ptr) {
    return `<section class="ie-sec off">${head}<span class="ie-note">${t === 0 ? 'Not set: the note keeps the sound that was playing' : 'Not used: whatever was running carries on'}</span>` +
      `<span class="grow"></span><button data-a="add" data-t="${t}">Add</button></section>`;
  }
  const p = E.programAt(S.song, t, ptr);
  if (!p) {
    return `<section class="ie-sec off">${head}<span class="ie-note warn">Points at row ${hex2(ptr)}, past the end of the table</span>` +
      `<span class="grow"></span><button data-a="remove" data-t="${t}">Remove</button></section>`;
  }
  const tbl = S.song.tables[t];
  const users = E.programUsers(S.song, t, p, i);
  const who = users.cmds.map(c => `${hex2(c + 1)} ${S.song.commands[c].name}`.trim()).join(', ');
  const shared = users.cmds.length || users.jumps
    ? `<span class="ie-note warn" title="Changes here are heard in those instruments too">Shared${who ? ` with ${esc(who)}` : ' with another program'}</span>` +
      `<button data-a="own" data-t="${t}" title="Give this instrument its own copy of these steps">Make own copy</button>`
    : '';
  const last = p.last;
  // What stands between these steps and the ear
  let unheard = '';
  if (t === 1) {
    const wp = E.programAt(S.song, 0, cmd.wave), wave = S.song.tables[0];
    let pulse = !wp;
    if (wp) for (let r = wp.start; r <= wp.last; r++) if (wave.left[r] < 0x90 && wave.left[r] & 0x40) pulse = true;
    if (!pulse) unheard = `<span class="ie-note warn" title="${esc(SECTION_HELP[1])}">Not heard: no waveform step uses pulse</span>`;
  } else if (t === 2) {
    unheard = `<span class="ie-note" title="${esc(SECTION_HELP[2])}">One filter for all channels: the last instrument to set it wins</span>`;
  }
  // Drawn first: playing the program through also finds the sweeps that wrap round
  const graph = graphHtml(t, p.start, -1, width, 112);
  let steps = '';
  for (let r = p.start; r <= last; r++) {
    const terminal = t === 0 && tbl.left[r] >= 0xc0;
    // Every row has the same buttons, greyed out where they do not apply, so they line up
    const btn = (a: string, label: string, title: string, ok: boolean, cls = '') =>
      `<button class="sq${cls}" data-a="${a}" data-t="${t}" data-r="${r}" title="${title}"${ok ? '' : ' disabled'}>${label}</button>`;
    // The step number is the handle the row is dragged by
    const grip = E.instStepRange(i, t, r)
      ? `<span class="rn grip" title="Drag to change the order (table row ${hex2(r + 1)})">${r - p.start + 1}</span>`
      : `<span class="rn" title="Table row ${hex2(r + 1)}">${r - p.start + 1}</span>`;
    steps += `<div class="st" data-t="${t}" data-r="${r}">${grip}<span class="stc">${stepControls(t, r, tbl.left[r], tbl.right[r], r < last, wrapped[t].has(r))}</span>` +
      btn('ins', '+', terminal ? 'A vibrato or slide is the last step' : 'Add a step after this one', !terminal) +
      btn('del', '&times;', last > p.start ? 'Remove this step' : 'The only step: use Remove above to stop using this table', last > p.start, ' rm') + `</div>`;
  }
  if (last < p.start) steps += `<div class="st"><span class="ie-note">No steps</span><span class="grow"></span><button data-a="ins" data-t="${t}" data-r="-1">Add a step</button></div>`;

  // What happens after the last step
  let end: string;
  if (t === 0 && p.jump < 0 && tbl.left[last] >= 0xc0) {
    end = `<span class="ie-note">${tbl.left[last] >= 0xe0 ? 'The slide' : 'The vibrato'} is the last step</span>`;
  } else {
    const dest = p.jump >= 0 ? tbl.right[p.jump] : -1;
    const opts: [string | number, string][] = [[0, t === 0 ? 'hold the last step' : 'stop']];
    for (let r = p.start; r <= last; r++) opts.push([r + 1, `repeat from step ${r - p.start + 1}`]);
    if (dest < 0) opts.unshift([-1, 'nothing set: runs on into the next rows']);
    else if (!opts.some(o => o[0] === dest)) opts.push([dest, `jump to table row ${hex2(dest)}`]);
    end = lab('Then') + sel({ t, f: 'end' }, opts, dest);
  }
  return `<section class="ie-sec">${head}${shared}${unheard}<span class="grow"></span>` +
    `<button data-a="remove" data-t="${t}" title="Stop using this table in this instrument">Remove</button>` +
    `<div class="ig">${graph}</div><div class="steps">${steps}<div class="st end">${end}</div></div></section>`;
}

function envelopeHtml(i: number): string {
  const c = S.song.commands[i];
  const a = c.ad >> 4, d = c.ad & 15, s = c.sr >> 4, r = c.sr & 15;
  // Not to scale: each stage gets a little more room the slower it is
  const w = (v: number) => 6 + v * 3.2;
  const x1 = 8 + w(a), x2 = x1 + w(d), x3 = x2 + 46, x4 = x3 + w(r);
  const top = 6, bottom = 58, ys = bottom - (bottom - top) * s / 15;
  const svg = `<svg class="env" width="240" height="64" viewBox="0 0 240 64"><line class="tg-grid" x1="8" x2="232" y1="${bottom}" y2="${bottom}"/>` +
    `<path class="env-fill" d="M8 ${bottom}L${x1} ${top}L${x2} ${ys}L${x3} ${ys}L${x4} ${bottom}Z"/>` +
    `<path class="tg-line" d="M8 ${bottom}L${x1} ${top}L${x2} ${ys}L${x3} ${ys}L${x4} ${bottom}"/>` +
    `<line class="tg-mark" x1="${x3}" x2="${x3}" y1="${top}" y2="${bottom}"/><text class="tg-marklab" x="${x3 + 3}" y="${top + 8}">key off</text></svg>`;
  const row = (f: string, name: string, v: number, out: string, tip: string) =>
    `<label class="adsr" title="${tip}">${lab(name)}${rng({ f }, v, 0, 15, out)}</label>`;
  return `<section class="ie-sec"><h3>Envelope</h3><div class="envrow">${svg}<div class="sliders">` +
    row('a', 'Attack', a, ms(ATTACK_MS[a]), 'Time to reach full volume') +
    row('d', 'Decay', d, ms(ATTACK_MS[d] * 3), 'Time to fall to the sustain level') +
    row('s', 'Sustain', s, `${Math.round(s / 15 * 100)}%`, 'Level held while the key is down') +
    row('r', 'Release', r, ms(ATTACK_MS[r] * 3), 'Time to fade out after key off') +
    `</div></div></section>`;
}

// ---------------------------------------------------------------------------

/** What the two halves of the panel last showed, so an unchanged panel is left alone. */
let shownList = '', shownEditor = '', shownInstrument = -1;

export function renderInstruments() {
  if (S.sideMode !== 'inst') {
    if (shownList) morphHtml($('inst-list'), shownList = '');
    if (shownEditor) morphHtml($('inst-editor'), shownEditor = '');
    shownInstrument = -1;
    return;
  }
  const i = S.cmdNum, cmd = S.song.commands[i];
  let list = `<button data-a="new" title="Set up the first unused instrument">+ New instrument</button>`;
  S.song.commands.forEach((c, n) => {
    if (!E.commandUsed(c) && n !== i) return;
    const tags = (c.wave ? 'W' : '') + (c.pulse ? 'P' : '') + (c.filt ? 'F' : '');
    list += `<div class="il${n === i ? ' cur' : ''}" data-a="sel" data-i="${n}"><span class="rn">${hex2(n + 1)}</span>` +
      `<span class="il-name">${E.commandUsed(c) ? esc(c.name) || '<i>unnamed</i>' : '<i>empty</i>'}</span><span class="il-tags" title="Tables it sets: Wave, Pulse, Filter">${tags}</span></div>`;
  });
  if (list !== shownList) morphHtml($('inst-list'), shownList = list);

  let html: string;
  if (!E.commandUsed(cmd)) {
    html = `<div class="ie-empty">Instrument ${hex2(i + 1)} is empty.<button data-a="create" class="primary">Create it</button></div>`;
  } else {
    const uses = E.commandUseCount(i + 1);
    const width = $('inst-editor').clientWidth - 30;
    html = `<div class="ie-head"><span class="num" title="Command number to type in a pattern">${hex2(i + 1)}</span>` +
      `<input class="ie-name" data-f="name" maxlength="9" spellcheck="false" value="${esc(cmd.name)}" placeholder="name" title="Instrument name (9 characters)">` +
      `<button data-a="test" class="go" title="Hold to hear the instrument (or play the piano keys while this panel is active)">&#9654; Test</button>` +
      `<span class="ie-note">${uses ? `used on ${uses} pattern row${uses === 1 ? '' : 's'}` : 'not used in a pattern yet'}</span><span class="grow"></span>` +
      `<button data-a="dup" title="Copy to the first unused instrument, with its own copies of the steps">Duplicate</button>` +
      `<button data-a="clear" class="danger" title="Remove this instrument from the song (Del; Ctrl+Z to undo)">Clear</button></div>` +
      envelopeHtml(i) + sectionHtml(i, 0, width) + sectionHtml(i, 1, width) + sectionHtml(i, 2, width);
  }
  if (html !== shownEditor) morphHtml($('inst-editor'), shownEditor = html);
  // Keep the selected instrument in view, moving only the list (never the page around it)
  const box = $('inst-list'), cur = box.querySelector<HTMLElement>('.il.cur');
  if (cur && i !== shownInstrument) {
    const top = cur.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + cur.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + cur.offsetHeight - box.clientHeight;
  }
  shownInstrument = i;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** The control whose changes are being joined into one undo step (a slider drag, a typed number). */
let gesture: EventTarget | null = null;

function onInput(e: Event) {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (!el.dataset.f) return;
  // Only an edit that went through starts a gesture: joining onto nothing would fold this change
  // into whatever was edited before
  const before = E.edits;
  applyInput(el, gesture === el);
  if (E.edits !== before) gesture = el;
  else if (gesture !== el) gesture = null;
}

function applyInput(el: HTMLInputElement | HTMLSelectElement, merge: boolean) {
  const f = el.dataset.f!;
  const i = S.cmdNum, cmd = S.song.commands[i];
  const n = parseInt(el.value, 10);
  const number = el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range');
  if (number && Number.isNaN(n)) return;

  if (f === 'name') return E.instSetName(i, el.value, merge);
  if (f === 'a') return E.instSetAdsr(i, 'ad', (n << 4) | (cmd.ad & 15), merge);
  if (f === 'd') return E.instSetAdsr(i, 'ad', (cmd.ad & 0xf0) | n, merge);
  if (f === 's') return E.instSetAdsr(i, 'sr', (n << 4) | (cmd.sr & 15), merge);
  if (f === 'r') return E.instSetAdsr(i, 'sr', (cmd.sr & 0xf0) | n, merge);

  const t = parseInt(el.dataset.t!, 10);
  if (f === 'end') {
    if (n >= 0) E.instSetEnd(i, t, n);
    return;
  }
  const r = parseInt(el.dataset.r!, 10);
  const tbl = S.song.tables[t];
  let l = tbl.left[r], rt = tbl.right[r];
  switch (f) {
    case 'kind': {
      const was = kindOf(t, l);
      const pitch = t === 0 && (was === 'set' || was === 'wait') ? rt : 0;
      const k = el.value as Kind;
      // On an earlier step it would cut the steps after it off from the instrument
      const p = E.programAt(S.song, t, cmd[PTR[t]]);
      if (t === 0 && ENDS_PROGRAM(k) && p && r < p.last) return;
      if (t === 0) [l, rt] = k === 'set' ? [0x41, pitch] : k === 'wait' ? [0x92, pitch] : k === 'vib' ? [0xc4, 0x20] : [0xe0, 0x40];
      else [l, rt] = k === 'sweep' ? [0x10, 0x04] : [t === 1 ? 0x80 : E.newFilterSet(), 0x80];
      break;
    }
    case 'wf': l = (n << 4) | (l & 0x0f); break;
    case 'bit': {
      const b = parseInt(el.dataset.b!, 10);
      l = (el as HTMLInputElement).checked ? l | b : l & ~b;
      break;
    }
    case 'pm':
      rt = el.value === 'abs' ? 0x80 | clamp(S.octave * 12 + rt, 0x0c, 0x5f) : clamp((rt & 0x7f) - S.octave * 12, 0, 127);
      break;
    case 'rel': rt = clamp(n, 0, 127); break;
    case 'abs': rt = n; break;
    case 'wait': l = 0x90 + clamp(n, 0, 47); break;
    case 'vs': l = 0xc0 + clamp(n, 0, 31); break;
    case 'vd': case 'val': rt = clamp(n, 0, 255); break;
    case 'sl': { const s = clamp(n, 0, 0x1eff); l = 0xe0 + (s >> 8); rt = s & 0xff; break; }
    case 'fr': l = clamp(n, 0, 127); break;
    case 'sp': rt = clamp(n, -128, 127) & 0xff; break;
    case 'ft': l = 0x80 | (n << 4) | (l & 0x0f); break;
  }
  // FF would turn the step into a jump
  if (l === 0xff) l = 0xf7;
  if (l !== tbl.left[r] || rt !== tbl.right[r]) E.tableSetRow(t, r, l, rt, merge);
}

/** Empty the selected instrument (the Clear button and the Delete key). Asks first when patterns use it. */
export function clearInstrument(status: (msg: string, error?: boolean) => void) {
  const i = S.cmdNum;
  if (!E.commandUsed(S.song.commands[i])) return;
  // Patterns keep the command number, so their notes would play an empty instrument
  const uses = E.commandUseCount(i + 1);
  const name = S.song.commands[i].name ? ` "${S.song.commands[i].name}"` : '';
  if (uses && !confirm(`Instrument ${hex2(i + 1)}${name} is used on ${uses} pattern row${uses === 1 ? '' : 's'}.\n\n` +
    'Those rows keep their command number and will play an empty instrument.\n\nClear it anyway?')) return;
  E.instClear(i);
  status(`Removed instrument ${hex2(i + 1)}${name} (Ctrl+Z to undo)`);
}

export interface InstrumentHost {
  /** Start and stop the test note for the current instrument. */
  test(): void;
  keyOff(): void;
  status(msg: string, error?: boolean): void;
}

// ---------------------------------------------------------------------------
// Dragging a step by its number to change the order
// ---------------------------------------------------------------------------

interface StepDrag { t: number; from: number; to: number; first: number; last: number }
let stepDrag: StepDrag | null = null;

const stepRows = (t: number) => [...$('inst-editor').querySelectorAll<HTMLElement>(`.st[data-t="${t}"][data-r]`)];

function markStepDrag() {
  if (!stepDrag) return;
  const { t, from, to } = stepDrag;
  for (const el of stepRows(t)) {
    const r = parseInt(el.dataset.r!, 10);
    el.classList.toggle('dragging', r === from);
    // The line shows where the step will land
    el.classList.toggle('drop-before', to < from && r === to);
    el.classList.toggle('drop-after', to > from && r === to);
  }
}

function onStepDragMove(e: MouseEvent) {
  if (!stepDrag) return;
  // The step lands on the row the pointer is over, or the nearest one it can go to
  let to = stepDrag.first;
  for (const el of stepRows(stepDrag.t)) {
    const r = parseInt(el.dataset.r!, 10), box = el.getBoundingClientRect();
    if (r <= stepDrag.last && e.clientY >= box.top) to = r;
  }
  stepDrag.to = to;
  markStepDrag();
}

function onStepDragEnd() {
  window.removeEventListener('mousemove', onStepDragMove);
  window.removeEventListener('mouseup', onStepDragEnd);
  document.body.classList.remove('step-drag');
  const d = stepDrag;
  stepDrag = null;
  if (!d) return;
  for (const el of stepRows(d.t)) el.classList.remove('dragging', 'drop-before', 'drop-after');
  if (d.to !== d.from) E.instMoveStep(S.cmdNum, d.t, d.from, d.to);
}

function stepDragStart(e: MouseEvent, row: HTMLElement) {
  const t = parseInt(row.dataset.t!, 10), from = parseInt(row.dataset.r!, 10);
  const range = E.instStepRange(S.cmdNum, t, from);
  if (!range) return;
  stepDrag = { t, from, to: from, ...range };
  document.body.classList.add('step-drag');
  window.addEventListener('mousemove', onStepDragMove);
  window.addEventListener('mouseup', onStepDragEnd);
  markStepDrag();
  // No text selection while dragging
  e.preventDefault();
}

export function wireInstruments(host: InstrumentHost) {
  const panel = $('panel-inst');
  panel.addEventListener('mousedown', e => {
    const grip = e.button === 0 ? (e.target as HTMLElement).closest<HTMLElement>('.rn.grip') : null;
    const row = grip?.closest<HTMLElement>('.st[data-r]');
    if (row) stepDragStart(e, row);
  });
  panel.addEventListener('input', onInput);
  panel.addEventListener('change', e => {
    gesture = null;
    // A typed number past the limit is stored as the limit: say so
    const typed = e.target as HTMLInputElement;
    if (typed instanceof HTMLInputElement && typed.type === 'number' && typed.value !== '') {
      const v = parseInt(typed.value, 10), lo = parseInt(typed.min, 10), hi = parseInt(typed.max, 10);
      if (v > hi) host.status(`${v} is over the limit for this field: set to ${hi}`, true);
      else if (v < lo) host.status(`${v} is under the limit for this field: set to ${lo}`, true);
    }
    // Show what was stored, in case a typed number was out of range
    shownEditor = '';
    E.notify();
    // Give the keyboard back to the editor, so the piano keys try the sound straight away
    const el = e.target as HTMLElement;
    if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type !== 'text' && el.type !== 'number')) el.blur();
  });
  panel.addEventListener('mousedown', e => {
    if ((e.target as HTMLElement).closest('[data-a="test"]')) host.test();
  });
  for (const ev of ['mouseup', 'mouseleave'] as const) {
    panel.addEventListener(ev, e => { if ((e.target as HTMLElement).closest?.('[data-a="test"]')) host.keyOff(); });
  }
  panel.addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!el) return;
    const i = S.cmdNum;
    const t = parseInt(el.dataset.t ?? '0', 10), r = parseInt(el.dataset.r ?? '0', 10);
    switch (el.dataset.a) {
      case 'sel': S.cmdNum = parseInt(el.dataset.i!, 10); E.notify(); break;
      case 'new': {
        const free = S.song.commands.findIndex(c => !E.commandUsed(c));
        if (free < 0) { host.status('All 127 instruments are in use', true); break; }
        if (E.instCreate(free)) { S.cmdNum = free; E.notify(); host.status(`Instrument ${hex2(free + 1)} created: use command ${hex2(free + 1)} in a pattern`); }
        break;
      }
      case 'create': E.instCreate(i); break;
      case 'dup': {
        const n = E.instDuplicate(i);
        if (n < 0) { host.status('No unused instrument, or the tables are full', true); break; }
        S.cmdNum = n;
        E.notify();
        host.status(`Copied to instrument ${hex2(n + 1)}`);
        break;
      }
      case 'clear': clearInstrument(host.status); break;
      case 'add':
        E.instAddProgram(i, t);
        if (t === 2 && S.song.commands[i].filt) host.status(`Filter added for channel ${S.trkCh + 1}, where test notes play: tick the channels this instrument is used on`);
        break;
      case 'remove': E.instRemoveProgram(i, t); break;
      case 'own': E.instOwnProgram(i, t); break;
      case 'ins': E.instInsertStep(i, t, r, ...newStep(t, r)); break;
      case 'del': {
        const p = E.programAt(S.song, t, S.song.commands[i][PTR[t]]);
        E.instDeleteStep(t, r);
        host.status(`Removed step ${p ? r - p.start + 1 : ''} of ${SECTION[t].toLowerCase()} (Ctrl+Z to undo)`);
        break;
      }
    }
    if (el instanceof HTMLButtonElement) el.blur();
  });
}
