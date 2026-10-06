import { expect, test } from 'bun:test';
import { subagentChips, subagentName } from '../web/subagents.ts';
import { fitPreview, linkLabel, previewSrc, safeLink } from '../web/preview.tsx';

test('a subagent reads as type · description, or the type alone', () => {
  expect(subagentName({ id: 'a', type: 'Explore', description: 'Find the routes' })).toBe('Explore · Find the routes');
  expect(subagentName({ id: 'a', type: 'Explore' })).toBe('Explore');
  expect(subagentName({ id: 'a', description: '  ' })).toBe('Subagent');
});

test('chips run oldest to newest, unknown times last, a nested one names its parent', () => {
  const chips = subagentChips([
    { id: 'late', type: 'Plan', at: 30 },
    { id: 'child', type: 'Explore', description: 'Read fixtures', parentId: 'mid', at: 25 },
    { id: 'undated', type: 'Explore' },
    { id: 'mid', type: 'general-purpose', at: 20 },
    { id: 'orphan', type: 'Explore', parentId: 'gone', at: 10 },
  ]);
  expect(chips.map((c) => c.id)).toEqual(['orphan', 'mid', 'child', 'late', 'undated']);
  expect(chips.find((c) => c.id === 'child')!.label).toBe('general-purpose › Explore · Read fixtures');
  expect(chips.find((c) => c.id === 'orphan')!.label).toBe('Explore');
});

test('the preview fits 1280×800 into the row width, keeps 16:10, and never enlarges', () => {
  expect(fitPreview(640)).toEqual({ scale: 0.5, height: 400 });
  expect(fitPreview(334)).toEqual({ scale: 334 / 1280, height: 209 });
  expect(fitPreview(2000)).toEqual({ scale: 1, height: 800 });
  expect(fitPreview(0)).toEqual({ scale: 0, height: 0 });
});

test('a link card titles itself from the tool, else the URL', () => {
  expect(linkLabel({ url: 'https://claude.ai/public/artifacts/6f1c-palette', title: 'Palette' })).toEqual({ title: 'Palette', host: 'claude.ai' });
  expect(linkLabel({ url: 'https://claude.ai/public/artifacts/6f1c-palette' })).toEqual({ title: '6f1c-palette', host: 'claude.ai' });
  expect(linkLabel({ url: 'https://claude.ai/' })).toEqual({ title: 'claude.ai', host: 'claude.ai' });
});

test('only an https link opens', () => {
  expect(safeLink('https://claude.ai/x')).toBe('https://claude.ai/x');
  expect(safeLink('javascript:alert(1)')).toBeUndefined();
  expect(safeLink('http://claude.ai/x')).toBeUndefined();
});

test('the preview route carries the subagent', () => {
  expect(previewSrc('mbp/herdr/w1:p2', 3)).toBe('/api/panes/mbp%2Fherdr%2Fw1%3Ap2/chat/preview/3');
  expect(previewSrc('k', 3, 'a 1')).toBe('/api/panes/k/chat/preview/3?agent=a%201');
});
