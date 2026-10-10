import { expect, test } from 'bun:test';
import { absolute, crumbs, dirname, filesUrl, pushRecent, viewerFor, homeOf, modified, README } from '../web/folders-logic.ts';

test('crumbs start at ~ under home and at / elsewhere', () => {
  expect(crumbs('/home/me/a/b', '/home/me').map((c) => c.label)).toEqual(['~', 'a', 'b']);
  expect(crumbs('/home/me/a', '/home/me')[2]).toBeUndefined();
  expect(crumbs('/etc/x', '/home/me')).toEqual([
    { label: '/', path: '/' },
    { label: 'etc', path: '/etc' },
    { label: 'x', path: '/etc/x' },
  ]);
  expect(crumbs('/home/meow', '/home/me')[0].label).toBe('/');
});

test('dirname, absolute and viewerFor', () => {
  expect(dirname('/a/b.txt')).toBe('/a');
  expect(dirname('/a')).toBe('/');
  expect(dirname('a.txt')).toBe('');
  expect(absolute('out/a.pdf', '/w/p/')).toBe('/w/p/out/a.pdf');
  expect(absolute('~/a.pdf', '/w')).toBe('~/a.pdf');
  expect(viewerFor('/x/A.PDF')).toBe('pdf');
  expect(viewerFor('a.mp4')).toBe('video');
  expect(viewerFor('a.flac')).toBe('audio');
  expect(viewerFor('a.ts')).toBe('other');
});

test('recents keep newest first without duplicates', () => {
  expect(pushRecent(['/a', '/b', '/c'], '/b', 3)).toEqual(['/b', '/a', '/c']);
  expect(pushRecent(['/a', '/b', '/c'], '/d', 3)).toEqual(['/d', '/a', '/b']);
  expect(filesUrl('list', { host: 'h', path: undefined, pane: 'p' })).toBe('/api/files/list?host=h&pane=p');
});

test('a code host reads: home folder, age, README', () => {
  expect(homeOf('/home/dev/projects/tautan')).toBe('/home/dev');
  expect(homeOf('/Users/dev')).toBe('/Users/dev');
  expect(homeOf('/srv/app')).toBe('');
  const now = Date.UTC(2026, 9, 11, 12);
  const at = (seconds: number) => Math.floor(now / 1000) - seconds;
  expect(modified(undefined, now)).toBe('');
  expect(modified(at(20), now)).toBe('just now');
  expect(modified(at(60), now)).toBe('1 minute ago');
  expect(modified(at(5 * 3600), now)).toBe('5 hours ago');
  expect(modified(at(3 * 86400), now)).toBe('3 days ago');
  expect(modified(at(90 * 86400), now)).not.toContain('ago');
  expect(['README.md', 'readme', 'Readme.markdown'].every((n) => README.test(n))).toBe(true);
  expect(README.test('README.txt')).toBe(false);
});
