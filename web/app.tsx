import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { ScreenEvent, State } from '../shared/types.ts';
import { NeedsCard } from './alert.tsx';
import { Diff } from './diff.tsx';
import { FileScreen } from './file.tsx';
import { Home, seedSeen, unseen } from './home.tsx';
import { HostDetail, Hosts } from './hosts.tsx';
import { AgentsTab, HostsTab, SettingsTab } from './icons.tsx';
import { mockOpen } from './mock.ts';
import { PaneScreen } from './pane.tsx';
import { setBadge } from './push.ts';
import { Settings } from './settings.tsx';
import { ThemeProvider, tokens } from './halaska-kit';

// ---- theme ----
// The UI is Halaska Kit: two palettes, light and dark, plus the accent context. The
// terminal grid keeps its own ANSI palettes (`--ansi-*` in theme.css), so `data-theme`
// still carries the resolved light/dark for it.
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];
type KitTheme = 'light' | 'dark';

const dark = matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): Theme {
  // `?mock&theme=dark` forces a theme, so a screenshot can reach one without touching storage.
  const forced = new URLSearchParams(location.search).get('theme') as Theme | null;
  if (forced && THEMES.includes(forced)) return forced;
  const t = localStorage.getItem('tautan.theme') as Theme | null;
  return t && THEMES.includes(t) ? t : 'system';
}

const resolve = (t: Theme): KitTheme => (t === 'system' ? (dark.matches ? 'dark' : 'light') : t);

export function setTheme(theme: Theme) {
  localStorage.setItem('tautan.theme', theme);
  applyTheme(theme);
  dispatchEvent(new CustomEvent('tautan:theme'));
}

function applyTheme(theme: Theme) {
  const kit = resolve(theme);
  document.documentElement.dataset.theme = kit;
  // The kit palette is the one source of colour. tautan's CSS tokens are re-pointed at it
  // at runtime, so the custom rows, headers and bars follow Halaska without every one of
  // them carrying kit inline styles. Tailwind keeps layout only.
  const pal = tokens[kit];
  const root = document.documentElement.style;
  const set = (name: string, value: string) => root.setProperty(name, value);
  set('--bg', pal.bg);
  set('--fg', pal.text);
  set('--muted', pal.textSecondary);
  set('--surface', pal.bgSubtle);
  set('--elevated', kit === 'dark' ? 'rgba(42,42,42,0.92)' : '#ffffff');
  set('--border', pal.border);
  set('--accent', pal.accent);
  set('--ok', pal.success);
  set('--warn', pal.warning);
  set('--danger', pal.danger);
  set(
    '--elevated-shadow',
    kit === 'dark' ? '0 8px 40px rgba(0,0,0,0.5)' : `0 0 0 1px ${pal.border}, 0 8px 40px rgba(0,0,0,0.14)`,
  );
  document.body.style.background = pal.bg;
  document.body.style.color = pal.text;
}

applyTheme(getTheme());
dark.addEventListener('change', () => applyTheme(getTheme()));

/** The resolved kit theme, as state, so <ThemeProvider> follows the picker and the OS. */
export function useKitTheme(): KitTheme {
  const [kit, setKit] = useState(() => resolve(getTheme()));
  useEffect(() => {
    const on = () => {
      applyTheme(getTheme());
      setKit(resolve(getTheme()));
    };
    dark.addEventListener('change', on);
    addEventListener('tautan:theme', on);
    return () => {
      dark.removeEventListener('change', on);
      removeEventListener('tautan:theme', on);
    };
  }, []);
  return kit;
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A short tap, Android only, behind the Settings toggle. iOS has no web haptics. */
export function haptic() {
  if (!/Android/.test(navigator.userAgent)) return;
  if (localStorage.getItem('tautan.haptics') === 'off') return;
  navigator.vibrate?.(8);
}

// ---- events ----

/** One EventSource for the whole app. It reopens when the watched Pane changes. */
export function useEvents(paneKey?: string) {
  const [state, setState] = useState<State | null>(null);
  const [screen, setScreen] = useState<ScreenEvent | null>(null);
  const [connected, setConnected] = useState(true);
  const [attempt, setAttempt] = useState(0);

  // Pane to Pane keeps the last Screen until the new Pane's first `screen` event, so the grid
  // swaps instead of blanking; PaneScreen matches `screen.key` to tell the two apart. Leaving
  // the Pane screens drops it, so the next Pane opened from Home never shows a stranger's grid.
  useEffect(() => { if (!paneKey) setScreen(null); }, [paneKey]);

  useEffect(() => {
    // The Hub still serves `mode=recent`; tautan's UI only ever shows the visible grid, and
    // Wrap reflows it client-side. See docs/DESIGN.md "Terminal width on a phone".
    const url = paneKey ? `/api/events?pane=${encodeURIComponent(paneKey)}&mode=visible` : '/api/events';
    const es = new EventSource(url);
    let retry: ReturnType<typeof setTimeout>;
    const on = <T,>(name: string, set: (v: T) => void) =>
      es.addEventListener(name, (e) => {
        setConnected(true);
        set(JSON.parse((e as MessageEvent<string>).data) as T);
      });
    on<State>('state', value => { seedSeen(value.panes); setState(value); });
    on<ScreenEvent>('screen', setScreen);
    es.onopen = () => { setConnected(true); debug.opens++; debug.log('open'); };
    es.addEventListener('state', () => { debug.events++; debug.log('state'); });
    es.onerror = () => {
      debug.errors++; debug.log(`error readyState=${es.readyState}`);
      setConnected(false);
      // The browser only retries a dropped stream. An HTTP error (Hub restarting) closes
      // the EventSource for good, so reopen it ourselves.
      if (es.readyState === EventSource.CLOSED) retry = setTimeout(() => setAttempt((a) => a + 1), 2000);
    };
    return () => {
      clearTimeout(retry);
      es.close();
    };
  }, [paneKey, attempt]);

  return { state, screen, connected };
}

// ---- ?debug overlay: stream diagnostics readable on a phone with no devtools ----
// ponytail: module-level counters, one fixed box; remove when Safari SSE is settled.
export const debug = {
  opens: 0, events: 0, errors: 0, lines: [] as string[],
  log(line: string) { this.lines = [...this.lines.slice(-7), `${new Date().toISOString().slice(11, 19)} ${line}`]; debugTick?.(); },
};
let debugTick: (() => void) | undefined;
export function DebugOverlay() {
  const [, tick] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => { debugTick = () => tick((n) => n + 1); return () => { debugTick = undefined; }; }, []);
  if (!new URLSearchParams(location.search).has('debug')) return null;
  return (
    <div className="fixed right-2 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-[60] flex flex-col items-end gap-1">
      {open && (
        <pre className="max-h-56 w-[min(420px,calc(100vw-1rem))] overflow-auto rounded-lg border border-border bg-elevated p-2 font-mono text-[11px] leading-snug text-fg shadow-lg">
          {`ua ${navigator.userAgent.slice(0, 80)}\nsse opens=${debug.opens} state-events=${debug.events} errors=${debug.errors}\n${debug.lines.join('\n')}`}
        </pre>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded-chip border border-border bg-elevated px-2.5 py-1 font-mono text-[11px] text-muted shadow-elevated"
      >
        debug · {debug.events}/{debug.errors}
      </button>
    </div>
  );
}

// ---- router ----

const path = () => location.hash.slice(1) || '/';
let apply: ((route: string) => void) | null = null;

/** `pane` for `#/pane/<key>`, `` for `#/`: what kind of screen a hash route is. */
const screenOf = (hash: string) => hash.replace(/^#?\/?/, '').split('/')[0];

/**
 * Push a hash route. `pushState` keeps the history entry the iOS edge swipe and the
 * Android back button need, and the View Transition wraps the synchronous re-render.
 * The push plays only when the kind of screen changes (Home ↔ Pane): Pane to Pane swaps
 * the content in place, so the header, the Tab strip and the dock never move.
 */
export function navigate(to: string, { transition = screenOf(to) !== screenOf(location.hash) } = {}) {
  if (to === location.hash) return;
  const run = () => {
    history.pushState(null, '', to);
    flushSync(() => apply?.(path()));
  };
  const start = (document as { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
  if (start && transition && !reducedMotion()) start.call(document, run);
  else run();
}

/** An `<a>` so the URL is real and long-press still offers "open in new tab". A caller's
 *  `onClick` runs first and may `preventDefault()` to keep the tap for itself. */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

function useRoute() {
  const [route, setRoute] = useState(path);
  useEffect(() => {
    apply = setRoute;
    const on = () => setRoute(path());
    addEventListener('hashchange', on);
    addEventListener('popstate', on);
    return () => {
      apply = null;
      removeEventListener('hashchange', on);
      removeEventListener('popstate', on);
    };
  }, []);
  return route;
}

// ---- tab bar ----

// Three tabs. Hosts and Settings are two screens; each owns its own routes.
const TABS = [
  { to: '#/', label: 'Panes', Icon: AgentsTab },
  { to: '#/hosts', label: 'Hosts', Icon: HostsTab },
  { to: '#/settings', label: 'Settings', Icon: SettingsTab },
];

/** A hash segment, decoded; undefined when it is malformed (`%E0%A4%A`), so render never throws. */
const safeDecode = (text: string) => {
  try { return decodeURIComponent(text); } catch { return undefined; }
};

/**
 * The one parser for the two non-Pane screens: `#/settings[/<section>]`, `#/hosts`, and
 * `#/hosts/<id>` (Host detail). An empty or malformed id is the Hosts list, and so is
 * `#/settings/hosts`, where Phase 22 kept Hosts, so saved links keep working.
 */
function screenRoute(route: string): { section: string } | { hosts: true; hostId?: string } | undefined {
  const m = /^\/(settings|hosts)(?:\/(.*))?$/.exec(route);
  if (!m) return undefined;
  if (m[1] === 'settings') return m[2] === 'hosts' ? { hosts: true } : { section: m[2] ?? '' };
  const id = safeDecode(m[2] ?? '');
  return id ? { hosts: true, hostId: id } : { hosts: true };
}

/** Which tab a route belongs to. Pane, Diff and File screens hide the bar, so they need none. */
const tabOf = (route: string) => {
  const at = screenRoute(route);
  return !at ? '#/' : 'hosts' in at ? '#/hosts' : '#/settings';
};

function TabBar({ route, badge }: { route: string; badge: number }) {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    // The keyboard must never cover a focused composer. One rule, both platforms.
    const is = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea'));
    const down = (e: FocusEvent) => is(e.target) && setTyping(true);
    const up = (e: FocusEvent) => is(e.target) && setTyping(false);
    document.addEventListener('focusin', down);
    document.addEventListener('focusout', up);
    return () => {
      document.removeEventListener('focusin', down);
      document.removeEventListener('focusout', up);
    };
  }, []);
  if (typing) return null;

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+8px)] z-40 mx-auto flex h-13 w-auto max-w-[420px] items-center justify-around rounded-tabbar border border-border bg-elevated/88 px-2 shadow-elevated backdrop-blur-md"
    >
      {TABS.map(({ to, label, Icon }) => {
        const on = tabOf(route) === to;
        return (
          <Link
            key={to}
            to={to}
            aria-current={on ? 'page' : undefined}
            className={`relative flex w-22 flex-col items-center gap-0.5 ${on ? 'text-accent' : 'text-muted'}`}
          >
            <Icon />
            <span className={`text-[10px] tracking-[0.02em] ${on ? 'font-semibold' : 'font-medium'}`}>{label}</span>
            {to === '#/' && badge > 0 && (
              <span
                aria-label={`${badge} need you`}
                className="absolute -top-[3px] right-[22px] h-4 min-w-4 rounded-chip bg-warn px-1 text-center text-[10px] leading-4 font-bold text-bg"
              >
                {badge > 9 ? '9+' : badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

// ---- desktop frame ----
// One breakpoint: Tailwind `lg`, 1024 px. Below it the app is the phone app, untouched.

const LG = '(min-width: 1024px)';

/** True at `lg` and up. Follows a window resize with no reload. */
export function useDesktop() {
  const [on, setOn] = useState(() => matchMedia(LG).matches);
  useEffect(() => {
    const mq = matchMedia(LG);
    const change = () => setOn(mq.matches);
    mq.addEventListener('change', change);
    change();
    return () => mq.removeEventListener('change', change);
  }, []);
  return on;
}

const SIDEBAR = 'tautan.sidebar';

/** The sidebar's open state, and the `⌘B` / `Ctrl+B` toggle. Remembered in localStorage. */
function useSidebar(enabled: boolean) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(SIDEBAR) !== 'closed'; } catch { return true; }
  });
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || e.altKey || e.shiftKey) return;
      // Ctrl+B is the tmux prefix: it toggles only outside an editable, and is never swallowed there.
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea'));
      if (!(e.metaKey || (e.ctrlKey && !typing))) return;
      e.preventDefault();
      setOpen((was) => {
        try { localStorage.setItem(SIDEBAR, was ? 'closed' : 'open'); } catch {}
        return !was;
      });
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [enabled]);
  return open;
}

/** The sidebar footer, and the cross-link at the foot of each screen's own nav. */
const FOOTER = [
  { to: '#/settings', label: 'Settings', Icon: SettingsTab },
  { to: '#/hosts', label: 'Hosts', Icon: HostsTab },
];

/** Settings' own sections. Each is `#/settings/<id>`, so a link lands on it. */
const SECTIONS = [
  ['appearance', 'Appearance'],
  ['notifications', 'Notifications'],
  ['replies', 'Replies'],
  ['access', 'Access'],
  ['about', 'About'],
] as const;

const NAV_LINK = 'flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] focus-visible:outline-2 focus-visible:outline-accent';
const navLink = (on: boolean) => `${NAV_LINK} ${on ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated/60 hover:text-fg'}`;

/**
 * The left column of Settings and of Hosts at `lg`: back to the Panes, the screen's title,
 * its own links, and the other screen at the foot. Settings lists its sections; Hosts lists
 * every Host, each with its reachability dot.
 */
// ponytail: the current section is the route, not a scroll-spy; scrolling by hand does not
// move the highlight. Add an IntersectionObserver if that reads wrong.
function ScreenNav({ hosts, current, state }: { hosts: boolean; current: string; state: State | null }) {
  const other = FOOTER.find((f) => f.to !== (hosts ? '#/hosts' : '#/settings'))!;
  return (
    <nav
      aria-label={hosts ? 'Hosts' : 'Settings sections'}
      className="sticky top-0 flex h-dvh w-[240px] shrink-0 flex-col gap-0.5 border-r border-border bg-surface px-4 py-6"
    >
      <Link to="#/" className="flex items-center gap-2 px-2 pb-4 text-[13px] text-muted hover:text-fg">
        <span aria-hidden>‹</span>All panes
      </Link>
      <span className="px-2 pb-3 text-[22px] font-semibold tracking-tight">{hosts ? 'Hosts' : 'Settings'}</span>
      {hosts ? (
        <>
          <Link to="#/hosts" aria-current={current === '' ? 'true' : undefined} className={navLink(current === '')}>
            All Hosts
            <span className="ml-auto text-caption tabular-nums text-muted">{state?.hosts.length ?? ''}</span>
          </Link>
          {state?.hosts.map((h) => {
            const on = h.id === current;
            return (
              <Link
                key={h.id}
                to={`#/hosts/${encodeURIComponent(h.id)}`}
                aria-current={on ? 'true' : undefined}
                className={navLink(on)}
              >
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${h.online ? 'bg-ok' : 'bg-danger'}`} />
                <span className="min-w-0 truncate">{h.label}</span>
                {!h.online && <span className="ml-auto shrink-0 text-caption text-danger">down</span>}
              </Link>
            );
          })}
        </>
      ) : (
        SECTIONS.map(([id, label]) => {
          const to = `#/settings/${id}`;
          const on = id === current;
          return (
            <Link
              key={id}
              to={to}
              aria-current={on ? 'true' : undefined}
              // The same link twice is no route change, so scroll back to the section by hand.
              onClick={() => location.hash === to && document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' })}
              className={navLink(on)}
            >
              {label}
            </Link>
          );
        })
      )}
      <span className="flex-1" />
      <Link to={other.to} className={`${NAV_LINK} text-muted hover:bg-elevated/60 hover:text-fg`}>
        <other.Icon size={16} />
        {other.label}
      </Link>
    </nav>
  );
}

// ---- app ----

export function App() {
  const route = useRoute();
  const kitTheme = useKitTheme();
  const paneKey = route.startsWith('/pane/') ? safeDecode(route.slice('/pane/'.length)) : undefined;
  const diffKey = route.startsWith('/diff/') ? safeDecode(route.slice('/diff/'.length)) : undefined;
  const fileRoute = route.startsWith('/file/') ? route.slice('/file/'.length) : '';
  const [encodedFileKey, fileQuery = ''] = fileRoute.split('?', 2);
  const fileKey = encodedFileKey ? safeDecode(encodedFileKey) : undefined;
  const filePath = fileKey ? (new URLSearchParams(fileQuery).get('path') ?? '') : '';
  const { state, screen, connected } = useEvents(paneKey);
  const desktop = useDesktop();
  const sidebar = useSidebar(desktop);
  const needsYou = state?.panes.filter((p) => p.status === 'blocked' && unseen(p)).length ?? 0;
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);
  const wakeLockToken = useRef(0);

  useEffect(() => {
    if (!paneKey) return;
    const token = ++wakeLockToken.current;
    let requestToken = 0;
    const release = async () => {
      const lock = wakeLock.current;
      wakeLock.current = null;
      try { await lock?.release(); } catch {}
    };
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || wakeLock.current) return;
      const request = ++requestToken;
      try {
        const lock = await (navigator as Navigator & {
          wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
        }).wakeLock?.request('screen');
        if (!lock) return;
        if (wakeLockToken.current !== token || requestToken !== request || document.visibilityState !== 'visible') {
          try { await lock.release(); } catch {}
          return;
        }
        wakeLock.current = lock;
      } catch {}
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void acquire();
      else {
        ++requestToken;
        void release();
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      ++wakeLockToken.current;
      ++requestToken;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void release();
    };
  }, [paneKey]);

  useEffect(() => {
    if (!paneKey) return;
    const title = state?.panes.find((pane) => pane.key === paneKey)?.title ?? paneKey.split('/').pop() ?? paneKey;
    document.title = `${title} · tautan`;
    return () => { document.title = 'tautan'; };
  }, [paneKey, state]);

  // The app icon counts what the Needs you section holds: unseen `blocked` and `done`.
  // The tab badge stays stricter, because only `blocked` is worth a push.
  useEffect(() => {
    setBadge(state?.panes.filter((p) => (p.status === 'blocked' || p.status === 'done') && unseen(p)).length ?? 0);
  }, [state]);

  // A Host id the state does not know falls back to the Hosts list. Before the first state
  // event it cannot be judged, so Host detail shows its loading line until then.
  const at = screenRoute(route);
  const hostsAt = at && 'hosts' in at ? at : undefined;
  const hostId =
    hostsAt?.hostId !== undefined && (!state || state.hosts.some((h) => h.id === hostsAt.hostId)) ? hostsAt.hostId : undefined;
  const settingsAt = at && 'section' in at ? at.section : undefined;
  const section = at !== undefined;
  // At `lg` the Pane list is the sidebar, so the `/` route has no list of its own to show
  // until `⌘B` hides the sidebar.
  const home = desktop && sidebar ? (
    <p className="px-6 pt-24 text-center text-body text-muted">Pick a Pane from the list.</p>
  ) : (
    <Home state={state} />
  );
  const screens = paneKey ? (
        <PaneScreen paneKey={paneKey} state={state} screen={screen} />
      ) : diffKey ? (
        <Diff workspaceKey={diffKey} state={state} />
      ) : fileKey ? (
        <FileScreen paneKey={fileKey} path={filePath} state={state} />
      ) : hostId !== undefined ? (
        <HostDetail hostId={hostId} state={state} />
      ) : hostsAt ? (
        <Hosts state={state} />
      ) : settingsAt !== undefined ? (
        <Settings section={settingsAt} />
      ) : (
        home
      );

  return (
    <ThemeProvider theme={kitTheme}>
      <DebugOverlay />
      <div
        role="status"
        className={`fixed inset-x-0 top-0 z-50 overflow-hidden ${connected ? 'h-0' : 'h-0.5 animate-pulse'}`}
        style={connected ? undefined : { background: tokens[kitTheme].warning }}
        title={connected ? undefined : 'Reconnecting'}
      >
        <span className="sr-only">{connected ? '' : 'Reconnecting'}</span>
      </div>
      <NeedsCard state={state} openPaneKey={paneKey} onOpen={(key) => navigate(`#/pane/${encodeURIComponent(key)}`)} />
      {desktop ? (
        <div className="flex">
          {section ? (
            <ScreenNav hosts={!!hostsAt} current={hostsAt ? (hostId ?? '') : (settingsAt ?? '')} state={state} />
          ) : (
            sidebar && (
              <aside aria-label="All panes" className="sticky top-0 flex h-dvh w-[300px] shrink-0 flex-col border-r border-border bg-surface">
                {/* Home scrolls its own list, under a top that stays put. */}
                <div className="min-h-0 flex-1">
                  <Home state={state} compact />
                </div>
                <nav aria-label="Sections" className="flex shrink-0 gap-1 border-t border-border p-2">
                  {FOOTER.map(({ to, label, Icon }) => (
                    <Link key={to} to={to} className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg text-[13px] text-muted hover:bg-elevated/60 hover:text-fg">
                      <Icon size={16} />
                      {label}
                    </Link>
                  ))}
                </nav>
              </aside>
            )
          )}
          <div className="min-w-0 flex-1">{screens}</div>
        </div>
      ) : (
        <>
          {screens}
          {!paneKey && !diffKey && !fileKey && <TabBar route={route} badge={needsYou} />}
        </>
      )}
    </ThemeProvider>
  );
}

/** POST helper. The browser sets Origin for us, which is what the Hub checks. */
export function post(paneKey: string, path: 'input' | 'mouse' | 'seen' | 'suggest', body: unknown) {
  return fetch(`/api/panes/${encodeURIComponent(paneKey)}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {}); // ponytail: the SSE reconnect indicator is the only error surface in phase 1
}

/**
 * Send JSON and say what went wrong. Rejects with the Hub's own `{error}` code, or
 * `http <status>`, or `network` when the fetch never landed; resolves with the parsed
 * body (201) or undefined (204). The caller turns the code into a sentence.
 * ponytail: `method` only because `/api/settings` is a PUT and a GET; no second helper.
 */
export async function api<T>(path: string, body?: unknown, method: 'GET' | 'POST' | 'PUT' = 'POST'): Promise<T> {
  let response: Response;
  try {
    response = await fetch(
      path,
      method === 'GET'
        ? {}
        : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) },
    );
  } catch {
    throw new Error('network');
  }
  if (!response.ok) {
    const code = await response
      .json()
      .then((v) => (v as { error?: string }).error)
      .catch(() => undefined);
    throw new Error(code || `http ${response.status}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** `?mock&open=switch` lands a screenshot on an open drawer. Always false without `?mock`. */
export const opensWith = (name: string) => mockOpen() === name;
