import { describe, expect, test } from 'bun:test';
import { qrHalfBlocks, qrMatrix } from '../shared/qr.ts';

function bch(data: number): number {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return rem;
}

function formatBits(matrix: boolean[][]): number {
  let bits = 0;
  const put = (value: boolean, bit: number) => { if (value) bits |= 1 << bit; };
  for (let i = 0; i <= 5; i++) put(matrix[i]![8]!, i);
  put(matrix[7]![8]!, 6); put(matrix[8]![8]!, 7); put(matrix[8]![7]!, 8);
  for (let i = 9; i < 15; i++) put(matrix[8]![14 - i]!, i);
  return bits;
}

function expectFinder(matrix: boolean[][], cx: number, cy: number) {
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
    const distance = Math.max(Math.abs(x), Math.abs(y));
    expect(matrix[cy + y]![cx + x]).toBe(distance !== 2);
  }
}

describe('QR encoder', () => {
  test('creates a square matrix with finder and valid format patterns', () => {
    const matrix = qrMatrix('tautan');
    expect(matrix).toHaveLength(21);
    expect(matrix.every(row => row.length === matrix.length)).toBe(true);
    expectFinder(matrix, 3, 3); expectFinder(matrix, 17, 3); expectFinder(matrix, 3, 17);
    const raw = formatBits(matrix) ^ 0x5412;
    const data = raw >>> 10;
    expect(data >>> 3).toBe(0); // ECC M format bits
    expect(data & 7).toBeLessThan(8);
    expect(raw & 0x3ff).toBe(bch(data));
  });

  test('is deterministic and grows by four modules for each version', () => {
    expect(qrMatrix('tautan')).toEqual(qrMatrix('tautan'));
    const sizes = [14, 15, 27, 43, 63].map(length => qrMatrix('a'.repeat(length)).length);
    expect(sizes).toEqual([21, 25, 29, 33, 37]);
    expect(qrHalfBlocks('tautan').split('\n')).toHaveLength(13);
  });

  test('encodes the version 5-M byte boundary', () => {
    expect(qrMatrix('a'.repeat(84))).toHaveLength(37);
    expect(() => qrMatrix('a'.repeat(85))).toThrow('too long (maximum 84 bytes)');
  });

  // Cross-validation against an independent QR decoder remains unavailable without adding a dependency.
  test('uses UTF-8 byte length for the capacity limit', () => {
    expect(qrMatrix('😀'.repeat(21))).toHaveLength(37);
    expect(() => qrMatrix('😀'.repeat(22))).toThrow('too long (maximum 84 bytes)');
  });
});
