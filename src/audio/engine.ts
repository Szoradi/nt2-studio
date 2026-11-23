// Editor playback engine: runs the NinjaTracker playroutine inside WebSid, one
// video frame at a time, and pokes song data / test notes into its memory.

import type { WebSid } from './websid.ts';
import { type Song, MAX_SONGLEN } from '../core/song.ts';
import { buildEditorSid, buildEditorImage, EDIT_DATA, EDIT_DATA_END, EDIT_LAYOUT } from '../core/packer.ts';

// Scratch area used to loop a single pattern: an extra song table entry (number 16) whose tracks
// live just past the song data, and pattern 7F borrowed as one bar of silence for the other channels.
const SCRATCH_SONG = 16;
const SCRATCH_TRACKS = EDIT_DATA_END;
const SILENT_PATTERN = 0x7f;
const SILENT_SLOT = EDIT_LAYOUT.vpatterns + (SILENT_PATTERN - 1) * 192;

export interface ChannelState { songPos: number; pattNum: number; pattPos: number }
export interface PlayState {
  playing: boolean;
  /** A single pattern is looping from a scratch track: track positions are meaningless. */
  loop: boolean;
  frames: number;
  channels: ChannelState[];
}

interface TestNote { note: number; cmd: number; phase: number }

const CH = [0, 7, 14];

export class Engine {
  private emu: WebSid;
  private sampleRate: number;
  private sym: Record<string, number> = {};
  private image: Uint8Array = new Uint8Array(0);
  private lens: number[][] = [];
  private loaded = false;
  private testNotes: (TestNote | null)[] = [null, null, null];
  private keyOffs = [false, false, false];
  /** Gate value to write on the next stopped frame (0 = none), per channel. */
  private gates = [0, 0, 0];
  private muted = [false, false, false];
  model: '6581' | '8580' = '8580';
  fastForward = false;
  /** Set while a single pattern is being looped (the pattern number), else 0. */
  patternLoop = 0;
  /** Channel the looped pattern plays on. */
  loopChannel = 0;
  /** The looped pattern was empty when the loop (re)started, so nothing is sounding. */
  loopSilent = false;
  private scratchActive = false;
  /** Called once per emulated frame while stopped, before that frame's test notes are applied. */
  onStoppedFrame: (() => void) | null = null;
  /** Loop mode for songs that use pattern 7F: the other channels play the pattern too, muted. */
  private muteOthers = false;
  state: PlayState = { playing: false, loop: false, frames: 0, channels: CH.map(() => ({ songPos: 0, pattNum: 0, pattPos: 0 })) };

  constructor(emu: WebSid, sampleRate: number) {
    this.emu = emu;
    this.sampleRate = sampleRate;
  }

  get outputRate(): number { return this.emu.sampleRate; }

  /** (Re)load everything: used for a new song and to reset the emulator. */
  setSong(song: Song) {
    const { sid, player, image } = buildEditorSid(song, this.model);
    this.emu.load(sid, this.sampleRate);
    this.emu.setModel(this.model);
    this.muted.forEach((m, v) => this.emu.enableVoice(v, !m));
    this.sym = player.symbols;
    this.image = image;
    this.lens = song.tracks.map(t => t.map(c => c.length));
    this.emu.write(this.sym.vinitsongnum + 1, 0xff);
    this.state.playing = false;
    this.state.loop = false;
    this.patternLoop = 0;
    this.scratchActive = false;
    this.muteOthers = false;
    this.testNotes = [null, null, null];
    this.loaded = true;
  }

  /** Push edits into the running emulator by writing only the bytes that changed. */
  updateSong(song: Song) {
    if (!this.loaded) return this.setSong(song);
    const next = buildEditorImage(song);
    const prev = this.image;
    for (let i = 0; i < next.length; i++) if (next[i] !== prev[i]) this.emu.write(EDIT_DATA + i, next[i]);
    this.image = next;
    this.lens = song.tracks.map(t => t.map(c => c.length));
    this.emu.write(this.sym.vhrparam + 1, song.hrParam);
    this.emu.write(this.sym.vfirstwave + 1, song.firstWave);
  }

  setModel(model: '6581' | '8580') {
    this.model = model;
    if (this.loaded) this.emu.setModel(model);
  }

  setMute(voice: number, muted: boolean) {
    this.muted[voice] = muted;
    if (!this.loaded) return;
    const placeholder = this.muteOthers && (voice !== this.loopChannel || this.loopSilent);
    this.emu.enableVoice(voice, !muted && !placeholder);
  }

  /**
   * Start a subtune, optionally from given track positions (one per channel) with the
   * transpose bytes (editor form, C0 = none) that are in effect at those positions.
   * `skip` frames are then run without sound, to begin in the middle of a pattern.
   */
  play(subtune: number, starts: number[] = [0, 0, 0], trans: number[] = [0xc0, 0xc0, 0xc0], skip = 0) {
    if (!this.loaded) return;
    this.restoreScratch();
    this.patternLoop = 0;
    this.state.loop = false;
    const s = this.sym, lens = this.lens[subtune];
    const e = EDIT_LAYOUT.vsongtbl + subtune * 5;
    const pos = [starts[0], lens[0] + starts[1], lens[0] + lens[1] + starts[2]];
    for (let c = 0; c < 3; c++) {
      this.emu.write(e + 2 + c, pos[c] & (MAX_SONGLEN - 1));
      this.emu.write(s.vchntrans + CH[c], ((trans[c] - 0x41) & 0xff) | 0x80);
      this.emu.write(s.vchngate + CH[c], 0xfe);
      this.emu.write(s.vchncmd + CH[c], 0x01);
    }
    this.emu.write(s.vinitsongnum + 1, subtune);
    this.testNotes = [null, null, null];
    this.state.playing = true;
    this.state.frames = 0;
    // The first frame only initialises the player, then run up to the requested position
    if (skip > 0) for (let i = 0; i <= skip; i++) this.emu.frame();
    this.state.frames = skip;
  }

  /**
   * Loop one pattern on one channel from its start; the other two channels stay silent. Edits are
   * heard live. With `silent` (an empty pattern) the loop keeps running but nothing sounds.
   */
  playPattern(pattern: number, channel: number, silent = false) {
    if (!this.loaded) return;
    this.restoreScratch();
    const s = this.sym, emu = this.emu;
    // Borrow pattern 7F as silence unless the song uses it (then the others play the same pattern, muted)
    const slotFree = this.image[SILENT_SLOT - EDIT_DATA] === 0;
    if (slotFree) {
      [0x0a, 0xc2, 0x00].forEach((b, i) => emu.write(SILENT_SLOT + i, b));
      this.scratchActive = true;
    } else {
      for (let v = 0; v < 3; v++) emu.enableVoice(v, v === channel && !silent && !this.muted[v]);
      this.scratchActive = true;
      this.muteOthers = true;
    }
    for (let c = 0; c < 3; c++) {
      const audible = c === channel && !silent;
      // Never point a channel at an empty pattern: the player would read past its end
      const patt = slotFree ? (audible ? pattern : SILENT_PATTERN) : (silent ? this.firstUsedPattern() : pattern);
      [patt, 0x00, c * 3].forEach((b, i) => emu.write(SCRATCH_TRACKS + c * 3 + i, b));
      emu.write(s.vchntrans + CH[c], 0xff);
      emu.write(s.vchngate + CH[c], 0xfe);
      emu.write(s.vchncmd + CH[c], 0x01);
    }
    const e = EDIT_LAYOUT.vsongtbl + SCRATCH_SONG * 5;
    [SCRATCH_TRACKS & 0xff, SCRATCH_TRACKS >> 8, 0, 3, 6].forEach((b, i) => emu.write(e + i, b));
    emu.write(s.vinitsongnum + 1, SCRATCH_SONG);
    this.testNotes = [null, null, null];
    this.patternLoop = pattern;
    this.loopChannel = channel;
    this.loopSilent = silent;
    this.state.loop = true;
    this.state.playing = true;
    this.state.frames = 0;
  }

  /** Number of any non-empty pattern (used only as a muted placeholder). */
  private firstUsedPattern(): number {
    for (let p = 0; p < 127; p++) if (this.image[EDIT_LAYOUT.vpatterns + p * 192 - EDIT_DATA] !== 0) return p + 1;
    return 1;
  }

  private restoreScratch() {
    if (!this.scratchActive) return;
    for (let i = 0; i < 3; i++) this.emu.write(SILENT_SLOT + i, this.image[SILENT_SLOT - EDIT_DATA + i]);
    this.muteOthers = false;
    this.muted.forEach((m, v) => this.emu.enableVoice(v, !m));
    this.scratchActive = false;
  }

  stop() {
    if (!this.loaded) return;
    this.restoreScratch();
    this.patternLoop = 0;
    this.state.loop = false;
    this.state.playing = false;
    for (const x of CH) this.emu.write(this.sym.vchngate + x, 0xfe);
    this.emu.write(this.sym.vinitsongnum + 1, 0xff);
  }

  /** Audition a note (pattern note value, i.e. note number * 2) with a command while stopped. */
  testNote(channel: number, note: number, cmd: number) {
    if (!this.loaded || this.state.playing) return;
    this.testNotes[channel] = { note: note >> 1, cmd, phase: 0 };
  }

  /**
   * Play one pattern row while stopped, the way the player would: a note with its command, or a
   * key on / key off with an optional command (which then only changes the sound).
   * `note` is the pattern note value (KEYON 4, KEYOFF 8, or note number * 2).
   */
  testRow(channel: number, note: number, cmd: number) {
    if (!this.loaded || this.state.playing) return;
    if (note >= 0x18) {
      if (cmd) this.testNotes[channel] = { note: note >> 1, cmd, phase: 0 };
      return;
    }
    this.gates[channel] = note === 0x04 ? 0xff : 0xfe;
    // A command on a gate row runs without a note: no hard restart, so go straight to the trigger
    if (cmd) this.testNotes[channel] = { note: note >> 1, cmd, phase: 2 };
  }

  testKeyOff(channel: number) {
    if (!this.loaded || this.state.playing) return;
    this.keyOffs[channel] = true;
  }

  silence() {
    if (!this.loaded) return;
    for (let c = 0; c < 3; c++) {
      this.emu.write(this.sym.vchngate + CH[c], 0xfe);
      this.emu.sidWrite(c * 7 + 6, 0x00);
    }
  }

  private stoppedFrame() {
    // Lets the editor time things to the emulated frames (held-Enter stepping)
    if (this.onStoppedFrame) this.onStoppedFrame();
    const s = this.sym, emu = this.emu;
    for (let c = 0; c < 3; c++) {
      const x = CH[c];
      // Keep the sequencer frozen: no pattern or track reads, tables keep running
      let counter = 0x10;
      emu.write(s.vchnpattpos + x, 0x01);
      emu.write(s.vchnnewnote + x, 0xff);
      if (this.keyOffs[c]) {
        emu.write(s.vchngate + x, 0xfe);
        this.keyOffs[c] = false;
      }
      if (this.gates[c]) {
        emu.write(s.vchngate + x, this.gates[c]);
        this.gates[c] = 0;
      }
      const t = this.testNotes[c];
      if (t) {
        if (t.phase === 0 && !(t.cmd & 0x80)) {
          // Hard restart, like the player does two frames before a note
          emu.write(s.vchngate + x, 0xfe);
          emu.sidWrite(c * 7 + 5, 0xfe);
          emu.sidWrite(c * 7 + 6, emu.read(s.vhrparam + 1));
          t.phase = 1;
        } else if (t.phase === 1) t.phase = 2;
        else {
          emu.write(s.vchncmd + x, t.cmd);
          emu.write(s.vchntrans + x, 0xff);
          emu.write(s.vchnnewnote + x, t.note);
          counter = 0x01;
          this.testNotes[c] = null;
        }
      }
      emu.write(s.vchncounter + x, counter);
    }
  }

  /** Emulate one frame and return its interleaved stereo samples. */
  frame(): Int16Array {
    const runs = this.state.playing && this.fastForward ? 4 : 1;
    let out!: Int16Array;
    for (let i = 0; i < runs; i++) {
      if (!this.state.playing) this.stoppedFrame();
      out = this.emu.frame();
      if (this.state.playing) this.state.frames++;
    }
    const s = this.sym;
    for (let c = 0; c < 3; c++) {
      const st = this.state.channels[c], x = CH[c];
      st.songPos = this.emu.read(s.vchnsongpos + x);
      st.pattNum = this.emu.read(s.vchnpattnum + x);
      st.pattPos = this.emu.read(s.vchnpattpos + x);
    }
    return out;
  }
}
