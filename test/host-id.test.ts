import { expect, test } from 'bun:test';
import { hostClash, hostId } from '../web/host-id.ts';

const others = [
  { id: 'vps', label: 'VPS', target: 'dev@vps.tail0000.ts.net' },
  { id: 'HireOpz', label: 'HireOpz' }, // the Hub's own Host carries no target
];

test('a Host id comes from the label, else the address', () => {
  expect(hostId('My VPS', 'dev@box')).toBe('my-vps');
  expect(hostId(undefined, 'dev@box.tail0000.ts.net:22')).toBe('box');
  expect(hostId(undefined, '')).toBe('host');
});

test('adding a Host never replaces another one', () => {
  // The same label: the id would collide, and the list used to drop the old entry for it.
  expect(hostClash({ id: 'vps', target: 'root@other' }, others)).toEqual({ kind: 'label', label: 'vps' });
  // A label equal to another Host's id in another case still collides.
  expect(hostClash({ id: 'hireopz', target: 'root@other' }, others)).toEqual({ kind: 'label', label: 'hireopz' });
  // The same machine under a new label.
  expect(hostClash({ id: 'box', target: 'dev@vps.tail0000.ts.net' }, others)).toEqual({ kind: 'target', label: 'VPS' });
  expect(hostClash({ id: 'box', target: 'dev@box' }, others)).toBeNull();
});

test('editing a Host keeps its own id and target', () => {
  expect(hostClash({ id: 'vps', target: 'dev@vps.tail0000.ts.net' }, others, 'vps')).toBeNull();
  expect(hostClash({ id: 'vps', target: 'root@new' }, others, 'vps')).toBeNull();
});
