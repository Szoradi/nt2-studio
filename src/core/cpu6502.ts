// Small MOS 6502 core (official opcodes, binary mode arithmetic only). It runs
// the original NinjaTracker playroutine so playback matches the real code.

import { OPCODES, type Mode } from './asm6502.ts';

const NAMES = Object.keys(OPCODES);
const opName = new Int16Array(256).fill(-1);
const opMode: (Mode | null)[] = new Array(256).fill(null);
for (let n = 0; n < NAMES.length; n++) {
  const modes = OPCODES[NAMES[n]];
  for (const m of Object.keys(modes) as Mode[]) {
    opName[modes[m]!] = n;
    opMode[modes[m]!] = m;
  }
}
const ID: Record<string, number> = {};
NAMES.forEach((n, i) => (ID[n] = i));

const MODE_CYCLES: Record<Mode, number> = {
  imp: 2, imm: 2, zp: 3, zpx: 4, zpy: 4, abs: 4, abx: 4, aby: 4, ind: 5, inx: 6, iny: 5, rel: 2,
};

export class CPU6502 {
  mem: Uint8Array;
  a = 0; x = 0; y = 0; sp = 0xff; pc = 0;
  n = 0; v = 0; z = 0; c = 0; i = 0; d = 0;
  cycles = 0;
  /** Called for every memory write, after the byte is stored. */
  onWrite: ((addr: number, value: number, cycle: number) => void) | null = null;

  constructor(mem: Uint8Array) {
    this.mem = mem;
  }

  private wr(addr: number, value: number) {
    this.mem[addr] = value;
    if (this.onWrite) this.onWrite(addr, value, this.cycles);
  }
  private push(v: number) { this.mem[0x100 + this.sp] = v; this.sp = (this.sp - 1) & 0xff; }
  private pull(): number { this.sp = (this.sp + 1) & 0xff; return this.mem[0x100 + this.sp]; }
  private nz(v: number): number { this.n = v >> 7; this.z = v === 0 ? 1 : 0; return v; }
  private status(): number {
    return (this.n << 7) | (this.v << 6) | 0x30 | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c;
  }
  private adc(m: number) {
    const r = this.a + m + this.c;
    this.v = (~(this.a ^ m) & (this.a ^ r) & 0x80) ? 1 : 0;
    this.c = r > 0xff ? 1 : 0;
    this.a = this.nz(r & 0xff);
  }
  private cmp(reg: number, m: number) {
    const r = reg - m;
    this.c = r >= 0 ? 1 : 0;
    this.nz(r & 0xff);
  }

  /** Call a subroutine and run until it returns. Returns false if it did not finish. */
  call(addr: number, maxInstructions = 100000): boolean {
    this.sp = 0xff;
    this.push(0xff);
    this.push(0xfe);
    this.pc = addr;
    for (let k = 0; k < maxInstructions; k++) {
      if (this.pc === 0xffff) return true;
      this.step();
    }
    return false;
  }

  step() {
    const mem = this.mem;
    const op = mem[this.pc];
    const name = opName[op];
    const mode = opMode[op];
    if (name < 0 || mode === null) {
      // Unknown opcode: treat as a return so a crashed player cannot hang the host
      this.pc = 0xffff;
      return;
    }
    let pc = (this.pc + 1) & 0xffff;
    let addr = -1;
    switch (mode) {
      case 'imp': break;
      case 'imm': addr = pc; pc++; break;
      case 'zp': addr = mem[pc]; pc++; break;
      case 'zpx': addr = (mem[pc] + this.x) & 0xff; pc++; break;
      case 'zpy': addr = (mem[pc] + this.y) & 0xff; pc++; break;
      case 'abs': addr = mem[pc] | (mem[pc + 1] << 8); pc += 2; break;
      case 'abx': addr = ((mem[pc] | (mem[pc + 1] << 8)) + this.x) & 0xffff; pc += 2; break;
      case 'aby': addr = ((mem[pc] | (mem[pc + 1] << 8)) + this.y) & 0xffff; pc += 2; break;
      case 'ind': { const p = mem[pc] | (mem[pc + 1] << 8); addr = mem[p] | (mem[(p & 0xff00) | ((p + 1) & 0xff)] << 8); pc += 2; break; }
      case 'inx': { const p = (mem[pc] + this.x) & 0xff; addr = mem[p] | (mem[(p + 1) & 0xff] << 8); pc++; break; }
      case 'iny': { const p = mem[pc]; addr = ((mem[p] | (mem[(p + 1) & 0xff] << 8)) + this.y) & 0xffff; pc++; break; }
      case 'rel': { const o = mem[pc]; pc++; addr = (pc + (o < 0x80 ? o : o - 0x100)) & 0xffff; break; }
    }
    pc &= 0xffff;
    this.cycles += MODE_CYCLES[mode];
    let t: number;
    switch (name) {
      case ID.lda: this.a = this.nz(mem[addr]); break;
      case ID.ldx: this.x = this.nz(mem[addr]); break;
      case ID.ldy: this.y = this.nz(mem[addr]); break;
      case ID.sta: this.wr(addr, this.a); break;
      case ID.stx: this.wr(addr, this.x); break;
      case ID.sty: this.wr(addr, this.y); break;
      case ID.adc: this.adc(mem[addr]); break;
      case ID.sbc: this.adc(mem[addr] ^ 0xff); break;
      case ID.and: this.a = this.nz(this.a & mem[addr]); break;
      case ID.ora: this.a = this.nz(this.a | mem[addr]); break;
      case ID.eor: this.a = this.nz(this.a ^ mem[addr]); break;
      case ID.cmp: this.cmp(this.a, mem[addr]); break;
      case ID.cpx: this.cmp(this.x, mem[addr]); break;
      case ID.cpy: this.cmp(this.y, mem[addr]); break;
      case ID.bit: t = mem[addr]; this.n = t >> 7; this.v = (t >> 6) & 1; this.z = (t & this.a) === 0 ? 1 : 0; break;
      case ID.inc: this.cycles += 2; this.wr(addr, this.nz((mem[addr] + 1) & 0xff)); break;
      case ID.dec: this.cycles += 2; this.wr(addr, this.nz((mem[addr] - 1) & 0xff)); break;
      case ID.asl:
        if (mode === 'imp') { this.c = this.a >> 7; this.a = this.nz((this.a << 1) & 0xff); }
        else { this.cycles += 2; t = mem[addr]; this.c = t >> 7; this.wr(addr, this.nz((t << 1) & 0xff)); }
        break;
      case ID.lsr:
        if (mode === 'imp') { this.c = this.a & 1; this.a = this.nz(this.a >> 1); }
        else { this.cycles += 2; t = mem[addr]; this.c = t & 1; this.wr(addr, this.nz(t >> 1)); }
        break;
      case ID.rol:
        if (mode === 'imp') { t = (this.a << 1) | this.c; this.c = this.a >> 7; this.a = this.nz(t & 0xff); }
        else { this.cycles += 2; t = (mem[addr] << 1) | this.c; this.c = mem[addr] >> 7; this.wr(addr, this.nz(t & 0xff)); }
        break;
      case ID.ror:
        if (mode === 'imp') { t = (this.a >> 1) | (this.c << 7); this.c = this.a & 1; this.a = this.nz(t); }
        else { this.cycles += 2; t = (mem[addr] >> 1) | (this.c << 7); this.c = mem[addr] & 1; this.wr(addr, this.nz(t)); }
        break;
      case ID.inx: this.x = this.nz((this.x + 1) & 0xff); break;
      case ID.iny: this.y = this.nz((this.y + 1) & 0xff); break;
      case ID.dex: this.x = this.nz((this.x - 1) & 0xff); break;
      case ID.dey: this.y = this.nz((this.y - 1) & 0xff); break;
      case ID.tax: this.x = this.nz(this.a); break;
      case ID.tay: this.y = this.nz(this.a); break;
      case ID.txa: this.a = this.nz(this.x); break;
      case ID.tya: this.a = this.nz(this.y); break;
      case ID.tsx: this.x = this.nz(this.sp); break;
      case ID.txs: this.sp = this.x; break;
      case ID.pha: this.cycles += 1; this.push(this.a); break;
      case ID.pla: this.cycles += 2; this.a = this.nz(this.pull()); break;
      case ID.php: this.cycles += 1; this.push(this.status()); break;
      case ID.plp:
        this.cycles += 2; t = this.pull();
        this.n = t >> 7; this.v = (t >> 6) & 1; this.d = (t >> 3) & 1; this.i = (t >> 2) & 1; this.z = (t >> 1) & 1; this.c = t & 1;
        break;
      case ID.clc: this.c = 0; break;
      case ID.sec: this.c = 1; break;
      case ID.cli: this.i = 0; break;
      case ID.sei: this.i = 1; break;
      case ID.cld: this.d = 0; break;
      case ID.sed: this.d = 1; break;
      case ID.clv: this.v = 0; break;
      case ID.nop: break;
      case ID.jmp: this.cycles -= 1; pc = addr; break;
      case ID.jsr: this.cycles += 2; t = (pc - 1) & 0xffff; this.push(t >> 8); this.push(t & 0xff); pc = addr; break;
      case ID.rts: this.cycles += 4; t = this.pull(); t |= this.pull() << 8; pc = (t + 1) & 0xffff; break;
      case ID.rti: this.cycles += 4; this.pull(); t = this.pull(); t |= this.pull() << 8; pc = t; break;
      case ID.brk: pc = 0xffff; break;
      case ID.bcc: if (!this.c) { pc = addr; this.cycles++; } break;
      case ID.bcs: if (this.c) { pc = addr; this.cycles++; } break;
      case ID.beq: if (this.z) { pc = addr; this.cycles++; } break;
      case ID.bne: if (!this.z) { pc = addr; this.cycles++; } break;
      case ID.bmi: if (this.n) { pc = addr; this.cycles++; } break;
      case ID.bpl: if (!this.n) { pc = addr; this.cycles++; } break;
      case ID.bvs: if (this.v) { pc = addr; this.cycles++; } break;
      case ID.bvc: if (!this.v) { pc = addr; this.cycles++; } break;
    }
    this.pc = pc;
  }
}
