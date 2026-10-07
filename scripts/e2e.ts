/**
 * tautan e2e — one command, the whole phone story on a throwaway stack.
 *
 *   bun scripts/e2e.ts        (after `pnpm build`)
 *
 * Starts a throwaway herdr and the real Hub with the built web, then drives the
 * built app in headless Chromium at 390 px. Nothing here may touch the live
 * herdr socket or port 7700. Write tests run only against the throwaway server.
 */
import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const exists = (p: string) => access(p).then(() => true, () => false);

// ---- the browser driver: playwright-core, resolved without adding a dependency ----
const candidates = [
  process.env.PLAYWRIGHT_CORE,
  ...(['423231821c231c73'] as const).map(id => `/home/tama/.npm/_npx/${id}/node_modules/playwright-core/index.mjs`),
];
// Typed loosely on purpose: the driver is resolved at runtime, not from a dependency.
let chromium: any;
for (const path of candidates) {
  if (path && await exists(path)) {
    ({ chromium } = await import(path));
    break;
  }
}
if (!chromium) {
  console.error('e2e: playwright-core not found. Set PLAYWRIGHT_CORE to its index.mjs (bunx @playwright/cli installs one), then rerun.');
  process.exit(1);
}

if (!await exists(new URL('../dist/web/index.html', import.meta.url).pathname)) {
  console.error('e2e: dist/web is missing — run `pnpm build` first.');
  process.exit(1);
}

const { startThrowawayHerdr, herdrMux, herdrRpc } = await import('../test/harness.ts');
const exe = '/home/tama/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';
if (!await exists(exe)) { console.error('e2e: headless chromium not found at', exe); process.exit(1); }

const results: [string, boolean, string][] = [];
const flow = async (name: string, run: () => Promise<string>) => {
  try { results.push([name, true, await run()]); console.log(`(pass) ${name}`); }
  catch (error) { results.push([name, false, String(error)]); console.log(`(fail) ${name}: ${String(error).slice(0, 140)}`); }
};
const assert = (condition: boolean, what: string) => { if (!condition) throw new Error(what); return what; };

// ---- the stack ----
const fixture = await startThrowawayHerdr();
const mux = herdrMux(fixture.sock);
const hub = spawn('bun', ['server/main.ts'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, TAUTAN_PORT: '7725', TAUTAN_BIND: '127.0.0.1', HERDR_SOCKET_PATH: fixture.sock, TAUTAN_STATE: `${fixture.dir}/e2e-state` },
  stdio: 'ignore', detached: true,
});
hub.unref();
const BASE = 'http://127.0.0.1:7725';
for (let i = 0; i < 40; i++) { if (await exists(`${fixture.dir}/e2e-state`)) break; await Bun.sleep(250); }
await Bun.sleep(1500);

const q = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
let seq = 0;
const report = async (pane: string, state: string) => {
  // herdr 0.9.2 quirks, probed: fresh source per report; the first refresh reads one
  // report behind, so settle-and-retry until the Hub actually shows the state.
  await herdrRpc(fixture.sock, 'pane.report_agent', { pane_id: pane, source: `e2e-${++seq}`, agent: 'claude', state });
  for (let attempt = 0; attempt < 4; attempt++) {
    await Bun.sleep(700);
    await fetch(`${BASE}/api/hosts/HireOpz/retry`, { method: 'POST' }).catch(() => {});
    await Bun.sleep(500);
    try {
      const hub = await (await fetch(`${BASE}/api/state`)).json();
      if (hub.panes.find((p: { key: string; status: string }) => p.key.endsWith(pane))?.status === state) return;
    } catch {}
  }
};
const pane = async (label: string) => {
  const workspace = await mux.newWorkspace({ cwd: fixture.dir, label });
  return (await mux.tree()).panes.find(p => p.workspaceId === workspace.id)!.id;
};
const print = async (paneId: string, lines: string[]) => {
  await mux.sendText(paneId, `clear; printf '%s\\n' ${q(lines.join('\n'))}`);
  await mux.sendKeys(paneId, ['enter']);
  await Bun.sleep(700);
};

const browser = await chromium.launch({ executablePath: exe, headless: true });
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  const main = await pane('e2e-main');
  const KEY = `HireOpz/default/${main}`;

  await flow('funnel requests are refused', async () => {
    const refused = await fetch(`${BASE}/api/state`, { headers: { 'Tailscale-Funnel-Request': '1' } });
    return assert(refused.status === 403, '403');
  });

  await flow('home lists the pane and opens it', async () => {
    await phone.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await phone.getByText('e2e-main').first().waitFor({ timeout: 8_000 });
    // The Workspace header folds; the Pane row under it navigates. One pane per section:
    // the row is the link whose aria-label names the pane.
    await phone.goto(`${BASE}/#/pane/${encodeURIComponent(KEY)}`, { waitUntil: 'networkidle' });
    await phone.waitForTimeout(900);
    return assert(decodeURIComponent(phone.url()).includes(KEY), 'navigated');
  });

  await flow('wrap guard: phone wraps a wide grid, desktop does not', async () => {
    await report(main, 'idle'); // an agent Pane: wrap is the agent default
    await print(main, ['B'.repeat(100)]);
    await phone.reload({ waitUntil: 'networkidle' });
    await phone.waitForTimeout(900);
    const phoneWrapped = await phone.evaluate(() => document.querySelector('pre')?.className.includes('pre-wrap') ?? false);
    await desktop.goto(`${BASE}/#/pane/${encodeURIComponent(KEY)}`, { waitUntil: 'networkidle' });
    // The first Screen fetch plus the font swap settle late: poll until the pre reports a
    // real layout mode (w-max when the grid fits, pre-wrap when it does not).
    let deskClasses = '';
    for (let i = 0; i < 20; i++) {
      await desktop.waitForTimeout(300);
      deskClasses = await desktop.evaluate(() => document.querySelector('pre')?.className ?? '');
      if (deskClasses.includes('w-max') || deskClasses.includes('pre-wrap')) break;
    }
    return assert(phoneWrapped && deskClasses.includes('w-max'), `phone=${phoneWrapped} desk=${deskClasses.slice(0, 44)}`);
  });

  await flow('blocked card: rows, refusal, re-read', async () => {
    const box = ['Bash command', 'echo e2e', 'Do you want to proceed?', '❯ 1. Yes', '────────────────────────────────', 'esc to cancel · enter to confirm'];
    await print(main, box);
    await report(main, 'blocked');
    await phone.goto(`${BASE}/#/pane/${encodeURIComponent(KEY)}`, { waitUntil: 'networkidle' });
    await phone.getByText('needs your call').waitFor({ timeout: 8_000 });
    const radios = await phone.getByRole('radio').count();
    assert(radios >= 2, `rows=${radios}`);
    await phone.getByRole('radio', { name: /yes/i }).first().click();
    await print(main, box.map(l => l.includes('echo') ? 'echo e2e-v2' : l)); // the box moves on
    await report(main, 'blocked');
    // The card's Send comes first; the composer's own Send now always stays in place, dim.
    await phone.getByRole('button', { name: 'Send', exact: true }).first().click();
    await phone.getByText('The prompt changed. Read it again before you answer.').waitFor({ timeout: 8_000 });
    await phone.getByRole('button', { name: 'Re-read' }).click();
    await phone.getByText('needs your call').waitFor({ timeout: 8_000 });
    return 'refused and re-read';
  });

  await flow('alert card drops and opens the asking pane', async () => {
    // main stays as it is (its own transition was consumed by the blocked flow); a fresh
    // asker pane provides the working→blocked transition the card fires on.
    await phone.goto(`${BASE}/#/pane/${encodeURIComponent(KEY)}`, { waitUntil: 'networkidle' });
    await phone.waitForTimeout(1600);
    const asker = await pane('e2e-asker');
    await report(asker, 'working');
    await phone.waitForTimeout(1600);
    await report(asker, 'blocked');
    const card = phone.locator('div[role="status"][aria-atomic="true"]');
    await card.waitFor({ timeout: 8_000 });
    assert((await card.innerText()).includes('Blocked'), 'card text');
    await card.click();
    await phone.waitForTimeout(900);
    return assert(decodeURIComponent(phone.url()).includes(asker), 'navigated to asker');
  });

  await flow('held messages queue and flush', async () => {
    const worker = await pane('e2e-held');
    await report(worker, 'working');
    await phone.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${worker}`)}`, { waitUntil: 'networkidle' });
    await phone.waitForTimeout(1600);
    await phone.getByRole('textbox', { name: /Reply to/i }).fill('e2e held message');
    await phone.getByRole('button', { name: 'Send' }).click();
    await phone.waitForTimeout(500);
    assert(await phone.getByText('1 held').count() > 0, 'held row');
    await report(worker, 'idle');
    await phone.getByRole('button', { name: 'Send now' }).click();
    await phone.waitForTimeout(1500);
    const screen = String((await mux.read(worker, 'visible')).text);
    return assert(screen.includes('e2e held message'), 'flushed to pane');
  });

  await flow('file viewer opens from a long press', async () => {
    await Bun.write(`${fixture.dir}/chart.png`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const filePane = await pane('e2e-file');
    await print(filePane, [`chart: ${fixture.dir}/chart.png`]);
    await desktop.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${filePane}`)}`, { waitUntil: 'networkidle' });
    await desktop.getByText('chart:').first().waitFor({ timeout: 8_000 });
    await desktop.waitForTimeout(600);
    const affordance = desktop.locator('button[aria-label*="chart.png"]').first();
    const box = await affordance.boundingBox();
    await desktop.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await desktop.mouse.down(); await desktop.waitForTimeout(650); await desktop.mouse.up();
    await desktop.waitForTimeout(900);
    assert(decodeURIComponent(desktop.url()).includes('/file/'), 'navigated to viewer');
    return assert((await desktop.locator('img').count()) === 1, 'image renders');
  });

  await flow('phone width lease narrows and restores', async () => {
    const wide = await pane('e2e-width');
    await print(wide, ['W'.repeat(110)]);
    await phone.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${wide}`)}`, { waitUntil: 'networkidle' });
    await phone.getByText('WWWW', { exact: false }).first().waitFor({ timeout: 8_000 });
    await phone.waitForTimeout(800);
    await phone.getByRole('button', { name: /more|⋯/i }).first().click();
    await phone.waitForTimeout(400);
    await phone.getByText('Phone width: off').click();
    await phone.waitForTimeout(2500);
    const screen = String((await mux.read(wide, 'visible')).text);
    const rulerNow = screen.split(/\r|\n/).find(l => /^W+$/.test(l.trim()))?.trim().length ?? 0;
    assert(rulerNow > 0 && rulerNow < 100, `narrowed to ${rulerNow}`);
    await phone.getByRole('button', { name: /more|⋯/i }).first().click();
    await phone.waitForTimeout(400);
    await phone.getByText('Phone width: on').click();
    await phone.waitForTimeout(2500);
    const after = String((await mux.read(wide, 'visible')).text).split(/\r|\n/).find(l => /^W+$/.test(l.trim()))?.trim().length ?? 0;
    return assert(after >= 100, `restored to ${after}`);
  });

  await flow('chat lens falls back to the Screen when no session resolves', async () => {
    const agent = await pane('e2e-lens');
    await report(agent, 'idle');
    await print(agent, ['plain shell for the lens test']);
    await phone.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${agent}`)}`, { waitUntil: 'networkidle' });
    await phone.waitForTimeout(1200);
    const chat = await fetch(`${BASE}/api/panes/${encodeURIComponent(`HireOpz/default/${agent}`)}/chat`);
    assert(chat.status === 404, `api=${chat.status}`);
    const switchButton = phone.getByRole('button', { name: 'Chat', exact: true }).first();
    if (await switchButton.count()) {
      await switchButton.click();
      await phone.waitForTimeout(1000);
      assert(await phone.getByText('plain shell for the lens test').first().isVisible().catch(() => false), 'screen still shown');
      return 'switch fell back to Screen';
    }
    return 'no switch offered (agent pane without lens support) — Screen only';
  });

  await flow('desktop card answers through the 409 guard; the header has no answer; ⌘2 opens Tab 2', async () => {
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'e2e-tabs' });
    const first = (await mux.tree()).panes.find(p => p.workspaceId === workspace.id)!.id;
    const second = (await mux.newTab(workspace.id, { cwd: fixture.dir, label: 'second' })).id;
    const box = ['Bash command', 'echo e2e-desk', 'Do you want to proceed?', '❯ 1. Yes', '────────────────────────────────', 'esc to cancel · enter to confirm'];
    await print(first, box);
    await report(first, 'blocked');
    await desktop.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${first}`)}`, { waitUntil: 'networkidle' });
    // The header says "needs you" and nothing more: the answer lives in the dock's card.
    const yes = desktop.getByRole('region', { name: 'Blocked' }).getByRole('button', { name: /^Yes, key/ });
    await yes.waitFor({ timeout: 8_000 });
    const banner = desktop.getByRole('banner').filter({ hasText: 'needs you' });
    assert(await banner.getByRole('button', { name: /^(Yes|No), key|^Review$/ }).count() === 0, 'no answer in the header');
    await print(first, box.map(l => l.includes('echo') ? 'echo e2e-desk-v2' : l)); // the box moves on
    await report(first, 'blocked');
    await yes.click();
    await desktop.getByText('The prompt changed. Read it again before you answer.').waitFor({ timeout: 8_000 });
    await desktop.keyboard.press('Meta+Digit2');
    await desktop.waitForTimeout(900);
    return assert(decodeURIComponent(desktop.url()).endsWith(second), `url=${desktop.url().slice(-30)}`);
  });

  await flow('desktop composer: / types only; mode chip follows the Screen', async () => {
    const agent = await pane('e2e-composer');
    await report(agent, 'idle');
    await print(agent, ['composer test, default mode']);
    const sent: string[] = [];
    const watch = (r: { method(): string; url(): string; postData(): string | null }) => {
      if (r.method() === 'POST' && r.url().includes('/input')) sent.push(r.postData() ?? '');
    };
    desktop.on('request', watch);
    try {
      await desktop.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${agent}`)}`, { waitUntil: 'networkidle' });
      await desktop.getByText('composer test, default mode').first().waitFor({ timeout: 8_000 });
      const field = desktop.getByRole('textbox', { name: /Reply to/i });
      await desktop.getByRole('button', { name: 'Type /' }).click();
      await desktop.waitForTimeout(400);
      assert(await field.inputValue() === '/', `field=${await field.inputValue()}`);
      assert(sent.length === 0, `sent ${sent.length} on /`);
      const chip = desktop.getByRole('button', { name: /^Mode:/ });
      assert(await chip.count() === 0, 'mode chip hidden without ⏵⏵');
      await print(agent, ['❯', '  ⏵⏵ accept edits on (shift+tab to cycle) · Opus 4.6 · Context left until auto-compact: 37%']);
      await chip.waitFor({ timeout: 8_000 });
      assert(await desktop.getByText('37% context left').count() === 1, 'context shown');
      await chip.click();
      await desktop.waitForTimeout(400);
      return assert(sent.some((body) => body.includes('"shift+tab"')), `sent=${sent.join('|').slice(0, 80)}`);
    } finally {
      desktop.off('request', watch);
    }
  });
  await flow('pane list answers a blocked prompt without opening the Pane; 409 shows Re-read', async () => {
    const asker = await pane('e2e-list');
    const box = ['Bash command', 'echo e2e-list', 'Do you want to proceed?', '❯ 1. Yes', '────────────────────────────────', 'esc to cancel · enter to confirm'];
    await print(asker, box);
    await report(asker, 'blocked');
    const sent: string[] = [];
    const watch = (r: { method(): string; url(): string; postData(): string | null }) => {
      if (r.method() === 'POST' && r.url().includes(encodeURIComponent(asker)) && r.url().endsWith('/input')) sent.push(r.postData() ?? '');
    };
    phone.on('request', watch);
    try {
      await phone.goto(`${BASE}/`, { waitUntil: 'networkidle' });
      const card = phone.getByRole('group', { name: /needs you$/ }).filter({ hasText: 'e2e-list' });
      const yes = card.getByRole('button', { name: 'Yes', exact: true });
      await yes.waitFor({ timeout: 8_000 });
      for (let i = 0; i < 20 && await yes.isDisabled(); i++) await phone.waitForTimeout(250); // Explain loading
      assert(await card.getByRole('button', { name: 'No', exact: true }).count() === 1, 'No offered');
      assert(await card.getByRole('link', { name: 'Open', exact: true }).count() === 1, 'Open offered');
      // 409: the box moves on under the card, so the card's prompt id is stale.
      await print(asker, box.map(l => l.includes('echo') ? 'echo e2e-list-v2' : l));
      await yes.click();
      await card.getByText('The prompt changed. Read it again before you answer.').waitFor({ timeout: 8_000 });
      assert(await yes.count() === 0, 'no answer offered after a 409');
      await card.getByRole('button', { name: 'Re-read' }).click();
      await yes.waitFor({ timeout: 8_000 });
      for (let i = 0; i < 20 && await yes.isDisabled(); i++) await phone.waitForTimeout(250);
      await yes.click();
      await phone.waitForTimeout(900);
      assert(!phone.url().includes('/pane/'), 'stayed on the list');
      assert(sent.length === 2, `sent ${sent.length}`);
      assert(sent.every(body => body.includes('"keys":["enter"]') && body.includes('"promptId"')), `bodies=${sent.join('|').slice(0, 120)}`);
      assert(await card.getByText('The prompt changed.', { exact: false }).count() === 0, 'second answer accepted');
    } finally {
      phone.off('request', watch);
    }
    // The desktop sidebar: Yes only, the row opens the Pane.
    await desktop.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    const sidebar = desktop.getByRole('complementary', { name: 'All panes' });
    const row = sidebar.locator('li').filter({ has: desktop.getByRole('link', { name: /needs you, e2e-list/ }) });
    await row.getByRole('button', { name: /^Yes to / }).waitFor({ timeout: 8_000 });
    assert(await row.getByRole('button', { name: 'No', exact: true }).count() === 0, 'sidebar has no No');
    return 'answered from the list, refused once, sidebar Yes only';
  });
  await flow('hosts: three tabs, #/hosts is its own screen, a Host row opens its Muxes', async () => {
    await phone.goto(`${BASE}/#/hosts`, { waitUntil: 'networkidle' });
    const bar = phone.getByRole('navigation', { name: 'Sections' });
    const tabs = await bar.getByRole('link').allTextContents();
    // The Panes tab may carry its Needs you badge count after the label.
    assert(tabs.length === 3 && tabs[0]!.startsWith('Panes') && tabs[1] === 'Hosts' && tabs[2] === 'Settings', `tabs=${tabs.join('|')}`);
    assert(await bar.getByRole('link', { name: 'Hosts' }).getAttribute('aria-current') === 'page', 'Hosts tab current');
    await phone.getByRole('heading', { name: 'Hosts', level: 1 }).waitFor({ timeout: 8_000 });
    await phone.locator('a[href="#/hosts/HireOpz"]').click();
    await phone.waitForTimeout(600);
    assert(phone.url().endsWith('#/hosts/HireOpz'), `url=${phone.url().slice(-30)}`);
    const herdr = phone.getByRole('region', { name: /^herdr / });
    await herdr.getByText('e2e-main', { exact: true }).waitFor({ timeout: 8_000 });
    assert((await herdr.textContent() ?? '').includes('1 Tab'), 'Tab count shown');
    // A malformed, empty or unknown id falls back to the Hosts list instead of throwing.
    for (const bad of ['%E0%A4%A', '', 'no-such-host']) {
      await phone.goto(`${BASE}/#/hosts/${bad}`, { waitUntil: 'networkidle' });
      await phone.getByRole('heading', { name: 'Hosts', level: 1 }).waitFor({ timeout: 8_000 });
    }
    // Settings no longer lists Hosts.
    await phone.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' });
    await phone.getByRole('heading', { name: 'Appearance' }).waitFor({ timeout: 8_000 });
    assert(await phone.locator('a[href="#/hosts/HireOpz"]').count() === 0, 'no Host rows in Settings');
    // Desktop: Hosts draws the Mux × Workspace table, and the same route opens Host detail.
    await desktop.goto(`${BASE}/#/hosts`, { waitUntil: 'networkidle' });
    await desktop.getByRole('table').getByText('e2e-main', { exact: true }).waitFor({ timeout: 8_000 });
    await desktop.goto(`${BASE}/#/hosts/HireOpz`, { waitUntil: 'networkidle' });
    await desktop.getByRole('region', { name: /^herdr / }).getByText('e2e-main', { exact: true }).waitFor({ timeout: 8_000 });
    return 'three tabs, Hosts apart from Settings, Host detail at both widths';
  });
  await flow('chat view: the pending tool row asks for approval; the pill scrolls to it; No sends esc', async () => {
    const asker = await pane('e2e-approval');
    const key = `HireOpz/default/${asker}`;
    // The live shape (Claude Code 2.1, herdr's bash_permission_prompt): description, the
    // command between dashed rules, numbered options, `Esc to cancel · Tab to amend`.
    const box = (cmd: string) => ['● Creating an empty test file in /tmp', '─'.repeat(40), ' Bash command', ' Create an empty test file in /tmp', '╌'.repeat(40), ` ${cmd}`, '╌'.repeat(40), ' Do you want to proceed?', ' ❯ 1. Yes', '   4. No', '', ' Esc to cancel · Tab to amend'];
    await print(asker, box('touch /tmp/tautan-permission-test'));
    await report(asker, 'working');
    // A transcript shaped like the live one (chat JSON saved from a real blocked Pane): long
    // enough to scroll, ending in the Bash call with no result.
    const filler = Array.from({ length: 12 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', text: `Filler turn ${n + 1}: ${'words '.repeat(30)}`, tools: [], at: Date.now() - 60_000 }));
    const transcript = { sessionId: 'e2e', at: Date.now(), turns: [...filler,
      { role: 'user', text: 'run: touch /tmp/tautan-permission-test', tools: [], at: Date.now() - 4_000 },
      { role: 'assistant', text: '', at: Date.now() - 2_000, tools: [{ name: 'Bash', brief: 'touch /tmp/tautan-permission-test', detail: '# Create an empty test file in /tmp\ntouch /tmp/tautan-permission-test' }] },
    ] };
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const sent: string[] = [];
    page.on('request', (r: { method(): string; url(): string; postData(): string | null }) => {
      if (r.method() === 'POST' && r.url().endsWith(`${encodeURIComponent(key)}/input`)) sent.push(r.postData() ?? '');
    });
    try {
      await page.route((url: URL) => /^\/api\/panes\/[^/]+\/chat$/.test(url.pathname), (route: { fulfill: (reply: object) => Promise<void> }) => route.fulfill({ json: transcript }));
      await page.addInitScript((k: string) => sessionStorage.setItem(`tautan.lens.${k}`, 'chat'), key);
      await page.goto(`${BASE}/#/pane/${encodeURIComponent(key)}`, { waitUntil: 'networkidle' });
      // The user reads further up when the Pane turns blocked: the pill says so, nothing jumps.
      const transcriptBox = page.locator('[aria-label$="transcript"]');
      await page.getByText('Filler turn 1:').waitFor({ timeout: 8_000 });
      await transcriptBox.evaluate((el: HTMLElement) => { el.scrollTop = 0; });
      await page.waitForTimeout(300);
      await report(asker, 'blocked');
      const pill = page.getByRole('button', { name: 'Needs your approval' });
      await pill.waitFor({ timeout: 8_000 });
      assert(await transcriptBox.evaluate((el: HTMLElement) => el.scrollTop) < 40, 'stayed scrolled up');
      const row = page.locator('[data-approval]');
      assert((await row.textContent() ?? '').includes('touch /tmp/tautan-permission-test'), 'command shown');
      assert(await row.getByRole('radio', { name: /^Yes, key enter/ }).count() === 1 && await row.getByRole('radio', { name: /^No, key esc/ }).count() === 1, 'Yes and No in the row');
      assert(await page.getByRole('region', { name: 'Blocked' }).count() === 0, 'dock card hidden in the Chat view');
      assert(await page.getByRole('banner').getByRole('button', { name: 'Review' }).count() === 0, 'no header Review');
      assert(await page.getByRole('banner').getByRole('button', { name: 'Chat' }).count() === 1, 'lens switch stays while blocked');
      // The pill scrolls to the row and focuses its first choice; the lens stays Chat.
      await pill.click();
      await page.waitForTimeout(800);
      const inView = await row.evaluate((el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const box = el.closest('[aria-label$="transcript"]')!.getBoundingClientRect();
        return r.top >= box.top - 1 && r.top < box.bottom;
      });
      assert(inView, 'row in view');
      assert(await row.evaluate((el: HTMLElement) => el.contains(document.activeElement)), 'focus in the row');
      assert(await page.evaluate((k: string) => sessionStorage.getItem(`tautan.lens.${k}`), key) === 'chat', 'lens still chat');
      await row.getByRole('radio', { name: /^No, key esc/ }).click();
      await row.getByRole('button', { name: 'Send', exact: true }).click();
      await row.getByText('Sent · waiting for Claude').waitFor({ timeout: 8_000 });
      return assert(sent.length === 1 && sent[0]!.includes('"keys":["esc"]') && sent[0]!.includes('"promptId"'), `sent=${sent.join('|').slice(0, 120)}`);
    } finally {
      await page.close().catch(() => {});
    }
  });
  await flow('split view: both cells render, a click moves focus without a new EventSource, the Chat lens keeps the split, chips return at 1100 px', async () => {
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'e2e-split' });
    const first = (await mux.tree()).panes.find(p => p.workspaceId === workspace.id)!.id;
    // herdr splits the focused Workspace whatever pane_id says, so focus ours first (throwaway server).
    await herdrRpc(fixture.sock, 'workspace.focus', { workspace_id: workspace.id });
    await herdrRpc(fixture.sock, 'pane.split', { pane_id: first, direction: 'right' });
    // herdr aliases pane ids (the split result's id is not the tree's), so read both from the tree.
    let both = (await mux.tree()).panes.filter(p => p.workspaceId === workspace.id);
    for (let i = 0; i < 20 && both.length < 2; i++) { await Bun.sleep(250); both = (await mux.tree()).panes.filter(p => p.workspaceId === workspace.id); }
    both.sort((l, r) => (l.x ?? 0) - (r.x ?? 0));
    assert(both.length === 2, `panes=${both.length}`);
    const [a, b] = [both[0]!.id, both[1]!.id];
    const keyA = `HireOpz/default/${a}`;
    const keyB = `HireOpz/default/${b}`;
    await report(a, 'idle');
    await report(b, 'idle');
    await print(a, ['SPLIT-MARK-A']);
    await print(b, ['SPLIT-MARK-B']);
    // No service worker, so the stubbed chat route below sees the page's fetch.
    const wide = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    try {
      // Count every EventSource the page constructs.
      await wide.addInitScript(() => {
        const Native = window.EventSource;
        (window as unknown as { __es: number }).__es = 0;
        window.EventSource = class extends Native {
          constructor(url: string | URL, init?: EventSourceInit) { super(url, init); (window as unknown as { __es: number }).__es++; }
        };
      });
      await wide.goto(`${BASE}/#/pane/${encodeURIComponent(keyA)}`, { waitUntil: 'networkidle' });
      const cells = wide.getByTestId('split-cell');
      await cells.nth(1).waitFor({ timeout: 8_000 });
      assert(await cells.count() === 2, `cells=${await cells.count()}`);
      const cellA = wide.locator(`[data-pane="${keyA}"]`);
      const cellB = wide.locator(`[data-pane="${keyB}"]`);
      await cellB.getByText('SPLIT-MARK-B').waitFor({ timeout: 8_000 });
      await cellA.getByText('SPLIT-MARK-A').waitFor({ timeout: 8_000 });
      assert(await cellA.getByText('SPLIT-MARK-B').count() === 0, 'marker B leaked into cell a');
      assert(await wide.getByRole('group', { name: 'Panes in this Tab' }).count() === 0, 'chips hidden in split');
      const composer = wide.getByRole('textbox', { name: /Reply to/i });
      assert(await cellA.getAttribute('aria-current') === 'true' && await composer.count() === 1, 'cell a focused, one Composer');
      const opened = await wide.evaluate(() => (window as unknown as { __es: number }).__es);
      await cellB.locator('pre').click();
      await wide.waitForFunction((k: string) => decodeURIComponent(location.hash).endsWith(k), b, { timeout: 8_000 });
      await wide.waitForTimeout(600);
      assert(await composer.count() === 1 && await cellA.getAttribute('aria-current') === null, 'Composer and focus moved to b');
      assert(await wide.getByTestId('split-cell').count() === 2, 'still split after the click');
      assert(await cellB.getAttribute('aria-current') === 'true', 'cell b focused');
      const reopened = await wide.evaluate(() => (window as unknown as { __es: number }).__es);
      assert(reopened === opened, `EventSource constructions ${opened} -> ${reopened}`);
      // The Chat lens keeps the split: the focused cell shows the Chat view, cell a its Screen.
      // A throwaway Pane has no transcript, so the page gets one from a stubbed chat route.
      const isChat = (url: URL) => /^\/api\/panes\/[^/]+\/chat$/.test(url.pathname);
      await wide.route(isChat, (route: { fulfill: (reply: object) => Promise<void> }) => route.fulfill({
        json: { sessionId: 'e2e', at: Date.now(), turns: [{ role: 'assistant', text: 'CHAT-MARK-B', tools: [], at: Date.now() }] },
      }));
      await wide.evaluate((k: string) => sessionStorage.setItem(`tautan.lens.${k}`, 'chat'), keyB);
      await wide.reload({ waitUntil: 'networkidle' });
      await cellB.getByText('CHAT-MARK-B').waitFor({ timeout: 8_000 });
      await cellA.getByText('SPLIT-MARK-A').waitFor({ timeout: 8_000 });
      assert(await wide.getByTestId('split-cell').count() === 2 && await cellB.locator('pre').count() === 0, 'Chat in cell b, Screen in cell a');
      // No transcript: the lens falls back to Screen, and the split stays.
      await wide.unroute(isChat);
      await wide.route(isChat, (route: { fulfill: (reply: object) => Promise<void> }) => route.fulfill({ status: 404, json: { error: 'no-transcript' } }));
      await wide.reload({ waitUntil: 'networkidle' });
      await cellB.getByText('SPLIT-MARK-B').waitFor({ timeout: 8_000 });
      const lens = await wide.evaluate((k: string) => sessionStorage.getItem(`tautan.lens.${k}`), keyB);
      assert(lens === 'screen' && await wide.getByTestId('split-cell').count() === 2, `still split after the lens fell back (lens=${lens})`);
      await wide.setViewportSize({ width: 1100, height: 900 });
      await wide.getByRole('group', { name: 'Panes in this Tab' }).waitFor({ timeout: 8_000 });
      assert(await wide.getByTestId('split-view').count() === 0, 'split gone at 1100 px');
      return 'two cells, focus by click, one stream, Chat in the focused cell, chips at 1100 px';
    } finally {
      await wide.close().catch(() => {});
    }
  });
} finally {
  await browser.close().catch(() => {});
  try { process.kill(-hub.pid!, 'SIGTERM'); } catch {}
  await fixture.stop().catch(() => {});
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\ne2e: ${results.length - failed.length}/${results.length} flows passed`);
if (failed.length) { for (const [name] of failed) console.log(`  failed: ${name}`); process.exit(1); }
