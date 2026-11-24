// Finds every NinjaTracker 2 playroutine in a C64 memory image and reads the addresses of its
// music tables out of the player's own instructions. More tolerant than src/core/sidimport.ts: it
// only needs the parts that matter for instruments, so it also copes with game players, players
// without a filter, and files holding several players.

export const X = -1; // wildcard

export function find(mem: Uint8Array, pattern: number[], from: number, to: number): number {
  const last = Math.min(to, mem.length) - pattern.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let k = 0; k < pattern.length; k++) if (pattern[k] !== X && mem[i + k] !== pattern[k]) continue outer;
    return i;
  }
  return -1;
}

const word = (mem: Uint8Array, o: number) => mem[o] | (mem[o + 1] << 8);

export interface Player {
  /** Address of the wave table instruction: identifies the player. */
  at: number;
  wave: number; note: number; pulseTime: number; pulseSpd: number;
  /** -1 when the player has no filter code. */
  filtTime: number; filtSpd: number;
  cmdAd: number; cmdSr: number; cmdWave: number; cmdPulse: number; cmdFilt: number;
  /** -1 when not found. */
  pattLo: number; pattHi: number;
  /** Song table (five bytes per subtune), -1 when not found. */
  songTbl: number;
  /** Some game players keep their music at another address than it was packed for: added to pattern and track addresses. */
  pattReloc: number; trackReloc: number;
  /** Other game players OR a base page into the high byte of pattern and track addresses. */
  pattOr: number; trackOr: number;
  /** The V2.0 track format: 80-BF transpose, C0 and up loop (later versions: 80-FF transpose, 00 loop). */
  oldTracks: boolean;
  /** Player variables (channel 1; the other channels are 7 and 14 bytes further). -1 when not found. */
  chnCmd: number; chnNote: number;
  hrParam: number; firstWave: number;
  missing: string[];
}

/** Locate all players. Call after the tune's init routine has run: game players patch their addresses then. */
export function locatePlayers(mem: Uint8Array): Player[] {
  const players: Player[] = [];
  let from = 0;
  for (;;) {
    const iWave = find(mem, [0xbc, X, X, 0xf0, X, 0xb9, X, X, 0xc9, 0xc0], from, mem.length);
    if (iWave < 0) break;
    from = iWave + 1;
    const lo = iWave - 0x260, hi = iWave + 0x140;
    const missing: string[] = [];
    const get = (pattern: number[], what: string, a = lo, b = hi): number => {
      const i = find(mem, pattern, a, b);
      if (i < 0) missing.push(what);
      return i;
    };
    // The player's parts come in a fixed order, so each is searched for between its neighbours.
    // "Last before" matters when a file holds two players close together.
    const lastBefore = (pattern: number[], a: number, b: number): number => {
      let at = -1;
      for (let i = find(mem, pattern, a, b); i >= 0; i = find(mem, pattern, i + 1, b)) at = i;
      return at;
    };
    const iNote = get([0xb9, X, X, 0x0a, 0xb0], 'note', iWave, hi);
    const iPulseT = lastBefore([0xbc, X, X, 0xf0, X, 0xb9, X, X, 0x30], lo, iWave);
    if (iPulseT < 0) missing.push('pulse time');
    // The speed column is read in two places. The first (cmp #$ff / lda speed,y / bcs) is preferred:
    // a few files were relocated by hand and have a wrong address in the second.
    let iPulseS = iPulseT < 0 ? -1 : find(mem, [0xc9, 0xff, 0xb9, X, X, 0xb0], iPulseT - 24, iPulseT);
    if (iPulseS >= 0) iPulseS += 2;
    else if (iPulseT >= 0) iPulseS = get([0x79, X, X, 0x69, 0x00], 'pulse speed', iPulseT, iWave);
    const iAdsr = lastBefore([0xb9, X, X, 0x9d, 0x05, X, 0xb9, X, X, 0x9d, 0x06, X], lo, iWave);
    if (iAdsr < 0) missing.push('adsr');
    // The table pointers of a command are read one after the other, each followed by a beq.
    // Players built without a filter have only the first two.
    const ptr: number[] = [];
    if (iAdsr >= 0) {
      let p = iAdsr + 12;
      while (ptr.length < 3) {
        const i = find(mem, [0xb9, X, X, 0xf0], p, Math.min(iAdsr + 80, iPulseT < 0 ? iWave : iPulseT));
        if (i < 0) break;
        ptr.push(word(mem, i + 1) + 1);
        p = i + 4;
      }
    }
    if (ptr.length < 2) missing.push('command pointers');
    const start = iAdsr < 0 ? lo : iAdsr - 0x1a0;
    // lda filttime,y / bpl / cmp #$ff / bcs ... then the next "lda table,y / bcs" is the cutoff column
    const iFilt = lastBefore([0xb9, X, X, 0x10, X, 0xc9, 0xff, 0xb0], start, iAdsr < 0 ? iWave : iAdsr);
    const iFiltS = iFilt < 0 ? -1 : find(mem, [0xb9, X, X, 0xb0], iFilt + 8, iFilt + 40);
    const iPatt = lastBefore([0xbc, X, X, 0xb9, X, X, 0x85, X, 0xb9, X, X], start, iAdsr < 0 ? iWave : iAdsr);
    // "sec / sbc #nn" after a high byte moves the address down by nn pages
    const reloc = (i: number) => (mem[i] === 0x38 && mem[i + 1] === 0xe9 ? -(mem[i + 2] << 8) : 0);
    // "ora zp" after a high byte: the music's base page is kept in a zero page address
    const orPage = (i: number) => (mem[i] === 0x05 ? mem[mem[i + 1]] << 8 : 0);
    // Song init: asl / asl / adc songnumber / tay / lda songtable,y ... lda songtable+1,y
    let iSong = lastBefore([0x0a, 0x0a, 0x6d, X, X, 0xa8, 0xb9], start - 0x100, iAdsr < 0 ? iWave : iAdsr);
    if (iSong >= 0) iSong += 6;
    else { iSong = lastBefore([0x0a, 0x0a, 0x65, X, 0xa8, 0xb9], start - 0x100, iAdsr < 0 ? iWave : iAdsr); if (iSong >= 0) iSong += 5; }
    const iSongHi = iSong < 0 ? -1 : find(mem, [0xb9], iSong + 3, iSong + 12);
    // sta chnnote,x / sec / ldy chncmd,x / bmi, right before the envelope is set
    const iVars = iAdsr < 0 ? -1 : find(mem, [0x9d, X, X, 0x38, 0xbc, X, X, 0x30], iAdsr - 16, iAdsr);
    const iHr = lastBefore([0xa9, 0xfe, 0x9d, X, X, 0x9d, 0x05, X, 0xa9, X, 0x9d, 0x06, X], start, iWave);
    const iFw = find(mem, [0xa9, 0xff, 0x9d, X, X, 0xa9, X, 0x9d, 0x04, X], iAdsr < 0 ? lo : iAdsr, iWave);
    players.push({
      at: iWave,
      wave: word(mem, iWave + 6) + 1,
      note: iNote < 0 ? -1 : word(mem, iNote + 1) + 1,
      pulseTime: iPulseT < 0 ? -1 : word(mem, iPulseT + 6) + 1,
      pulseSpd: iPulseS < 0 ? -1 : word(mem, iPulseS + 1) + 1,
      filtTime: iFiltS < 0 ? -1 : word(mem, iFilt + 1) + 1,
      filtSpd: iFiltS < 0 ? -1 : word(mem, iFiltS + 1) + 1,
      cmdAd: iAdsr < 0 ? -1 : word(mem, iAdsr + 1) + 1,
      cmdSr: iAdsr < 0 ? -1 : word(mem, iAdsr + 7) + 1,
      cmdWave: ptr[0] ?? -1, cmdPulse: ptr[1] ?? -1, cmdFilt: ptr[2] ?? -1,
      pattLo: iPatt < 0 ? -1 : word(mem, iPatt + 4) + 1,
      pattHi: iPatt < 0 ? -1 : word(mem, iPatt + 9) + 1,
      // A player stripped of its song init (one tune, started by setting the variables directly)
      // still has the table in the usual place: right after the two halves of the pattern table
      songTbl: iSong >= 0 ? word(mem, iSong + 1) : iPatt >= 0 ? 2 * (word(mem, iPatt + 9) + 1) - (word(mem, iPatt + 4) + 1) : -1,
      pattOr: iPatt < 0 ? 0 : orPage(iPatt + 11),
      trackOr: iSongHi < 0 ? 0 : orPage(iSongHi + 3),
      pattReloc: iPatt < 0 ? 0 : reloc(iPatt + 11),
      trackReloc: iSongHi < 0 ? 0 : reloc(iSongHi + 3),
      // iny / asl / bpl / lda (zp),y / tay / bcs: the old way of telling a transpose from a loop
      oldTracks: find(mem, [0xc8, 0x0a, 0x10, X, 0xb1, X, 0xa8, 0xb0], start - 0x100, iAdsr < 0 ? iWave : iAdsr) >= 0,
      chnCmd: iVars < 0 ? -1 : word(mem, iVars + 5),
      chnNote: iVars < 0 ? -1 : word(mem, iVars + 1),
      hrParam: iHr < 0 ? 0x00 : mem[iHr + 9],
      firstWave: iFw < 0 ? 0x09 : mem[iFw + 6],
      missing,
    });
  }
  return players;
}
