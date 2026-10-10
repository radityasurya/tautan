import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Explain, Mux, Pane, Screen, ScreenMode, Tree, Workspace } from '../shared/types.ts';
import { Hub } from '../server/mux.ts';
import { configureSuggest, parseSuggestions, SUGGEST_SYSTEM, type SuggestAdapter } from '../server/suggest.ts';

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(true); });
const canListen = (() => {
  try { const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() }); server.stop(); return true; }
  catch { return false; }
})();

const fakeMux = (pane: Pane, onRead?: () => void): Mux => {
  const tree: Tree = { workspaces: [{ id: 'w', label: 'Work' }], tabs: [{ id: 't', workspaceId: 'w', label: 'Tab' }], panes: [pane] };
  return {
    kind: 'herdr', id: 'fake', tree: async () => tree,
    read: async (_id: string, mode: ScreenMode): Promise<Screen> => { onRead?.(); return { text: '\n first \n\n latest output \n', ansi: false, revision: pane.revision, mode }; },
    sendText: async () => {}, sendKeys: async () => {}, sendRaw: async () => {}, onChange: () => () => {},
    newTab: async (): Promise<Pane> => pane, newWorkspace: async (): Promise<Workspace> => tree.workspaces[0]!,
    rename: async () => {}, closePane: async () => {}, zoom: async () => {}, closeWorkspace: async () => {}, split: async () => '', swap: async () => {}, move: async () => '', resize: async () => {}, explain: async (): Promise<Explain | null> => null, close: () => {},
  };
};

describe('suggest parser', () => {
  test('parses arrays from plain, prose, and fenced text', () => {
    expect(parseSuggestions('[" a ","b","c"]')).toEqual(['a', 'b', 'c']);
    expect(parseSuggestions('Sure! ["a","b","c"] hope that helps')).toEqual(['a', 'b', 'c']);
    expect(parseSuggestions('```json\n["a", "b", "c"]\n```')).toEqual(['a', 'b', 'c']);
    expect(parseSuggestions('[" a ", "", "  ", "b", "c", "d"]')).toEqual(['a', 'b', 'c']);
  });

});

describe.skipIf(!canListen)('suggest adapter HTTP', () => {
  test('sends Anthropic Messages format and returns trimmed strings', async () => {
    let captured: Request | undefined; let body: any;
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
      captured = request; body = await request.json();
      return Response.json({ content: [{ type: 'text', text: 'Here: [" yes "," no "," inspect logs "]' }] });
    } }); servers.push(server);
    const adapter = configureSuggest({ TAUTAN_SUGGEST: 'zai', TAUTAN_SUGGEST_KEY: 'test-key', TAUTAN_SUGGEST_BASE: `http://127.0.0.1:${server.port}`, TAUTAN_SUGGEST_MODEL: 'test-model' })!;
    expect(await adapter.suggest('visible output')).toEqual(['yes', 'no', 'inspect logs']);
    expect(new URL(captured!.url).pathname).toBe('/v1/messages');
    expect(captured!.headers.get('x-api-key')).toBe('test-key');
    expect(captured!.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(captured!.headers.get('content-type')).toBe('application/json');
    expect(body).toEqual({ model: 'test-model', max_tokens: 300, system: SUGGEST_SYSTEM, messages: [{ role: 'user', content: 'visible output' }] });
  });

  test('times out without throwing and warns only once', async () => {
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async () => { await new Promise(() => {}); return new Response(); } }); servers.push(server);
    const adapter = configureSuggest({ TAUTAN_SUGGEST: 'anthropic', TAUTAN_SUGGEST_KEY: 'test-key', TAUTAN_SUGGEST_BASE: `http://127.0.0.1:${server.port}` }, { timeoutMs: 20 })!;
    const original = console.warn; const warnings: unknown[][] = []; console.warn = (...args) => { warnings.push(args); };
    try { expect(await adapter.suggest('one')).toBeNull(); expect(await adapter.suggest('two')).toBeNull(); } finally { console.warn = original; }
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toMatch(/^tautan: suggest failed \(anthropic\): /);
  });
});

describe('Hub suggestion trigger', () => {
  test('caches one automatic request per Pane revision', async () => {
    const pane: Pane = { id: 'p', tabId: 't', workspaceId: 'w', title: 'Agent', agent: 'codex', status: 'working', revision: 7 };
    let requests = 0;
    const suggest: SuggestAdapter = { provider: 'zai', model: 'fake', suggest: async () => { requests++; return ['Continue']; } };
    const old = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'tautan-suggest-'));
    const hub = new Hub({ refreshMs: 0, suggest }); hub.add('local', fakeMux(pane));
    try {
      await hub.state(); hub.setSuggestEnabled(true); pane.status = 'blocked';
      await hub.refreshHost('local'); await Bun.sleep(0);
      await hub.refreshHost('local'); await Bun.sleep(0);
      expect(requests).toBe(1);
      expect((await hub.state()).panes[0]!.suggestions).toEqual(['Continue']);
    } finally { hub.close(); if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; }
  });

  test('a failed call caches nothing, and the next refresh asks again', async () => {
    const pane: Pane = { id: 'p', tabId: 't', workspaceId: 'w', title: 'Agent', agent: 'codex', status: 'working', revision: 7 };
    let requests = 0, fail = true;
    const suggest: SuggestAdapter = { provider: 'zai', model: 'fake', suggest: async () => { requests++; return fail ? null : ['Back']; } };
    const old = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'tautan-suggest-retry-'));
    const hub = new Hub({ refreshMs: 0, suggest }); hub.add('local', fakeMux(pane));
    try {
      await hub.state(); hub.setSuggestEnabled(true); pane.status = 'blocked';
      await hub.refreshHost('local'); await Bun.sleep(0);
      expect(requests).toBe(1);
      expect((await hub.state()).panes[0]!.suggestions).toBeUndefined(); // the failure cached nothing
      await Bun.sleep(1_050); // the in-flight key clears on a timer, not on the failure's own recompute
      fail = false;
      await hub.refreshHost('local'); await Bun.sleep(0);
      expect(requests).toBe(2);
      expect((await hub.state()).panes[0]!.suggestions).toEqual(['Back']);
    } finally { hub.close(); if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; }
  });

  test('does not request while disabled', async () => {
    const pane: Pane = { id: 'p', tabId: 't', workspaceId: 'w', title: 'Agent', agent: 'codex', status: 'blocked', revision: 1 };
    let requests = 0;
    const suggest: SuggestAdapter = { provider: 'zai', model: 'fake', suggest: async () => { requests++; return []; } };
    const old = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'tautan-suggest-off-'));
    const hub = new Hub({ refreshMs: 0, suggest }); hub.add('local', fakeMux(pane));
    try { await hub.state(); await hub.refreshHost('local'); await Bun.sleep(0); expect(requests).toBe(0); }
    finally { hub.close(); if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; }
  });

  test('forceSuggest does not duplicate an in-flight request, and is a no-op while disabled', async () => {
    let requests = 0;
    const suggest: SuggestAdapter = { provider: 'zai', model: 'fake', suggest: async () => { requests++; return ['Continue']; } };
    const old = process.env.XDG_STATE_HOME;

    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'tautan-suggest-force-'));
    const pane: Pane = { id: 'p', tabId: 't', workspaceId: 'w', title: 'Agent', agent: 'codex', status: 'working', revision: 3 };
    const hub = new Hub({ refreshMs: 0, suggest }); hub.add('local', fakeMux(pane));
    try {
      await hub.state(); hub.setSuggestEnabled(true); pane.status = 'blocked';
      await hub.refreshHost('local');
      await hub.forceSuggest('local/fake/p');
      await Bun.sleep(0);
      expect(requests).toBe(1);
    } finally { hub.close(); }

    process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'tautan-suggest-force-off-'));
    const offPane: Pane = { id: 'p', tabId: 't', workspaceId: 'w', title: 'Agent', agent: 'codex', status: 'blocked', revision: 1 };
    const offHub = new Hub({ refreshMs: 0, suggest }); offHub.add('local', fakeMux(offPane));
    try {
      await offHub.state();
      const result = await offHub.forceSuggest('local/fake/p');
      expect(requests).toBe(1);
      expect(result.suggestions).toBeUndefined();
    } finally { offHub.close(); if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old; }
  });
});
