// The example browser: tunes rebuilt from NinjaTracker 2 .sid files by scripts/extract-instruments.ts,
// listed by musician, with the tunes from the original NinjaTracker disk as a group of their own.

import { d64Directory, d64ReadFile } from '../core/d64.ts';
import { isSongFile } from '../core/songfile.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ExampleTune {
  /** Path of the song file under the examples folder. */
  file: string;
  title: string; author: string; released: string;
  /** SID model the tune was made for, when the .sid says. */
  model: string;
  subtunes: number;
  /** 'exact': plays register for register like the .sid. 'close': same notes, commands and timing, but the original used a modified player. */
  check: 'exact' | 'close';
  /**
   * The tune may be saved and exported, as a copy: its author allows it. Set by hand on the tune in
   * index.json ("copy": true); the bundled file is never written to.
   */
  copy?: boolean;
  /** The song file itself, for a tune that is not fetched from the examples folder (the disk's). */
  bytes?: Uint8Array;
}
export interface ExampleMusician { id: string; name: string; tunes: ExampleTune[] }
interface Index { format: string; musicians: ExampleMusician[] }

export interface ExamplesHost {
  /** Folder the index and the song files are served from, ending in a slash. */
  base: string;
  /** The disk image of the NinjaTracker distribution, whose tunes are listed as a group. */
  disk: string;
  load(tune: ExampleTune, bytes: Uint8Array): void;
  status(msg: string, error?: boolean): void;
}

const DISK = '*disk';

/** The tunes that came on the NinjaTracker disk, as a group like a musician's. Freeware with the editor. */
async function diskTunes(url: string): Promise<ExampleMusician | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const image = new Uint8Array(await res.arrayBuffer());
    const tunes: ExampleTune[] = [];
    for (const entry of d64Directory(image)) {
      const bytes = d64ReadFile(image, entry);
      if (!isSongFile(bytes)) continue;
      tunes.push({
        file: `${entry.name.toLowerCase()}.nt2`, title: entry.name, author: 'Lasse \u00D6\u00F6rni (Cadaver)', released: 'NinjaTracker V2.03 disk',
        model: '', subtunes: 1, check: 'exact', copy: true, bytes,
      });
    }
    return tunes.length ? { id: DISK, name: 'NinjaTracker 2 disk', tunes } : null;
  } catch {
    return null;
  }
}

let host: ExamplesHost;
let index: Index | null = null;
let musician = '';
let query = '';
let shown: ExampleTune[] = [];

const matches = (t: ExampleTune, words: string[]) => words.every(w => `${t.title} ${t.author} ${t.released}`.toLowerCase().includes(w));

function render() {
  if (!index) return;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  const counts = index.musicians.map(m => { const n = m.tunes.filter(t => matches(t, words)).length; total += n; return n; });
  $('exm-musicians').innerHTML =
    `<div class="il${musician === '' ? ' cur' : ''}" data-m=""><span class="il-name">All musicians</span><span class="il-tags">${total}</span></div>` +
    index.musicians.map((m, k) => `<div class="il${m.id === musician ? ' cur' : ''}${counts[k] ? '' : ' none'}" data-m="${esc(m.id)}">` +
      `<span class="il-name">${esc(m.name)}</span><span class="il-tags">${counts[k]}</span></div>`).join('');
  shown = [];
  let html = '';
  for (const m of index.musicians) {
    if (musician && m.id !== musician) continue;
    for (const t of m.tunes) {
      if (!matches(t, words)) continue;
      html += `<div class="kr" data-k="${shown.length}"><span class="exm-title">${esc(t.title)}</span>` +
        `<span class="kr-desc">${musician ? '' : esc(m.name)}</span>` +
        `<span class="exm-sub">${t.subtunes > 1 ? `${t.subtunes} subtunes` : ''}</span>` +
        `<span class="exm-copy"${t.copy ? ' title="Can be changed and saved as a copy"' : ''}>${t.copy ? 'copy' : ''}</span>` +
        `<span class="exm-check">${t.check === 'close' ? '&asymp;' : ''}</span>` +
        `<span class="kr-src">${esc(t.released)}</span></div>`;
      shown.push(t);
    }
  }
  $('exm-list').innerHTML = html || '<div class="kit-more">Nothing matches</div>';
}

export async function openExamples() {
  const dlg = $<HTMLDialogElement>('dlg-examples');
  if (dlg.open) return;
  dlg.showModal();
  if (!index) {
    $('exm-list').innerHTML = '<div class="kit-more">Loading the list…</div>';
    try {
      const res = await fetch(host.base + 'index.json');
      if (!res.ok) throw new Error(`the list is missing (${res.status})`);
      const data = await res.json() as Index;
      if (data?.format !== 'nt2-examples') throw new Error('the list is not in the expected format');
      index = data;
    } catch (err) {
      // Without the collection there are still the tunes of the original disk
      index = { format: 'nt2-examples', musicians: [] };
      host.status(`Could not load the tune list: ${(err as Error).message}`, true);
    }
    const disk = await diskTunes(host.disk);
    if (disk) index.musicians.unshift(disk);
  }
  render();
  $<HTMLInputElement>('exm-search').focus();
}

export function wireExamples(h: ExamplesHost) {
  host = h;
  const dlg = $<HTMLDialogElement>('dlg-examples');
  $('exm-musicians').addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const el = target.closest<HTMLElement>('[data-m]');
    if (!el) return;
    musician = el.dataset.m!;
    render();
    $('exm-list').scrollTop = 0;
  });
  $<HTMLInputElement>('exm-search').addEventListener('input', e => {
    query = (e.target as HTMLInputElement).value;
    render();
    $('exm-list').scrollTop = 0;
  });
  $('exm-list').addEventListener('click', async e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-k]');
    const tune = el && shown[parseInt(el.dataset.k!, 10)];
    if (!tune) return;
    try {
      let bytes = tune.bytes;
      if (!bytes) {
        const res = await fetch(host.base + tune.file.split('/').map(encodeURIComponent).join('/'));
        if (!res.ok) throw new Error(`could not fetch ${tune.file}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      }
      dlg.close();
      host.load(tune, bytes);
    } catch (err) { host.status((err as Error).message, true); }
  });
}
