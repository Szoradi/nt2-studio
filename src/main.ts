import {
  type Song, newSong, hex2, hex4, scanUsage, trackProblem, KEYON, KEYOFF, LASTNOTE, MAX_PATTLEN, MAX_TBLLEN,
  MAX_CMD, MAX_CMDNAMELEN, MAX_SONGLEN,
} from './core/song.ts';
import { loadSongFile, saveSongFile, isSongFile } from './core/songfile.ts';
import { isD64, d64Directory, d64ReadFile } from './core/d64.ts';
import { importPacked } from './core/sidimport.ts';
import { packNormal, packGamemusic, makeSid, withLoadAddress } from './core/packer.ts';
import { export4k, MAX_4K_ROWS, type Export4k } from './core/export4k.ts';
import { verify4k } from './core/verify4k.ts';
import { WebSid, loadWebSidModule } from './audio/websid.ts';
import { Engine } from './audio/engine.ts';
import { AudioOutput, OUTPUT_RATE } from './audio/output.ts';
import * as E from './ui/editor.ts';
import { S, PANELS, CMD_NAME_COL, type Panel } from './ui/editor.ts';
import { graphMouseDown } from './ui/tablegraph.ts';
import { wireInstruments, clearInstrument } from './ui/instrument.ts';
import { wireKit, openKit, previewNote } from './ui/kit.ts';
import { wireExamples, openExamples as openExampleBrowser } from './ui/examples.ts';
import { addKitInstrument, type KitInstrument } from './core/kit.ts';
import { wireMenus } from './ui/menu.ts';
import { renderAll, renderTime, showStatus, HELP_HTML, FOLDS, folded, hiddenNow, foldOf, setFolded, type Fold } from './ui/view.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let engine: Engine | null = null;
let output: AudioOutput | null = null;

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function initEngine() {
  try {
    const mod = await loadWebSidModule(import.meta.env.BASE_URL + 'websid/');
    engine = new Engine(new WebSid(mod), OUTPUT_RATE);
    engine.model = $<HTMLSelectElement>('sel-model').value as '6581' | '8580';
    engine.setSong(S.song);
    engine.onStoppedFrame = heldStepFrame;
    applyMutes(); // a mute switch may have been clicked while the emulator was loading
    showStatus('Ready. Press F1 to play, F8 for help.');
  } catch (err) {
    showStatus(`Sound is unavailable: ${(err as Error).message}`, true);
  }
}

/** Browsers only allow audio after a user gesture, so the output starts on first use. */
function ensureAudio() {
  if (!engine) return;
  if (!output) output = new AudioOutput(engine);
  output.resume();
}

/** Hand the mute switches of the pattern columns to the sound engine. */
function applyMutes() {
  S.mute.forEach((m, v) => engine?.setMute(v, m));
}

function play() {
  if (!engine) return;
  ensureAudio();
  const problems = E.curTracks().map(trackProblem).filter(Boolean);
  if (E.curTracks().some(t => t.length === 0)) return showStatus('This subtune has an empty track. Each track needs a pattern and a 00 xx loop.', true);
  if (problems.length) showStatus(`Track problem: ${problems[0]}`, true);
  else showStatus('Playing');
  engine.play(S.subtune);
}

function stop() {
  engine?.stop();
  showStatus('Stopped');
  renderAll(null);
}

/**
 * Play from the cursor: the cursor row in the pattern panel, or the track cursor elsewhere.
 * All three channels start together at that moment of the song.
 */
function playFromCursor() {
  if (!engine) return;
  ensureAudio();
  const at = E.cursorStart();
  if (at === null) return showStatus('Each track needs at least one pattern to play from the cursor', true);
  if (at === 'notInTrack') {
    // The pattern on screen is not in this channel's track, so the best we can do is loop it
    const n = S.pattNum[S.pattCh];
    if (!S.song.patterns[n - 1].length) {
      return showStatus(`Pattern ${hex2(n)} is empty and not in the channel ${S.pattCh + 1} track, so there is nothing to play`, true);
    }
    playPattern();
    return showStatus(`Pattern ${hex2(n)} is not in the channel ${S.pattCh + 1} track, so it is looped on its own`);
  }
  const bar = Math.floor(at.time / S.barFrames) + 1;
  const beat = Math.floor(((at.time % S.barFrames) / (S.barFrames / 4)) * 100) / 100 + 1;
  engine.play(S.subtune, at.starts, at.trans, at.skip);
  showStatus(`Playing from bar ${bar}, beat ${beat}`);
}

/** Loop the pattern shown in the focused pattern column, on that channel alone. */
function playPattern() {
  if (!engine) return;
  ensureAudio();
  const c = S.pattCh, n = S.pattNum[c];
  if (!S.song.patterns[n - 1].length) return showStatus(`Pattern ${hex2(n)} is empty`, true);
  engine.playPattern(n, c);
  showStatus(`Looping pattern ${hex2(n)} on channel ${c + 1}. Edits are heard live; F3 stops.`);
}

/**
 * Working in a channel's track or pattern column while the song plays switches that channel's
 * follow toggle off, so its column stops jumping to whatever is playing. It stays off until the
 * user turns it back on; the other channels are not affected.
 */
function holdFollow() {
  if (!engine?.state.playing || engine.patternLoop) return;
  if (S.focus !== 'pattern' && S.focus !== 'tracks') return;
  const channel = S.focus === 'pattern' ? S.pattCh : S.trkCh;
  if (!S.follow[channel]) return;
  S.follow[channel] = false;
  renderAll(engine.state);
}

function testNote(note: number, cmd: number, channel: number) {
  if (!engine || !cmd) return;
  ensureAudio();
  engine.testNote(channel, note, cmd);
}

// The kit browser plays an instrument without adding it: the emulator is given a copy of the song
// with the instrument in it, and gets the real song back when the browser closes.
let kitPreviewing = false;

function kitPreview(ins: KitInstrument): boolean {
  if (!engine) return false;
  if (engine.state.playing) { showStatus('Stop the song (F3) to hear kit instruments', true); return false; }
  ensureAudio();
  let temp = structuredClone(S.song);
  let n = addKitInstrument(temp, ins);
  if (typeof n === 'string') {
    // No room in this song: it can still be heard in an empty one
    temp = newSong();
    temp.hrParam = S.song.hrParam; temp.firstWave = S.song.firstWave;
    n = addKitInstrument(temp, ins);
    if (typeof n === 'string') return false;
  }
  engine.updateSong(temp);
  kitPreviewing = true;
  engine.testNote(S.trkCh, previewNote(ins), n + 1);
  return true;
}

function kitPreviewEnd() {
  if (!kitPreviewing) return;
  kitPreviewing = false;
  engine?.silence();
  engine?.updateSong(S.song);
}

function testChannel(): number {
  return S.focus === 'pattern' ? S.pattCh : S.trkCh;
}

// ---------------------------------------------------------------------------
// Rendering loop
// ---------------------------------------------------------------------------

let lastPlayKey = '';
function tick() {
  if (engine) {
    const st = engine.state;
    if (st.playing) {
      const key = st.channels.map(c => `${c.songPos},${c.pattNum},${c.pattPos}`).join(';');
      if (key !== lastPlayKey) {
        lastPlayKey = key;
        if (!engine.patternLoop) {
          for (let c = 0; c < 3; c++) {
            if (!S.follow[c]) continue;
            const n = st.channels[c].pattNum;
            if (n >= 1 && n <= 127) S.pattNum[c] = n;
          }
          E.clampCursors();
        }
        renderAll(st, { playOnly: true });
      }
      renderTime(st.frames);
    }
  }
  requestAnimationFrame(tick);
}

let autosaveTimer = 0;
function onStateChanged(songChanged: boolean) {
  if (songChanged) {
    engine?.updateSong(S.song);
    syncGlobals();
    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(autosave, 800);
  }
  retargetLoop();
  renderAll(engine?.state ?? null);
}

/**
 * While a pattern loops, what you hear is the pattern shown in the looping column: showing a
 * different pattern there restarts the loop on it at once. An empty pattern is silent until it
 * gets its first row.
 */
function retargetLoop() {
  if (!engine?.patternLoop || !engine.state.playing) return;
  const c = engine.loopChannel, n = S.pattNum[c];
  const empty = !S.song.patterns[n - 1].length;
  if (n === engine.patternLoop && empty === engine.loopSilent) return;
  engine.playPattern(n, c, empty);
  showStatus(empty
    ? `Pattern ${hex2(n)} is empty; the loop continues when you show a pattern with notes`
    : `Looping pattern ${hex2(n)} on channel ${c + 1}. Edits are heard live; F3 stops.`);
}

function syncGlobals() {
  syncExampleLock();
  const hr = $<HTMLInputElement>('in-hr'), fw = $<HTMLInputElement>('in-fw'), name = $<HTMLInputElement>('in-name');
  if (document.activeElement !== name) name.value = S.fileName;
  if (document.activeElement !== hr) hr.value = hex2(S.song.hrParam);
  if (document.activeElement !== fw) fw.value = hex2(S.song.firstWave);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const STORE_KEY = 'nt2studio.song';
const RECENT_KEY = 'nt2studio.recent';
const MAX_RECENT = 12;

interface StoredSong { name: string; data: string; time?: number; example?: string; copy?: boolean }

/**
 * Set while the song in the editor is one of the bundled examples ("title by author"): another
 * musician's tune, to study and play with, but not to save or export. It stays set through
 * edits, the autosave and Recent, and ends when another song is opened or a new one started.
 *
 * Some authors allow their tunes to be changed and saved (`exampleCopy`). Those can be saved and
 * exported, but a save is always a copy in a file of the user's choosing; from then on the song
 * is that file and no longer the example.
 */
let exampleOf = '';
let exampleCopy = false;
const exampleLocked = () => !!exampleOf && !exampleCopy;
const EXAMPLE_SAVE_TIP = 'This is an example tune by another musician: it can be played and changed, but not saved or exported';

function refuseForExample(what: string): boolean {
  if (!exampleLocked()) return false;
  showStatus(`${exampleOf} is an example tune: it can be played and changed here, but not ${what}. Use the Kit to take its instruments into a song of your own.`, true);
  return true;
}

function syncExampleLock() {
  const save = $<HTMLButtonElement>('btn-save'), exp = $<HTMLButtonElement>('btn-export');
  for (const b of [save, exp]) {
    if (!b.dataset.tip) b.dataset.tip = b.title;
    b.disabled = exampleLocked();
    b.title = exampleLocked() ? EXAMPLE_SAVE_TIP : b.dataset.tip;
  }
  if (exampleOf && exampleCopy) save.title = `Save a copy of ${exampleOf} to a file of your own (Ctrl+S)`;
}

const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin);
};
const fromBase64 = (data: string) => Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
const EMPTY_SONG_DATA = toBase64(saveSongFile(newSong()));

// File System Access API (Chrome, Edge): lets Save write back to the opened file
interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
}
const fsApi = window as unknown as {
  showOpenFilePicker?: (options?: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (options?: unknown) => Promise<FileHandle>;
};
let fileHandle: FileHandle | null = null;

// The bar length is a display setting the song format has no room for, so it is remembered
// per song name in this browser, and guessed from the patterns for a song seen for the first time.
const BARS_KEY = 'nt2studio.bars';

function readBars(): Record<string, number> {
  try {
    const m = JSON.parse(localStorage.getItem(BARS_KEY) ?? '{}') as Record<string, number>;
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function storeBar() {
  try {
    const m = readBars();
    m[S.fileName] = S.barFrames;
    localStorage.setItem(BARS_KEY, JSON.stringify(m));
  } catch { /* storage may be unavailable */ }
}

/** Shortest pattern that is at least a couple of beats long, halved until it is a plausible single bar. */
function guessBar(song: Song): number {
  let best = 0;
  for (const rows of song.patterns) {
    let total = 0, dur = 0;
    for (const r of rows) {
      if (r.dur) dur = r.dur;
      total += dur;
    }
    if (total >= 48 && (!best || total < best)) best = total;
  }
  if (!best) return 96;
  while (best > 200 && best % 2 === 0) best /= 2;
  return best;
}

/** Set the bar length for the current song: the remembered one, else a guess. */
function applyBarForSong() {
  const known = readBars()[S.fileName];
  S.barFrames = known >= 12 && known <= 999 ? known : guessBar(S.song);
  const el = document.getElementById('in-bar') as HTMLInputElement | null;
  if (el) el.value = String(S.barFrames);
}

function autosave() {
  try {
    const stored: StoredSong = { name: S.fileName, data: toBase64(saveSongFile(S.song)) };
    if (exampleOf) { stored.example = exampleOf; stored.copy = exampleCopy; }
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch { /* storage may be unavailable */ }
}

function restoreAutosave(): boolean {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const { name, data, example, copy } = JSON.parse(raw) as StoredSong;
    E.replaceSong(loadSongFile(fromBase64(data)), name);
    exampleOf = example ?? '';
    exampleCopy = !!example && !!copy;
    return true;
  } catch {
    return false;
  }
}

function readRecent(): StoredSong[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as StoredSong[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Keep a copy of the current song before it is replaced, so New / Open / Examples never lose work. */
function keepInRecent(): boolean {
  try {
    const data = toBase64(saveSongFile(S.song));
    if (data === EMPTY_SONG_DATA) return false;
    const list = readRecent().filter(r => !(r.name === S.fileName && r.data === data));
    const entry: StoredSong = { name: S.fileName, data, time: Date.now() };
    if (exampleOf) { entry.example = exampleOf; entry.copy = exampleCopy; }
    list.unshift(entry);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    return true;
  } catch {
    return false;
  }
}

/** Replace the song in the editor. Returns true if the previous song was kept under Recent. */
function setSong(song: Song, name: string, handle: FileHandle | null = null): boolean {
  const kept = keepInRecent();
  exampleOf = ''; // whoever loads an example sets it again
  exampleCopy = false;
  engine?.stop();
  E.replaceSong(song, name);
  applyBarForSong();
  fileHandle = handle;
  engine?.setSong(song);
  syncGlobals();
  renderAll(null);
  renderTime(0);
  autosave();
  return kept;
}

const keptNote = (kept: boolean) => (kept ? ' The previous song is kept under Recent.' : '');

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chooseFromD64(image: Uint8Array, title: string) {
  const songs = d64Directory(image)
    .map(entry => ({ entry, data: d64ReadFile(image, entry) }))
    .filter(f => isSongFile(f.data));
  if (!songs.length) return showStatus('No NinjaTracker 2 songs found on this disk image', true);
  const dlg = $<HTMLDialogElement>('dlg-files');
  $('dlg-files-title').textContent = title;
  const list = $('dlg-files-list');
  list.innerHTML = '';
  for (const f of songs) {
    const b = document.createElement('button');
    b.textContent = `${f.entry.name.padEnd(17)} ${f.entry.blocks} blocks`;
    b.onclick = () => {
      dlg.close();
      try {
        const kept = setSong(loadSongFile(f.data), f.entry.name.toLowerCase());
        showStatus(`Loaded ${f.entry.name}.${keptNote(kept)}`);
      } catch (err) { showStatus((err as Error).message, true); }
    };
    list.appendChild(b);
  }
  dlg.showModal();
}

function openRecent() {
  const recent = readRecent();
  if (!recent.length) return showStatus('No recent songs yet. Songs are kept here whenever New, Open or Examples replaces them.');
  const dlg = $<HTMLDialogElement>('dlg-files');
  $('dlg-files-title').textContent = 'Recent songs (kept in this browser)';
  const list = $('dlg-files-list');
  list.innerHTML = '';
  for (const r of recent) {
    const b = document.createElement('button');
    const when = r.time ? new Date(r.time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
    b.textContent = `${r.name.padEnd(24)} ${when}`;
    b.onclick = () => {
      dlg.close();
      try {
        setSong(loadSongFile(fromBase64(r.data)), r.name);
        if (r.example) { exampleOf = r.example; exampleCopy = !!r.copy; autosave(); syncGlobals(); }
        showStatus(`Restored ${r.name} from Recent`);
      } catch (err) { showStatus((err as Error).message, true); }
    };
    list.appendChild(b);
  }
  dlg.showModal();
}

function openBytes(bytes: Uint8Array, name: string, handle: FileHandle | null = null) {
  if (isD64(bytes)) return chooseFromD64(bytes, `Songs on ${name}`);
  if (!isSongFile(bytes)) {
    // Not a project file: try it as a packed NinjaTracker 2 tune (.sid, packed .prg, gamemusic data)
    try {
      const res = importPacked(bytes, name);
      const kept = setSong(res.song, res.name);
      // An import has no project file yet, so it counts as unsaved; Save will ask where to put it
      S.dirty = true;
      if (res.author) $<HTMLInputElement>('ex-author').value = res.author;
      // Play it on the chip model the file was made for
      if (res.model) {
        $<HTMLSelectElement>('sel-model').value = res.model;
        engine?.setModel(res.model);
      }
      renderAll(null);
      showStatus(`Imported ${name}: ${res.report.join('; ')}. Command names are not stored in packed tunes.${keptNote(kept)}`);
    } catch (err) { showStatus((err as Error).message, true); }
    return;
  }
  try {
    const kept = setSong(loadSongFile(bytes), name.replace(/\.[^.]+$/, ''), handle);
    showStatus(`Loaded ${name}.${keptNote(kept)}`);
  } catch (err) { showStatus((err as Error).message, true); }
}

async function openFile() {
  if (fsApi.showOpenFilePicker) {
    try {
      const [handle] = await fsApi.showOpenFilePicker();
      const file = await handle.getFile();
      openBytes(new Uint8Array(await file.arrayBuffer()), file.name, handle);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') showStatus(`Could not open the file: ${(err as Error).message}`, true);
    }
    return;
  }
  const input = $<HTMLInputElement>('file-input');
  input.value = '';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  };
  input.click();
}

/** Save writes back to the file the song was opened from or last saved to; Save As picks a new one. */
async function saveSong(saveAs = false) {
  if (refuseForExample('saved')) return;
  const bytes = saveSongFile(S.song);
  // An example that may be saved goes to a file of the user's own, under a name that says it is a copy
  const copyOf = exampleOf;
  const saveName = copyOf && !/-copy$/.test(S.fileName) ? `${S.fileName}-copy` : S.fileName;
  try {
    if ((saveAs || !fileHandle || copyOf) && fsApi.showSaveFilePicker) {
      fileHandle = await fsApi.showSaveFilePicker({
        suggestedName: `${saveName}.nt2`,
        types: [{ description: 'NinjaTracker 2 song', accept: { 'application/octet-stream': ['.nt2'] } }],
      });
    }
    if (fileHandle) {
      const w = await fileHandle.createWritable();
      await w.write(bytes as BlobPart);
      await w.close();
      S.fileName = fileHandle.name.replace(/\.[^.]+$/, '');
      storeBar();
      showStatus(copyOf ? `Saved a copy of ${copyOf} to ${fileHandle.name}` : `Saved to ${fileHandle.name}`);
    } else {
      S.fileName = saveName;
      download(bytes, `${S.fileName}.nt2`);
      showStatus(`Downloaded ${S.fileName}.nt2 (this browser cannot save back to a file)`);
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') showStatus(`Could not save: ${(err as Error).message}`, true);
    return;
  }
  // The saved copy is the user's own song from here on
  exampleOf = '';
  exampleCopy = false;
  S.dirty = false;
  syncGlobals();
  autosave();
  renderAll(engine?.state ?? null);
}

// ---------------------------------------------------------------------------
// Export dialog
// ---------------------------------------------------------------------------

const ZP_ERROR = 'Zeropage address must be between 02 and FE';
const zpValid = (zp: number) => zp >= 2 && zp <= 0xfe;

function exportParams() {
  const format = $<HTMLSelectElement>('ex-format').value;
  const addr = parseInt($<HTMLInputElement>('ex-addr').value, 16);
  const zp = parseInt($<HTMLInputElement>('ex-zp').value, 16);
  if (format !== '4k' && !(addr >= 0x0200 && addr <= 0xffff)) throw new Error('Start address must be between 0200 and FFFF');
  if (format !== 'game' && format !== '4k' && !zpValid(zp)) throw new Error(ZP_ERROR);
  return { format, addr, zp };
}

function buildExport(): { bytes: Uint8Array; ext: string; info: string; x4k?: Export4k } {
  const { format, addr, zp } = exportParams();
  if (format === '4k') {
    // A 4k export without slide, vibrato or the long player uses no zeropage: the field is then ignored
    const x = export4k(S.song, { zp: zpValid(zp) ? zp : 2, name: S.fileName });
    if (x.zpBytes && !zpValid(zp)) throw new Error(ZP_ERROR);
    const playerLine = x.player === 'short'
      ? `Player: short (the tune fits its ${MAX_4K_ROWS} rows)`
      : `Player: long (more than ${MAX_4K_ROWS} rows), pattern addresses in zeropage pointers`;
    const on = Object.entries(x.features).filter(e => e[1]).map(e => e[0]);
    const off = Object.entries(x.features).filter(e => !e[1]).map(e => e[0]);
    const more = scanUsage(S.song).lastSong > 0 ? '\nOnly subtune 00 is exported' : '';
    return {
      bytes: new TextEncoder().encode(x.source),
      ext: 'asm',
      x4k: x,
      info: `${x.patterns} patterns, ${x.rows} rows, ${x.commands} commands, ${x.freqEntries} of 84 frequencies kept\n` +
        (x.droppedCommands || x.droppedRows ? `Dropped as unused: ${x.droppedCommands} commands, ${x.droppedRows} table rows\n` : '') +
        `${playerLine}\n` +
        `Player ${x.codeBytes} bytes, data ${x.dataBytes} bytes, total ${x.totalBytes} bytes before crunching\n` +
        `Player parts kept: ${on.join(', ') || 'basics only'}${off.length ? '; left out: ' + off.join(', ') : ''}\n` +
        x.warnings.map(w => `Warning: ${w}\n`).join('') +
        `Patterns: ${x.layout === 'stream' ? 'note stream with command prefixes' : `columns (${x.layoutReason})`}\n` +
        `JSR nt_init once${x.needsInit ? '' : ' (does nothing for this tune)'}, then JSR nt_play once per frame${x.usesZeropage ? `, zeropage $${hex2(zp)}-$${hex2(zp + x.zpBytes - 1)}` : ', no zeropage used'}${more}\n` +
        'Saving first plays it against the normal export and compares every SID write',
    };
  }
  const u = scanUsage(S.song);
  for (let s = 0; s <= u.lastSong; s++) {
    S.song.tracks[s].forEach((t, c) => {
      const p = t.length ? trackProblem(t) : 'is empty';
      if (p) throw new Error(`Subtune ${hex2(s)} track ${c + 1}: ${p}`);
    });
  }
  const summary = `${u.lastSong + 1} subtune(s), ${u.lastPatt + 1} patterns, ${u.lastLegatoCmd} commands`;
  if (format === 'game') {
    const g = packGamemusic(S.song, addr);
    const withAddr = $<HTMLInputElement>('ex-loadaddr').checked;
    return {
      bytes: withAddr ? withLoadAddress(g.bytes, addr) : g.bytes,
      ext: 'bin',
      info: `${summary}\nMusic data $${hex4(g.stats.start)}-$${hex4(g.stats.end - 1)}, ${g.stats.totalBytes} bytes\n` +
        `Use with nt2play.s: LDA #<$${hex4(addr)}, LDX #>$${hex4(addr)}, JSR nt_newmusic`,
    };
  }
  const n = packNormal(S.song, addr, zp);
  const info = `${summary}\nPlayer ${n.stats.playerBytes} bytes, music ${n.stats.dataBytes} bytes, total $${hex4(n.stats.start)}-$${hex4(n.stats.end - 1)}\n` +
    `Init $${hex4(addr)} (A = subtune), play $${hex4(addr + 3)} once per frame, zeropage $${hex2(zp)}-$${hex2(zp + 1)}`;
  if (format === 'prg') return { bytes: withLoadAddress(n.bytes, addr), ext: 'prg', info };
  const sid = makeSid(n.bytes, addr, u.lastSong + 1, {
    name: $<HTMLInputElement>('ex-title').value,
    author: $<HTMLInputElement>('ex-author').value,
    released: $<HTMLInputElement>('ex-released').value,
    model: $<HTMLSelectElement>('sel-model').value as '6581' | '8580',
    ntsc: false,
  });
  return { bytes: sid, ext: 'sid', info };
}

function refreshExport() {
  const format = $<HTMLSelectElement>('ex-format').value;
  document.querySelectorAll<HTMLElement>('.ex-sid').forEach(el => el.classList.toggle('hidden', format !== 'sid'));
  document.querySelectorAll<HTMLElement>('.ex-normal').forEach(el => el.classList.toggle('hidden', format === 'game'));
  document.querySelectorAll<HTMLElement>('.ex-addr').forEach(el => el.classList.toggle('hidden', format === '4k'));
  document.querySelectorAll<HTMLElement>('.ex-game').forEach(el => el.classList.toggle('hidden', format !== 'game'));
  const info = $('ex-info');
  $('ex-zp-label').textContent = format === '4k' ? 'Zeropage' : 'Zeropage (2 bytes)';
  try {
    const out = buildExport();
    if (out.x4k) $('ex-zp-label').textContent = out.x4k.zpBytes ? `Zeropage (${out.x4k.zpBytes} bytes)` : 'Zeropage (not used)';
    info.textContent = out.info;
    info.classList.remove('err');
  } catch (err) {
    info.textContent = (err as Error).message;
    info.classList.add('err');
  }
}

function openExport() {
  if (refuseForExample('exported')) return;
  const title = $<HTMLInputElement>('ex-title');
  if (!title.value) title.value = S.fileName;
  refreshExport();
  $<HTMLDialogElement>('dlg-export').showModal();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const PT_KEYS = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM',
  'KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU',
  'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP'];
const DMC_KEYS = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ',
  'KeyK', 'KeyO', 'KeyL', 'KeyP'];

function hexDigit(e: KeyboardEvent): number {
  if (/^[0-9a-fA-F]$/.test(e.key)) return parseInt(e.key, 16);
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  return m && !e.shiftKey ? parseInt(m[1], 10) : -1;
}

function setOctave(o: number) {
  S.octave = o < 1 ? 7 : o > 7 ? 1 : o;
  E.notify();
}

function storeSideMode() {
  try { localStorage.setItem('nt2studio.sideMode', S.sideMode); } catch { /* storage unavailable */ }
}

/** Switch the right-hand side between the instrument editor and the tables with the command list. */
function setSideMode(mode: 'inst' | 'classic') {
  S.sideMode = mode;
  storeSideMode();
  // Choosing what the sounds column shows also brings it back when it is hidden
  setFolded('side', false);
  if (mode === 'inst' && (S.focus === 'tables' || S.focus === 'commands')) S.focus = 'inst';
  if (mode === 'classic' && S.focus === 'inst') S.focus = 'commands';
  E.notify();
}

/** Drag the divider inside the instrument panel to resize the list of instruments; the width is remembered. */
function wireListSplit() {
  const split = $('inst-split'), list = $('inst-list');
  const KEY = 'nt2studio.instListWidth';
  const apply = (w: number) => { list.style.width = w ? `${w}px` : ''; };
  try { apply(parseInt(localStorage.getItem(KEY) ?? '', 10) || 0); } catch { /* storage unavailable */ }
  let width = 0;
  const onMove = (e: MouseEvent) => {
    const panel = list.parentElement!.getBoundingClientRect();
    // Keep room for a name in the list and for the controls beside it
    width = Math.round(Math.max(80, Math.min(panel.width - 260, e.clientX - panel.left)));
    apply(width);
    renderAll(engine?.state ?? null);
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    split.classList.remove('drag');
    try { if (width) localStorage.setItem(KEY, String(width)); } catch { /* storage unavailable */ }
  };
  split.addEventListener('mousedown', e => {
    e.preventDefault();
    width = 0;
    split.classList.add('drag');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
  split.addEventListener('dblclick', () => {
    apply(0);
    try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
    renderAll(engine?.state ?? null);
  });
}

/** Fold a column down to its title strip. The keyboard moves to a panel that is still showing. */
function foldPanel(g: Fold, panel?: Panel) {
  // On a strip the same button brings the column back, with the keyboard in it: in the panel the
  // button is on (the sounds column has two with the tables showing)
  if (hiddenNow[g]) {
    setFolded(g, false);
    S.focus = g !== 'side' ? g : panel && foldOf(panel) === 'side' ? panel : S.sideMode === 'inst' ? 'inst' : 'commands';
    S.sel = null;
    E.notify();
    return;
  }
  const open = FOLDS.filter(f => !folded[f]);
  if (folded[g] || open.length === 1) return;
  setFolded(g, true);
  focusOpenPanel();
  E.notify();
}

/** If the keyboard is in a column that is folded away, move it to one that shows (Patterns first). */
function focusOpenPanel() {
  if (!folded[foldOf(S.focus)]) return;
  const to = (['pattern', 'tracks', 'side'] as Fold[]).find(g => !folded[g]) ?? 'pattern';
  S.focus = to === 'side' ? (S.sideMode === 'inst' ? 'inst' : 'commands') : to;
  S.sel = null;
}

function setFocus(p: Panel) {
  // In instrument mode the command list is the instrument panel, and a table means leaving the mode
  if (S.sideMode === 'inst' && p === 'commands') p = 'inst';
  if (S.sideMode === 'inst' && p === 'tables') { S.sideMode = 'classic'; storeSideMode(); }
  S.focus = p;
  S.sel = null;
  E.notify();
}

/** Move a row cursor; with Shift the range between anchor and cursor becomes the selection. */
function moveRow(delta: number, shift: boolean, toEdge = false) {
  let idx: number, rows: number[], max: number;
  if (S.focus === 'tracks') { idx = S.trkCh; rows = S.trkRow; max = Math.min(E.curTracks()[idx].length, MAX_SONGLEN - 1); }
  else if (S.focus === 'pattern') { idx = S.pattCh; rows = S.pattRow; max = Math.min(E.curPattern().length, MAX_PATTLEN - 1); }
  else if (S.focus === 'tables') { idx = S.tblNum; rows = S.tblRow; max = Math.min(S.song.tables[idx].left.length, MAX_TBLLEN - 1); }
  else {
    S.cmdNum = Math.max(0, Math.min(MAX_CMD - 1, toEdge ? (delta < 0 ? 0 : MAX_CMD - 1) : S.cmdNum + delta));
    S.namePos = 0;
    return E.notify();
  }
  if (shift) {
    if (!S.sel || S.sel.panel !== S.focus || S.sel.idx !== idx) S.sel = { panel: S.focus, idx, anchor: rows[idx] };
  } else S.sel = null;
  rows[idx] = Math.max(0, Math.min(max, toEdge ? (delta < 0 ? 0 : max) : rows[idx] + delta));
  if (S.focus === 'tracks') E.syncPatternsFromTracks(idx);
  E.notify();
}

function moveCol(delta: number) {
  S.sel = null;
  if (S.focus === 'tracks') {
    const n = S.trkCh * 2 + S.trkNib + delta;
    const w = (n + 6) % 6;
    S.trkCh = w >> 1;
    S.trkNib = w & 1;
  } else if (S.focus === 'pattern') {
    const n = (S.pattCh * 5 + S.pattCol + delta + 15) % 15;
    S.pattCh = Math.floor(n / 5);
    S.pattCol = n % 5;
  } else if (S.focus === 'tables') {
    const n = (S.tblNum * 4 + S.tblCol + delta + 12) % 12;
    S.tblNum = n >> 2;
    S.tblCol = n & 3;
  } else if (S.cmdCol === CMD_NAME_COL) {
    const p = S.namePos + delta;
    if (p < 0) S.cmdCol = CMD_NAME_COL - 1;
    else if (p >= MAX_CMDNAMELEN) S.cmdCol = 0;
    else S.namePos = p;
  } else {
    S.cmdCol = (S.cmdCol + delta + CMD_NAME_COL + 1) % (CMD_NAME_COL + 1);
    S.namePos = delta < 0 ? MAX_CMDNAMELEN - 1 : 0;
  }
  E.notify();
}

function gotoCommand(n: number) {
  if (n < 1 || n > MAX_CMD) return;
  S.cmdNum = n - 1;
  S.cmdCol = 0;
  setFocus('commands');
}

function patternKey(e: KeyboardEvent): boolean {
  const c = S.pattCh, r = S.pattRow[c], rows = E.curPattern();
  const row = rows[r];
  if (e.shiftKey) {
    switch (e.code) {
      case 'KeyQ': E.patternTranspose(true); return true;
      case 'KeyA': E.patternTranspose(false); return true;
      case 'KeyL': E.patternToggleLegato(); return true;
      case 'KeyO': E.patternOptimize(); return true;
      case 'Space': if (S.pattCol === 0) { E.patternSetNote(KEYON); return true; } break;
      case 'Enter':
        if (S.pattCol >= 1 && S.pattCol <= 2) {
          // New command: first unused one
          const free = S.song.commands.findIndex(k => !(k.ad || k.sr || k.wave || k.pulse || k.filt || k.name));
          if (free >= 0) {
            E.edit(() => {
              const rr = E.curPattern();
              if (r === rr.length) rr.push({ note: KEYOFF, cmd: 0, dur: 0 });
              rr[r].cmd = free + 1;
            });
            gotoCommand(free + 1);
          }
          return true;
        }
        break;
    }
    return false;
  }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') { E.patternStepCmd(-1); return true; }
  if (e.code === 'Equal' || e.code === 'NumpadAdd') { E.patternStepCmd(1); return true; }
  if (e.code === 'Enter') {
    // Key repeat is ignored: a held key steps on by itself at the pattern's own pace
    if (e.repeat) return true;
    const frames = stepRow();
    heldStep = frames ? { frames } : null;
    return true;
  }
  if (S.pattCol === 0) {
    if (e.code === 'Space') {
      E.patternSetNote(KEYOFF);
      engine?.testKeyOff(c);
      return true;
    }
    if (S.keyMode === 1 && /^Digit[1-7]$/.test(e.code)) { setOctave(parseInt(e.code.slice(5), 10)); return true; }
    const idx = (S.keyMode === 0 ? PT_KEYS : DMC_KEYS).indexOf(e.code);
    if (idx < 0) return false;
    const note = Math.min(LASTNOTE, (S.octave * 12 + idx) * 2);
    if (E.patternSetNote(note)) {
      const cmd = E.commandAt(E.curPattern(), r) || S.testCmd;
      S.testCmd = cmd;
      testNote(note, cmd, c);
    }
    return true;
  }
  if (e.code === 'Space') { E.patternClearField(); return true; }
  if (S.pattCol <= 2) {
    const d = hexDigit(e);
    if (d < 0) return false;
    E.patternCmdHex(d);
    return true;
  }
  const d = hexDigit(e);
  if (d < 0 || d > 9) return false;
  E.patternDurDigit(d);
  return true;
}

/**
 * Enter in a pattern: play the row under the cursor on that channel and move down one row, so
 * repeated presses walk through the pattern by ear. After the last row it wraps to the top.
 * Returns the length of the played row in frames (0 if nothing was played).
 */
function stepRow(): number {
  const c = S.pattCh, rows = E.curPattern(), r = S.pattRow[c];
  if (!rows.length) { showStatus(`Pattern ${hex2(S.pattNum[c])} is empty`, true); return 0; }
  let frames = 0;
  if (r < rows.length && engine && !engine.state.playing) {
    ensureAudio();
    const row = rows[r];
    // A note uses the command in effect at that row; a key on/off only runs a command of its own
    const cmd = row.note >= 0x18 ? E.commandAt(rows, r) || S.testCmd : row.cmd;
    engine.testRow(c, row.note, cmd);
    // The row lasts for its own duration, or the one carried from above (or from the pattern before)
    frames = E.carriedDur(c);
    for (let i = 0; i <= r; i++) if (rows[i].dur) frames = rows[i].dur;
    if (!frames) frames = 6;
  }
  S.sel = null;
  S.pattRow[c] = r + 1 < rows.length ? r + 1 : 0;
  E.notify();
  return frames;
}

/**
 * While Enter is held, the next row is stepped when the current one has lasted its duration,
 * counted in emulated frames, so holding the key plays the pattern at its real speed.
 */
let heldStep: { frames: number } | null = null;

function heldStepFrame() {
  if (!heldStep) return;
  if (S.focus !== 'pattern' || engine?.state.playing) { heldStep = null; return; }
  if (--heldStep.frames > 0) return;
  const frames = stepRow();
  if (frames) heldStep.frames = frames; else heldStep = null;
}

/** Ctrl+Enter in a pattern: fill with the note above (note column) or go to the command (command column). */
function patternCtrlEnter() {
  const c = S.pattCh, row = E.curPattern()[S.pattRow[c]];
  if (S.pattCol === 0) E.patternFillFromAbove();
  else if (S.pattCol <= 2 && row) gotoCommand(row.cmd & 0x7f);
}

/** Set while Enter holds a note of the instrument editor: letting go of the key ends the note. */
let enterNote = false;
function endEnterNote() {
  if (!enterNote) return;
  enterNote = false;
  engine?.testKeyOff(S.trkCh);
}

function testCurrentCommand(cmdNumber: number) {
  S.testCmd = cmdNumber;
  testNote(S.octave * 12 * 2, cmdNumber, S.trkCh);
}

function panelKey(e: KeyboardEvent): boolean {
  if (S.focus === 'pattern') return patternKey(e);

  if (S.focus === 'inst') {
    if (e.code === 'Space') {
      if (e.shiftKey) testCurrentCommand(S.cmdNum + 1);
      else engine?.testKeyOff(S.trkCh);
      return true;
    }
    // Enter plays the instrument for as long as it is held, so the list can be walked and heard
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (!e.repeat) { testCurrentCommand(S.cmdNum + 1); enterNote = true; }
      return true;
    }
    if (e.shiftKey || e.repeat) return false;
    if (S.keyMode === 1 && /^Digit[1-7]$/.test(e.code)) { setOctave(parseInt(e.code.slice(5), 10)); return true; }
    // The piano keys try the instrument
    const idx = (S.keyMode === 0 ? PT_KEYS : DMC_KEYS).indexOf(e.code);
    if (idx < 0) return false;
    S.testCmd = S.cmdNum + 1;
    testNote(Math.min(LASTNOTE, (S.octave * 12 + idx) * 2), S.cmdNum + 1, S.trkCh);
    return true;
  }

  if (S.focus === 'tracks') {
    const c = S.trkCh, t = E.curTracks()[c], r = S.trkRow[c];
    if (e.code === 'Enter') {
      if (e.shiftKey) { if (E.trackNewPattern()) { S.pattCh = c; setFocus('pattern'); } }
      else if (r < t.length && t[r] >= 1 && t[r] < 0x80) {
        S.pattNum[c] = t[r];
        S.pattRow[c] = 0;
        S.pattCh = c;
        setFocus('pattern');
      }
      return true;
    }
    const d = hexDigit(e);
    if (d < 0 || e.shiftKey) return false;
    E.trackHex(d);
    return true;
  }

  if (S.focus === 'tables') {
    if (e.code === 'Space') {
      if (e.shiftKey) testCurrentCommand(S.cmdNum + 1);
      else engine?.testKeyOff(S.trkCh);
      return true;
    }
    if (e.code === 'Enter') { E.tableFollowJump(); return true; }
    const d = hexDigit(e);
    if (d < 0 || e.shiftKey) return false;
    E.tableHex(d);
    return true;
  }

  // Commands
  if (S.cmdCol === CMD_NAME_COL) {
    if (e.key === 'Backspace') { E.commandNameBackspace(); return true; }
    if (e.key.length === 1 && e.key >= ' ' && e.key <= '~' && !e.ctrlKey && !e.metaKey) { E.commandNameType(e.key); return true; }
    if (e.code === 'Enter') { moveRow(1, false); return true; }
    return false;
  }
  if (e.code === 'Space') {
    if (e.shiftKey) testCurrentCommand(S.cmdNum + 1);
    else engine?.testKeyOff(S.trkCh);
    return true;
  }
  if (e.code === 'Enter') {
    const t = E.commandTableColumn();
    if (t < 0) return true;
    if (e.shiftKey) { E.commandPointToTableEnd(t); setFocus('tables'); return true; }
    const ptr = [S.song.commands[S.cmdNum].wave, S.song.commands[S.cmdNum].pulse, S.song.commands[S.cmdNum].filt][t];
    if (ptr >= 1 && ptr - 1 <= S.song.tables[t].left.length) {
      S.tblNum = t;
      S.tblRow[t] = ptr - 1;
      S.tblCol = 0;
      setFocus('tables');
    }
    return true;
  }
  const d = hexDigit(e);
  if (d < 0 || e.shiftKey) return false;
  E.commandHex(d);
  return true;
}

function insertRow() {
  if (S.focus === 'inst') return;
  if (S.focus === 'tracks') E.trackInsert();
  else if (S.focus === 'pattern') E.patternInsert();
  else if (S.focus === 'tables') E.tableInsert();
  else E.commandInsert();
}

function deleteRow() {
  if (S.focus === 'inst') return;
  if (S.focus === 'tracks') E.trackDelete();
  else if (S.focus === 'pattern') E.patternDelete();
  else if (S.focus === 'tables') E.tableDelete();
  else E.commandDelete();
}

function onKeyDown(e: KeyboardEvent) {
  const target = e.target as HTMLElement;
  if (document.querySelector('dialog[open]')) return;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT') {
    if (e.key === 'Escape' || e.key === 'Enter') target.blur();
    // A number of the instrument editor takes no letters or spaces: there the letter piano keys and
    // Space still try the sound, so a value can be changed and heard without leaving the field
    if ((target as HTMLInputElement).type === 'number' && target.closest('#panel-inst') && S.focus === 'inst' &&
      !e.ctrlKey && !e.metaKey && !e.altKey && (e.code === 'Space' || /^Key[A-Z]$/.test(e.code))) {
      ensureAudio();
      panelKey(e);
      e.preventDefault();
      return;
    }
    // Sliders, tick boxes and lists have no undo of their own: Ctrl+Z is the editor's
    const typing = target.tagName === 'INPUT' && !['range', 'checkbox'].includes((target as HTMLInputElement).type);
    if (!typing && (e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      if (e.code === 'KeyY' || e.shiftKey) E.redo(); else E.undo();
      e.preventDefault();
    }
    return;
  }
  ensureAudio();
  const ctrl = e.ctrlKey || e.metaKey;
  const typingName = S.focus === 'commands' && S.cmdCol === CMD_NAME_COL;
  let handled = true;

  if (ctrl) {
    switch (e.code) {
      case 'KeyZ': if (e.shiftKey) E.redo(); else E.undo(); break;
      case 'KeyY': E.redo(); break;
      case 'KeyC': if (E.copy()) showStatus('Copied'); S.sel = null; E.notify(); break;
      case 'KeyX': E.cut(); break;
      case 'KeyV': E.paste(); break;
      case 'KeyS': void saveSong(e.shiftKey); break;
      case 'KeyO': void openFile(); break;
      // Fold away the column the keyboard is in (it moves on to one that shows)
      case 'KeyB': foldPanel(foldOf(S.focus)); break;
      case 'KeyD':
        if (S.focus === 'pattern') {
          const n = E.patternDuplicate();
          showStatus(n ? `Duplicated to pattern ${hex2(n)}` : 'Nothing to duplicate, or no free pattern', !n);
        }
        break;
      case 'Enter': case 'NumpadEnter':
        if (S.focus === 'pattern') patternCtrlEnter();
        else handled = false;
        break;
      case 'ArrowLeft': case 'ArrowRight': {
        const d = e.code === 'ArrowLeft' ? -1 : 1;
        if (S.focus === 'tracks') E.setSubtune(S.subtune + d);
        else if (S.focus === 'pattern') E.setPatternNumber(S.pattCh, S.pattNum[S.pattCh] + d);
        else handled = false;
        break;
      }
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      if (e.code !== 'KeyS' && e.code !== 'KeyO') holdFollow();
    }
    return;
  }
  if (e.altKey) return;

  switch (e.code) {
    case 'F1': play(); break;
    case 'F3': case 'Escape': stop(); break;
    case 'F4': S.keyMode = S.keyMode ? 0 : 1; E.notify(); showStatus(`Note entry: ${S.keyMode ? 'DMC' : 'ProTracker'} keys`); break;
    case 'F6': playFromCursor(); break;
    case 'F7': toggleFastForward(); break;
    case 'F9': playPattern(); break;
    case 'F8': openHelp(); break;
    case 'Tab': {
      // Tab goes round the panels that are showing
      const panels = (S.sideMode === 'inst' ? ['tracks', 'pattern', 'inst'] as Panel[] : PANELS).filter(p => !folded[foldOf(p)]);
      const i = panels.indexOf(S.focus);
      setFocus(panels[(i + (e.shiftKey ? panels.length - 1 : 1)) % panels.length]);
      break;
    }
    case 'ArrowUp': moveRow(-1, e.shiftKey); break;
    case 'ArrowDown': moveRow(1, e.shiftKey); break;
    case 'PageUp': moveRow(-16, e.shiftKey); break;
    case 'PageDown': moveRow(16, e.shiftKey); break;
    case 'Home': moveRow(-1, e.shiftKey, true); break;
    case 'End': moveRow(1, e.shiftKey, true); break;
    case 'ArrowLeft': moveCol(-1); break;
    case 'ArrowRight': moveCol(1); break;
    case 'Insert': insertRow(); break;
    case 'Delete': if (S.focus === 'inst') clearInstrument(showStatus); else deleteRow(); break;
    default: handled = false;
  }

  if (!handled && !typingName) {
    handled = true;
    if (e.shiftKey && /^Digit[1-8]$/.test(e.code)) {
      const n = parseInt(e.code.slice(5), 10);
      if (n <= 3) { S.trkCh = n - 1; setFocus('tracks'); }
      else if (n === 4) setFocus('pattern');
      else if (n <= 7) { S.tblNum = n - 5; setFocus('tables'); }
      else setFocus('commands');
    } else if (e.code === 'Backspace' && S.focus !== 'commands') deleteRow();
    else if (e.code === 'Comma' || e.code === 'BracketLeft') setOctave(S.octave - 1);
    else if (e.code === 'Period' || e.code === 'BracketRight') setOctave(S.octave + 1);
    else if (e.code === 'Slash' || e.code === 'NumpadDivide') engine?.silence();
    else handled = false;
  }
  if (!handled) handled = panelKey(e);
  if (handled) {
    e.preventDefault();
    if (!/^(F\d+|Escape|Tab)$/.test(e.code)) holdFollow();
  } else if (e.code === 'Space') e.preventDefault();
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

function onMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const panelEl = target.closest<HTMLElement>('.panel');
  if (!panelEl) return;
  ensureAudio();
  // Folding a column away is not working in it: the keyboard stays where it is
  if (target.closest('button[data-fold]')) return;
  if (target.closest('svg.tg')) { graphMouseDown(e); return; }
  const panel = panelEl.dataset.panel as Panel;
  if (panel === 'inst') {
    // The instrument panel handles its own controls; it only needs the keyboard focus
    if (S.focus !== 'inst') { S.focus = 'inst'; S.sel = null; E.notify(); }
    return;
  }
  const colEl = target.closest<HTMLElement>('.col');
  const idx = colEl?.dataset.i !== undefined ? parseInt(colEl.dataset.i, 10) : 0;
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'follow') {
    S.follow[idx] = !S.follow[idx];
    E.notify();
    return;
  }
  if (act === 'mute') {
    // Shift+click solos the channel, or brings the others back when it already is solo
    if (e.shiftKey) {
      const soloed = !S.mute[idx] && S.mute.every((m, c) => c === idx || m);
      S.mute = S.mute.map((_, c) => c !== idx && !soloed);
    } else S.mute[idx] = !S.mute[idx];
    applyMutes();
    E.notify();
    return;
  }
  if (act === 'pattprev' || act === 'pattnext') {
    S.focus = 'pattern';
    S.pattCh = idx;
    holdFollow();
    E.setPatternNumber(idx, S.pattNum[idx] + (act === 'pattprev' ? -1 : 1));
    return;
  }
  const rowEl = target.closest<HTMLElement>('.row');
  const cellEl = target.closest<HTMLElement>('[data-k]');
  S.focus = panel;
  const row = rowEl ? parseInt(rowEl.dataset.r!, 10) : -1;
  const col = cellEl ? parseInt(cellEl.dataset.k!, 10) : -1;
  const rows = panel === 'tracks' ? S.trkRow : panel === 'pattern' ? S.pattRow : panel === 'tables' ? S.tblRow : null;
  if (rows && row >= 0) {
    if (e.shiftKey) {
      if (!S.sel || S.sel.panel !== panel || S.sel.idx !== idx) S.sel = { panel, idx, anchor: rows[idx] };
    } else S.sel = null;
    rows[idx] = row;
  } else if (!e.shiftKey) S.sel = null;

  if (panel === 'tracks') {
    if (colEl) S.trkCh = idx;
    if (col >= 0) S.trkNib = col;
    E.syncPatternsFromTracks(idx);
  } else if (panel === 'pattern') {
    if (colEl) S.pattCh = idx;
    if (col >= 0) S.pattCol = col;
  } else if (panel === 'tables') {
    if (colEl) S.tblNum = idx;
    if (col >= 0) S.tblCol = col;
  } else {
    if (row >= 0) S.cmdNum = row;
    if (col >= 0) { S.cmdCol = col; S.namePos = 0; }
  }
  E.clampCursors();
  E.notify();
  holdFollow();
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function toggleFastForward() {
  if (!engine) return;
  engine.fastForward = !engine.fastForward;
  $('btn-ff').classList.toggle('on', engine.fastForward);
}

function openHelp() {
  const body = $('help-body');
  body.innerHTML = HELP_HTML;
  $<HTMLDialogElement>('dlg-help').showModal();
  body.scrollLeft = 0;
}
// The help is pages of two columns lying side by side. It always rests on a column edge: the mouse
// wheel and the arrow keys turn a whole page, and after the bar is dragged it settles on the
// nearest column.
/** Width of a help page and of one of its columns (two to a page, one in a narrow window), gap included. */
function helpSizes(body: HTMLElement): { page: number; col: number } {
  const cs = getComputedStyle(body);
  const page = body.clientWidth + (parseFloat(cs.columnGap) || 0);
  return { page, col: page / (parseInt(cs.columnCount, 10) || 1) };
}
function helpTurn(pages: number) {
  const body = $('help-body');
  const { page, col } = helpSizes(body);
  const max = body.scrollWidth - body.clientWidth;
  // From the column it rests on now, a whole page on
  const to = Math.round(body.scrollLeft / col) * col + pages * page;
  body.scrollTo({ left: Math.max(0, Math.min(max, to)), behavior: 'smooth' });
}
let helpWheeled = 0;
$('help-body').addEventListener('wheel', e => {
  const body = e.currentTarget as HTMLElement;
  // Ctrl+wheel is the browser's zoom
  if (e.ctrlKey || body.scrollWidth <= body.clientWidth) return;
  e.preventDefault();
  const d = e.deltaY || e.deltaX;
  if (!d) return;
  // One turn for one movement of the wheel or the touchpad, however long its events keep coming:
  // the next turn needs a pause first
  const now = performance.now(), paused = now - helpWheeled > 150;
  helpWheeled = now;
  if (paused) helpTurn(d > 0 ? 1 : -1);
}, { passive: false });
$('help-body').addEventListener('scrollend', () => {
  const body = $('help-body');
  const { col } = helpSizes(body);
  const max = body.scrollWidth - body.clientWidth;
  const to = Math.min(max, Math.round(body.scrollLeft / col) * col);
  if (Math.abs(to - body.scrollLeft) > 1) body.scrollTo({ left: to, behavior: 'smooth' });
});
$('dlg-help').addEventListener('keydown', e => {
  const dir = ['ArrowRight', 'PageDown', 'Space'].includes(e.code) ? 1 : ['ArrowLeft', 'PageUp'].includes(e.code) ? -1 : 0;
  if (!dir || (e.target as HTMLElement).tagName === 'BUTTON' && e.code === 'Space') return;
  helpTurn(dir);
  e.preventDefault();
});

function hexField(id: string, apply: (v: number) => void) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('change', () => {
    const v = parseInt(el.value, 16);
    if (v >= 0 && v <= 0xff) E.edit(() => apply(v));
    el.value = hex2(id === 'in-hr' ? S.song.hrParam : S.song.firstWave);
  });
}

function wireToolbar() {
  const on = (id: string, fn: () => void) => $(id).addEventListener('click', () => { ensureAudio(); fn(); ($(id) as HTMLElement).blur(); });
  on('btn-new', () => { const kept = setSong(newSong(), 'untitled'); showStatus(`New song.${keptNote(kept)}`); });
  on('btn-open', () => void openFile());
  on('btn-recent', openRecent);
  on('btn-pclear', () => { S.focus = 'pattern'; E.patternClear(); showStatus(`Cleared pattern ${hex2(S.pattNum[S.pattCh])} (Ctrl+Z to undo)`); });
  on('btn-pdup', () => {
    S.focus = 'pattern';
    const n = E.patternDuplicate();
    showStatus(n ? `Duplicated to pattern ${hex2(n)}` : 'Nothing to duplicate, or no free pattern', !n);
  });
  on('btn-clearmusic', () => { E.clearMusic(); showStatus('Cleared all patterns and tracks; tables and commands are kept (Ctrl+Z to undo)'); });
  on('btn-examples', () => void openExampleBrowser());
  on('btn-undo', () => E.undo());
  on('btn-redo', () => E.redo());
  on('btn-save', () => void saveSong(false));
  on('btn-export', openExport);
  on('btn-play', play);
  on('btn-playcursor', playFromCursor);
  on('btn-playpatt', playPattern);
  on('btn-stop', stop);
  on('btn-ff', toggleFastForward);
  on('btn-subprev', () => E.setSubtune(S.subtune - 1));
  on('btn-subnext', () => E.setSubtune(S.subtune + 1));
  on('btn-octprev', () => setOctave(S.octave - 1));
  on('btn-octnext', () => setOctave(S.octave + 1));
  on('btn-keymode', () => { S.keyMode = S.keyMode ? 0 : 1; E.notify(); });
  on('btn-help', openHelp);
  on('btn-mode-inst', () => setSideMode('inst'));
  on('btn-mode-classic', () => setSideMode('classic'));
  on('btn-kit', () => void openKit());
  document.querySelectorAll<HTMLButtonElement>('button[data-fold]').forEach(b => {
    b.addEventListener('click', () => { foldPanel(b.dataset.fold as Fold, b.closest<HTMLElement>('.panel')?.dataset.panel as Panel | undefined); b.blur(); });
  });
  // Bar length for the bar and beat lines: remembered per song
  const barEl = $<HTMLInputElement>('in-bar');
  barEl.value = String(S.barFrames);
  barEl.addEventListener('change', () => {
    const v = parseInt(barEl.value, 10);
    if (v >= 12 && v <= 999) {
      S.barFrames = v;
      storeBar();
      showStatus(`Bar length for ${S.fileName} set to ${v} frames`);
    }
    barEl.value = String(S.barFrames);
    renderAll(engine?.state ?? null);
  });
  $<HTMLSelectElement>('sel-model').addEventListener('change', ev => {
    engine?.setModel((ev.target as HTMLSelectElement).value as '6581' | '8580');
    (ev.target as HTMLElement).blur();
  });
  const nameEl = $<HTMLInputElement>('in-name');
  nameEl.addEventListener('change', () => {
    // Keep it usable as a file name
    const name = nameEl.value.replace(/[\/:*?"<>|]/g, '').trim() || 'untitled';
    S.fileName = name;
    storeBar();
    fileHandle = null; // a renamed song saves to a new file
    nameEl.value = name;
    const title = $<HTMLInputElement>('ex-title');
    title.value = '';
    autosave();
    renderAll(engine?.state ?? null);
    showStatus(`Song named ${name}`);
  });
  hexField('in-hr', v => { S.song.hrParam = v; });
  hexField('in-fw', v => { S.song.firstWave = v; });

  document.querySelectorAll<HTMLElement>('dialog [data-close]').forEach(b =>
    b.addEventListener('click', () => b.closest('dialog')!.close()));
  for (const id of ['ex-format', 'ex-addr', 'ex-zp', 'ex-loadaddr']) {
    $(id).addEventListener('input', refreshExport);
    $(id).addEventListener('change', refreshExport);
  }
  // Like Save: where the browser can write files, ask where to put the export; otherwise download it
  if (fsApi.showSaveFilePicker) $('ex-go').textContent = 'Save…';
  $('ex-go').addEventListener('click', async () => {
    try {
      const out = buildExport();
      let name = `${S.fileName}.${out.ext}`;
      let checked = '';
      if (out.x4k) {
        // The 4k export leaves things out; make sure this song still plays the same
        const v = verify4k(S.song, out.x4k);
        if (!v.ok) {
          const msg = `The 4k export does not play like the normal export: first difference in frame ${v.frame}.\n` +
            `Normal: ${v.normal}\n4k:     ${v.exported}`;
          $('ex-info').textContent = msg;
          $('ex-info').classList.add('err');
          if (!confirm(`${msg}\n\nSave it anyway?`)) return;
          checked = ', NOT identical to the normal export';
        } else checked = `, identical to the normal export for ${v.frames} frames${v.silentFrames ? ' apart from the frequency of a voice before its first note' : ''}`;
      }
      if (fsApi.showSaveFilePicker) {
        const handle = await fsApi.showSaveFilePicker({
          id: 'nt2-export',
          suggestedName: name,
          types: [{ description: `Exported tune (.${out.ext})`, accept: { 'application/octet-stream': [`.${out.ext}`] } }],
        });
        const w = await handle.createWritable();
        await w.write(out.bytes as BlobPart);
        await w.close();
        name = handle.name;
        showStatus(`Exported to ${name} (${out.bytes.length} bytes${checked})`);
      } else {
        download(out.bytes, name);
        showStatus(`Downloaded ${name} (${out.bytes.length} bytes${checked}; this browser cannot save to a chosen file)`);
      }
      $<HTMLDialogElement>('dlg-export').close();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // save dialog cancelled, keep the export dialog open
      refreshExport();
      showStatus((err as Error).message, true);
    }
  });
}

// ---------------------------------------------------------------------------

E.setListeners(onStateChanged, msg => showStatus(msg, true));
try { if (localStorage.getItem('nt2studio.sideMode') === 'classic') S.sideMode = 'classic'; } catch { /* storage unavailable */ }
wireToolbar();
wireMenus($('menus'));
wireListSplit();
wireInstruments({
  test: () => { ensureAudio(); testCurrentCommand(S.cmdNum + 1); },
  keyOff: () => engine?.testKeyOff(S.trkCh),
  status: showStatus,
});
wireExamples({
  base: import.meta.env.BASE_URL + 'examples/',
  disk: import.meta.env.BASE_URL + 'examples.d64',
  status: showStatus,
  load: (tune, bytes) => {
    try {
      const kept = setSong(loadSongFile(bytes), tune.file.split('/').pop()!.replace(/\.nt2$/i, ''));
      exampleOf = `${tune.title} by ${tune.author}`;
      exampleCopy = !!tune.copy;
      autosave();
      syncGlobals();
      // Keep the credit with the song for a later export, and play it on the chip it was made for
      $<HTMLInputElement>('ex-title').value = tune.title.slice(0, 31);
      $<HTMLInputElement>('ex-author').value = tune.author.slice(0, 31);
      $<HTMLInputElement>('ex-released').value = tune.released.slice(0, 31);
      if (tune.model === '6581' || tune.model === '8580') {
        $<HTMLSelectElement>('sel-model').value = tune.model;
        engine?.setModel(tune.model);
      }
      renderAll(null);
      showStatus(`Loaded ${tune.title} by ${tune.author}${tune.released ? ` (${tune.released})` : ''}.` +
        `${tune.check === 'close' ? ' It was made with a modified player, so it may sound slightly different here.' : ''}` +
        ` ${tune.copy ? 'It can be changed and saved as a copy.' : 'This example cannot be saved or exported.'}${keptNote(kept)}`);
    } catch (err) { showStatus((err as Error).message, true); }
  },
});
wireKit({
  url: import.meta.env.BASE_URL + 'kit/instruments.json',
  preview: kitPreview,
  previewOff: () => engine?.testKeyOff(S.trkCh),
  add: (ins, mus) => {
    let n = -1, why = '';
    E.edit(() => {
      const r = addKitInstrument(S.song, ins);
      if (typeof r === 'string') { why = r; return false; }
      n = r;
    });
    if (n < 0) { showStatus(`${ins.name} was not added: ${why}`, true); return 0; }
    kitPreviewing = false; // the edit already gave the emulator the real song
    S.cmdNum = n;
    E.notify();
    showStatus(`Added ${ins.name} (${mus.name}) as instrument ${hex2(n + 1)}: use command ${hex2(n + 1)} in a pattern. Ctrl+Z takes it out again.`);
    return n + 1;
  },
  closed: kitPreviewEnd,
});
document.addEventListener('keydown', onKeyDown);
// Releasing Enter (or leaving the window) ends held stepping
document.addEventListener('keyup', e => { if (e.code === 'Enter' || e.code === 'NumpadEnter') { heldStep = null; endEnterNote(); } });
window.addEventListener('blur', () => { heldStep = null; endEnterNote(); });
// Drop a song file or disk image anywhere on the window to open it
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
});
$('main').addEventListener('mousedown', onMouseDown);
window.addEventListener('resize', () => renderAll(engine?.state ?? null));
window.addEventListener('beforeunload', autosave);

// The app starts with the keyboard in Patterns: if that column was left folded, start in one that shows
focusOpenPanel();
const restored = restoreAutosave();
applyBarForSong();
E.syncPatternsFromTracks();
syncGlobals();
renderAll(null);
showStatus(restored ? `Restored ${S.fileName} from the last session. Loading sound...` : 'Loading sound...');
void initEngine();
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// The splash screen: what this is, its version and whose work is in it. Shown when the app opens,
// and again from the name in the toolbar.
// ---------------------------------------------------------------------------

declare const __APP_VERSION__: string;

function openSplash() {
  const dlg = $<HTMLDialogElement>('dlg-splash');
  $('splash-version').textContent = __APP_VERSION__;
  if (!dlg.open) dlg.showModal();
  // The browser would put the keyboard on Start and draw its focus ring round it: keep it on the
  // box itself, where Enter and Space still start
  dlg.focus();
}
{
  const dlg = $<HTMLDialogElement>('dlg-splash');
  // A click beside the box closes it too. Closing is the first click in the app, so sound can start
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', ensureAudio);
  dlg.addEventListener('keydown', e => {
    if (e.target === dlg && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) { dlg.close(); e.preventDefault(); }
  });
  // Without the keyboard staying on the name, or Space would open it again
  $('brand').addEventListener('click', () => { $('brand').blur(); openSplash(); });
  openSplash();
}
