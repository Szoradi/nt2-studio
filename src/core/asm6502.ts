// Minimal two-pass 6502 assembler for the DASM subset used by the NinjaTracker
// playroutine: labels, "name = expr" constants, dc.b / dc.w and all official
// opcodes. Used to relocate the player to any address (replaces the original
// editor's instruction-table based relocator).

export type Mode =
  | 'imp' | 'imm' | 'zp' | 'zpx' | 'zpy' | 'abs' | 'abx' | 'aby' | 'ind' | 'inx' | 'iny' | 'rel';

type OpTable = Record<string, Partial<Record<Mode, number>>>;

const std = (imm: number, zp: number, zpx: number, abs: number, abx: number, aby: number, inx: number, iny: number) =>
  ({ imm, zp, zpx, abs, abx, aby, inx, iny });
const shift = (imp: number, zp: number, zpx: number, abs: number, abx: number) => ({ imp, zp, zpx, abs, abx });

export const OPCODES: OpTable = {
  adc: std(0x69, 0x65, 0x75, 0x6d, 0x7d, 0x79, 0x61, 0x71),
  and: std(0x29, 0x25, 0x35, 0x2d, 0x3d, 0x39, 0x21, 0x31),
  cmp: std(0xc9, 0xc5, 0xd5, 0xcd, 0xdd, 0xd9, 0xc1, 0xd1),
  eor: std(0x49, 0x45, 0x55, 0x4d, 0x5d, 0x59, 0x41, 0x51),
  lda: std(0xa9, 0xa5, 0xb5, 0xad, 0xbd, 0xb9, 0xa1, 0xb1),
  ora: std(0x09, 0x05, 0x15, 0x0d, 0x1d, 0x19, 0x01, 0x11),
  sbc: std(0xe9, 0xe5, 0xf5, 0xed, 0xfd, 0xf9, 0xe1, 0xf1),
  sta: { zp: 0x85, zpx: 0x95, abs: 0x8d, abx: 0x9d, aby: 0x99, inx: 0x81, iny: 0x91 },
  asl: shift(0x0a, 0x06, 0x16, 0x0e, 0x1e),
  lsr: shift(0x4a, 0x46, 0x56, 0x4e, 0x5e),
  rol: shift(0x2a, 0x26, 0x36, 0x2e, 0x3e),
  ror: shift(0x6a, 0x66, 0x76, 0x6e, 0x7e),
  dec: { zp: 0xc6, zpx: 0xd6, abs: 0xce, abx: 0xde },
  inc: { zp: 0xe6, zpx: 0xf6, abs: 0xee, abx: 0xfe },
  bit: { zp: 0x24, abs: 0x2c },
  cpx: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  cpy: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  ldx: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, aby: 0xbe },
  ldy: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, abx: 0xbc },
  stx: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  sty: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  jmp: { abs: 0x4c, ind: 0x6c },
  jsr: { abs: 0x20 },
  bcc: { rel: 0x90 }, bcs: { rel: 0xb0 }, beq: { rel: 0xf0 }, bmi: { rel: 0x30 },
  bne: { rel: 0xd0 }, bpl: { rel: 0x10 }, bvc: { rel: 0x50 }, bvs: { rel: 0x70 },
  brk: { imp: 0x00 }, clc: { imp: 0x18 }, cld: { imp: 0xd8 }, cli: { imp: 0x58 }, clv: { imp: 0xb8 },
  dex: { imp: 0xca }, dey: { imp: 0x88 }, inx: { imp: 0xe8 }, iny: { imp: 0xc8 }, nop: { imp: 0xea },
  pha: { imp: 0x48 }, php: { imp: 0x08 }, pla: { imp: 0x68 }, plp: { imp: 0x28 },
  rti: { imp: 0x40 }, rts: { imp: 0x60 }, sec: { imp: 0x38 }, sed: { imp: 0xf8 }, sei: { imp: 0x78 },
  tax: { imp: 0xaa }, tay: { imp: 0xa8 }, tsx: { imp: 0xba }, txa: { imp: 0x8a }, txs: { imp: 0x9a }, tya: { imp: 0x98 },
};

export const MODE_SIZE: Record<Mode, number> = {
  imp: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, inx: 2, iny: 2, rel: 2,
};

export interface AsmResult {
  origin: number;
  bytes: Uint8Array;
  symbols: Record<string, number>;
}

class Undefined extends Error {}

function evalExpr(text: string, symbols: Record<string, number>): number {
  let pos = 0;
  const peek = () => {
    while (pos < text.length && text[pos] === ' ') pos++;
    return text[pos];
  };
  const atom = (): number => {
    const ch = peek();
    if (ch === '(') {
      pos++;
      const v = top();
      if (peek() !== ')') throw new Error(`Expected ) in "${text}"`);
      pos++;
      return v;
    }
    if (ch === '-') { pos++; return -atom(); }
    if (ch === '<') { pos++; return top() & 0xff; }
    if (ch === '>') { pos++; return (top() >> 8) & 0xff; }
    if (ch === '$') {
      const m = /^[0-9a-fA-F]+/.exec(text.slice(pos + 1));
      if (!m) throw new Error(`Bad hex number in "${text}"`);
      pos += 1 + m[0].length;
      return parseInt(m[0], 16);
    }
    const num = /^[0-9]+/.exec(text.slice(pos));
    if (num) { pos += num[0].length; return parseInt(num[0], 10); }
    const sym = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos));
    if (!sym) throw new Error(`Bad expression "${text}"`);
    pos += sym[0].length;
    const v = symbols[sym[0]];
    if (v === undefined) throw new Undefined(sym[0]);
    return v;
  };
  const prod = (): number => {
    let v = atom();
    for (;;) {
      const ch = peek();
      if (ch === '*') { pos++; v *= atom(); }
      else if (ch === '/') { pos++; v = Math.floor(v / atom()); }
      else return v;
    }
  };
  const top = (): number => {
    let v = prod();
    for (;;) {
      const ch = peek();
      if (ch === '+') { pos++; v += prod(); }
      else if (ch === '-') { pos++; v -= prod(); }
      else return v;
    }
  };
  const v = top();
  if (peek() !== undefined) throw new Error(`Trailing characters in expression "${text}"`);
  return v;
}

interface Item {
  kind: 'op' | 'bytes' | 'words';
  addr: number;
  mnemonic?: string;
  mode?: Mode;
  expr?: string;
  list?: string[];
  line: number;
}

export function assemble(source: string, origin: number, predefined: Record<string, number> = {}): AsmResult {
  const symbols: Record<string, number> = { ...predefined };
  const items: Item[] = [];
  let pc = origin;
  const lines = source.split('\n');

  lines.forEach((raw, idx) => {
    const semi = raw.indexOf(';');
    let line = (semi >= 0 ? raw.slice(0, semi) : raw).replace(/\s+$/, '');
    if (!line.trim()) return;
    let label: string | null = null;
    if (!/^\s/.test(line)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):?/.exec(line);
      if (!m) throw new Error(`Line ${idx + 1}: bad label`);
      label = m[1];
      line = line.slice(m[0].length);
    }
    const rest = line.trim();
    if (label && rest.startsWith('=')) {
      symbols[label] = evalExpr(rest.slice(1), symbols);
      return;
    }
    if (label) symbols[label] = pc;
    if (!rest) return;
    const sp = rest.search(/\s/);
    const word = (sp < 0 ? rest : rest.slice(0, sp)).toLowerCase();
    const operand = sp < 0 ? '' : rest.slice(sp).trim();

    if (word === 'dc.b' || word === 'dc.w') {
      const list = operand.split(',').map(s => s.trim());
      items.push({ kind: word === 'dc.b' ? 'bytes' : 'words', addr: pc, list, line: idx + 1 });
      pc += list.length * (word === 'dc.b' ? 1 : 2);
      return;
    }
    const modes = OPCODES[word];
    if (!modes) throw new Error(`Line ${idx + 1}: unknown instruction "${word}"`);

    let mode: Mode;
    let expr = operand;
    const lower = operand.toLowerCase().replace(/\s+/g, '');
    if (!operand) mode = 'imp';
    else if (modes.rel !== undefined) mode = 'rel';
    else if (operand.startsWith('#')) { mode = 'imm'; expr = operand.slice(1); }
    else if (lower.startsWith('(') && lower.endsWith('),y')) { mode = 'iny'; expr = operand.slice(operand.indexOf('(') + 1, operand.lastIndexOf(')')); }
    else if (lower.startsWith('(') && lower.endsWith(',x)')) { mode = 'inx'; expr = operand.slice(operand.indexOf('(') + 1, operand.lastIndexOf(',')); }
    else if (word === 'jmp' && lower.startsWith('(') && lower.endsWith(')')) { mode = 'ind'; expr = operand.slice(1, -1); }
    else {
      let index: '' | 'x' | 'y' = '';
      if (lower.endsWith(',x')) { index = 'x'; expr = operand.slice(0, operand.lastIndexOf(',')); }
      else if (lower.endsWith(',y')) { index = 'y'; expr = operand.slice(0, operand.lastIndexOf(',')); }
      const zpMode: Mode = index === 'x' ? 'zpx' : index === 'y' ? 'zpy' : 'zp';
      const absMode: Mode = index === 'x' ? 'abx' : index === 'y' ? 'aby' : 'abs';
      // Like DASM: zeropage addressing only when the value is already known and fits
      let known: number | null = null;
      try { known = evalExpr(expr, symbols); } catch (e) { if (!(e instanceof Undefined)) throw e; }
      mode = known !== null && known >= 0 && known < 0x100 && modes[zpMode] !== undefined ? zpMode : absMode;
    }
    if (modes[mode] === undefined) throw new Error(`Line ${idx + 1}: illegal addressing mode for "${word}"`);
    items.push({ kind: 'op', addr: pc, mnemonic: word, mode, expr, line: idx + 1 });
    pc += MODE_SIZE[mode];
  });

  const bytes = new Uint8Array(pc - origin);
  for (const it of items) {
    let o = it.addr - origin;
    const ev = (e: string) => {
      try { return evalExpr(e, symbols); }
      catch (err) { throw new Error(`Line ${it.line}: ${err instanceof Undefined ? 'undefined symbol ' : ''}${(err as Error).message}`); }
    };
    if (it.kind === 'bytes') for (const e of it.list!) bytes[o++] = ev(e) & 0xff;
    else if (it.kind === 'words') for (const e of it.list!) { const v = ev(e); bytes[o++] = v & 0xff; bytes[o++] = (v >> 8) & 0xff; }
    else {
      const mode = it.mode!;
      bytes[o++] = OPCODES[it.mnemonic!][mode]!;
      if (mode === 'imp') continue;
      const v = ev(it.expr!);
      if (mode === 'rel') {
        const d = v - (it.addr + 2);
        if (d < -128 || d > 127) throw new Error(`Line ${it.line}: branch out of range`);
        bytes[o++] = d & 0xff;
      } else if (MODE_SIZE[mode] === 2) bytes[o++] = v & 0xff;
      else { bytes[o++] = v & 0xff; bytes[o++] = (v >> 8) & 0xff; }
    }
  }
  return { origin, bytes, symbols };
}
