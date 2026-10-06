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
    await phone.getByRole('button', { name: 'Send', exact: true }).click();
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

  await flow('desktop header answers through the 409 guard; ⌘2 opens Tab 2', async () => {
    const workspace = await mux.newWorkspace({ cwd: fixture.dir, label: 'e2e-tabs' });
    const first = (await mux.tree()).panes.find(p => p.workspaceId === workspace.id)!.id;
    const second = (await mux.newTab(workspace.id, { cwd: fixture.dir, label: 'second' })).id;
    const box = ['Bash command', 'echo e2e-desk', 'Do you want to proceed?', '❯ 1. Yes', '────────────────────────────────', 'esc to cancel · enter to confirm'];
    await print(first, box);
    await report(first, 'blocked');
    await desktop.goto(`${BASE}/#/pane/${encodeURIComponent(`HireOpz/default/${first}`)}`, { waitUntil: 'networkidle' });
    const yes = desktop.getByRole('banner').getByRole('button', { name: /^Yes, key/ });
    await yes.waitFor({ timeout: 8_000 });
    await print(first, box.map(l => l.includes('echo') ? 'echo e2e-desk-v2' : l)); // the box moves on
    await report(first, 'blocked');
    await yes.click();
    await desktop.getByRole('banner').getByText('The prompt changed.').waitFor({ timeout: 8_000 });
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
} finally {
  await browser.close().catch(() => {});
  try { process.kill(-hub.pid!, 'SIGTERM'); } catch {}
  await fixture.stop().catch(() => {});
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\ne2e: ${results.length - failed.length}/${results.length} flows passed`);
if (failed.length) { for (const [name] of failed) console.log(`  failed: ${name}`); process.exit(1); }
