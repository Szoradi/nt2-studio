// The instrument kit browser: pick a musician, filter and search, hear an instrument, add it to the song.

import { type Kit, type KitInstrument, type KitMusician, parseKit, kitRows, kitMainSource, kitTestNote } from '../core/kit.ts';
import { hex2, noteName } from '../core/song.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface KitHost {
  /** Where the kit file is served from. */
  url: string;
  /** Start sounding the instrument; false when it cannot be played right now. */
  preview(ins: KitInstrument): boolean;
  previewOff(): void;
  /** Add it to the song. Returns the command number, or 0 when it did not fit. */
  add(ins: KitInstrument, musician: KitMusician): number;
  /** The browser was closed. */
  closed(): void;
}

const CATEGORIES: [string, string][] = [
  ['', 'All'], ['drum', 'Drums'], ['bass', 'Bass'], ['lead', 'Leads'], ['pad', 'Pads'], ['chord', 'Chords'], ['modifier', 'Modifiers'],
];
const MAX_SHOWN = 600;

let kit: Kit | null = null;
let host: KitHost;
/** Musician id, or '' for all. */
let musician = '';
let category = '';
let query = '';
/** The instruments on screen, and which one is selected. */
let shown: { ins: KitInstrument; mus: KitMusician }[] = [];
let selected: KitInstrument | null = null;
/** Instruments added while the browser is open: name -> command number. */
const added = new Map<KitInstrument, number>();

function matches(ins: KitInstrument, words: string[]): boolean {
  if (category && ins.category !== category) return false;
  if (!words.length) return true;
  const text = `${ins.name} ${ins.description} ${ins.sources.map(s => s.song).join(' ')}`.toLowerCase();
  return words.every(w => text.includes(w));
}

function render() {
  if (!kit) return;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Musicians, with how many of their instruments pass the filter
  let total = 0;
  const counts = kit.musicians.map(m => { const n = m.instruments.filter(i => matches(i, words)).length; total += n; return n; });
  $('kit-musicians').innerHTML =
    `<div class="il${musician === '' ? ' cur' : ''}" data-m=""><span class="il-name">All musicians</span><span class="il-tags">${total}</span></div>` +
    kit.musicians.map((m, k) => `<div class="il${m.id === musician ? ' cur' : ''}${counts[k] ? '' : ' none'}" data-m="${esc(m.id)}" title="${esc(m.songs.join(', '))}">` +
      `<span class="il-name">${esc(m.name)}</span><span class="il-tags">${counts[k]}</span></div>`).join('');
  $('kit-cats').innerHTML = CATEGORIES.map(([id, label]) => `<button class="toggle${id === category ? ' on' : ''}" data-c="${id}">${label}</button>`).join('');

  shown = [];
  for (const m of kit.musicians) {
    if (musician && m.id !== musician) continue;
    for (const ins of m.instruments) if (matches(ins, words)) shown.push({ ins, mus: m });
  }
  if (!shown.some(s => s.ins === selected)) selected = null;
  const rows = shown.slice(0, MAX_SHOWN).map((s, k) => {
    const src = kitMainSource(s.ins);
    const n = added.get(s.ins);
    return `<div class="kr${s.ins === selected ? ' cur' : ''}" data-k="${k}">` +
      `<span class="kr-name">${esc(s.ins.name)}</span><span class="kr-cat c-${s.ins.category}">${s.ins.category}</span>` +
      `<span class="kr-desc">${esc(s.ins.description)}</span>` +
      `<span class="kr-src">${n ? `<b>added as ${hex2(n)}</b>` : esc((musician ? '' : s.mus.name.replace(/^.*\((.*)\)$/, '$1') + ' · ') + src.song)}</span></div>`;
  }).join('');
  $('kit-list').innerHTML = rows + (shown.length > MAX_SHOWN ? `<div class="kit-more">${shown.length - MAX_SHOWN} more: pick a musician or type in the search box to narrow it down</div>` : '') +
    (shown.length ? '' : '<div class="kit-more">Nothing matches</div>');
  renderDetail();
}

function renderDetail() {
  const ins = selected;
  $<HTMLButtonElement>('kit-add').disabled = !ins;
  $<HTMLButtonElement>('kit-test').disabled = !ins;
  if (!ins) { $('kit-detail').innerHTML = '<span class="dim">Click an instrument to hear it. Double-click, or press Add, to put it in your song.</span>'; return; }
  const prog = (label: string, text: string) => (text ? `<div><span class="dim">${label}</span> ${esc(text)}</div>` : '');
  const src = kitMainSource(ins);
  const others = ins.sources.length - 1;
  const range = src.uses ? `played ${src.uses} time${src.uses === 1 ? '' : 's'}, ${noteName(src.lowNote * 2)} to ${noteName(src.highNote * 2)}, mostly ${noteName(src.typicalNote * 2)}` : 'named in a pattern but not reached while playing';
  $('kit-detail').innerHTML =
    `<div><b>${esc(ins.name)}</b> &nbsp;${esc(ins.description)}</div>` +
    `<div><span class="dim">From</span> ${esc(src.song)}${src.released ? ` (${esc(src.released)})` : ''}, command ${hex2(src.cmd)}: ${range}${others > 0 ? `; also in ${others} other tune${others === 1 ? '' : 's'}` : ''}</div>` +
    `<div class="kit-bytes"><div><span class="dim">Attack/Decay</span> ${ins.ad} <span class="dim">Sustain/Release</span> ${ins.sr}` +
    `${ins.legatoOnly ? ' <span class="dim">(meant for tied notes: use it as command + 80)</span>' : ''}</div>` +
    prog('Wave', ins.wave) + prog('Pulse', ins.pulse) + prog('Filter', ins.filter) + '</div>' +
    (kitRows(ins.wave).length || ins.legatoOnly ? '' : '<div class="dim">It has no waveform of its own: on its own you hear nothing; it changes a note that is already sounding.</div>');
}

function select(k: number, play: boolean) {
  const s = shown[k];
  if (!s) return;
  selected = s.ins;
  $('kit-list').querySelectorAll('.kr.cur').forEach(el => el.classList.remove('cur'));
  $('kit-list').querySelector(`[data-k="${k}"]`)?.classList.add('cur');
  renderDetail();
  if (play) host.preview(s.ins);
}

function addSelected() {
  const s = shown.find(x => x.ins === selected);
  if (!s) return;
  const n = host.add(s.ins, s.mus);
  if (n) { added.set(s.ins, n); render(); }
}

export async function openKit() {
  const dlg = $<HTMLDialogElement>('dlg-kit');
  if (dlg.open) return;
  added.clear();
  dlg.showModal();
  if (!kit) {
    $('kit-list').innerHTML = '<div class="kit-more">Loading the kit…</div>';
    try {
      const res = await fetch(host.url);
      if (!res.ok) throw new Error(`the kit file is missing (${res.status})`);
      kit = parseKit(await res.text());
    } catch (err) {
      $('kit-list').innerHTML = `<div class="kit-more err">Could not load the kit: ${esc((err as Error).message)}</div>`;
      return;
    }
  }
  render();
  $<HTMLInputElement>('kit-search').focus();
}

export function wireKit(h: KitHost) {
  host = h;
  const dlg = $<HTMLDialogElement>('dlg-kit');
  $('kit-musicians').addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-m]');
    if (!el) return;
    musician = el.dataset.m!;
    render();
    $('kit-list').scrollTop = 0;
  });
  $('kit-cats').addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    if (!el) return;
    category = el.dataset.c!;
    render();
    $('kit-list').scrollTop = 0;
  });
  $<HTMLInputElement>('kit-search').addEventListener('input', e => {
    query = (e.target as HTMLInputElement).value;
    render();
    $('kit-list').scrollTop = 0;
  });
  const list = $('kit-list');
  const rowOf = (e: Event) => { const el = (e.target as HTMLElement).closest<HTMLElement>('[data-k]'); return el ? parseInt(el.dataset.k!, 10) : -1; };
  // The note sounds while the mouse button is held on a row, like the Test button
  list.addEventListener('mousedown', e => { const k = rowOf(e); if (k >= 0 && e.button === 0) select(k, true); });
  list.addEventListener('dblclick', e => { if (rowOf(e) >= 0) addSelected(); });
  $('kit-test').addEventListener('mousedown', () => { if (selected) host.preview(selected); });
  for (const ev of ['mouseup', 'mouseleave'] as const) {
    list.addEventListener(ev, () => host.previewOff());
    $('kit-test').addEventListener(ev, () => host.previewOff());
  }
  $('kit-add').addEventListener('click', addSelected);
  // Arrow keys walk the list and play each instrument; Enter adds it
  dlg.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    if (e.key === 'Enter') { if (selected) { e.preventDefault(); addSelected(); } return; }
    e.preventDefault();
    const at = shown.findIndex(s => s.ins === selected);
    const next = Math.max(0, Math.min(Math.min(shown.length, MAX_SHOWN) - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    select(next, true);
    list.querySelector(`[data-k="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  dlg.addEventListener('keyup', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') host.previewOff(); });
  dlg.addEventListener('close', () => { host.previewOff(); host.closed(); });
}

/** The note the preview should play, as a pattern note value. */
export const previewNote = (ins: KitInstrument) => kitTestNote(ins) * 2;
