// A picture of a table program, with points that can be dragged (shown in the instrument editor).
//
// The graph plays the program the way the playroutine does, one frame at a time: the pitch steps of
// a wave program, the pulse width of a pulse program, the cutoff of a filter program. Each row of the
// first pass gets a handle; dragging it rewrites that row, so the hex list and the sound follow.

import { type Table, hex2, noteName } from '../core/song.ts';
import { S, tableSetRow, notify, programAt } from './editor.ts';
import { describeTableRow } from './view.ts';

type Kind = 'set' | 'mod' | 'arp';

interface Frame { v: number; row: number; wave: number; abs: boolean; fx: boolean }
interface Handle {
  row: number; kind: Kind;
  /** Frame and value where the handle sits. */
  f: number; v: number;
  /** Modulation: first frame, the value before it, and the frame count (0 = runs on, speed only). */
  f0: number; v0: number; n: number;
  abs: boolean;
  /** Position in the picture, filled in when drawn. */
  x: number; y: number;
}
interface Mark { f: number; label: string }
interface Sim {
  frames: Frame[]; handles: Handle[]; marks: Mark[]; firstPass: number; loops: boolean;
  /** Rows whose sweep ran past the end of the range and came round the other side. */
  wraps: Set<number>;
}

/** Per table: the rows of the graph last drawn whose sweep wraps round (the step list says so too). */
export const wrapped: Set<number>[] = [new Set(), new Set(), new Set()];

const SIM_FRAMES = 2000;
/** A row that modulates forever has no end to drag, so its handle sits this many frames in. */
const OPEN_MOD_FRAMES = 16;

const signed = (v: number) => (v < 0x80 ? v : v - 0x100);

/** Play a program from row `start`. Runs a little past its first pass, and at least `minFrames` frames. */
function simulate(t: number, tbl: Table, start: number, minFrames = 0): Sim {
  const len = tbl.left.length;
  const frames: Frame[] = [], handles: Handle[] = [], marks: Mark[] = [];
  const seen = new Set<number>();
  let pos = start + 1, time = 0, firstPass = -1, loops = false;
  let v = t === 1 ? 0x80 : 0, wave = 0, abs = false, fx = false;
  /** Past what is drawn the program is only played on to see whether a sweep wraps round later. */
  let quiet = false;
  const hold = (row: number) => { if (!quiet) frames.push({ v, row, wave, abs, fx }); };
  // The pulse is kept with its nybbles swapped and added with end-around carry: modulo 255 here
  const wrap = (x: number) => (t === 1 ? (x > 255 ? x - 255 : x < 0 ? x + 255 : x) : x & 0xff);
  const wraps = new Set<number>();
  /** One frame of a sweep on row `r`. Running off either end is marked, once for the row. */
  const sweep = (r: number, f: number, by: number, flag = true) => {
    const x = v + by;
    // On any pass: a repeating sweep that drifts wraps on a later one
    if (flag && (x > 255 || x < 0) && !wraps.has(r)) { wraps.add(r); marks.push({ f, label: 'wraps' }); }
    v = wrap(x);
  };
  /** Where a jump goes, the way the step list numbers it. */
  const dest = (to: number, from: number) => (!to ? 'stop' : to > start && to - 1 <= from ? `to step ${to - start}` : `to row ${hex2(to)}`);

  for (let f = 0; f < SIM_FRAMES; f++) {
    // Nothing past the repeat that is drawn is needed for the picture. A pulse or filter program
    // that is still running is played on without being kept, to find a sweep that wraps later
    if (firstPass >= 0 && f >= Math.max(firstPass + 100, 32, minFrames)) {
      if (t === 0 || pos === 0 || pos > len) break;
      quiet = true;
    }
    if (fx || pos === 0 || pos > len) {
      if (firstPass < 0) firstPass = f;
      hold(fx ? pos - 1 : -1);
      continue;
    }
    const r = pos - 1, l = tbl.left[r], rt = tbl.right[r];
    const live = firstPass < 0;
    if (time === 0 && live) {
      if (seen.has(r)) { firstPass = f; loops = true; }
      else seen.add(r);
    }
    const first = firstPass < 0;

    if (t === 0) {
      if (l === 0xff) { pos = 0; f--; continue; }
      if (l >= 0xc0) {
        // Vibrato and slide stay on their row
        if (first) marks.push({ f, label: l >= 0xe0 ? 'slide' : 'vibrato' });
        fx = true;
        f--;
        continue;
      }
      if (l > 0x90) {
        if (time === 0) { time = l - 0x90; hold(r); continue; }
        if (--time > 0) { hold(r); continue; }
      } else if (l < 0x90) wave = l;
      abs = rt > 0x80;
      v = abs ? rt & 0x7f : rt & 0x7f;
      if (first) handles.push({ row: r, kind: 'arp', f, v, f0: f, v0: v, n: 1, abs, x: 0, y: 0 });
      // A jump on the next row is taken at once
      if (pos < len && tbl.left[pos] === 0xff) {
        if (first) marks.push({ f: f + 1, label: dest(tbl.right[pos], pos) });
        pos = tbl.right[pos];
      } else pos++;
      hold(r);
      continue;
    }

    if (l === 0xff) {
      if (first) marks.push({ f, label: dest(rt, r) });
      pos = rt;
      hold(r);
    } else if (l >= 0x80) {
      v = rt;
      if (first) handles.push({ row: r, kind: 'set', f, v, f0: f, v0: v, n: 1, abs: false, x: 0, y: 0 });
      pos++;
      hold(r);
    } else if (l === 0) {
      // Time 00 never runs out
      if (first) {
        handles.push({ row: r, kind: 'mod', f: f + OPEN_MOD_FRAMES - 1, v: 0, f0: f, v0: v, n: 0, abs: false, x: 0, y: 0 });
        marks.push({ f, label: 'runs on' });
        firstPass = f + OPEN_MOD_FRAMES * 2;
      }
      // A sweep that runs for ever goes round by design: that is not a mistake to warn about
      sweep(r, f, signed(rt), false);
      hold(r);
    } else if (time === 0) {
      time = l;
      if (first) handles.push({ row: r, kind: 'mod', f: f + l - 1, v: 0, f0: f, v0: v, n: l, abs: false, x: 0, y: 0 });
      sweep(r, f, signed(rt));
      hold(r);
    } else {
      // The frame on which the time runs out only moves on to the next row
      if (--time === 0) pos++;
      else sweep(r, f, signed(rt));
      hold(r);
    }
  }
  if (firstPass < 0) firstPass = SIM_FRAMES;
  return { frames, handles, marks, firstPass, loops, wraps };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const PL = 30, PR = 10, PT = 12, PB = 16;
const TABLE_NAMES = ['Wave', 'Pulse', 'Filter'];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Geom { t: number; start: number; total: number; ymin: number; ymax: number; w: number; h: number }
/** Per table: the scales and handles of the graph last drawn for it (one is on screen at a time). */
const geoms: (Geom | null)[] = [null, null, null];
const showns: Handle[][] = [[], [], []];

interface Drag { geom: Geom; h: Handle; dx: number; dy: number; merged: boolean }
let drag: Drag | null = null;

/** Note the wave graph measures absolute steps against: the one Shift+Space tests with. */
const baseNote = () => S.octave * 12;

function waveClass(w: number): string {
  const kind = { 0x10: 'tri', 0x20: 'saw', 0x40: 'pul', 0x80: 'noi' }[w & 0xf0] ?? 'mix';
  return `w-${kind}${w & 1 ? '' : ' off'}`;
}

function frameStep(pxPerFrame: number): number {
  for (const s of [1, 2, 5, 10, 20, 50, 100, 200, 500]) if (s * pxPerFrame >= 34) return s;
  return 1000;
}

/** The graph of the program of table `t` that starts at row `from`; `cur` is the row to highlight (-1 = none). */
export function graphHtml(t: number, from: number, cur: number, width: number, H = 150): string {
  const tbl = S.song.tables[t];
  const frozen = drag && drag.geom.t === t ? drag.geom : null;
  const start = frozen ? frozen.start : from;
  const sim = simulate(t, tbl, start, frozen ? frozen.total : 0);
  wrapped[t] = sim.wraps;
  const base = baseNote();
  const val = (fr: { v: number; abs: boolean }) => (t === 0 && fr.abs ? fr.v - base : fr.v);

  let total: number, ymin = 0, ymax = 255;
  if (frozen) ({ total, ymin, ymax } = frozen);
  else {
    const tail = sim.loops ? Math.min(Math.max(sim.firstPass, 16), 96) : 8;
    total = Math.min(Math.max(sim.firstPass + tail, 24), SIM_FRAMES);
    if (t === 0) {
      const vals = sim.frames.slice(0, total).map(val);
      ymin = Math.min(0, ...vals) - 2;
      ymax = Math.max(12, ...vals) + 2;
    }
  }
  const w = Math.max(240, Math.floor(width));
  geoms[t] = { t, start, total, ymin, ymax, w, h: H };
  const plotW = w - PL - PR, plotH = H - PT - PB;
  const px = plotW / total;
  const X = (f: number) => PL + f * px;
  const Y = (v: number) => PT + (ymax - v) / (ymax - ymin) * plotH;
  const n1 = (v: number) => v.toFixed(1);
  let g = '';

  // Value grid
  if (t === 0) {
    const semis = plotH / (ymax - ymin);
    for (let s = Math.ceil(ymin); s <= ymax; s++) {
      const octave = s % 12 === 0;
      if (!octave && semis < 5) continue;
      g += `<line class="tg-grid${octave ? ' major' : ''}" x1="${PL}" x2="${w - PR}" y1="${n1(Y(s))}" y2="${n1(Y(s))}"/>`;
      if (octave) g += `<text class="tg-lab" x="${PL - 4}" y="${n1(Y(s) + 3)}" text-anchor="end">${s > 0 ? '+' : ''}${s}</text>`;
    }
  } else {
    for (const s of [0, 0x40, 0x80, 0xc0, 0xff]) {
      g += `<line class="tg-grid${s === 0x80 ? ' major' : ''}" x1="${PL}" x2="${w - PR}" y1="${n1(Y(s))}" y2="${n1(Y(s))}"/>` +
        // The same units as the sliders: pulse width in per cent, cutoff 0-255
        `<text class="tg-lab" x="${PL - 4}" y="${n1(Y(s) + 3)}" text-anchor="end">${t === 1 ? `${Math.round(s / 255 * 100)}%` : s}</text>`;
    }
  }
  // Frame axis
  const step = frameStep(px);
  for (let f = 0; f <= total; f += step) {
    g += `<line class="tg-tick" x1="${n1(X(f))}" x2="${n1(X(f))}" y1="${H - PB}" y2="${H - PB + 3}"/>` +
      `<text class="tg-lab" x="${n1(X(f))}" y="${H - 3}" text-anchor="middle">${f}</text>`;
  }
  // What follows the first pass is a repeat (or the value the program leaves behind)
  if (sim.firstPass < total) {
    g += `<rect class="tg-rep" x="${n1(X(sim.firstPass))}" y="${PT}" width="${n1(X(total) - X(sim.firstPass))}" height="${plotH}"/>`;
  }
  for (const m of sim.marks) {
    if (m.f > total) continue;
    const x = X(t === 0 ? m.f : m.f + 0.5);
    g += `<line class="tg-mark" x1="${n1(x)}" x2="${n1(x)}" y1="${PT}" y2="${H - PB}"/>` +
      `<text class="tg-marklab" x="${n1(Math.min(x + 3, w - PR - 30))}" y="${PT + 8}">${m.label}</text>`;
  }

  const live = sim.handles.filter(h => h.f < total);
  let hits = '';
  if (t === 0) {
    // Pitch steps, coloured by waveform
    let path = '';
    for (let f = 0; f < total; f++) {
      const fr = sim.frames[f], y = Y(val(fr));
      path += `${f ? 'L' : 'M'}${n1(X(f))} ${n1(y)}L${n1(X(f + 1))} ${n1(y)}`;
    }
    g += `<path class="tg-stepline" d="${path}"/>`;
    for (let f = 0; f < total; f++) {
      const fr = sim.frames[f];
      if (fr.row < 0 && f >= sim.firstPass) continue;
      g += `<rect class="tg-step ${waveClass(fr.wave)}${fr.abs ? ' abs' : ''}${f >= sim.firstPass ? ' rep' : ''}${fr.fx ? ' fx' : ''}" ` +
        `x="${n1(X(f) + 0.5)}" y="${n1(Y(val(fr)) - 2.5)}" width="${n1(Math.max(px - 1, 1))}" height="5"/>`;
    }
    live.forEach((h, i) => {
      h.x = X(h.f + 0.5); h.y = Y(val(h));
      const tip = `Step ${h.row - start + 1} (table row ${hex2(h.row + 1)}): ${describeTableRow(t, tbl.left[h.row], tbl.right[h.row])}` +
        `${h.abs ? '' : ` (${noteName(Math.min(95, base + h.v) * 2)} on the test note)`}. Drag up or down`;
      if (h.row === cur) g += `<rect class="tg-cur" x="${n1(X(h.f) - 1)}" y="${n1(h.y - 5)}" width="${n1(px + 2)}" height="10" rx="2"/>`;
      hits += `<rect class="tg-hit" data-h="${i}" x="${n1(X(h.f))}" y="${n1(h.y - 8)}" width="${n1(Math.max(px, 4))}" height="16"><title>${esc(tip)}</title></rect>`;
    });
  } else {
    const line = (from: number, to: number) => {
      let d = '', prev = NaN;
      for (let f = from; f < to; f++) {
        const v = sim.frames[f].v;
        d += `${Number.isNaN(prev) || Math.abs(v - prev) > 127 ? 'M' : 'L'}${n1(X(f + 0.5))} ${n1(Y(v))}`;
        prev = v;
      }
      return d;
    };
    const end = Math.min(sim.firstPass, total);
    g += `<path class="tg-line" d="${line(0, end)}"/>`;
    if (end < total) g += `<path class="tg-line rep" d="${line(Math.max(end - 1, 0), total)}"/>`;
    live.forEach((h, i) => {
      h.v = sim.frames[h.f].v;
      h.x = X(h.f + 0.5); h.y = Y(h.v);
      const how = h.kind === 'set' ? 'Drag up or down' : h.n ? 'Drag sideways for the length, up or down for the speed' : 'Drag up or down for the speed';
      const tip = `Step ${h.row - start + 1} (table row ${hex2(h.row + 1)}): ${describeTableRow(t, tbl.left[h.row], tbl.right[h.row])}. ${how}`;
      const c = `tg-h ${h.kind}${h.row === cur ? ' cur' : ''}`;
      g += h.kind === 'set'
        ? `<circle class="${c}" cx="${n1(h.x)}" cy="${n1(h.y)}" r="4"/>`
        : `<rect class="${c}" x="${n1(h.x - 3.5)}" y="${n1(h.y - 3.5)}" width="7" height="7" transform="rotate(45 ${n1(h.x)} ${n1(h.y)})"/>`;
      hits += `<circle class="tg-hit" data-h="${i}" cx="${n1(h.x)}" cy="${n1(h.y)}" r="9"><title>${esc(tip)}</title></circle>`;
    });
  }
  showns[t] = live;

  const legend = t === 0
    ? '<span class="tg-key"><i class="w-tri"></i>tri<i class="w-saw"></i>saw<i class="w-pul"></i>pulse<i class="w-noi"></i>noise</span>'
    : '<span class="tg-key"><i class="k-set"></i>set<i class="k-mod"></i>sweep</span>';
  // Short enough never to be cut off; the rest is in the tooltip
  const what = t === 0 ? 'semitones from the note' : t === 1 ? 'pulse width per frame' : 'cutoff per frame';
  const whatTip = t === 0 ? `One column per frame. Fixed-note steps are drawn against ${noteName(base * 2)}, the note Shift+Space tests with` : '';
  // The steps of the program itself, as the list under the graph counts them (a jump may lead the
  // picture on into rows of another program)
  const prog = programAt(S.song, t, start + 1);
  const steps = prog ? prog.last - prog.start + 1 : 0;
  return `<div class="tg-head"><b>${TABLE_NAMES[t]} graph</b>` +
    `<span class="tg-count" title="Table rows ${hex2(start + 1)}-${hex2((prog ? prog.end : start) + 1)}">${steps} step${steps === 1 ? '' : 's'}</span>` +
    `<span class="tg-what" title="${whatTip}">${what}</span><span class="grow"></span>${legend}</div>` +
    `<svg class="tg${drag ? ' dragging' : ''}" data-t="${t}" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">${g}${hits}</svg>`;
}

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function onMove(e: MouseEvent) {
  if (!drag) return;
  const { geom: gm, h } = drag;
  const svg = document.querySelector<SVGElement>(`svg.tg[data-t="${gm.t}"]`);
  if (!svg) return;
  const box = svg.getBoundingClientRect();
  const x = e.clientX - box.left - drag.dx, y = e.clientY - box.top - drag.dy;
  const px = (gm.w - PL - PR) / gm.total;
  const value = gm.ymax - (y - PT) / (gm.h - PT - PB) * (gm.ymax - gm.ymin);
  const tbl = S.song.tables[gm.t];
  let left = tbl.left[h.row], right = tbl.right[h.row];
  if (h.kind === 'arp') {
    const semis = Math.round(value);
    right = h.abs ? 0x80 | clamp(semis + baseNote(), 0x0c, 0x5f) : clamp(semis, 0, 0x7f);
  } else if (h.kind === 'set') {
    right = clamp(Math.round(value), 0, 255);
  } else {
    const frames = h.n ? clamp(Math.round((x - PL) / px - 0.5) - h.f0 + 1, 1, 0x7f) : OPEN_MOD_FRAMES;
    if (h.n) left = frames;
    right = clamp(Math.round((clamp(value, 0, 255) - h.v0) / frames), -128, 127) & 0xff;
  }
  if (left === tbl.left[h.row] && right === tbl.right[h.row]) return;
  tableSetRow(gm.t, h.row, left, right, drag.merged);
  drag.merged = true;
}

function onUp() {
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  drag = null;
  notify();
}

/** Mouse down inside the graph: pick up the handle under the pointer, if any. */
export function graphMouseDown(e: MouseEvent) {
  const el = (e.target as Element).closest<SVGElement>('[data-h]');
  const svg = (e.target as Element).closest<SVGElement>('svg.tg');
  S.focus = 'inst';
  S.sel = null;
  const geom = svg ? geoms[parseInt(svg.dataset.t!, 10)] : null;
  if (el && svg && geom) {
    const h = showns[geom.t][parseInt(el.dataset.h!, 10)];
    if (h) {
      const box = svg.getBoundingClientRect();
      S.tblRow[geom.t] = h.row;
      drag = { geom: { ...geom }, h: { ...h }, dx: e.clientX - box.left - h.x, dy: e.clientY - box.top - h.y, merged: false };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      e.preventDefault();
    }
  }
  notify();
}
