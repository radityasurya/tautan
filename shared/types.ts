// Shared contract between the Hub (server/), the web app (web/), and tests.
// Vocabulary: see CONTEXT.md (Hub, Host, Mux, Workspace, Tab, Pane, Agent, Status, Seen, Screen, Explain).

export type Status = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface Workspace { id: string; label: string; cwd?: string }
export interface Tab { id: string; workspaceId: string; label: string }
export interface Pane {
  id: string; tabId: string; workspaceId: string; title: string; cwd?: string;
  agent?: string; status: Status; revision: number; cols?: number; rows?: number;
  /** foreground command name (tmux: pane_current_command; herdr: last foreground process), used to pick the App profile */ command?: string;
}
export interface Tree { workspaces: Workspace[]; tabs: Tab[]; panes: Pane[] }

export type ScreenMode = 'visible' | 'recent';
export interface Screen { text: string; ansi: boolean; revision: number; mode: ScreenMode }

export interface Explain {
  ruleId: string; state: Status; detection: string;
  hintKeys: { key: string; label: string }[];
}

export interface Mux {
  readonly kind: 'herdr' | 'tmux';
  readonly id: string;
  tree(): Promise<Tree>;
  read(paneId: string, mode: ScreenMode): Promise<Screen>;
  sendText(paneId: string, text: string): Promise<void>;
  sendKeys(paneId: string, keys: string[]): Promise<void>; // herdr key names are canonical
  /** write bytes to the pty untouched (escape sequences included) */
  sendRaw(paneId: string, raw: string): Promise<void>;
  onChange(cb: (paneIds: string[] | 'all') => void): () => void;
  // herdr only; tmux throws Error('unsupported'). ponytail: no capability flags, add at a third backend.
  newTab(workspaceId: string, o: { cwd?: string; label?: string; agent?: string }): Promise<Pane>;
  newWorkspace(o: { cwd?: string; label?: string; branch?: string }): Promise<Workspace>;
  rename(t: { workspaceId: string } | { tabId: string } | { paneId: string }, label: string): Promise<void>;
  closePane(paneId: string): Promise<void>;
  closeWorkspace(workspaceId: string): Promise<void>;
  explain(paneId: string): Promise<Explain | null>;
  close(): void;
}

// ---- HTTP API payloads ----
// Keys: muxKey = `${hostId}/${muxId}`, paneKey = `${muxKey}/${paneId}`. Raw in JSON;
// `encodeURIComponent(key)` when used as a path segment (`/api/panes/:key/...`).

export interface StateHost {
  id: string; label: string; online: boolean; error?: string;
  /** ssh target or tailnet name; absent for the local machine */
  target?: string;
  /** where the Host came from: this machine, `herdr machine list`, or the config file */
  source?: 'local' | 'machines' | 'config';
}
export interface StateMux { key: string; hostId: string; kind: 'herdr' | 'tmux'; label: string; online: boolean }
export interface StateWorkspace { key: string; muxKey: string; id: string; label: string; cwd?: string }
export interface StateTab { key: string; muxKey: string; workspaceId: string; id: string; label: string }
export interface StatePane {
  key: string; muxKey: string; workspaceId: string; tabId: string; id: string; title: string;
  cwd?: string; agent?: string; status: Status; revision: number; seenRevision: number;
  cols?: number; rows?: number;
  /** foreground command name (tmux: pane_current_command; herdr: last foreground process), used to pick the App profile */ command?: string;
  /** last non-empty line of the visible Screen; agent Panes only, cached per revision by the Hub */
  lastLine?: string;
  /** ms epoch of the last Status change the Hub observed; first sight counts as a change */
  statusChangedAt?: number;
  /** Smart replies drafted by the Hub for the latest Status change; agent Panes only, ≤ 3, absent when off */
  suggestions?: string[];
}
/** GET /api/state and SSE `event: state` */
export interface State { hosts: StateHost[]; muxes: StateMux[]; workspaces: StateWorkspace[]; tabs: StateTab[]; panes: StatePane[] }
/** GET /api/panes/:key/screen?mode= and SSE `event: screen` */
export interface ScreenEvent extends Screen { key: string }
/** POST /api/panes/:key/input — text is sent first, then keys, then raw (bytes written to the pty untouched) */
export interface InputBody { text?: string; keys?: string[]; raw?: string }
/** POST /api/panes/:key/mouse — the Hub builds the SGR bytes; `allow` must be true (profile or per-Pane switch) or the Hub answers 409 */
export interface MouseBody { kind: 'click' | 'right' | 'double' | 'wheelUp' | 'wheelDown'; col: number; row: number; allow: boolean }
/** what tapping an Affordance does: keys → send_keys names; text → sendText; command → text + enter; copy → clipboard */
export type Action = { keys: string[] } | { text: string } | { command: string } | { copy: string };
/** a tappable token on the grid, 0-based row/col, colEnd exclusive */
export interface Affordance { row: number; colStart: number; colEnd: number; label: string; action: Action }
/** POST /api/panes/:key/seen */
export interface SeenBody { revision: number }
// Phase 7 write routes. Keys: muxKey = `${hostId}/${muxId}`; paneKey = `${muxKey}/${paneId}`;
// workspaceKey = `${muxKey}/${workspaceId}`. Encode a key with encodeURIComponent in a path.
/** POST /api/muxes/:key/tabs → 201 NewTabResult */
export interface NewTabBody { workspaceId: string; cwd?: string; label?: string; agent?: string }
export interface NewTabResult { paneKey: string }
/** POST /api/muxes/:key/workspaces → 201 NewWorkspaceResult; branch set → git worktree */
export interface NewWorkspaceBody { cwd?: string; label?: string; branch?: string }
export interface NewWorkspaceResult { workspaceKey: string }
/** POST /api/rename → 204; exactly one of workspaceId | tabId | paneId */
export type RenameBody = { muxKey: string; label: string } & ({ workspaceId: string } | { tabId: string } | { paneId: string });
/** POST /api/panes/:key/close → 204. Errors on all four: `{ error: string }` — 400 body, 403 origin, 404 unknown, 501 'unsupported', 502 herdr error code. */
/** POST /api/workspaces/:key/close → 204; `key` is the workspaceKey. Same error set as the Pane close. */
/** POST /api/panes/:key/attach */
export interface AttachResult { path: string; bytes: number; display: string }
export type DiffScope = 'working' | 'staged' | 'base';
export interface DiffLine { type: 'ctx' | 'add' | 'del' | 'meta'; text: string; oldNo?: number; newNo?: number }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile {
  path: string; oldPath?: string; additions: number; deletions: number; binary?: boolean;
  hunks: DiffHunk[];
}
export interface DiffResult { scope: DiffScope; base?: string; files: DiffFile[]; truncated: boolean }
/** POST /api/push/subscribe */
export interface PushSubscriptionBody {
  endpoint: string; expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}
/** One entry of $XDG_CONFIG_HOME/tautan/hosts.json (default ~/.config/tautan/hosts.json). */
export interface HostConfig {
  id: string; label?: string;
  /** ssh target, e.g. `dev@vps.example.ts.net` */
  target: string;
  /** herdr session name; absent = discover all running sessions */
  session?: string;
  herdr?: boolean; tmux?: boolean;
}
/** POST /api/hosts/probe body: run discovery once, save nothing. */
export interface ProbeBody { target: string; session?: string }
export interface ProbeResult { online: boolean; sessions?: string[]; error?: string }
/** PUT /api/settings body. `trustedUser: null` unlocks. Omitted keys are left unchanged. */
export interface SettingsBody { trustedUser?: string | null; hosts?: HostConfig[] }
/** GET /api/settings */
export interface Settings {
  trustedUser?: string;
  /** the `Tailscale-User-Login` header as seen on this request; absent when not behind tailscale serve */
  login?: string;
  servedBy?: string;
  hosts: HostConfig[];
  /** Smart replies: provider/model absent when the Hub has no TAUTAN_SUGGEST; enabled is the persisted Hub flag */
  suggest: { provider?: string; model?: string; enabled: boolean };
}
/** POST /api/settings/suggest */
export interface SuggestSettingBody { enabled: boolean }
/** POST /api/panes/:key/suggest — forces a fresh Smart replies call; responds with the StatePane */

// ---- ANSI spans (shared/ansi.ts) ----
// fg/bg: a number 0..15 is a palette index (render as `var(--ansi-N)`);
// a string is a CSS color such as `rgb(r,g,b)` (256-color cube/grayscale and truecolor).
export interface Span {
  text: string; fg?: number | string; bg?: number | string;
  bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean; strike?: boolean;
}
