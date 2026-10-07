import { readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Hub } from './mux.ts';
import type { StatePane } from '../shared/types.ts';

/** GET /api/panes/:key/complete — one item the composer can insert verbatim. */
export interface CompleteItem { value: string; label: string; detail?: string; dir?: boolean }

export class CompleteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The Hub's git runner (server/http.ts); over ssh when a target is given. */
export type GitRunner = (cwd: string, args: string[], target?: string) => Promise<{ stdout: string; stderr: string; code: number }>;

const FILE_CAP = 20_000;
const WALK_CAP = 2_000;
const COMMAND_CAP = 400;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const NAME_OK = /^[A-Za-z0-9:_-]{1,64}$/;

// Static lists verified on this machine, not invented: Claude Code 2.1.292 (the installed
// bundle's command table; /review and /agents are not built-ins there) and pi 1.0.3
// (docs/slash-commands.md in the installed release). Re-check on major upgrades.
const CLAUDE_BUILTINS: CompleteItem[] = [
  { value: '/clear', label: '/clear', detail: 'Start a new session with empty context' },
  { value: '/compact', label: '/compact', detail: 'Free up context by summarizing the conversation so far' },
  { value: '/model', label: '/model', detail: 'Set the AI model for Claude Code' },
  { value: '/help', label: '/help', detail: 'Show help and available commands' },
  { value: '/init', label: '/init', detail: 'Initialize CLAUDE.md file(s)' },
  { value: '/memory', label: '/memory', detail: 'Edit CLAUDE.md files and memory settings' },
  { value: '/config', label: '/config', detail: 'Open settings' },
  { value: '/resume', label: '/resume', detail: 'Resume a previous conversation' },
  { value: '/mcp', label: '/mcp', detail: 'Manage MCP servers' },
  { value: '/permissions', label: '/permissions', detail: 'Manage allow and deny tool permission rules' },
  { value: '/status', label: '/status', detail: 'Show version, model, account and connectivity' },
  { value: '/usage', label: '/usage', detail: 'Show session cost and plan usage' },
  { value: '/cost', label: '/cost', detail: 'Alias of /usage: session cost and plan usage' },
];
const PI_BUILTINS: CompleteItem[] = [
  { value: '/settings', label: '/settings', detail: 'Open settings' },
  { value: '/model', label: '/model', detail: 'Select a model' },
  { value: '/thinking', label: '/thinking', detail: 'Set the thinking level' },
  { value: '/scoped-models', label: '/scoped-models', detail: 'Configure the models used by interactive cycling' },
  { value: '/login', label: '/login', detail: 'Add provider authentication' },
  { value: '/logout', label: '/logout', detail: 'Remove provider authentication' },
  { value: '/llama', label: '/llama', detail: 'Manage models on the configured llama.cpp router' },
  { value: '/new', label: '/new', detail: 'Start a new session' },
  { value: '/resume', label: '/resume', detail: 'Switch to another saved session' },
  { value: '/name', label: '/name', detail: 'Set the session display name' },
  { value: '/session', label: '/session', detail: 'Show current session information and statistics' },
  { value: '/tree', label: '/tree', detail: 'Navigate the session tree' },
  { value: '/fork', label: '/fork', detail: 'Create a new session from an earlier user message' },
  { value: '/clone', label: '/clone', detail: 'Duplicate the current session at its current position' },
  { value: '/compact', label: '/compact', detail: 'Compact the current context' },
  { value: '/import', label: '/import', detail: 'Import and resume a JSONL session' },
  { value: '/copy', label: '/copy', detail: 'Copy the last assistant message' },
  { value: '/export', label: '/export', detail: 'Export the session as HTML or JSONL' },
  { value: '/share', label: '/share', detail: 'Upload the session and return a viewer link' },
  { value: '/bug', label: '/bug', detail: 'Prepare a private bug report for the Pi developers' },
  { value: '/trust', label: '/trust', detail: 'Save a project trust decision' },
  { value: '/reload', label: '/reload', detail: 'Reload keybindings, extensions, skills and templates' },
  { value: '/hotkeys', label: '/hotkeys', detail: 'Show active keyboard shortcuts' },
  { value: '/changelog', label: '/changelog', detail: 'Show changelog entries' },
  { value: '/quit', label: '/quit', detail: 'Quit Pi' },
];
// Claude Code 2.1.292 accepts exactly these /model aliases (bundle: ["sonnet","opus",
// "haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"], plus `default`).
const CLAUDE_MODELS: CompleteItem[] = [
  { value: 'default', label: 'default', detail: 'Reset to the configured default model' },
  { value: 'sonnet', label: 'sonnet', detail: 'The latest Sonnet' },
  { value: 'opus', label: 'opus', detail: 'The latest Opus' },
  { value: 'haiku', label: 'haiku', detail: 'The latest Haiku' },
  { value: 'fable', label: 'fable', detail: 'The latest Fable' },
  { value: 'best', label: 'best' },
  { value: 'opusplan', label: 'opusplan' },
  { value: 'sonnet[1m]', label: 'sonnet[1m]', detail: 'Sonnet with a 1M context window' },
  { value: 'opus[1m]', label: 'opus[1m]', detail: 'Opus with a 1M context window' },
  { value: 'fable[1m]', label: 'fable[1m]', detail: 'Fable with a 1M context window' },
];

const PI_MODELS_TTL = 5 * 60_000;
const PI_MODELS_RETRY = 30_000;
let piModelsCache: { items: CompleteItem[]; expires: number } | undefined;

/** Contract ranking: prefix matches on the label first, then substring matches, then the
 *  rest; case-insensitive. Original order is kept inside a tier; the caller slices. */
function rank(items: CompleteItem[], q: string): CompleteItem[] {
  const needle = q.toLowerCase();
  return items
    .map((item, index) => ({ item, index, tier: needle && item.label.toLowerCase().startsWith(needle) ? 0 : needle && item.label.toLowerCase().includes(needle) ? 1 : 2 }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(entry => entry.item);
}

const dedupe = (items: CompleteItem[]): CompleteItem[] => {
  const seen = new Set<string>();
  return items.filter(item => { if (seen.has(item.value)) return false; seen.add(item.value); return true; });
};

/** Read only `name`, `description` and `user-invocable` from a leading `---` block. */
async function frontmatter(path: string): Promise<{ name?: string; description?: string; hidden?: boolean }> {
  const text = await Bun.file(path).slice(0, 4096).text().catch(() => '');
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const out: { name?: string; description?: string; hidden?: boolean } = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'name' && !out.name) out.name = match[2]!.trim().replace(/^['"]|['"]$/g, '');
    if (match[1] === 'description' && !out.description) out.description = match[2]!.trim().replace(/^['"]|['"]$/g, '').slice(0, 160);
    if (match[1] === 'user-invocable' && /^false$/i.test(match[2]!.trim())) out.hidden = true;
  }
  return out;
}

/** Markdown files under a `commands` directory → `/name`, subdirectories joined with
 *  ':' (Claude Code's rule for `.claude/commands`). */
async function commandFiles(dir: string): Promise<CompleteItem[]> {
  let names: string[];
  try { names = await readdir(dir, { recursive: true }) as string[]; } catch { return []; }
  const items: CompleteItem[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const command = name.replace(/\.md$/, '').replace(/\//g, ':');
    if (!NAME_OK.test(command)) continue;
    const meta = await frontmatter(join(dir, name));
    if (meta.hidden) continue;
    items.push({ value: `/${command}`, label: `/${command}`, ...(meta.description ? { detail: meta.description } : {}) });
    if (items.length >= COMMAND_CAP) break;
  }
  return items;
}

/** One `SKILL.md` per child directory → `/<name>`; the frontmatter name wins. */
async function skillDirs(dir: string): Promise<CompleteItem[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const items: CompleteItem[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !NAME_OK.test(entry.name)) continue;
    const meta = await frontmatter(join(dir, entry.name, 'SKILL.md'));
    if (meta.hidden) continue;
    const name = meta.name && NAME_OK.test(meta.name) ? meta.name : entry.name;
    items.push({ value: `/${name}`, label: `/${name}`, ...(meta.description ? { detail: meta.description } : {}) });
  }
  return items;
}

async function slashItems(agent: string, cwd: string | undefined, remote: boolean): Promise<CompleteItem[]> {
  const home = os.homedir();
  if (agent.startsWith('claude')) {
    const items = [...CLAUDE_BUILTINS];
    // ponytail: on a remote Host the project and user sources live over there; shipping
    // them needs an ssh cat per file. Built-ins only until the UI asks for more.
    if (!remote) for (const root of [...(cwd ? [join(cwd, '.claude')] : []), join(home, '.claude')]) {
      items.push(...await commandFiles(join(root, 'commands')));
      items.push(...await skillDirs(join(root, 'skills')));
    }
    return dedupe(items);
  }
  if (agent === 'pi') {
    const items = [...PI_BUILTINS];
    if (!remote && cwd) items.push(...await commandFiles(join(cwd, '.pi', 'prompts')));
    if (!remote) items.push(...await commandFiles(join(home, '.pi/agent/prompts')));
    return dedupe(items);
  }
  return [];
}

/** Turn one `git ls-files` line into a path, undoing core.quotepath's octal quoting. */
function unquoteGitPath(line: string): string {
  if (!line.startsWith('"')) return line;
  const inner = line.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '\\' && /[0-7]/.test(inner[i + 1] ?? '') && inner.slice(i + 1, i + 4).length === 3) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8)); i += 3;
    } else if (c === '\\' && inner[i + 1]) bytes.push(inner.charCodeAt(++i)!);
    else for (const byte of new TextEncoder().encode(c)) bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function pathItems(paths: string[], cap: number): CompleteItem[] {
  const items: CompleteItem[] = []; const dirs = new Set<string>();
  for (const raw of paths) {
    const path = unquoteGitPath(raw);
    if (!path) continue;
    const slash = path.lastIndexOf('/');
    if (slash > 0) {
      const dir = `${path.slice(0, slash)}/`;
      if (!dirs.has(dir)) { dirs.add(dir); items.push({ value: dir, label: dir, dir: true }); }
    }
    items.push({ value: path, label: path });
    if (items.length >= cap) break;
  }
  return items;
}

/** Bounded walk of a non-git cwd: real entries only, so a symlink pointing out of the
 *  cwd is listed by name but never descended into. */
async function walkFiles(root: string): Promise<CompleteItem[]> {
  const items: CompleteItem[] = []; const queue: string[] = [''];
  const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  while (queue.length && items.length < WALK_CAP) {
    const base = queue.shift()!;
    let entries;
    try { entries = await readdir(join(root, base), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort(byName)) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        items.push({ value: `${path}/`, label: `${path}/`, dir: true });
        queue.push(path);
      } else items.push({ value: path, label: path });
      if (items.length >= WALK_CAP) break;
    }
  }
  return items;
}

async function fileItems(cwd: string, target: string | undefined, runGit?: GitRunner): Promise<CompleteItem[]> {
  if (runGit) {
    // Tracked and untracked files, gitignored ones excluded (listing node_modules is never
    // cheap; ignored-but-wanted files stay reachable by typing their path).
    const result = await runGit(cwd, ['ls-files', '--cached', '--others', '--exclude-standard'], target);
    if (!result.code) return pathItems(result.stdout.split('\n'), FILE_CAP);
  }
  // ponytail: a remote non-git cwd has no cheap listing (an ssh find per keystroke);
  // add a remote walk over the file route's ssh path when the UI needs one.
  if (target) return [];
  const root = await realpath(cwd).catch(() => undefined);
  return root ? walkFiles(root) : [];
}

/** `pi --list-models` (the supported surface; ~/.pi/agent/models.json holds API keys).
 *  Cached: the spawn costs ~1.7 s and the catalog rarely changes. */
async function piModelItems(spawn: typeof Bun.spawn): Promise<CompleteItem[]> {
  if (piModelsCache && Date.now() < piModelsCache.expires) return piModelsCache.items;
  const child = spawn(['pi', '--list-models'], { stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => child.kill(), 5_000);
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  clearTimeout(timer);
  let items: CompleteItem[] = [];
  if (!code) {
    items = stdout.split(/\r?\n/).slice(1).map(line => line.trim().split(/\s{2,}/))
      .filter((cols): cols is [string, string, ...string[]] => cols.length >= 2 && Boolean(cols[0]) && Boolean(cols[1]))
      .map(([provider, model]) => ({ value: `${provider}/${model}`, label: model, detail: provider }));
  }
  piModelsCache = { items, expires: Date.now() + (code ? PI_MODELS_RETRY : PI_MODELS_TTL) };
  return items;
}

async function modelItems(agent: string, remote: boolean, spawn: typeof Bun.spawn): Promise<CompleteItem[]> {
  if (agent.startsWith('claude')) return CLAUDE_MODELS;
  if (agent === 'pi' && !remote) return piModelItems(spawn);
  return [];
}

const agentOf = (pane: StatePane) => pane.agent?.toLowerCase() ?? '';

export async function paneCompletion(hub: Hub, paneKey: string, kind: 'slash' | 'file' | 'model', q: string, limit: number,
  opts: { runGit?: GitRunner; spawn?: typeof Bun.spawn } = {}): Promise<CompleteItem[]> {
  const pane = (await hub.state()).panes.find(item => item.key === paneKey);
  if (!pane) throw new CompleteError(404, 'pane not found');
  const target = hub.host(await hub.paneHost(paneKey))?.target;
  const remote = Boolean(target);
  const agent = agentOf(pane);
  if (kind === 'file') {
    if (!pane.cwd || !isAbsolute(pane.cwd)) return [];
    return rank(await fileItems(pane.cwd, target, opts.runGit), q).slice(0, limit);
  }
  if (kind === 'model') return rank(await modelItems(agent, remote, opts.spawn ?? Bun.spawn), q).slice(0, limit);
  return rank(await slashItems(agent, pane.cwd, remote), q).slice(0, limit);
}
