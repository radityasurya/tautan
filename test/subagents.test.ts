import { expect, test } from 'bun:test';
import { finishedIn, subagentChips, subagentName, subagentRows, subagentRunning } from '../web/subagents.ts';
import { fitPreview, linkLabel, previewSrc, safeLink } from '../web/preview.tsx';

test('a subagent reads as type · description, or the type alone', () => {
  expect(subagentName({ id: 'a', type: 'Explore', description: 'Find the routes' })).toBe('Explore · Find the routes');
  expect(subagentName({ id: 'a', type: 'Explore' })).toBe('Explore');
  expect(subagentName({ id: 'a', description: '  ' })).toBe('Subagent');
});

test('chips follow the rows: running first, then newest; a nested one names its parent', () => {
  const list = [
    { id: 'late', type: 'Plan', at: 30 },
    { id: 'child', type: 'Explore', description: 'Read fixtures', parentId: 'mid', at: 25 },
    { id: 'undated', type: 'Explore' },
    { id: 'mid', type: 'general-purpose', at: 20 },
    { id: 'orphan', type: 'Explore', parentId: 'gone', at: 10 },
  ];
  const chips = subagentChips(list, (agent) => agent.id === 'mid' || agent.id === 'child');
  expect(chips.map((c) => `${c.id}:${c.depth}:${c.running}`)).toEqual(['mid:0:true', 'child:1:true', 'late:0:false', 'orphan:0:false', 'undated:0:false']);
  expect(chips.find((c) => c.id === 'child')!.label).toBe('general-purpose › Explore · Read fixtures');
  expect(chips.find((c) => c.id === 'orphan')!.label).toBe('Explore');
});

test('the rows nest each subagent under its parent, siblings newest first, a cycle still listed', () => {
  const rows = subagentRows([
    { id: 'late', at: 30 },
    { id: 'child', parentId: 'mid', at: 25 },
    { id: 'grandchild', parentId: 'child', at: 26 },
    { id: 'undated' },
    { id: 'mid', at: 20 },
    { id: 'orphan', parentId: 'gone', at: 10 },
    { id: 'loopA', parentId: 'loopB', at: 40 },
    { id: 'loopB', parentId: 'loopA', at: 41 },
  ]);
  expect(rows.map((r) => `${r.agent.id}:${r.depth}`)).toEqual([
    'late:0', 'mid:0', 'child:1', 'grandchild:2', 'orphan:0', 'undated:0', 'loopB:0', 'loopA:1',
  ]);
});

test('a subagent runs while the Pane is live and no Task row of it or a parent has a result', () => {
  const list = [{ id: 'a' }, { id: 'b', parentId: 'a' }, { id: 'c' }];
  const finished = new Set(finishedIn([
    { role: 'assistant', text: '', tools: [
      { name: 'Task', brief: '', detail: '', subagentId: 'a', result: 'done' },
      { name: 'Task', brief: '', detail: '', subagentId: 'c' },
    ] },
  ]));
  expect([...finished]).toEqual(['a']);
  expect(list.map((agent) => subagentRunning(agent, list, finished, true))).toEqual([false, false, true]);
  expect(list.map((agent) => subagentRunning(agent, list, finished, false))).toEqual([false, false, false]);
});

test('the Hub state wins over the guess; the guess holds when it is absent', () => {
  const list = [
    { id: 'a', state: 'done' as const },
    { id: 'b', state: 'running' as const, parentId: 'a' },
    { id: 'c' },
  ];
  const finished = new Set(['b']); // the guess says b is done; the Hub says it runs
  expect(list.map((agent) => subagentRunning(agent, list, finished, true))).toEqual([false, true, true]);
  expect(subagentRunning(list[2]!, list, finished, false)).toBe(false); // absent state: the guess
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
