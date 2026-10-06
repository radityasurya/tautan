type Version = { capacity: number; data: number; ecc: number; blocks: number; align: number[] };

// Byte mode, ECC M. The capacity includes the mode and character-count fields.
const VERSIONS: Version[] = [
  { capacity: 14, data: 16, ecc: 10, blocks: 1, align: [] },
  { capacity: 26, data: 28, ecc: 16, blocks: 1, align: [6, 18] },
  { capacity: 42, data: 44, ecc: 26, blocks: 1, align: [6, 22] },
  { capacity: 62, data: 64, ecc: 18, blocks: 2, align: [6, 26] },
  { capacity: 84, data: 86, ecc: 24, blocks: 2, align: [6, 30] },
];

const mul = (x: number, y: number) => {
  let z = 0;
  for (; y; y >>>= 1, x = (x << 1) ^ (x >>> 7 ? 0x11d : 0)) if (y & 1) z ^= x;
  return z;
};

function divisor(degree: number): number[] {
  const result = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    result.push(0);
    for (let j = result.length - 1; j > 0; j--) result[j] = mul(result[j]!, root) ^ result[j - 1]!;
    result[0] = mul(result[0]!, root);
    root = mul(root, 2);
  }
  return result.reverse();
}

function remainder(data: number[], poly: number[]): number[] {
  const result = Array(poly.length - 1).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < result.length; i++) result[i] ^= mul(poly[i + 1]!, factor);
  }
  return result;
}

function codewords(bytes: Uint8Array, version: Version): number[] {
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(4, 4); put(bytes.length, 8);
  for (const byte of bytes) put(byte, 8);
  const capacity = version.data * 8;
  for (let i = 0; i < Math.min(4, capacity - bits.length); i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, bit) => (n << 1) | bit, 0));
  for (let pad = 0; data.length < version.data; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  const blockLength = version.data / version.blocks;
  const blocks = Array.from({ length: version.blocks }, (_, i) => data.slice(i * blockLength, (i + 1) * blockLength));
  const checks = blocks.map(block => remainder(block, divisor(version.ecc)));
  const output: number[] = [];
  for (let i = 0; i < blockLength; i++) for (const block of blocks) output.push(block[i]!);
  for (let i = 0; i < version.ecc; i++) for (const check of checks) output.push(check[i]!);
  return output;
}

function bch(data: number): number {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return rem;
}

function maskBit(mask: number, x: number, y: number): boolean {
  const product = x * y;
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return product % 2 + product % 3 === 0;
    case 6: return (product % 2 + product % 3) % 2 === 0;
    default: return ((x + y) % 2 + product % 3) % 2 === 0;
  }
}

function penalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;
  for (let axis = 0; axis < 2; axis++) for (let line = 0; line < size; line++) {
    let run = 1;
    for (let i = 1; i < size; i++) {
      const here = axis ? matrix[i]![line]! : matrix[line]![i]!;
      const previous = axis ? matrix[i - 1]![line]! : matrix[line]![i - 1]!;
      if (here === previous) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
    for (let i = 0; i <= size - 11; i++) {
      const bit = (at: number) => axis ? matrix[at]![line]! : matrix[line]![at]!;
      const before = i >= 4 && !bit(i - 1) && !bit(i - 2) && !bit(i - 3) && !bit(i - 4);
      const after = !bit(i + 7) && !bit(i + 8) && !bit(i + 9) && !bit(i + 10);
      if (bit(i) && !bit(i + 1) && bit(i + 2) && bit(i + 3) && bit(i + 4) && !bit(i + 5) && bit(i + 6) && (before || after)) score += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const color = matrix[y]![x]!;
    if (color === matrix[y]![x + 1]! && color === matrix[y + 1]![x]! && color === matrix[y + 1]![x + 1]!) score += 3;
  }
  const dark = matrix.flat().filter(Boolean).length;
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

/** Returns an unbordered QR matrix for byte mode, ECC level M, versions 1 through 5. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = VERSIONS.find(entry => bytes.length <= entry.capacity);
  if (!version) throw new Error('too long (maximum 84 bytes)');
  const number = VERSIONS.indexOf(version) + 1;
  const size = number * 4 + 17;
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const functional = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { matrix[y]![x] = dark; functional[y]![x] = true; };
  const finder = (cx: number, cy: number) => {
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const xx = cx + x, yy = cy + y;
      if (xx >= 0 && yy >= 0 && xx < size && yy < size) {
        const distance = Math.max(Math.abs(x), Math.abs(y));
        set(xx, yy, distance !== 2 && distance !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 8; i < size - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }
  for (const y of version.align) for (const x of version.align) {
    if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (mask: number, target: boolean[][]) => {
    const bits = ((mask << 10) | bch(mask)) ^ 0x5412;
    const put = (x: number, y: number, bit: number) => { target[y]![x] = Boolean((bits >>> bit) & 1); functional[y]![x] = true; };
    for (let i = 0; i <= 5; i++) put(8, i, i);
    put(8, 7, 6); put(8, 8, 7); put(7, 8, 8);
    for (let i = 9; i < 15; i++) put(14 - i, 8, i);
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, i);
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, i);
    target[size - 8]![8] = true; functional[size - 8]![8] = true;
  };
  format(0, matrix as boolean[][]);
  const words = codewords(bytes, version);
  let bit = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (let x = right; x >= right - 1; x--) if (matrix[y]![x] === null) {
        matrix[y]![x] = bit < words.length * 8 && Boolean((words[Math.floor(bit / 8)]! >>> (7 - bit % 8)) & 1);
        bit++;
      }
    }
    upward = !upward;
  }
  const base = matrix as boolean[][];
  let best: boolean[][] | undefined;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map(row => [...row]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!functional[y]![x] && maskBit(mask, x, y)) candidate[y]![x] = !candidate[y]![x];
    format(mask, candidate);
    const score = penalty(candidate);
    if (score < bestPenalty) { bestPenalty = score; best = candidate; }
  }
  return best!;
}

/** Renders the matrix with a two-module quiet zone using Unicode half-block characters. */
export function qrHalfBlocks(text: string): string {
  const matrix = qrMatrix(text);
  const size = matrix.length + 4;
  const module = (x: number, y: number) => x >= 2 && y >= 2 && x < size - 2 && y < size - 2 && matrix[y - 2]![x - 2]!;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = module(x, y), bottom = module(x, y + 1);
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(line);
  }
  return lines.join('\n');
}
