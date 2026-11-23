// Read-only access to 1541 disk images (.d64), enough to pull song files out.

export interface D64Entry { name: string; type: string; blocks: number; track: number; sector: number }

function sectorsPerTrack(track: number): number {
  return track <= 17 ? 21 : track <= 24 ? 19 : track <= 30 ? 18 : 17;
}

function offset(track: number, sector: number): number {
  let o = 0;
  for (let t = 1; t < track; t++) o += sectorsPerTrack(t);
  return (o + sector) * 256;
}

export function isD64(data: Uint8Array): boolean {
  return data.length === 174848 || data.length === 175531 || data.length === 196608 || data.length === 197376;
}

function petsciiName(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    if (b === 0xa0) break;
    if (b >= 0x41 && b <= 0x5a) s += String.fromCharCode(b);
    else if (b >= 0xc1 && b <= 0xda) s += String.fromCharCode(b - 0x80);
    else if (b >= 0x20 && b <= 0x3f) s += String.fromCharCode(b);
    else s += '?';
  }
  return s;
}

const TYPES = ['DEL', 'SEQ', 'PRG', 'USR', 'REL'];

export function d64Directory(image: Uint8Array): D64Entry[] {
  const entries: D64Entry[] = [];
  let track = 18, sector = 1, guard = 0;
  while (track !== 0 && guard++ < 40) {
    const o = offset(track, sector);
    if (o + 256 > image.length) break;
    for (let i = 0; i < 8; i++) {
      const e = image.subarray(o + i * 32, o + i * 32 + 32);
      if ((e[2] & 0x07) === 0 && e[2] === 0) continue;
      entries.push({
        name: petsciiName(e.subarray(5, 21)),
        type: TYPES[e[2] & 0x07] ?? '???',
        blocks: e[30] | (e[31] << 8),
        track: e[3],
        sector: e[4],
      });
    }
    track = image[o];
    sector = image[o + 1];
  }
  return entries;
}

export function d64ReadFile(image: Uint8Array, entry: D64Entry): Uint8Array {
  const out: number[] = [];
  let track = entry.track, sector = entry.sector, guard = 0;
  while (track !== 0 && guard++ < 800) {
    const o = offset(track, sector);
    if (o + 256 > image.length) break;
    const nt = image[o], ns = image[o + 1];
    const end = nt === 0 ? ns + 1 : 256;
    for (let i = 2; i < end; i++) out.push(image[o + i]);
    track = nt;
    sector = ns;
  }
  return Uint8Array.from(out);
}
