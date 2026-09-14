// Fixtures plus a fake Hub, so the web app runs with no herdr, no Host and no network.
// Nothing imports this in production: `installMock()` is a no-op unless the page is
// opened with `?mock` (or built with VITE_MOCK=1).
import type {
  DiffFile, DiffHunk, DiffLine, DiffResult, DiffScope,
  Explain, InputBody, MouseBody, NewTabBody, NewWorkspaceBody, ProbeBody, ProbeResult, RenameBody, Screen, ScreenEvent,
  ScreenMode, SeenBody, Settings, SettingsBody, State, StatePane, Status, SuggestSettingBody,
} from '../shared/types.ts';

// ---- fixtures ----

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const ORANGE = '\x1b[38;5;214m'; // 256-colour
const BLUE = '\x1b[38;5;39m';
const GREEN = '\x1b[32m';
const CLAUDE = '\x1b[38;2;215;119;87m'; // truecolor

/** Interior width of the permission box, in columns. */
const BOX = 58;
const row = (text: string, sgr = '') =>
  `${ORANGE}│${RESET} ${sgr}${text}${sgr && RESET}${' '.repeat(Math.max(0, BOX - 1 - text.length))}${ORANGE}│${RESET}`;

/** What herdr classified: a Claude Code tool-permission prompt, as it sits on the screen. */
const PERMISSION_BOX = [
  `${ORANGE}┌─ ${BOLD}Permission required${RESET}${ORANGE} ${'─'.repeat(BOX - 22)}┐${RESET}`,
  row(''),
  row('Bash command', BOLD),
  row('  pnpm test --filter ansi', BLUE),
  row('  Run the ANSI parser tests'),
  row(''),
  row('Do you want to proceed?'),
  row('❯ 1. Yes', BOLD),
  row('  2. Yes, and don’t ask again for pnpm'),
  row('  3. No, and tell Claude what to do differently'),
  row(''),
  `${ORANGE}└${'─'.repeat(BOX)}┘${RESET}`,
];

const HINT_LINE = `${DIM}  esc to cancel · enter to confirm${RESET}`;

/** A Claude Code TUI mid-run, 24 rows, ending on the permission prompt. */
const CLAUDE_VISIBLE = [
  `${CLAUDE}✻${RESET} ${BOLD}Claude Code${RESET} ${DIM}v2.1.4${RESET}  ${DIM}~/projects/tautan${RESET}`,
  '',
  `${BLUE}●${RESET} ${BOLD}Read${RESET} ${DIM}shared/ansi.ts${RESET}`,
  `  ${GREEN}⎿${RESET}  ${DIM}Read 84 lines${RESET}`,
  '',
  `${CLAUDE}✻${RESET} The failure is in the SGR 22 branch: it clears ${BOLD}bold${RESET} and`,
  `  ${DIM}dim${RESET} together, so a run styled dim-only keeps its weight when`,
  '  the parser merges the next span. I will run the suite to confirm.',
  '',
  `  ${DIM}docs:${RESET} ${BLUE}https://github.com/radityasurya/tautan/blob/main/docs/UI.md${RESET}`,
  '',
  `${BLUE}●${RESET} ${BOLD}Bash${RESET} ${DIM}pnpm test --filter ansi${RESET}`,
  '',
  ...PERMISSION_BOX,
  HINT_LINE,
  // Claude Code's own status footer: two Affordances, `shift+tab` and `/tasks`.
  `${DIM}⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent${RESET}`,
].join('\r\n');

/** The same Pane in `recent` mode: reflowed, no styling. */
const CLAUDE_RECENT = [
  '● Read shared/ansi.ts',
  '  ⎿  Read 84 lines',
  '● Read test/ansi.test.ts',
  '  ⎿  Read 31 lines',
  '',
  'The failure is in the SGR 22 branch: it clears bold and dim together, so a run styled dim-only keeps its weight when the parser merges the next span. I will run the suite to confirm.',
  '',
  '● Bash pnpm test --filter ansi',
  '',
  'Permission required — Bash command: pnpm test --filter ansi',
  'Do you want to proceed?',
  '  1. Yes',
  '  2. Yes, and don’t ask again for pnpm',
  '  3. No, and tell Claude what to do differently',
  'esc to cancel · enter to confirm',
].join('\r\n');

/** A real htop grid, 120 columns wide: the shell Pane that proves Fit and the edge fade.
 *  Every row is padded to the full 120, the way a terminal hands one over. */
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const HEAD = '\x1b[48;5;10m\x1b[38;5;0m';
const SEL = '\x1b[48;5;12m\x1b[38;5;0m';
/** One row of a 120-column grid: padded out, cut off, exactly like the terminal's own. */
const wide = (text: string) => text.padEnd(120).slice(0, 120);
const bar = (on: number, of: number) => `${GREEN}${'|'.repeat(on)}${RESET}${DIM}${' '.repeat(of - on)}${RESET}`;
const HTOP = [
  `  ${CYAN}0${RESET}[${bar(11, 41)}${DIM}28.1%${RESET}]   ${CYAN}4${RESET}[${bar(4, 41)}${DIM} 9.4%${RESET}]`,
  `  ${CYAN}1${RESET}[${bar(26, 41)}${DIM}61.3%${RESET}]   ${CYAN}5${RESET}[${bar(2, 41)}${DIM} 3.9%${RESET}]`,
  `  ${CYAN}2${RESET}[${bar(8, 41)}${DIM}18.8%${RESET}]   ${CYAN}6${RESET}[${bar(7, 41)}${DIM}16.2%${RESET}]`,
  `  ${CYAN}3${RESET}[${bar(3, 41)}${DIM} 6.7%${RESET}]   ${CYAN}7${RESET}[${bar(1, 41)}${DIM} 1.2%${RESET}]`,
  `  ${CYAN}Mem${RESET}[${GREEN}${'|'.repeat(17)}${CYAN}${'|'.repeat(5)}${YELLOW}${'|'.repeat(3)}${RESET}${DIM}${' '.repeat(14)}11.2G/31.3G${RESET}]   ${CYAN}Tasks: ${BOLD}212${RESET}${CYAN}, 1043 thr; ${BOLD}3${RESET}${CYAN} running${RESET}`,
  `  ${CYAN}Swp${RESET}[${DIM}${' '.repeat(41)}0K/8.00G${RESET}]   ${CYAN}Load average: ${BOLD}1.42 1.18 0.97${RESET}`,
  `${' '.repeat(64)}${CYAN}Uptime: ${BOLD}14 days, 03:12:41${RESET}`,
  '',
  `${HEAD}${wide('  PID USER       PRI  NI  VIRT   RES   SHR S  CPU% MEM%   TIME+  Command')}${RESET}`,
  `${SEL}${wide('48211 dev        20   0 2841M  612M 41.2M S  61.0  1.9  2:14.02 claude --dangerously-skip-permissions')}${RESET}`,
  wide('48590 dev        20   0 1412M  388M 28.0M S  18.4  1.2  0:41.55 bun --watch server/main.ts --port 7700'),
  wide(' 1132 dev        20   0  912M  201M 14.1M S   6.1  0.6 12:03.18 herdr server --socket ~/.config/herdr/herdr.sock'),
  wide('50021 dev        20   0  734M  164M 22.9M S   3.0  0.5  0:08.40 node vite --host 0.0.0.0 --port 5173'),
  wide('  912 root        20   0  244M   32M 12.4M S   0.7  0.1  3:55.02 tailscaled --state /var/lib/tailscale/tailscaled.state'),
  wide(' 3050 dev        20   0  618M  120M 18.8M S   0.3  0.4  0:33.10 pi --model glm-5.2 --workspace ~/projects/tautan'),
  wide('  501 root        20   0   88M   14M  9.1M S   0.0  0.0  0:02.11 sshd: dev@pts/4'),
  `${DIM}F1${RESET}Help  ${DIM}F2${RESET}Setup ${DIM}F3${RESET}Search${DIM}F4${RESET}Filter${DIM}F5${RESET}Tree  ${DIM}F6${RESET}SortBy${DIM}F7${RESET}Nice -${DIM}F8${RESET}Nice +${DIM}F9${RESET}Kill  ${DIM}F10${RESET}Quit${' '.repeat(38)}`,
].join('\r\n');

/** k9s: the App profile with mouse forwarding on, and a header full of `<key> Label` Hints. */
const K9S = [
  ` ${CYAN}Context:${RESET} kind-tautan      ${DIM}<0>${RESET} all      ${DIM}<1>${RESET} default   ${DIM}<d>${RESET} describe  ${DIM}<ctrl-d>${RESET} delete`,
  ` ${CYAN}Cluster:${RESET} kind-tautan      ${DIM}<e>${RESET} edit     ${DIM}<l>${RESET} logs      ${DIM}<s>${RESET} shell     ${DIM}<?>${RESET} help`,
  ` ${CYAN}Namespace:${RESET} default`,
  '',
  `${HEAD}${wide('  NAME                             READY   STATUS      RESTARTS   AGE')}${RESET}`,
  `${SEL}${wide('  api-7c9f6b8d4-2kq9x              1/1     Running     0          4d2h')}${RESET}`,
  wide('  web-5f4d8c7b9-mn4pz              1/1     Running     1          4d2h'),
  wide('  worker-6b8c5d7f4-xj28t           1/1     Running     0          19h'),
  wide('  postgres-0                       1/1     Running     0          11d'),
  wide('  redis-59c7d8b4f-qq4kl            1/1     Running     3          11d'),
  wide('  migrate-28471204-hb9rd           0/1     Completed   0          42m'),
  '',
  `${DIM}<pods>${RESET}${' '.repeat(100)}`,
].join('\r\n');

/** ms epoch `m` minutes ago, for `statusChangedAt`. */
const ago = (m: number) => Date.now() - m * 60_000;

export const mockState: State = {
  hosts: [
    { id: 'mbp', label: 'mbp', online: true, source: 'local' },
    // Added from the Hosts screen, and down: the card that has to show an error, Retry,
    // Edit and Remove all at once.
    {
      id: 'vps', label: 'vps', online: false, source: 'config',
      target: 'dev@vps.example.ts.net',
      error: 'ssh: connect to host vps.example.ts.net port 22: Connection timed out',
    },
    // Discovered, so tautan may not edit it: the card that carries the machine-list caption.
    { id: 'unraid', label: 'unraid', online: true, source: 'machines', target: 'root@unraid' },
  ],
  muxes: [
    { key: 'mbp/herdr', hostId: 'mbp', kind: 'herdr', label: 'default', online: true },
    { key: 'mbp/tmux', hostId: 'mbp', kind: 'tmux', label: 'admin', online: true },
    { key: 'vps/herdr', hostId: 'vps', kind: 'herdr', label: 'default', online: false },
    { key: 'unraid/tmux', hostId: 'unraid', kind: 'tmux', label: 'main', online: true },
  ],
  workspaces: [
    { key: 'mbp/herdr/tautan', muxKey: 'mbp/herdr', id: 'tautan', label: 'tautan', cwd: '~/projects/tautan' },
    { key: 'mbp/herdr/digivaley', muxKey: 'mbp/herdr', id: 'digivaley', label: 'digivaley.com', cwd: '~/projects/digivaley.com' },
    // Empty on purpose: Home must not render a Workspace with no Panes.
    { key: 'mbp/herdr/dotfiles', muxKey: 'mbp/herdr', id: 'dotfiles', label: 'dotfiles', cwd: '~/.local/share/chezmoi' },
    { key: 'mbp/tmux/admin', muxKey: 'mbp/tmux', id: 'admin', label: 'admin', cwd: '~' },
    { key: 'vps/herdr/blog', muxKey: 'vps/herdr', id: 'blog', label: 'blog', cwd: '~/srv/blog' },
    { key: 'unraid/tmux/main', muxKey: 'unraid/tmux', id: 'main', label: 'main', cwd: '/mnt/user' },
  ],
  // herdr numbers Tabs `t<n>`; tmux windows are their index. Both are the Mux's own id.
  tabs: [
    { key: 'mbp/herdr/t1', muxKey: 'mbp/herdr', workspaceId: 'tautan', id: 't1', label: 'main' },
    { key: 'mbp/herdr/t2', muxKey: 'mbp/herdr', workspaceId: 'tautan', id: 't2', label: 'tests' },
    { key: 'mbp/herdr/t3', muxKey: 'mbp/herdr', workspaceId: 'tautan', id: 't3', label: 'docs' },
    { key: 'mbp/herdr/t4', muxKey: 'mbp/herdr', workspaceId: 'digivaley', id: 't4', label: 'main' },
    { key: 'mbp/herdr/t5', muxKey: 'mbp/herdr', workspaceId: 'digivaley', id: 't5', label: 'shell' },
    { key: 'mbp/tmux/0', muxKey: 'mbp/tmux', workspaceId: 'admin', id: '0', label: 'htop' },
    { key: 'mbp/tmux/1', muxKey: 'mbp/tmux', workspaceId: 'admin', id: '1', label: 'logs' },
    { key: 'mbp/tmux/2', muxKey: 'mbp/tmux', workspaceId: 'admin', id: '2', label: 'k9s' },
    { key: 'unraid/tmux/0', muxKey: 'unraid/tmux', workspaceId: 'main', id: '0', label: 'shell' },
    { key: 'unraid/tmux/1', muxKey: 'unraid/tmux', workspaceId: 'main', id: '1', label: 'rsync' },
  ],
  panes: [
    {
      key: 'mbp/herdr/p1', muxKey: 'mbp/herdr', workspaceId: 'tautan', tabId: 't1', id: 'p1',
      title: 'fix ansi parser', cwd: '~/projects/tautan', agent: 'claude',
      status: 'blocked', revision: 412, seenRevision: 402, cols: 80, rows: 24,
      lastLine: 'Permission required — Bash pnpm test', statusChangedAt: ago(4),
      suggestions: ['Yes, but skip the e2e tests', 'Run it in a worktree', 'Show me the command first'],
    },
    {
      key: 'mbp/herdr/p2', muxKey: 'mbp/herdr', workspaceId: 'tautan', tabId: 't2', id: 'p2',
      title: 'wire SSE events', cwd: '~/projects/tautan', agent: 'claude',
      status: 'working', revision: 1180, seenRevision: 1180, cols: 80, rows: 24,
      lastLine: 'Reading server/mux.ts…', statusChangedAt: ago(2),
    },
    {
      key: 'mbp/herdr/p3', muxKey: 'mbp/herdr', workspaceId: 'tautan', tabId: 't2', id: 'p3',
      title: 'pnpm dev', cwd: '~/projects/tautan',
      status: 'unknown', revision: 87, seenRevision: 87, cols: 80, rows: 24, statusChangedAt: ago(46),
    },
    {
      key: 'mbp/herdr/p4', muxKey: 'mbp/herdr', workspaceId: 'tautan', tabId: 't3', id: 'p4',
      title: 'migrate hosts.json', cwd: '~/projects/tautan', agent: 'pi',
      status: 'done', revision: 640, seenRevision: 611, cols: 80, rows: 24,
      lastLine: '3 files changed, tests green', statusChangedAt: ago(12),
    },
    {
      key: 'mbp/herdr/p5', muxKey: 'mbp/herdr', workspaceId: 'digivaley', tabId: 't4', id: 'p5',
      title: 'bump deps', cwd: '~/projects/digivaley.com', agent: 'codex',
      status: 'blocked', revision: 55, seenRevision: 55, cols: 80, rows: 24,
      lastLine: 'Waiting for approval: edit src/auth.ts', statusChangedAt: ago(23),
    },
    {
      key: 'mbp/herdr/p6', muxKey: 'mbp/herdr', workspaceId: 'digivaley', tabId: 't4', id: 'p6',
      title: 'seo audit for listings', cwd: '~/projects/digivaley.com', agent: 'claude',
      status: 'idle', revision: 233, seenRevision: 233, cols: 80, rows: 24,
      lastLine: 'Audited 42 listing pages', statusChangedAt: ago(95),
    },
    {
      key: 'mbp/herdr/p7', muxKey: 'mbp/herdr', workspaceId: 'digivaley', tabId: 't5', id: 'p7',
      title: 'zsh', cwd: '~/projects/digivaley.com',
      status: 'idle', revision: 12, seenRevision: 12, cols: 80, rows: 24, statusChangedAt: ago(121),
    },
    {
      key: 'mbp/tmux/p0', muxKey: 'mbp/tmux', workspaceId: 'admin', tabId: '0', id: 'p0',
      title: 'htop', cwd: '~', command: 'htop',
      status: 'unknown', revision: 3, seenRevision: 0, cols: 120, rows: 30, statusChangedAt: ago(178),
    },
    // The App profile with mouse forwarding on: taps go to k9s, Hints go to the dock.
    {
      key: 'mbp/tmux/p2', muxKey: 'mbp/tmux', workspaceId: 'admin', tabId: '2', id: 'p2',
      title: 'k9s', cwd: '~', command: 'k9s',
      status: 'unknown', revision: 21, seenRevision: 21, cols: 120, rows: 30, statusChangedAt: ago(31),
    },
    {
      key: 'mbp/tmux/p1', muxKey: 'mbp/tmux', workspaceId: 'admin', tabId: '1', id: 'p1',
      title: 'docker logs -f plex', cwd: '~',
      status: 'unknown', revision: 9, seenRevision: 9, cols: 120, rows: 30, statusChangedAt: ago(150),
    },
    {
      key: 'unraid/tmux/p0', muxKey: 'unraid/tmux', workspaceId: 'main', tabId: '0', id: 'p0',
      title: 'bash', cwd: '/mnt/user',
      status: 'unknown', revision: 6, seenRevision: 6, cols: 100, rows: 28, statusChangedAt: ago(320),
    },
    {
      key: 'unraid/tmux/p1', muxKey: 'unraid/tmux', workspaceId: 'main', tabId: '1', id: 'p1',
      title: 'rsync -a media/', cwd: '/mnt/user',
      status: 'unknown', revision: 44, seenRevision: 44, cols: 100, rows: 28, statusChangedAt: ago(61),
    },
    {
      key: 'unraid/tmux/p2', muxKey: 'unraid/tmux', workspaceId: 'main', tabId: '1', id: 'p2',
      title: 'btrfs scrub status', cwd: '/mnt/user',
      status: 'unknown', revision: 2, seenRevision: 2, cols: 100, rows: 28, statusChangedAt: ago(400),
    },
  ],
};

export const mockExplains: Record<string, Explain> = {
  'mbp/herdr/p1': {
    ruleId: 'claude.permission.bash',
    state: 'blocked',
    detection: [...PERMISSION_BOX, HINT_LINE].join('\r\n'),
    hintKeys: [{ key: 'enter', label: 'Yes' }, { key: 'esc', label: 'No' }],
  },
  'mbp/herdr/p5': {
    ruleId: 'prompt.idle',
    state: 'blocked',
    detection: [
      `${DIM}› Ran 14 tasks, 2 packages need a major bump.${RESET}`,
      `${BOLD}Press enter to continue${RESET}${DIM}, or type a new instruction.${RESET}`,
    ].join('\r\n'),
    hintKeys: [{ key: 'enter', label: 'Continue' }],
  },
};

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
const basename = (cwd?: string) => cwd?.replace(/\/+$/, '').split('/').pop() ?? '~';

const TAIL: Record<Status, string> = {
  working: `${BLUE}⠋${RESET} ${DIM}working…${RESET}`,
  blocked: `${ORANGE}?${RESET} waiting for an answer`,
  done: `${GREEN}✔${RESET} ${DIM}finished in 4.2s${RESET}`,
  idle: `${GREEN}❯${RESET} `,
  unknown: `${DIM}…${RESET}`,
};

// ponytail: one generic screen for every Pane that is not the star of the fixture.
function genericScreen(pane: StatePane): string {
  return [
    `${GREEN}${basename(pane.cwd)}${RESET} ${BLUE}❯${RESET} ${pane.title}`,
    '',
    TAIL[pane.status],
  ].join('\r\n');
}

const pair = (revision: number, visible: string, recent: string): Record<ScreenMode, Screen> => ({
  visible: { text: visible, ansi: true, revision, mode: 'visible' },
  recent: { text: recent, ansi: false, revision, mode: 'recent' },
});

/** Both Screen modes for every Pane, keyed by paneKey. */
export const mockScreens: Record<string, Record<ScreenMode, Screen>> = Object.fromEntries(
  mockState.panes.map((p) => [
    p.key,
    p.key === 'mbp/herdr/p1'
      ? pair(p.revision, CLAUDE_VISIBLE, CLAUDE_RECENT)
      : p.key === 'mbp/tmux/p0'
        ? pair(p.revision, HTOP, strip(HTOP))
        : p.key === 'mbp/tmux/p2'
          ? pair(p.revision, K9S, strip(K9S))
          : pair(p.revision, genericScreen(p), strip(genericScreen(p))),
  ]),
);

/** The fixtures must keep exercising every branch of the UI. Cheaper than a test file. */
// ---- diffs ----
// One fixture per Workspace and scope, in the shape `shared/diff.ts` produces. A line is
// written with its git prefix, and the builder counts the two line numbers from the hunk
// header, the way a real unified diff does.

function hunk(header: string, oldStart: number, newStart: number, body: string[]): DiffHunk {
  let o = oldStart;
  let n = newStart;
  return {
    header,
    lines: body.map((raw): DiffLine => {
      const text = raw.slice(1);
      if (raw[0] === '+') return { type: 'add', text, newNo: n++ };
      if (raw[0] === '-') return { type: 'del', text, oldNo: o++ };
      if (raw[0] === '\\') return { type: 'meta', text: raw };
      return { type: 'ctx', text, oldNo: o++, newNo: n++ };
    }),
  };
}

/** Sum the markers, so a fixture can never disagree with its own counts. */
function file(path: string, hunks: DiffHunk[], extra: Partial<DiffFile> = {}): DiffFile {
  const lines = hunks.flatMap((h) => h.lines);
  return {
    path,
    additions: lines.filter((l) => l.type === 'add').length,
    deletions: lines.filter((l) => l.type === 'del').length,
    hunks,
    ...extra,
  };
}

const RENAMED = file(
  'web/pane.tsx',
  [
    hunk('@@ -18,7 +18,9 @@ export function PaneScreen({ paneKey, state }: Props) {', 18, 18, [
      '   const [wrap, setWrap] = useState(false);',
      '   const [fit, setFit] = useState(false);',
      '-  const [fade, setFade] = useState(false);',
      '+  const [fade, setFade] = useState(false);',
      '+  const [fresh, setFresh] = useState(false);',
      '+',
      '   const box = useRef<HTMLDivElement>(null);',
      '   const pre = useRef<HTMLPreElement>(null);',
      '   const pinned = useRef(true);',
    ]),
  ],
  { oldPath: 'web/screen.tsx' },
);

const MULTI_HUNK = file('server/http.ts', [
  hunk('@@ -42,6 +42,7 @@ function json(value: unknown, status = 200): Response {', 42, 42, [
    '   return Response.json(value, { status });',
    ' }',
    ' ',
    '+const DIFF_FILE_CAP = 50;',
    ' ',
    ' export function serve(hub: Hub): Server {',
    '   const server = Bun.serve({',
  ]),
  hunk('@@ -118,10 +119,20 @@ export function serve(hub: Hub): Server {', 118, 119, [
    "     const workspace = url.pathname.match(/^\\/api\\/workspaces\\/([^/]+)\\/diff$/);",
    "     if (workspace && request.method === 'GET') {",
    "-      return json({ error: 'unsupported' }, 501);",
    "+      const key = decodeURIComponent(workspace[1]!);",
    "+      const found = hub.workspace(key);",
    "+      if (!found?.cwd) return json({ error: 'unknown-workspace' }, 404);",
    "+      try {",
    "+        const scope = url.searchParams.get('scope') ?? 'working';",
    "+        return json(await hub.diff(found, scope, url.searchParams.get('file')));",
    "+      } catch (error) {",
    "+        const code = String(error).split(': ')[0]!;",
    "+        return json({ error: code }, code === 'not-a-repo' ? 409 : 502);",
    "+      }",
    '     }',
    ' ',
    '     return new Response(null, { status: 404 });',
    '   },',
  ]),
]);

const STAGED_TYPES = file('shared/types.ts', [
  hunk('@@ -84,6 +84,14 @@ export interface AttachResult { path: string; bytes: number }', 84, 84, [
    ' /** POST /api/push/subscribe */',
    ' export interface PushSubscriptionBody {',
    '   endpoint: string; expirationTime?: number | null;',
    "+export type DiffScope = 'working' | 'staged' | 'base';",
    "+export interface DiffLine { type: 'ctx' | 'add' | 'del' | 'meta'; text: string; oldNo?: number; newNo?: number }",
    '+export interface DiffHunk { header: string; lines: DiffLine[] }',
    '+export interface DiffFile {',
    '+  path: string; oldPath?: string; additions: number; deletions: number; binary?: boolean;',
    '+  hunks: DiffHunk[];',
    '+}',
    '+export interface DiffResult { scope: DiffScope; base?: string; files: DiffFile[]; truncated: boolean }',
    '+',
    '   keys: { p256dh: string; auth: string };',
    ' }',
  ]),
]);

const BASE_FILES: DiffFile[] = [
  file('docs/ROADMAP.md', [
    hunk('@@ -195,9 +195,9 @@ ## Phase 8 — diff review', 195, 195, [
      '   the Workspace cwd, local or over SSH; `GET /api/workspaces/:key/diff?scope=`',
      '-- [ ] PWA renders it with `gitdiff-parser` + `react-diff-view` (MIT), unified view on the',
      '-      phone, per-file collapse, hunk headers',
      '+- [x] the Hub parses the unified diff with a hand-written `shared/diff.ts`; the PWA renders',
      '+      it itself in `web/diff.tsx`, per-file collapse, hunk headers',
      ' - [x] hunk itself is a TUI with no web or JSON mode, so it is not embedded',
    ]),
  ]),
  // A new file: git names `/dev/null` as the old path, which is not a rename.
  file('web/diff.tsx', [
    hunk('@@ -0,0 +1,6 @@', 0, 1, [
      "+import type { DiffFile, DiffResult, DiffScope } from '../shared/types.ts';",
      "+import { api } from './app.tsx';",
      '+',
      '+export function Diff({ workspaceKey }: { workspaceKey: string }) {',
      "+  const [scope, setScope] = useState<DiffScope>('working');",
      '+  const [wrap, setWrap] = useState(false);',
      '\\ No newline at end of file',
    ]),
  ], { oldPath: '/dev/null' }),
  file('web/public/tautan-box.woff2', [], { binary: true, oldPath: 'web/public/tautan-box.woff2' }),
];

/** The Workspace whose diff is cut short, so `?mock&open=diff` always lands on that state. */
const CUT: DiffFile[] = [
  file('src/pages/listings.astro', [
    hunk('@@ -31,7 +31,11 @@ const listings = await getCollection("listings");', 31, 31, [
      '   <section class="grid">',
      '     {listings.map((listing) => (',
      '-      <Card listing={listing} />',
      '+      <Card listing={listing} priority={listing.data.featured} />',
      '+    ))}',
      '+  </section>',
      '+  <section class="grid grid--archive">',
      '+    {archived.map((listing) => (',
      '+      <Card listing={listing} muted />',
      '     ))}',
      '   </section>',
    ]),
  ]),
  file('src/components/Card.astro', [
    hunk('@@ -4,8 +4,11 @@ interface Props {', 4, 4, [
      '   listing: CollectionEntry<"listings">;',
      '-  featured?: boolean;',
      '+  priority?: boolean;',
      '+  muted?: boolean;',
      ' }',
      ' ',
      '-const { listing, featured } = Astro.props;',
      '+const { listing, priority = false, muted = false } = Astro.props;',
      ' ',
      ' const href = `/listings/${listing.slug}`;',
    ]),
  ]),
  file('package.json', [
    hunk('@@ -12,8 +12,8 @@', 12, 12, [
      '   "dependencies": {',
      '-    "astro": "^5.2.0",',
      '-    "sharp": "^0.33.0"',
      '+    "astro": "^5.6.1",',
      '+    "sharp": "^0.34.2"',
      '   },',
    ]),
  ]),
];

/** What `?file=<path>` answers for a cut file: the same file with the rest of its hunks. */
const WHOLE: Record<string, DiffFile> = {
  'src/pages/listings.astro': file('src/pages/listings.astro', [
    ...CUT[0]!.hunks,
    hunk('@@ -58,6 +62,9 @@ const listings = await getCollection("listings");', 58, 62, [
      '   <footer>',
      '     <p>{listings.length} listings</p>',
      '+    <p class="muted">{archived.length} archived</p>',
      '+    <a href="/listings/archive">See the archive</a>',
      '+',
      '   </footer>',
      ' </Layout>',
    ]),
  ]),
};

const MOCK_DIFFS: Record<string, Partial<Record<DiffScope, DiffResult>>> = {
  'mbp/herdr/tautan': {
    working: { scope: 'working', files: [RENAMED, MULTI_HUNK], truncated: false },
    staged: { scope: 'staged', files: [STAGED_TYPES], truncated: false },
    base: { scope: 'base', base: 'main', files: BASE_FILES, truncated: false },
  },
  'mbp/herdr/digivaley': {
    working: { scope: 'working', files: CUT, truncated: true },
    staged: { scope: 'staged', files: [], truncated: false },
    base: { scope: 'base', base: 'main', files: CUT.slice(0, 2), truncated: false },
  },
};

export function assertMockInvariants(): void {
  const statuses = new Set(mockState.panes.map((p) => p.status));
  const problems = [
    (['idle', 'working', 'blocked', 'done', 'unknown'] as Status[]).every((s) => statuses.has(s)) || 'every Status',
    mockState.panes.some((p) => p.revision > p.seenRevision) || 'an unseen Pane',
    mockState.workspaces.some((w) => !mockState.panes.some((p) => p.muxKey === w.muxKey && p.workspaceId === w.id)) || 'an empty Workspace',
    Object.values(mockExplains).some((e) => e.ruleId.includes('permission')) || 'a permission Explain',
    mockState.panes.some((p) => p.suggestions?.length) || 'a Pane with Smart replies',
    mockState.panes.some((p) => p.cols === 120 && mockScreens[p.key]?.visible.text.split('\r\n').some(
      (l) => strip(l).length >= 120)) || 'a 120-column grid',
    mockState.panes.every((p) => mockScreens[p.key]) || 'a Screen per Pane',
    // Phase 10: one Pane per App profile that forwards the mouse, and one Screen carrying
    // each kind of Affordance the generic patterns look for.
    mockState.panes.some((p) => p.command === 'htop') || 'a Pane running htop',
    mockState.panes.some((p) => p.command === 'k9s') || 'a Pane running k9s',
    /<ctrl-d>\s+delete/.test(strip(K9S)) || 'a k9s Hint header',
    /https?:\/\//.test(strip(CLAUDE_VISIBLE)) || 'a URL on a Screen',
    strip(CLAUDE_VISIBLE).includes('auto mode on') || 'a Claude Code status footer',
    strip(CLAUDE_VISIBLE).includes('esc to cancel') || 'an `esc to cancel` Hint',
    strip(CLAUDE_VISIBLE).replace(/[│┃]/g, ' ').split('\r\n')
      .filter((l) => /^\s*[❯>]?\s*[1-9]\.\s+\S/.test(l)).length >= 2 || 'an option list',
    mockState.panes.every((p) => mockState.tabs.some((t) => t.muxKey === p.muxKey && t.id === p.tabId)) || 'a Tab per Pane',
    Object.values(MOCK_DIFFS).some((d) => d.working?.truncated) || 'a cut diff',
    Object.values(MOCK_DIFFS).some((d) => d.staged?.files.length === 0) || 'an empty diff scope',
    Object.keys(MOCK_DIFFS).every((key) => mockState.workspaces.some((w) => w.key === key)) || 'a Workspace per diff',
  ].filter((p) => p !== true);
  if (problems.length) throw new Error(`mock fixtures lost ${problems.join(', ')}`);
}

// ---- fake Hub ----

interface Store {
  state: State;
  screens: Record<string, Record<ScreenMode, Screen>>;
  settings: Settings;
}

let store: Store | null = null;
let installed = false;
const sources = new Set<MockEventSource>();

const meta = (key: string): unknown => (import.meta as unknown as { env?: Record<string, unknown> }).env?.[key];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T,>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)];

/** Keep `visible` to a screenful and `recent` to a short scrollback. */
const clamp = (text: string, rows: number) => text.split('\r\n').slice(-rows).join('\r\n');

/** Append output to a Pane, bump its revision, and keep both Screen modes in step. */
function append(s: Store, key: string, ...lines: string[]): void {
  const pane = s.state.panes.find((p) => p.key === key);
  const screens = s.screens[key];
  if (!pane || !screens) return;
  pane.revision += 1;
  screens.visible.text = clamp(`${screens.visible.text}\r\n${lines.join('\r\n')}`, 24);
  screens.recent.text = clamp(`${screens.recent.text}\r\n${lines.map(strip).join('\r\n')}`, 120);
  screens.visible.revision = pane.revision;
  screens.recent.revision = pane.revision;
}

function input(s: Store, key: string, body: InputBody): void {
  const pane = s.state.panes.find((p) => p.key === key);
  if (!pane) return;
  if (body.text) append(s, key, `${BLUE}›${RESET} ${body.text}`, `${DIM}  … thinking${RESET}`);
  for (const k of body.keys ?? []) {
    append(s, key, k === 'enter' ? '⏎' : `${DIM}[${k}]${RESET}`);
    if (pane.status === 'blocked' && (k === 'enter' || k === 'esc')) {
      pane.status = k === 'enter' ? 'working' : 'idle';
      pane.statusChangedAt = Date.now();
      append(s, key, k === 'enter' ? `${GREEN}✔${RESET} ${DIM}running pnpm test --filter ansi${RESET}` : `${DIM}cancelled${RESET}`);
    }
  }
}

const LOG = [
  `${BLUE}●${RESET} ${BOLD}Edit${RESET} ${DIM}server/mux.ts${RESET}`,
  `  ${GREEN}⎿${RESET}  ${DIM}Updated 2 additions, 1 removal${RESET}`,
  `${BLUE}●${RESET} ${BOLD}Grep${RESET} ${DIM}paneKey${RESET}`,
  `  ${GREEN}⎿${RESET}  ${DIM}Found 11 matches${RESET}`,
  `${DIM}  ✻ Reticulating splines… (12s · 3.4k tokens)${RESET}`,
];

/** Every tick: one working Pane produces output, and sometimes a Status moves on. */
function tick(s: Store): void {
  const busy = pick(s.state.panes.filter((p) => p.status === 'working'));
  if (busy) append(s, busy.key, pick(LOG) ?? '');
  if (Math.random() < 0.3) {
    const mover = pick(s.state.panes.filter((p) => p.status === 'working' || p.status === 'idle'));
    if (mover) {
      mover.status = mover.status === 'working' ? 'done' : 'working';
      mover.statusChangedAt = Date.now();
      if (mover.status === 'done') mover.revision += 1;
    }
  }
  for (const es of sources) es.push(s, { state: true, screenKey: busy?.key });
}

class MockEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  readonly paneKey?: string;
  readonly mode: ScreenMode;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    const params = new URL(this.url, location.origin).searchParams;
    this.paneKey = params.get('pane') ?? undefined;
    this.mode = params.get('mode') === 'recent' ? 'recent' : 'visible';
    setTimeout(() => {
      if (this.readyState !== 0 || !store) return;
      this.readyState = 1;
      sources.add(this);
      this.onopen?.(new Event('open'));
      this.push(store, { state: true, screenKey: this.paneKey });
    }, 120);
  }

  /** Send what this stream watches: always `state`, plus `screen` when its Pane changed. */
  push(s: Store, what: { state?: boolean; screenKey?: string }): void {
    if (this.readyState !== 1) return;
    const send = (name: string, data: unknown) =>
      this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
    if (what.state) send('state', s.state);
    if (this.paneKey && what.screenKey === this.paneKey) {
      const screen = s.screens[this.paneKey]?.[this.mode];
      if (screen) send('screen', { ...screen, key: this.paneKey } satisfies ScreenEvent);
    }
  }

  close(): void {
    this.readyState = 2;
    sources.delete(this);
  }
}

/**
 * Enough XMLHttpRequest for the composer's upload: the mock patches `fetch`, and the
 * upload needs `xhr.upload.onprogress`, which `fetch` cannot give. Three progress ticks
 * make the composer's progress line visible; the reply comes from `route()` like any
 * other fake call.
 * ponytail: no readyState, no events, no headers on the way back. Add them if a second
 * caller ever needs XHR.
 */
class MockXMLHttpRequest {
  status = 0;
  responseText = '';
  readonly upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private url = '';
  private name = 'file';
  private aborted = false;

  open(_method: string, url: string): void {
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    if (name.toLowerCase() === 'x-name') this.name = value;
  }

  abort(): void {
    this.aborted = true;
  }

  async send(file: Blob): Promise<void> {
    const total = file?.size ?? 0;
    for (const share of [0.25, 0.6, 1]) {
      await sleep(220);
      if (this.aborted) return;
      this.upload.onprogress?.({ lengthComputable: true, loaded: total * share, total } as ProgressEvent);
    }
    if (!store) return this.onerror?.();
    const response = route(store, new URL(this.url, location.origin), 'POST', { name: this.name, size: total });
    if (this.aborted) return;
    this.status = response?.status ?? 404;
    this.responseText = response ? await response.text() : '';
    this.onload?.();
  }
}

/** The Hub's name rule, repeated here so the fake path looks like the real one. */
const sanitize = (name: string) =>
  name.split(/[/\\]/).pop()!.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file';

/** What a small model would draft for a Pane with no fixture replies of its own. */
const DRAFTS = ['Continue', 'Show me the diff', 'Stop and explain'];

const json = (value: unknown, status = 200) => Response.json(value, { status });
const noContent = () => new Response(null, { status: 204 });

// ---- writes ----
// The four phase 7 routes, answered with the same status codes and key formats the Hub
// sends, so the sheets can be driven end to end with no herdr.

// Starts past the fixture ids (t1…t5, p1…p7), so a created id never collides with one.
let counter = 100;
const fresh = (prefix: string) => `${prefix}${(counter += 1)}`;

/** A Workspace, Tab or Pane named `fail` fails: the one way to reach the sheet's error line. */
const FAIL = 'fail';

/** tmux cannot create, rename or close, exactly as `server/tmux.ts` says. */
function writableMux(s: Store, muxKey: string): Response | undefined {
  const mux = s.state.muxes.find((m) => m.key === muxKey);
  if (!mux) return json({ error: 'mux not found' }, 404);
  if (mux.kind !== 'herdr') return json({ error: 'unsupported' }, 501);
  return undefined;
}

/** 80 characters is the Hub's limit; an empty name is a 400 too. */
const badLabel = (label?: string) => label !== undefined && (label.length === 0 || label.length > 80);

/** One Tab with one Pane, plus the Screen that Pane needs, the way herdr makes them. */
function addTab(s: Store, muxKey: string, workspaceId: string, o: NewTabBody): StatePane {
  const tabId = fresh('t');
  s.state.tabs.push({ key: `${muxKey}/${tabId}`, muxKey, workspaceId, id: tabId, label: o.label ?? o.agent ?? 'shell' });
  const id = fresh('p');
  const pane: StatePane = {
    key: `${muxKey}/${id}`, muxKey, workspaceId, tabId, id,
    // herdr gives the label to the Tab; the Pane keeps the terminal's own title, which
    // starts as the directory. Verified against a throwaway herdr.
    title: basename(o.cwd), cwd: o.cwd, agent: o.agent,
    status: o.agent ? 'working' : 'idle', revision: 1, seenRevision: 0,
    cols: 80, rows: 24, statusChangedAt: Date.now(),
    lastLine: o.agent ? `${o.agent} starting…` : undefined,
  };
  s.state.panes.push(pane);
  s.screens[pane.key] = pair(1, genericScreen(pane), strip(genericScreen(pane)));
  return pane;
}

/** ponytail: no `cwd` check here. The fixtures carry `~/projects/…`, which the Hub's own
 *  "must be absolute" rule would reject, and the sheets default to what State gave them. */
function write(s: Store, url: URL, method: string, body: unknown): Response | undefined {
  if (method !== 'POST') return undefined;

  const closeWs = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/close$/);
  if (closeWs) {
    const ws = s.state.workspaces.find((w) => w.key === decodeURIComponent(closeWs[1]!));
    if (!ws) return json({ error: 'unknown-workspace' }, 404);
    const bad = writableMux(s, ws.muxKey);
    if (bad) return bad;
    if (ws.label === FAIL) return json({ error: 'agent_not_ready' }, 502);
    const gone = s.state.panes.filter((p) => p.muxKey === ws.muxKey && p.workspaceId === ws.id);
    s.state.workspaces = s.state.workspaces.filter((w) => w !== ws);
    s.state.tabs = s.state.tabs.filter((t) => !(t.muxKey === ws.muxKey && t.workspaceId === ws.id));
    s.state.panes = gone.length ? s.state.panes.filter((p) => !gone.includes(p)) : s.state.panes;
    for (const p of gone) delete s.screens[p.key];
    for (const es of sources) es.push(s, { state: true });
    return noContent();
  }

  const mux = url.pathname.match(/^\/api\/muxes\/([^/]+)\/(tabs|workspaces)$/);
  if (mux) {
    const muxKey = decodeURIComponent(mux[1]!);
    const bad = writableMux(s, muxKey);
    if (bad) return bad;

    if (mux[2] === 'tabs') {
      const o = (body ?? {}) as NewTabBody;
      if (badLabel(o.label)) return json({ error: 'label' }, 400);
      if (o.label === FAIL) return json({ error: 'agent_not_ready' }, 502);
      const ws = s.state.workspaces.find((w) => w.muxKey === muxKey && w.id === o.workspaceId);
      if (!ws) return json({ error: 'workspace not found' }, 404);
      const pane = addTab(s, muxKey, ws.id, { ...o, cwd: o.cwd ?? ws.cwd });
      for (const es of sources) es.push(s, { state: true });
      return json({ paneKey: pane.key }, 201);
    }

    const o = (body ?? {}) as NewWorkspaceBody;
    if (badLabel(o.label)) return json({ error: 'label' }, 400);
    if (o.label === FAIL || o.branch === FAIL) return json({ error: 'agent_not_ready' }, 502);
    const id = fresh('w');
    // A worktree lives beside its directory, named after the branch, and says so.
    const cwd = o.branch ? `${o.cwd ?? '~'}-${o.branch.replace(/\//g, '-')}` : o.cwd;
    const label = o.label ?? [basename(o.cwd), o.branch].filter(Boolean).join(' · ');
    s.state.workspaces.push({ key: `${muxKey}/${id}`, muxKey, id, label, cwd });
    addTab(s, muxKey, id, { workspaceId: id, cwd });
    for (const es of sources) es.push(s, { state: true });
    return json({ workspaceKey: `${muxKey}/${id}` }, 201);
  }

  if (url.pathname !== '/api/rename') return undefined;
  const o = (body ?? {}) as RenameBody & { workspaceId?: string; tabId?: string; paneId?: string };
  const bad = writableMux(s, o.muxKey ?? '');
  if (bad) return bad;
  if (badLabel(o.label) || o.label === undefined) return json({ error: 'label' }, 400);
  if (o.label === FAIL) return json({ error: 'agent_not_ready' }, 502);
  const pane = s.state.panes.find((p) => p.muxKey === o.muxKey && p.id === o.paneId);
  const target =
    s.state.workspaces.find((w) => w.muxKey === o.muxKey && w.id === o.workspaceId) ??
    s.state.tabs.find((t) => t.muxKey === o.muxKey && t.id === o.tabId) ??
    pane;
  if (!target) return json({ error: 'not found' }, 404);
  if (pane && target === pane) pane.title = o.label;
  else (target as { label: string }).label = o.label;
  for (const es of sources) es.push(s, { state: true });
  return noContent();
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  try {
    if (init?.body) return JSON.parse(String(init.body));
    if (input instanceof Request) return await input.clone().json();
  } catch { /* an unparseable body is simply no body */ }
  return undefined;
}

function route(s: Store, url: URL, method: string, body: unknown): Response | undefined {
  if (method === 'GET' && url.pathname === '/api/state') return json(s.state);
  if (url.pathname === '/api/settings') {
    if (method === 'GET') return json(s.settings);
    if (method === 'PUT') {
      const patch = (body ?? {}) as SettingsBody;
      if (patch.hosts) s.settings.hosts = patch.hosts;
      if ('trustedUser' in patch) {
        // The Hub only locks to the login it saw on this very request, so a phone cannot
        // lock a Hub to somebody else's identity. `null` unlocks and needs no header.
        if (patch.trustedUser === null) delete s.settings.trustedUser;
        else if (patch.trustedUser !== s.settings.login) return json({ error: 'login' }, 400);
        else s.settings.trustedUser = patch.trustedUser;
      }
      return json(s.settings);
    }
  }
  if (method === 'POST' && url.pathname === '/api/settings/suggest') {
    s.settings.suggest.enabled = Boolean((body as SuggestSettingBody | undefined)?.enabled);
    return json(s.settings);
  }
  // ponytail: just enough that the push wiring does not crash under `?mock`. The key is
  // not a real P-256 point, so `pushManager.subscribe` still refuses it in the browser.
  if (method === 'GET' && url.pathname === '/api/push/vapid') return json({ publicKey: 'mock-vapid-public-key' });
  if (url.pathname === '/api/push/subscribe') return noContent();

  // The Hub re-dials the Host and answers with the Host as it now stands. The fixture Host
  // stays down, which is the honest answer for a machine that is actually unreachable.
  const host = url.pathname.match(/^\/api\/hosts\/([^/]+)\/retry$/);
  if (method === 'POST' && host) {
    const found = s.state.hosts.find((h) => h.id === decodeURIComponent(host[1]!));
    if (!found) return json({ error: 'host not found' }, 404);
    for (const es of sources) es.push(s, { state: true });
    return json(found);
  }

  // One dial, nothing saved. A target containing `ok` answers; anything else is refused,
  // which is the pair of answers the Add Host sheet has to render.
  if (method === 'POST' && url.pathname === '/api/hosts/probe') {
    const target = (body as ProbeBody | undefined)?.target?.trim();
    if (!target) return json({ error: 'target' }, 400);
    return json(
      target.includes('ok')
        ? ({ online: true, sessions: ['default', 'work'] } satisfies ProbeResult)
        : ({ online: false, error: 'ssh: Permission denied (publickey)' } satisfies ProbeResult),
    );
  }

  // git runs in the Workspace cwd, so a Workspace the fixture has no repo for answers 409.
  const diff = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/diff$/);
  if (method === 'GET' && diff) {
    const key = decodeURIComponent(diff[1]!);
    if (!s.state.workspaces.some((w) => w.key === key)) return json({ error: 'unknown-workspace' }, 404);
    const scopes = MOCK_DIFFS[key];
    if (!scopes) return json({ error: 'not-a-repo' }, 409);
    const scope = (['working', 'staged', 'base'] as DiffScope[]).find((v) => v === url.searchParams.get('scope')) ?? 'working';
    const result = scopes[scope] ?? { scope, files: [], truncated: false };
    const one = url.searchParams.get('file');
    if (!one) return json(result);
    const whole = WHOLE[one] ?? result.files.find((f) => f.path === one);
    return whole ? json({ ...result, files: [whole], truncated: false }) : json({ error: 'unknown-file' }, 404);
  }

  const wrote = write(s, url, method, body);
  if (wrote) return wrote;

  const match = url.pathname.match(/^\/api\/panes\/([^/]+)\/(screen|input|mouse|seen|explain|attach|suggest|close)$/);
  if (!match) return undefined;
  let key: string;
  try { key = decodeURIComponent(match[1]!); } catch { return json({ error: 'bad pane key' }, 400); }
  const pane = s.state.panes.find((p) => p.key === key);
  if (!pane) return json({ error: 'pane not found' }, 404);

  if (method === 'GET' && match[2] === 'screen') {
    const mode: ScreenMode = url.searchParams.get('mode') === 'recent' ? 'recent' : 'visible';
    return json(s.screens[key]![mode]);
  }
  if (method === 'GET' && match[2] === 'explain') return json(mockExplains[key] ?? null);
  if (method === 'POST' && match[2] === 'input') {
    input(s, key, (body ?? {}) as InputBody);
    for (const es of sources) es.push(s, { state: true, screenKey: key });
    return noContent();
  }
  // The Hub builds the SGR bytes and refuses a report the client has not been told it may
  // send. ponytail: the fixture screens do not move under a tap; the answer is the point.
  if (method === 'POST' && match[2] === 'mouse') {
    return (body as MouseBody | undefined)?.allow ? noContent() : json({ error: 'mouse-off' }, 409);
  }
  // The upload arrives as `{name, size}` from MockXMLHttpRequest: no bytes are kept, and
  // the reply is the same three fields the Hub sends.
  if (method === 'POST' && match[2] === 'attach') {
    const { name, size } = body as { name: string; size: number };
    if (!size) return json({ error: 'body' }, 400);
    const file = `${Date.now()}-${sanitize(name)}`;
    return json({ path: `/home/dev/.cache/tautan/attachments/${file}`, bytes: size, display: `~/.cache/tautan/attachments/${file}` });
  }
  // A fresh draft. The fixture's own replies come back; a real Hub asks the model, and a
  // Hub with Smart replies off answers with the Pane unchanged.
  if (method === 'POST' && match[2] === 'suggest') {
    if (s.settings.suggest.enabled) {
      pane.suggestions = mockState.panes.find((p) => p.key === key)?.suggestions ?? [...DRAFTS];
      for (const es of sources) es.push(s, { state: true });
    }
    return json(pane);
  }
  if (method === 'POST' && match[2] === 'close') {
    const bad = writableMux(s, pane.muxKey);
    if (bad) return bad;
    s.state.panes = s.state.panes.filter((p) => p !== pane);
    delete s.screens[key];
    // A Tab with no Panes left goes with it, the way a Mux drops an empty Tab.
    if (!s.state.panes.some((p) => p.muxKey === pane.muxKey && p.tabId === pane.tabId))
      s.state.tabs = s.state.tabs.filter((t) => !(t.muxKey === pane.muxKey && t.id === pane.tabId));
    for (const es of sources) es.push(s, { state: true });
    return noContent();
  }
  if (method === 'POST' && match[2] === 'seen') {
    pane.seenRevision = (body as SeenBody | undefined)?.revision ?? pane.revision;
    for (const es of sources) es.push(s, { state: true });
    return noContent();
  }
  return undefined;
}

/**
 * The `open` query param, so a screenshot can land on an open drawer:
 * `switch`, `more`, `newtab`, `newworkspace`, `add-host`. `diff` is a screen, not a
 * drawer: it sets the hash below. `?mock&theme=latte` forces a
 * theme (read in app.tsx) and `?mock&still` stops the fixture ticking.
 * ponytail: no allow-list of names; the screens that read it already know theirs.
 */
export function mockOpen(): string | null {
  return new URLSearchParams(location.search).get('open');
}

/** Serve the Hub API from memory when the page is opened with `?mock`. */
export function installMock(): void {
  if (installed) return;
  if (!location.search.includes('mock') && meta('VITE_MOCK') !== '1') return;
  installed = true;
  if (meta('DEV') !== false) assertMockInvariants();
  // `?mock&open=diff` opens the Diff screen on the Workspace whose diff is cut short.
  if (mockOpen() === 'diff' && !location.hash) location.hash = `#/diff/${encodeURIComponent('mbp/herdr/digivaley')}`;

  const s: Store = {
    state: structuredClone(mockState),
    screens: structuredClone(mockScreens),
    settings: {
      // Locked to the login this request carries, so Unlock works and a re-lock is legal.
      login: 'dev@github',
      trustedUser: 'dev@github',
      servedBy: 'tailscale serve · 127.0.0.1:7700',
      hosts: [{ id: 'vps', label: 'vps', target: 'dev@vps.example.ts.net' }],
      suggest: { provider: 'zai', model: 'glm-5.2', enabled: true },
    },
  };
  store = s;

  const original = window.fetch.bind(window);
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, location.origin);
    if (!url.pathname.startsWith('/api/')) return original(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const response = route(s, url, method, await readBody(input, init));
    await sleep(80 + Math.random() * 120); // slow enough to see the loading states
    return response ?? json({ error: 'not found' }, 404);
  };
  // The cast drops Bun's `fetch.preconnect`, which no browser has anyway.
  window.fetch = patched as typeof window.fetch;

  window.EventSource = MockEventSource as unknown as typeof EventSource;
  window.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
  // `?mock&still` freezes the fixture: no new output, no Status drift, so a screenshot
  // of the same URL is the same picture twice.
  if (!location.search.includes('still')) setInterval(() => tick(s), 2500);
}
