// "4k intro" export: one subtune as assembler source with a player cut down to what the song uses.
//
// Differences from the normal packed tune:
// - Patterns are one note stream with command prefix bytes plus a duration column, indexed by one
//   8-bit offset, so there are no pattern pointers and no zeropage indirection. Tunes the stream
//   cannot hold (legato, more than 31 commands) get note, command and duration columns instead.
// - Player code for unused features (filter, pulse, slide, vibrato, wave delay, legato,
//   transpose) is left out; unused patterns, commands and table rows are dropped.
// - The frequency table is stored as one octave that nt_init halves down into the lower ones,
//   or in full with unused entries zero when that is smaller.
// - The player variables are assembled in their start state, so nt_init never has to reset them.
//
// The player is written in the DASM subset of asm6502.ts so it can be assembled and run here;
// toKickAss() rewrites it to KickAssembler syntax.

import { assemble } from './asm6502.ts';
import {
  type Song, type Row, type Command, type Table, packTracks, trackProblem, convertWaveLeft, convertPulseRight,
  FIRSTNOTE, KEYOFF, KEYON, TBL_WAVE, hex2,
} from './song.ts';

export const MAX_4K_ROWS = 255;

export interface Features {
  filter: boolean; pulse: boolean; slide: boolean; vibrato: boolean;
  wavedelay: boolean; legato: boolean; transpose: boolean;
}
const FEATURE_TEXT: Record<keyof Features, string> = {
  filter: 'filter', pulse: 'pulse', slide: 'slide', vibrato: 'vibrato',
  wavedelay: 'wave delay', legato: 'legato', transpose: 'transpose',
};

export interface Export4kOptions {
  subtune?: number;
  /** Two zeropage bytes; only used when the song has slides or vibrato. */
  zp?: number;
  name?: string;
  /** Test hook: keep the code for every feature even if the song does not use it. */
  allFeatures?: boolean;
  /** Test hook: 'columns' forces the three-column pattern layout. */
  layout?: 'auto' | 'columns';
  /** Test hook: 'full' forces the complete frequency table, 'seed' the generated one where possible. */
  freqTable?: 'auto' | 'full' | 'seed';
}

export interface Export4k {
  /** KickAssembler source. */
  source: string;
  /** The same thing in the DASM subset the built-in assembler reads. */
  dasm: string;
  features: Features;
  usesZeropage: boolean;
  /** stream: commands are prefix bytes in the note stream; columns: note, command and duration columns. */
  layout: 'stream' | 'columns';
  /** Why the column layout was used, when it was. */
  layoutReason: string;
  /** True when nt_init has work to do (it always exists; otherwise it is the address of an RTS). */
  needsInit: boolean;
  /** Entries nt_init corrects after halving, or -1 when the full table is stored. */
  freqFixups: number;
  rows: number;
  patterns: number;
  commands: number;
  droppedCommands: number;
  droppedRows: number;
  freqEntries: number;
  /** Things the export cannot reproduce; the tune may differ from the editor. */
  warnings: string[];
  codeBytes: number;
  dataBytes: number;
  totalBytes: number;
}

export const FREQ = [
  0x022d, 0x024e, 0x0271, 0x0296, 0x02be, 0x02e8, 0x0314, 0x0343, 0x0374, 0x03a9, 0x03e1, 0x041c,
  0x045a, 0x049c, 0x04e2, 0x052d, 0x057c, 0x05cf, 0x0628, 0x0685, 0x06e8, 0x0752, 0x07c1, 0x0837,
  0x08b4, 0x0939, 0x09c5, 0x0a5a, 0x0af7, 0x0b9e, 0x0c4f, 0x0d0a, 0x0dd1, 0x0ea3, 0x0f82, 0x106e,
  0x1168, 0x1271, 0x138a, 0x14b3, 0x15ee, 0x173c, 0x189e, 0x1a15, 0x1ba2, 0x1d46, 0x1f04, 0x20dc,
  0x22d0, 0x24e2, 0x2714, 0x2967, 0x2bdd, 0x2e79, 0x313c, 0x3429, 0x3744, 0x3a8d, 0x3e08, 0x41b8,
  0x45a1, 0x49c5, 0x4e28, 0x52cd, 0x57ba, 0x5cf1, 0x6278, 0x6853, 0x6e87, 0x751a, 0x7c10, 0x8371,
  0x8b42, 0x9389, 0x9c4f, 0xa59b, 0xaf74, 0xb9e2, 0xc4f0, 0xd0a6, 0xdd0e, 0xea33, 0xf820, 0xffff,
];

// ---------------------------------------------------------------------------
// Player template. A line starting with [a] is kept only when feature a is on, [!a] only when
// it is off; [a|b] and [a&b] combine two features.
// ---------------------------------------------------------------------------

const PLAYER = `
nt_play:        ldx #$00
[filter]nt_filtpos:     ldy #$00
[filter]                beq nt_filtdone
[filter]                lda nt_filttimetbl-1,y
[filter]                bpl nt_filtmod
[filter]                cmp #$ff
[filter]                bcs nt_filtjump
[filter]                sta $d417
[filter]                and #$70
[filter]                sta nt_filtdone+1
[filter]nt_filtjump:    lda nt_filtspdtbl-1,y
[filter]                bcs nt_filtjump2
[filter]                inc nt_filtpos+1
[filter]                bcc nt_storecutoff
[filter]nt_filtjump2:   sta nt_filtpos+1
[filter]                bcs nt_filtdone
[filter]nt_filtmod:     clc
[filter]                dec nt_filttime
[filter]                bmi nt_newfiltmod
[filter]                bne nt_filtcutoff
[filter]                inc nt_filtpos+1
[filter]                bcc nt_filtdone
[filter]nt_newfiltmod:  sta nt_filttime
[filter]nt_filtcutoff:  lda #$00
[filter]                adc nt_filtspdtbl-1,y
[filter]nt_storecutoff: sta nt_filtcutoff+1
[filter]                sta $d416
[filter]nt_filtdone:    lda #$00
[filter]                ora #$0f
[!filter]                lda #$0f
                sta $d418
                jsr nt_chnexec
                ldx #$07
                jsr nt_chnexec
                ldx #$0e

nt_chnexec:     inc nt_chncounter,x
                bne nt_nopattern

        ;Get a row: nt_chnpattpos is the global row number, 0 = start of the pattern in nt_chnpattnum

                ldy nt_chnpattpos,x
                bne nt_gotrow
                ldy nt_chnpattnum,x
                lda nt_pattstart-1,y
                tay
nt_gotrow:      lda nt_rownote-1,y
[stream]                cmp #$e0
[stream]                bcc nt_norowcmd
[stream]                sbc #$e0
[stream]                sta nt_chncmd,x
[stream]                iny
[stream]                lda nt_rownote-1,y
[stream]nt_norowcmd:
                and #$7f
                sta nt_chnnewnote,x
                cmp #NT_FIRSTNOTE/2
                bcc nt_gatectrl
[!stream]                lda nt_rowcmd-1,y
[!stream]                bne nt_setcmd
[!stream]                lda nt_chncmd,x
[!stream]nt_setcmd:      sta nt_chncmd,x
[!stream&legato]                bmi nt_rest
                lda #$fe
                sta nt_chngate,x
                sta $d405,x
                lda #NT_HRPARAM
                sta $d406,x
nt_rest:        lda nt_rowdur-1,y
                beq nt_nonewdur
                sta nt_chnduration,x
        ;At offset 255 the INY wraps to 0 and the flag test reads a wrong byte, but 0 is stored either
        ;way, and 0 is right: offset 255 can only be the last row of the last pattern

nt_nonewdur:    iny
                lda nt_rownote-2,y
                bpl nt_notlastrow
                ldy #$00
nt_notlastrow:  tya
                sta nt_chnpattpos,x
                jmp nt_waveexec

        ;Keyoff / keyon row, with or without a command

[!stream]nt_gatectrl:    ora #$fc
[!stream]                sta nt_chngate,x
[!stream]                lda nt_rowcmd-1,y
[!stream]                beq nt_gatenocmd
[!stream]                sta nt_chncmd,x
[!stream]                bne nt_rest
[stream]nt_gatectrl:    cmp #$04
[stream]                ora #$fc
[stream]                sta nt_chngate,x
[stream]                bcs nt_rest
nt_gatenocmd:   lda #$ff
                sta nt_chnnewnote,x
                bne nt_rest

[legato]nt_legatocmd:   tya
[legato]                and #$7f
[legato]                tay
[legato]                bpl nt_skipadsr

[pulse]nt_jumptopulse: jmp nt_pulseexec
[!pulse]nt_jumptopulse: jmp nt_waveexec
nt_nopattern:   lda nt_chncounter,x
                cmp #$02
                bne nt_jumptopulse

        ;Reload counter and check for new note / command exec / track access

                lda nt_chnduration,x
                sta nt_chncounter,x
                lda nt_chnnewnote,x
                bpl nt_newnoteinit
                lda nt_chnpattpos,x
                bne nt_jumptopulse

nt_track:       ldy nt_chnsongpos,x
                lda nt_tracks,y
                bne nt_nosongjump
                lda nt_tracks+1,y
                tay
                lda nt_tracks,y
nt_nosongjump:
[transpose]                bpl nt_nosongtrans
[transpose]                sta nt_chntrans,x
[transpose]                iny
[transpose]                lda nt_tracks,y
nt_nosongtrans: sta nt_chnpattnum,x
                iny
                tya
                sta nt_chnsongpos,x
                bcc nt_cmdexecuted
                jmp nt_waveexec

        ;New note init / command exec

nt_newnoteinit: cmp #NT_FIRSTNOTE/2
                bcc nt_skipnote
[transpose]                adc nt_chntrans,x
                asl
                sta nt_chnnote,x
                sec
nt_skipnote:    ldy nt_chncmd,x
[legato]                bmi nt_legatocmd
                lda nt_cmdad-1,y
                sta $d405,x
                lda nt_cmdsr-1,y
                sta $d406,x
                bcc nt_skipadsr
                lda #$ff
                sta nt_chngate,x
                lda #NT_FIRSTWAVE
                sta $d404,x
nt_skipadsr:    lda nt_cmdwavepos-1,y
                beq nt_skipwave
                sta nt_chnwavepos,x
                lda #$00
                sta nt_chnwavetime,x
nt_skipwave:
[pulse]                lda nt_cmdpulsepos-1,y
[pulse]                beq nt_skippulse
[pulse]                sta nt_chnpulsepos,x
[pulse]                lda #$00
[pulse]                sta nt_chnpulsetime,x
[pulse]nt_skippulse:
[filter]                lda nt_cmdfiltpos-1,y
[filter]                beq nt_skipfilt
[filter]                sta nt_filtpos+1
[filter]                lda #$00
[filter]                sta nt_filttime
[filter]nt_skipfilt:
                clc
                lda nt_chnpattpos,x
                beq nt_track
nt_cmdexecuted: rts

[pulse]nt_nopulsemod:  cmp #$ff
[pulse]                lda nt_pulsespdtbl-1,y
[pulse]                bcs nt_pulsejump
[pulse]                inc nt_chnpulsepos,x
[pulse]                bcc nt_storepulse
[pulse]nt_pulsejump:   sta nt_chnpulsepos,x
[pulse]                bcs nt_pulsedone
[pulse]nt_pulseexec:   ldy nt_chnpulsepos,x
[pulse]                beq nt_pulsedone
[pulse]                lda nt_pulsetimetbl-1,y
[pulse]                bmi nt_nopulsemod
[pulse]                clc
[pulse]                dec nt_chnpulsetime,x
[pulse]                bmi nt_newpulsemod
[pulse]                bne nt_nonewpulsemod
[pulse]                inc nt_chnpulsepos,x
[pulse]                bcc nt_pulsedone
[pulse]nt_newpulsemod: sta nt_chnpulsetime,x
[pulse]nt_nonewpulsemod:
[pulse]                lda nt_chnpulse,x
[pulse]                adc nt_pulsespdtbl-1,y
[pulse]                adc #$00
[pulse]nt_storepulse:  sta nt_chnpulse,x
[pulse]                sta $d402,x
[pulse]                sta $d403,x
[pulse]nt_pulsedone:

nt_waveexec:    ldy nt_chnwavepos,x
                beq nt_wavedone
                lda nt_wavetbl-1,y
[slide|vibrato]                cmp #$c0
[slide|vibrato]                bcs nt_slideorvib
[wavedelay]                cmp #$90
[wavedelay]                bcc nt_wavechange
[wavedelay]                beq nt_nowavechange
[wavedelay]                dec nt_chnwavetime,x
[wavedelay]                beq nt_nowavechange
[wavedelay]                bpl nt_wavedone
[wavedelay]                sbc #$90
[wavedelay]                sta nt_chnwavetime,x
[wavedelay]                bcs nt_wavedone
nt_wavechange:  sta nt_chnwave,x
                tya
                sta nt_chnwaveold,x
nt_nowavechange:
                lda nt_wavetbl,y
                cmp #$ff
                bcs nt_wavejump
                inc nt_chnwavepos,x
                bcc nt_wavejumpdone
nt_wavejump:    lda nt_notetbl,y
                sta nt_chnwavepos,x
nt_wavejumpdone:
                lda nt_notetbl-1,y
                asl
                bcs nt_absfreq
                adc nt_chnnote,x
nt_absfreq:     tay
                bne nt_notenum
nt_slidedone:   ldy nt_chnnote,x
                lda nt_chnwaveold,x
                sta nt_chnwavepos,x
nt_notenum:     lda nt_freqtbl-24,y
                sta nt_chnfreqlo,x
                sta $d400,x
                lda nt_freqtbl-23,y
nt_storefreqhi: sta $d401,x
                sta nt_chnfreqhi,x
nt_wavedone:    lda nt_chnwave,x
                and nt_chngate,x
                sta $d404,x
                rts

[slide|vibrato]nt_slideorvib:  sbc #$e0
[slide|vibrato]                sta nt_temp1
[slide|vibrato]                lda nt_chncounter,x
[slide|vibrato]                beq nt_wavedone
[slide|vibrato]                lda nt_notetbl-1,y
[slide|vibrato]                sta nt_temp2
[slide&vibrato]                bcc nt_vibrato
[slide]                ldy nt_chnnote,x
[slide]                lda nt_chnfreqlo,x
[slide]                sbc nt_freqtbl-24,y
[slide]                pha
[slide]                lda nt_chnfreqhi,x
[slide]                sbc nt_freqtbl-23,y
[slide]                tay
[slide]                pla
[slide]                bcs nt_slidedown
[slide]                adc nt_temp2
[slide]                tya
[slide]                adc nt_temp1
[slide]                bcs nt_slidedone
[!slide&vibrato]@VIBRATO
[!slide&vibrato]                bcs nt_freqsub
[slide|vibrato]nt_freqadd:     lda nt_chnfreqlo,x
[slide|vibrato]                adc nt_temp2
[slide|vibrato]                sta nt_chnfreqlo,x
[slide|vibrato]                sta $d400,x
[slide|vibrato]                lda nt_chnfreqhi,x
[slide|vibrato]                adc nt_temp1
[slide|vibrato]                jmp nt_storefreqhi
[slide]nt_slidedown:   sbc nt_temp2
[slide]                tya
[slide]                sbc nt_temp1
[slide]                bcc nt_slidedone
[slide|vibrato]nt_freqsub:     lda nt_chnfreqlo,x
[slide|vibrato]                sbc nt_temp2
[slide|vibrato]                sta nt_chnfreqlo,x
[slide|vibrato]                sta $d400,x
[slide|vibrato]                lda nt_chnfreqhi,x
[slide|vibrato]                sbc nt_temp1
[slide|vibrato]                jmp nt_storefreqhi
[slide&vibrato]@VIBRATO
[slide&vibrato]                bcc nt_freqadd
[slide&vibrato]                bcs nt_freqsub
`;

const VIBRATO = `
nt_vibrato:     lda nt_chnwavetime,x
                bpl nt_vibnodir
                cmp nt_temp1
                bcs nt_vibnodir2
                eor #$ff
nt_vibnodir:    sec
nt_vibnodir2:   sbc #$02
                sta nt_chnwavetime,x
                lsr
                lda #$00
                sta nt_temp1`;

/** Features plus the pattern layout: stream = command prefix bytes in the note stream. */
type Flags = Features & { stream: boolean };

function featureOn(cond: string, f: Flags): boolean {
  const term = (t: string) => (t.startsWith('!') ? !f[t.slice(1) as keyof Flags] : f[t as keyof Flags]);
  if (cond.includes('|')) return cond.split('|').some(term);
  return cond.split('&').every(term);
}

function playerCode(f: Flags): string[] {
  const out: string[] = [];
  for (const raw of PLAYER.split('\n')) {
    let line = raw;
    const m = /^\[([^\]]+)\]/.exec(line);
    if (m) {
      if (!featureOn(m[1], f)) continue;
      line = line.slice(m[0].length);
    }
    if (line.trim() === '@VIBRATO') {
      if (f.vibrato) out.push(...VIBRATO.split('\n').slice(1));
      continue;
    }
    out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

// ---------------------------------------------------------------------------
// Song analysis
// ---------------------------------------------------------------------------

interface Prepared {
  patterns: Row[][];          // used patterns, renumbered from 1
  tracks: number[][];         // editor form, pattern numbers renumbered
  commands: Command[];        // used commands only, renumbered from 1
  tables: [Table, Table, Table]; // reachable rows only, renumbered from 1
  lastCmd: number;
  /** A wave jump row (FF) is rested on, which the player runs as a slide. */
  waveFfSlide: boolean;
  /** Original number of each kept command, or null when no number changed. */
  cmdMap: number[] | null;
  droppedCommands: number;
  droppedRows: number;
}

function prepare(song: Song, subtune: number): Prepared {
  const src = song.tracks[subtune] ?? [[], [], []];
  src.forEach((t, c) => {
    const p = t.length ? trackProblem(t) : 'is empty';
    if (p) throw new Error(`Subtune ${hex2(subtune)} track ${c + 1}: ${p}`);
  });
  src.forEach((t, c) => {
    const where = `Subtune ${hex2(subtune)} track ${c + 1}`;
    for (let i = 0; i < t.length - 2; i++) {
      if (t[i] === 0) throw new Error(`${where}: position ${hex2(i)} is a loop mark (00) before the end of the track`);
      if (t[i] < 0x80) continue;
      const next = i + 1 < t.length - 2 ? t[i + 1] : 0;
      if (next === 0 || next >= 0x80) throw new Error(`${where}: the transpose at position ${hex2(i)} must be followed by a pattern`);
      i++;
    }
  });
  const used = new Set<number>();
  for (const t of src) for (let i = 0; i < t.length - 2; i++) if (t[i] > 0 && t[i] < 0x80) used.add(t[i]);
  const order = [...used].sort((a, b) => a - b);
  const renum = new Map(order.map((p, i) => [p, i + 1]));
  for (const p of order) {
    if (!song.patterns[p - 1]?.length) throw new Error(`Pattern ${hex2(p)} is used in a track but is empty`);
  }
  const tracks = src.map(t => t.map((v, i) => (i < t.length - 2 && v > 0 && v < 0x80 ? renum.get(v)! : v)));

  // Commands the patterns refer to. Command 1 is also used when a channel plays a note before
  // any command was given, because the player starts out with command 1 selected.
  const usedCmd = new Set<number>();
  for (const p of order) for (const r of song.patterns[p - 1]) if (r.cmd) usedCmd.add(r.cmd & 0x7f);
  for (const t of src) {
    const first = t.slice(0, -2).filter(v => v > 0 && v < 0x80).flatMap(v => song.patterns[v - 1])
      .find(r => r.note >= FIRSTNOTE || r.cmd);
    if (first && !first.cmd) usedCmd.add(1);
  }
  const cmdOrder = [...usedCmd].sort((a, b) => a - b);
  const cmdMap = new Map(cmdOrder.map((c, i) => [c, i + 1]));
  const patterns = order.map(p => song.patterns[p - 1].map(r =>
    (r.cmd ? { ...r, cmd: (r.cmd & 0x80) | cmdMap.get(r.cmd & 0x7f)! } : r)));

  // Table rows the used commands can reach, then everything renumbered
  const keys = ['wave', 'pulse', 'filt'] as const;
  const rowMaps: Map<number, number>[] = [];
  let waveFfSlide = false;
  const tables = song.tables.map((tbl, ti) => {
    const n = tbl.left.length;
    const keep = new Set<number>();
    const rested = new Set<number>();
    const jumps = new Set<number>();    // wave rows used as jumps (seen one row ahead)
    const ffSlides = new Set<number>(); // wave jump rows the player rests on: it runs them as slides
    for (const c of cmdOrder) {
      let pos = song.commands[c - 1][keys[ti]];
      while (pos >= 1 && pos <= n && !rested.has(pos)) {
        const l = tbl.left[pos - 1];
        if (ti !== TBL_WAVE) {
          // Pulse and filter programs rest on their jump rows
          rested.add(pos);
          keep.add(pos);
          pos = l === 0xff ? tbl.right[pos - 1] : pos + 1;
          continue;
        }
        // The wave player looks one row ahead for a jump and does not rest on it. A row it does
        // rest on is a slide when it is E0 or above, and that includes FF: landing a legato
        // command on an FF row is a known trick for an instant glide to the new note.
        rested.add(pos);
        keep.add(pos);
        if (l === 0xff) ffSlides.add(pos);
        if (l >= 0xc0) break; // slide and vibrato rows stay put
        if (pos < n && tbl.left[pos] === 0xff) { keep.add(pos + 1); jumps.add(pos + 1); pos = tbl.right[pos]; } else pos++;
      }
    }
    // A row that is both cannot be renumbered: as a jump its right column is a row number, as a
    // slide the same byte is a speed. Such a wave table is exported whole, with its row numbers.
    if (ti === TBL_WAVE) {
      waveFfSlide = ffSlides.size > 0;
      if ([...ffSlides].some(r => jumps.has(r))) {
        for (let r = 1; r <= n; r++) keep.add(r);
        ffSlides.clear(); // nothing moves, so every FF row keeps its right column as it is
        jumps.clear();
      }
    }
    const kept = [...keep].sort((a, b) => a - b);
    const map = new Map(kept.map((r, i) => [r, i + 1]));
    rowMaps.push(map);
    return {
      left: kept.map(r => tbl.left[r - 1]),
      right: kept.map(r => (tbl.left[r - 1] === 0xff && !ffSlides.has(r) && kept.length < n ? map.get(tbl.right[r - 1]) ?? 0 : tbl.right[r - 1])),
    };
  }) as [Table, Table, Table];
  const commands = cmdOrder.map(c => {
    const o = song.commands[c - 1];
    return { ...o, wave: rowMaps[0].get(o.wave) ?? 0, pulse: rowMaps[1].get(o.pulse) ?? 0, filt: rowMaps[2].get(o.filt) ?? 0 };
  });
  let lastOld = 1;
  for (const p of order) for (const r of song.patterns[p - 1]) lastOld = Math.max(lastOld, r.cmd & 0x7f);
  return {
    patterns, tracks, commands, tables, lastCmd: commands.length, waveFfSlide,
    cmdMap: cmdOrder.some((c, i) => c !== i + 1) ? cmdOrder : null,
    droppedCommands: lastOld - commands.length,
    droppedRows: song.tables.reduce((a, t, i) => a + t.left.length - tables[i].left.length, 0),
  };
}

function detectFeatures(song: Song, p: Prepared): Features {
  const cmds = song.commands.slice(0, p.lastCmd);
  const waveLeft = song.tables[0].left;
  return {
    filter: cmds.some(c => c.filt !== 0),
    pulse: cmds.some(c => c.pulse !== 0),
    slide: p.waveFfSlide || waveLeft.some(v => v >= 0xe0 && v < 0xff),
    vibrato: waveLeft.some(v => v >= 0xc0 && v < 0xe0),
    wavedelay: waveLeft.some(v => v >= 0x90 && v < 0xc0),
    legato: p.patterns.some(rows => rows.some(r => r.cmd >= 0x80)),
    transpose: p.tracks.some(t => t.slice(0, -2).some(v => v >= 0x80)),
  };
}

/**
 * Frequency table entries (0-83) the player can read. Follows each channel through its track,
 * pairing every note with the wavetable rows its command can reach. Errs on the side of keeping.
 */
function usedFrequencies(song: Song, p: Prepared, outside: Set<number>): Set<number> {
  const left = song.tables[0].left, right = song.tables[0].right;
  const n = left.length;

  // Wavetable rows (1-based) reachable from a start row
  const reachCache = new Map<number, number[]>();
  const reach = (start: number): number[] => {
    let r = reachCache.get(start);
    if (r) return r;
    const seen = new Set<number>();
    let pos = start;
    while (pos >= 1 && pos <= n && !seen.has(pos)) {
      seen.add(pos); // a rested FF row is a slide, like E0-FE
      if (left[pos - 1] >= 0xc0) break; // slide / vibrato rows stay put
      pos = pos < n && left[pos] === 0xff ? right[pos] : pos + 1;
    }
    r = [...seen];
    // A finished slide or a row with absolute note 00 sends the player back to an earlier wave
    // position, which can belong to another command
    if (r.some(row => (left[row - 1] < 0xc0 ? right[row - 1] === 0x80 : left[row - 1] >= 0xe0))) {
      r = [];
      for (let i = 1; i <= n; i++) if (left[i - 1] !== 0xff) r.push(i);
    }
    reachCache.set(start, r);
    return r;
  };

  const used = new Set<number>();
  let noteSet = false;
  const mark = (index: number) => {
    const e = (index - 24) / 2;
    if (index >= 24 && e < FREQ.length) used.add(e);
    else if (noteSet) outside.add(index);
  };
  const play = (note: number, prog: number) => {
    if (!prog) return;
    noteSet = note !== 0; // before the first note the player reads below the table in any export
    for (const row of reach(prog)) {
      const l = left[row - 1], v = right[row - 1];
      if (l >= 0xc0) { mark(note); continue; } // slide target; vibrato reads nothing
      const idx = v >= 0x80 ? (v * 2) & 0xff : (v * 2 + note) & 0xff;
      mark(idx === 0 ? note : idx);
    }
  };

  for (const track of p.tracks) {
    const body = track.slice(0, -2), loop = track[track.length - 1];
    let trans = 0xff, note = 0, cmd = 1, prog = 0;
    const seen = new Set<string>();
    let pos = 0;
    for (let guard = 0; guard < 100000; guard++) {
      if (pos >= body.length) {
        const key = `${trans},${note},${cmd},${prog}`;
        if (seen.has(key)) break;
        seen.add(key);
        pos = loop;
      }
      let v = body[pos++];
      if (v >= 0x80) { trans = ((v - 0x41) & 0xff) | 0x80; v = body[pos++]; }
      for (const r of p.patterns[v - 1]) {
        const isNote = r.note >= FIRSTNOTE;
        if (!isNote && !r.cmd) continue;
        if (r.cmd) cmd = r.cmd;
        if (isNote) note = (((r.note >> 1) + trans + 1) << 1) & 0xff;
        const w = song.commands[(cmd & 0x7f) - 1]?.wave ?? 0;
        if (w) prog = w;
        play(note, prog);
      }
    }
  }
  return used;
}

// ---------------------------------------------------------------------------
// Frequency table from one octave
// ---------------------------------------------------------------------------

/** More corrections than this cost more than the full table saves. */
const MAX_FREQ_FIXUPS = 8;
/** At or below this many used notes the 24 seed bytes plus the init code do not pay off. */
const MIN_SEED_NOTES = 20;

export interface SeedTable {
  /** Octave row (0-based) that is stored; rows below are built by halving, rows above dropped. */
  row: number;
  /** The 12 stored words. */
  values: number[];
  /** Used entries the halving gets wrong: table entry, value after halving, correct value. */
  fixups: { entry: number; got: number; want: number }[];
}

/**
 * Picks the 12 words of the highest used octave so that repeated truncating halving gives the
 * used entries of the lower octaves. A semitone that is used in the stored octave is fixed; for
 * the others the value with the fewest wrong entries wins. An entry k octaves down is right for
 * the 2^k values that shift down to it, so the best value is at the start of one of those ranges
 * (or is the real frequency, or the value in a range nearest to it).
 */
export function seedTable(used: Set<number>): SeedTable | null {
  if (!used.size) return null;
  const row = Math.floor(Math.max(...used) / 12);
  if (row === 0) return null;
  const values: number[] = [], fixups: SeedTable['fixups'] = [];
  for (let s = 0; s < 12; s++) {
    const lower: number[] = [];
    for (let r = 0; r < row; r++) if (used.has(r * 12 + s)) lower.push(r);
    const misses = (v: number) => lower.reduce((n, r) => n + ((v >> (row - r)) !== FREQ[r * 12 + s] ? 1 : 0), 0);
    const nominal = FREQ[row * 12 + s];
    let best = nominal;
    if (!used.has(row * 12 + s)) {
      if (!lower.length) best = 0; // nothing reads this semitone at all
      else {
        let bestMiss = Infinity;
        const candidates = new Set<number>([nominal]);
        for (const r of lower) {
          const k = row - r, lo = FREQ[r * 12 + s] << k, hi = Math.min(0xffff, lo + (1 << k) - 1);
          if (lo > 0xffff) continue; // B-7 is clipped to $ffff in the table, so B cannot always be halved down
          candidates.add(lo);
          candidates.add(Math.min(hi, Math.max(lo, nominal)));
        }
        for (const v of candidates) {
          const m = misses(v);
          if (m < bestMiss || (m === bestMiss && Math.abs(v - nominal) < Math.abs(best - nominal))) { best = v; bestMiss = m; }
        }
      }
    }
    values.push(best);
    for (const r of lower) {
      const got = best >> (row - r), want = FREQ[r * 12 + s];
      if (got !== want) fixups.push({ entry: r * 12 + s, got, want });
    }
  }
  fixups.sort((a, b) => a.entry - b.entry);
  return { row, values, fixups };
}

export function seedInit(seed: SeedTable): string[] {
  const start = seed.row * 24 - 1;
  const out = [
    `nt_init:        ldx #${start}`,
    'nt_initloop:    lda nt_freqtbl+24,x',
    '                lsr',
    '                sta nt_freqtbl,x',
    '                dex',
    '                lda nt_freqtbl+24,x',
    '                ror',
    '                sta nt_freqtbl,x',
    '                dex',
  ];
  // BPL only works while the start index is below 128 (five octaves below the stored one)
  if (start < 128) out.push('                bpl nt_initloop');
  else out.push('                cpx #$ff', '                bne nt_initloop');
  for (const fx of seed.fixups) {
    const lo = fx.entry * 2, sameHi = (fx.got >> 8) === (fx.want >> 8), d = fx.want - fx.got;
    if (sameHi && (d === 1 || d === -1)) {
      out.push(`                ${d > 0 ? 'inc' : 'dec'} nt_freqtbl+${lo}       ;halving gave ${fx.got.toString(16)}, the table has ${fx.want.toString(16)}`);
      continue;
    }
    if ((fx.got & 0xff) !== (fx.want & 0xff)) out.push(`                lda #${h(fx.want & 0xff)}`, `                sta nt_freqtbl+${lo}`);
    if (!sameHi) out.push(`                lda #${h(fx.want >> 8)}`, `                sta nt_freqtbl+${lo + 1}`);
  }
  out.push('                rts');
  return out;
}

// ---------------------------------------------------------------------------
// Source generation
// ---------------------------------------------------------------------------

const h = (v: number) => '$' + hex2(v);

function byteLines(label: string, data: ArrayLike<number>, perLine = 16): string[] {
  const out: string[] = [];
  if (!data.length) return [`${label}:`];
  for (let i = 0; i < data.length; i += perLine) {
    const chunk = Array.from({ length: Math.min(perLine, data.length - i) }, (_, k) => h(data[i + k])).join(',');
    out.push(`${i === 0 ? (label + ':').padEnd(16) : ' '.repeat(16)}dc.b ${chunk}`);
  }
  return out;
}

/** DASM subset -> KickAssembler. */
export function toKickAss(dasm: string): string {
  return dasm.split('\n').map(line => {
    const semi = line.indexOf(';');
    let code = semi >= 0 ? line.slice(0, semi) : line;
    const comment = semi >= 0 ? '//' + line.slice(semi + 1) : '';
    const eq = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(code);
    if (eq) code = `.label ${eq[1]} = ${eq[2]} `.padEnd(32);
    code = code.replace(/\bdc\.b\b/, '.byte').replace(/\bdc\.w\b/, '.word');
    return (code + comment).replace(/\s+$/, '');
  }).join('\n');
}

export function export4k(song: Song, opts: Export4kOptions = {}): Export4k {
  const subtune = opts.subtune ?? 0;
  const zp = opts.zp ?? 0xfc;
  const p = prepare(song, subtune);
  song = { ...song, commands: p.commands, tables: p.tables }; // everything below sees the pruned song
  const f = detectFeatures(song, p);
  if (opts.allFeatures) for (const k of Object.keys(f) as (keyof Features)[]) f[k] = true;
  const usesZeropage = f.slide || f.vibrato;

  // Pattern layout. Stream: a row with a command is a prefix byte ($E0 + command) followed by the
  // note byte, and there is no command column. It needs commands 1-31 without legato and an
  // 8-bit stream offset; otherwise the three-column layout is used.
  const allRows = p.patterns.flat();
  const rowCount = allRows.length;
  if (rowCount > MAX_4K_ROWS) {
    throw new Error(`The 4k export holds at most ${MAX_4K_ROWS} pattern rows; the patterns this subtune uses have ${rowCount}`);
  }
  const streamBytes = rowCount + allRows.filter(r => r.cmd).length;
  const layoutReason = opts.layout === 'columns' ? 'forced'
    : allRows.some(r => r.cmd >= 0x80) ? 'the tune uses legato commands'
    : p.commands.length > 31 ? `the tune uses ${p.commands.length} commands, more than 31`
    : streamBytes > MAX_4K_ROWS ? `rows plus command prefixes are ${streamBytes} bytes, more than ${MAX_4K_ROWS}`
    : '';
  const stream = !layoutReason;

  const rowNote: number[] = [], rowCmd: number[] = [], rowDur: number[] = [], pattStart: number[] = [];
  const pattLen: number[] = [];
  const durByte = (r: Row) => (r.dur ? ((r.dur - 3) ^ 0xff) & 0xff : 0);
  for (const rows of p.patterns) {
    pattStart.push(rowNote.length + 1);
    rows.forEach((r, i) => {
      const last = i === rows.length - 1 ? 0x80 : 0;
      const gate = r.note === KEYOFF ? 2 : r.note === KEYON ? 3 : 0;
      if (stream) {
        if (r.cmd) { rowNote.push(0xe0 + r.cmd); rowDur.push(0); }
        rowNote.push((gate ? gate + (r.cmd ? 4 : 0) : r.note >> 1) | last);
      } else {
        rowNote.push((gate || r.note >> 1) | last);
        rowCmd.push(r.cmd);
      }
      rowDur.push(durByte(r));
    });
    pattLen.push(rowNote.length + 1 - pattStart[pattStart.length - 1]);
  }
  const tracks = packTracks(p.tracks);
  if (tracks.data.length > 256) throw new Error('The three tracks together are longer than 256 bytes');

  const wave = song.tables[0], pulse = song.tables[1], filt = song.tables[2];
  const cmds = song.commands.slice(0, p.lastCmd);
  const outside = new Set<number>();
  const usedFreq = usedFrequencies(song, p, outside);
  const warnings: string[] = [];
  if (outside.size) {
    warnings.push('A transpose or wavetable note offset may take a note outside C-1 to B-7. ' +
      'The player then reads past the frequency table, and the export will not sound like the editor there.');
  }

  // Frequency table: store one octave and let nt_init halve it down, when that is smaller
  const candidate = opts.freqTable === 'full' ? null : seedTable(usedFreq);
  const freqReason = opts.freqTable === 'full' ? 'forced'
    : !candidate ? 'the tune stays within one octave'
    : candidate.fixups.length > MAX_FREQ_FIXUPS ? `${candidate.fixups.length} values would need correcting`
    : opts.freqTable !== 'seed' && usedFreq.size <= MIN_SEED_NOTES ? `only ${usedFreq.size} notes are used`
    : '';
  const seed = freqReason ? null : candidate;

  const on =(Object.keys(f) as (keyof Features)[]).filter(k => f[k]).map(k => FEATURE_TEXT[k]);
  const off = (Object.keys(f) as (keyof Features)[]).filter(k => !f[k]).map(k => FEATURE_TEXT[k]);
  const L: string[] = [];
  L.push(`; ${opts.name ?? 'Untitled'} - NinjaTracker 2 tune, 4k intro export from NT2 Studio`);
  L.push(';');
  if (seed) {
    L.push('; Import this file where the music should be, call nt_init once, then nt_play once per frame.');
    L.push('; nt_init only builds the frequency table from its top octave. The variables at the end are');
    L.push('; assembled in their start state, so the tune still plays once from a freshly loaded copy.');
  } else {
    L.push('; Import this file where the music should be, call nt_init once, then nt_play once per frame.');
    L.push('; nt_init does nothing for this tune (it is the address of an RTS and costs no bytes); it is');
    L.push('; there so the intro can call it whatever the export. The variables at the end are assembled');
    L.push('; in their start state, so the tune plays once from a freshly loaded copy.');
  }
  L.push('; The SID is expected in its reset state (write 0 to $d417 first if something else used the filter).');
  L.push(';');
  L.push(`; Player code included: ${on.length ? on.join(', ') : 'basics only'}`);
  L.push(`; Left out (unused):    ${off.length ? off.join(', ') : 'nothing'}`);
  L.push(`; ${p.patterns.length} patterns, ${rowCount} rows, ${cmds.length} commands, ${usedFreq.size} of ${FREQ.length} frequencies`);
  L.push(stream
    ? `; Patterns: note stream with command prefix bytes, ${rowNote.length} of ${MAX_4K_ROWS} bytes`
    : `; Patterns: note, command and duration columns (${layoutReason})`);
  L.push(seed
    ? `; Frequency table: octave ${seed.row + 1} stored, ${seed.row} lower octave(s) built by nt_init, ${seed.fixups.length} value(s) corrected`
    : `; Frequency table: stored in full, unused notes zero (${freqReason})`);
  if (p.droppedCommands || p.droppedRows) {
    L.push(`; Unused commands dropped: ${p.droppedCommands}, unused table rows dropped: ${p.droppedRows}. Table rows are renumbered.`);
  }
  for (const w of warnings) L.push(`; WARNING: ${w}`);
  if (p.cmdMap) {
    L.push(`; Command numbers, editor -> here: ${p.cmdMap.map((c, i) => `${hex2(c)}->${hex2(i + 1)}`).join(' ')}`);
  }
  L.push('');
  L.push(`NT_FIRSTNOTE = ${h(FIRSTNOTE)}`);
  L.push(`NT_HRPARAM = ${h(song.hrParam)}`);
  L.push(`NT_FIRSTWAVE = ${h(song.firstWave)}`);
  if (usesZeropage) {
    L.push(`nt_temp1 = ${h(zp)}                 ; two zeropage bytes for slide / vibrato`);
    L.push(`nt_temp2 = ${h((zp + 1) & 0xff)}`);
  }
  L.push('');
  const codeStart = L.length;
  L.push(...playerCode({ ...f, stream }));
  if (seed) L.push('', '        ;Call once before nt_play: halves the stored octave down into the lower ones', '', ...seedInit(seed));
  const codeEnd = L.length;
  if (!seed) L.push('', 'nt_init = nt_cmdexecuted     ; nothing to set up for this tune: nt_init is just an RTS');

  const w4 = (v: number) => '$' + v.toString(16).padStart(4, '0');
  const freqRow = (i: number, words: number[]) =>
    `${i === 0 ? 'nt_freqtbl:'.padEnd(16) : ' '.repeat(16)}dc.w ${words.map(w4).join(',')}`;
  if (seed) {
    L.push('', '        ;Frequency table: only the last octave is stored, nt_init fills in the rest', '');
    for (let r = 0; r < seed.row; r++) L.push(freqRow(r, new Array(12).fill(0)));
    L.push(freqRow(seed.row, seed.values));
  } else {
    L.push('', '        ;Frequency table, unused notes are zero', '');
    for (let i = 0; i < FREQ.length; i += 12) L.push(freqRow(i, FREQ.slice(i, i + 12).map((v, k) => (usedFreq.has(i + k) ? v : 0))));
  }

  L.push('', '        ;Wavetable: waveform / delay / slide / vibrato column, then note column', '');
  L.push(...byteLines('nt_wavetbl', wave.left.map(convertWaveLeft)));
  L.push(...byteLines('nt_notetbl', wave.right));
  if (f.pulse) {
    L.push('', '        ;Pulse table: time, speed', '');
    L.push(...byteLines('nt_pulsetimetbl', pulse.left));
    L.push(...byteLines('nt_pulsespdtbl', pulse.left.map((t, i) => convertPulseRight(t, pulse.right[i]))));
  }
  if (f.filter) {
    L.push('', '        ;Filter table: time, speed', '');
    L.push(...byteLines('nt_filttimetbl', filt.left));
    L.push(...byteLines('nt_filtspdtbl', filt.right));
  }
  L.push('', '        ;Commands: attack/decay, sustain/release, table start positions', '');
  L.push(...byteLines('nt_cmdad', cmds.map(c => c.ad)));
  L.push(...byteLines('nt_cmdsr', cmds.map(c => c.sr)));
  L.push(...byteLines('nt_cmdwavepos', cmds.map(c => c.wave)));
  if (f.pulse) L.push(...byteLines('nt_cmdpulsepos', cmds.map(c => c.pulse)));
  if (f.filter) L.push(...byteLines('nt_cmdfiltpos', cmds.map(c => c.filt)));

  L.push('', '        ;Tracks of the three channels: 00 xx = loop to offset xx, 01-7F = pattern, 80-FF = transpose', '');
  let base = 0;
  tracks.lens.forEach((len, c) => {
    L.push(...byteLines(c === 0 ? 'nt_tracks' : `nt_track${c + 1}`, tracks.data.subarray(base, base + len)));
    base += len;
  });

  const perPattern = (label: string, data: number[]) => p.patterns.forEach((_, i) => {
    const s = pattStart[i] - 1;
    L.push(...byteLines(i === 0 ? label : '', data.slice(s, s + pattLen[i]), 32).map(l => l.replace(/^:/, ' ')));
  });
  if (stream) {
    L.push('', '        ;Patterns. nt_pattstart = offset of each pattern in the note stream (offsets count from 1)', '');
    L.push(...byteLines('nt_pattstart', pattStart));
    L.push('', '        ;Note stream: E1-FF = command 01-1F for the row whose note byte follows,');
    L.push('        ;02 = keyoff, 03 = keyon, 06 / 07 = the same on a row with a command, 0C-5F = note,');
    L.push('        ;+80 on the note byte of the last row of a pattern', '');
    perPattern('nt_rownote', rowNote);
    L.push('', '        ;Durations, one per stream byte (00 at prefix bytes): 00 = unchanged, else 255 - (frames - 3)', '');
    perPattern('nt_rowdur', rowDur);
  } else {
    L.push('', '        ;Patterns as columns. nt_pattstart = first row of each pattern (rows count from 1)', '');
    L.push(...byteLines('nt_pattstart', pattStart));
    L.push('', '        ;Note column: 02 = keyoff, 03 = keyon, 0C-5F = note, +80 on the last row of a pattern', '');
    perPattern('nt_rownote', rowNote);
    L.push('', '        ;Command column: 00 = none, 01-7F = command, 81-FF = command in legato mode', '');
    perPattern('nt_rowcmd', rowCmd);
    L.push('', '        ;Duration column: 00 = unchanged, else 255 - (frames - 3)', '');
    perPattern('nt_rowdur', rowDur);
  }

  const starts = [0, tracks.lens[0], tracks.lens[0] + tracks.lens[1]];
  L.push('', '        ;Variables, 7 per channel in three groups. They must start out exactly like this.', '');
  L.push('nt_chnpattpos:  dc.b 0');
  L.push('nt_chncounter:  dc.b 0');
  L.push('nt_chnnewnote:  dc.b $ff');
  L.push('nt_chnwavepos:  dc.b 0');
  L.push('nt_chnpulsepos: dc.b 0');
  L.push('nt_chnwave:     dc.b 0');
  L.push('nt_chnwaveold:  dc.b 0');
  L.push('                dc.b 0,0,$ff,0,0,0,0');
  L.push('                dc.b 0,0,$ff,0,0,0,0');
  L.push('nt_chngate:     dc.b $fe');
  L.push('nt_chntrans:    dc.b $ff');
  L.push('nt_chncmd:      dc.b $01');
  L.push(`nt_chnsongpos:  dc.b ${h(starts[0])}`);
  L.push('nt_chnpattnum:  dc.b 0');
  L.push('nt_chnduration: dc.b $ff');
  L.push('nt_chnnote:     dc.b 0');
  L.push(`                dc.b $fe,$ff,$01,${h(starts[1])},0,$ff,0`);
  L.push(`                dc.b $fe,$ff,$01,${h(starts[2])},0,$ff,0`);
  L.push('nt_chnfreqlo:   dc.b 0');
  L.push('nt_chnfreqhi:   dc.b 0');
  L.push('nt_chnpulse:    dc.b 0');
  L.push('nt_chnwavetime: dc.b 0');
  L.push('nt_chnpulsetime:dc.b 0');
  L.push('nt_filttime:    dc.b 0');
  L.push('                dc.b 0');
  L.push('                dc.b 0,0,0,0,0,0,0');
  L.push('                dc.b 0,0,0,0,0');
  L.push('');

  const dasm = L.join('\n');
  const total = assemble(dasm, 0x1000).bytes.length;
  const code = assemble(L.slice(0, codeEnd).join('\n') + '\n' + stubSymbols(L.slice(codeStart, codeEnd)), 0x1000).bytes.length;
  return {
    source: toKickAss(dasm),
    dasm,
    features: f,
    usesZeropage,
    layout: stream ? 'stream' : 'columns',
    layoutReason,
    needsInit: !!seed,
    freqFixups: seed ? seed.fixups.length : -1,
    rows: rowCount,
    patterns: p.patterns.length,
    commands: cmds.length,
    droppedCommands: p.droppedCommands,
    droppedRows: p.droppedRows,
    freqEntries: usedFreq.size,
    warnings,
    codeBytes: code,
    dataBytes: total - code,
    totalBytes: total,
  };
}

/** Dummy definitions for the data labels, so the code can be assembled alone to measure it. */
function stubSymbols(code: string[]): string {
  const defined = new Set<string>(), usedSyms = new Set<string>();
  for (const line of code) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) defined.add(m[1]);
    for (const s of line.replace(/;.*/, '').match(/\bnt_[a-z0-9]+\b/g) ?? []) usedSyms.add(s);
  }
  return [...usedSyms].filter(s => !defined.has(s) && s !== 'nt_temp1' && s !== 'nt_temp2').map(s => `${s} = $4000`).join('\n');
}
