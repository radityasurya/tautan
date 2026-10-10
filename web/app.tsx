import { Component, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { ScreenEvent, State, StatePane } from '../shared/types.ts';
import { NeedsCard } from './alert.tsx';
import { Diff } from './diff.tsx';
import { FileScreen } from './file.tsx';
import { Home, seedSeen, unseen } from './home.tsx';
import { HostDetail, Hosts } from './hosts.tsx';
import { AgentsTab, HostsTab, SettingsTab } from './icons.tsx';
import { PaneScreen } from './pane.tsx';
import { CHAT_EVENT } from '../shared/chat-merge.ts';
import { autoDeliver } from './pending.ts';
import { setBadge } from './push.ts';
import { Settings } from './settings.tsx';
import { UsageStrip } from './usage.tsx';
import { ThemeProvider, tokens } from './halaska-kit';
import { PALETTES, PALETTE_IDS, kitTokens } from './palettes.ts';
import { store, StorageNotice } from './store.tsx';

// ---- theme ----
// The UI is Halaska Kit: two bases, light and dark. A named palette (web/palettes.ts) sits
// on one base and overrides the tokens and the grid's `--ansi-*`; plain light and dark use
// the ANSI blocks in theme.css. `data-theme` carries the palette id, or the resolved base.
export const THEMES = ['system', 'light', 'dark', ...PALETTE_IDS] as string[];
export type Theme = string;
type KitTheme = 'light' | 'dark';

const dark = matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): Theme {
  // `?mock&theme=dark` forces a theme, so a screenshot can reach one without touching storage.
  const forced = new URLSearchParams(location.search).get('theme') as Theme | null;
  if (forced && THEMES.includes(forced)) return forced;
  const t = store.get('tautan.theme') as Theme | null;
  return t && THEMES.includes(t) ? t : 'system';
}

const resolve = (t: Theme): KitTheme =>
  t === 'system' ? (dark.matches ? 'dark' : 'light') : (PALETTES[t]?.base ?? (t as KitTheme));

export function setTheme(theme: Theme) {
  store.set('tautan.theme', theme);
  applyTheme(theme);
  dispatchEvent(new CustomEvent('tautan:theme'));
}

// The kit exports `tokens` as a plain object and reads it on every render, so a named palette
// is laid over tokens.light or tokens.dark in place; plain light and dark restore the originals.
const kitBase = { light: { ...tokens.light }, dark: { ...tokens.dark } };

function applyTheme(theme: Theme) {
  const kit = resolve(theme);
  const named = PALETTES[theme];
  for (const k of ['light', 'dark'] as const) Object.assign(tokens[k], kitBase[k]);
  if (named) Object.assign(tokens[kit], kitTokens(named));
  // A named palette is its own `data-theme`, so the Pane's nearest-ANSI cache (keyed on it)
  // rebuilds. Its colours go inline; the light and dark ANSI blocks in theme.css stay the
  // fallback and are what plain light and dark use.
  document.documentElement.dataset.theme = named ? theme : kit;
  // The kit palette is the one source of colour. tautan's CSS tokens are re-pointed at it
  // at runtime, so the custom rows, headers and bars follow Halaska without every one of
  // them carrying kit inline styles. Tailwind keeps layout only.
  const pal = tokens[kit];
  const root = document.documentElement.style;
  const set = (name: string, value: string) => root.setProperty(name, value);
  const bg = named?.bg ?? pal.bg;
  const fg = named?.fg ?? pal.text;
  const border = named?.border ?? pal.border;
  set('--bg', bg);
  set('--fg', fg);
  set('--muted', named?.muted ?? pal.textSecondary);
  set('--surface', named?.surface ?? pal.bgSubtle);
  set('--elevated', named?.elevated ?? (kit === 'dark' ? 'rgba(42,42,42,0.92)' : '#ffffff'));
  set('--border', border);
  set('--accent', named?.accent ?? pal.accent);
  set('--ok', named?.ok ?? pal.success);
  set('--warn', named?.warn ?? pal.warning);
  set('--danger', named?.danger ?? pal.danger);
  set(
    '--elevated-shadow',
    kit === 'dark' ? '0 8px 40px rgba(0,0,0,0.5)' : `0 0 0 1px ${border}, 0 8px 40px rgba(0,0,0,0.14)`,
  );
  root.colorScheme = kit;
  for (let i = 0; i < 16; i++) {
    if (named) set(`--ansi-${i}`, named.ansi[i]!);
    else root.removeProperty(`--ansi-${i}`);
  }
  document.body.style.background = bg;
  document.body.style.color = fg;
}

applyTheme(getTheme());
dark.addEventListener('change', () => applyTheme(getTheme()));

/** The resolved kit theme, as state, so <ThemeProvider> follows the picker and the OS. */
export function useKitTheme(): KitTheme {
  const [kit, setKit] = useState(() => resolve(getTheme()));
  const [, repaint] = useState(0);
  useEffect(() => {
    const on = () => {
      applyTheme(getTheme());
      setKit(resolve(getTheme()));
      // Two palettes can share a base; the bump re-renders the kit so it re-reads its tokens.
      repaint((n) => n + 1);
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

// ---- the keyboard ----
// iOS keeps the layout viewport when the keyboard opens and ignores `interactive-widget`, so
// the visual viewport is the only ruler for the space above the keyboard. The phone's Pane
// screen is sized from `--vv-h` and placed at `--vv-top`, so the composer sits on the
// keyboard. `--safe-b` drops the home-indicator inset while the keyboard covers it.
// ponytail: a 120 px gap is the keyboard test; a floating iPad keyboard leaves the inset on.
const viewport = window.visualViewport;
if (viewport) {
  const follow = () => {
    if (viewport.scale > 1.01) return; // a pinch zoom is not a keyboard
    const root = document.documentElement.style;
    root.setProperty('--vv-h', `${viewport.height}px`);
    root.setProperty('--vv-top', `${viewport.offsetTop}px`);
    if (innerHeight - viewport.height > 120) root.setProperty('--safe-b', '0px');
    else root.removeProperty('--safe-b');
  };
  viewport.addEventListener('resize', follow);
  viewport.addEventListener('scroll', follow);
  follow();
}

/** A short tap, Android only, behind the Settings toggle. iOS has no web haptics. */
export function haptic() {
  if (!/Android/.test(navigator.userAgent)) return;
  if (store.get('tautan.haptics') === 'off') return;
  navigator.vibrate?.(8);
}

// ---- events ----

// ---- split view (ADR 0006) ----

const SPLIT_KEY = 'tautan.split';
export const splitOn = () => {
  try { return store.get(SPLIT_KEY) !== 'off'; } catch { return true; }
};
export function setSplitOn(on: boolean) {
  try { store.set(SPLIT_KEY, on ? 'on' : 'off'); } catch {}
  dispatchEvent(new Event('tautan:split'));
}
/** "Split view" in the ⋯ sheet, as state, so the App's watched set follows the toggle. */
export function useSplitPref() {
  const [on, setOn] = useState(splitOn);
  useEffect(() => {
    const change = () => setOn(splitOn());
    addEventListener('tautan:split', change);
    return () => removeEventListener('tautan:split', change);
  }, []);
  return on;
}

/** The Panes a split view could draw: this Pane's Tab when it holds 2-4 Panes that all carry
 *  `x` and `y` (herdr omits both for a zoomed Tab). Size and the toggle are the caller's. */
export function splitSet(state: State | null, pane: StatePane | undefined): StatePane[] | null {
  if (!state || !pane) return null;
  const tab = state.panes.filter((p) => p.muxKey === pane.muxKey && p.workspaceId === pane.workspaceId && p.tabId === pane.tabId);
  return tab.length >= 2 && tab.length <= 4 && tab.every((p) => p.x !== undefined && p.y !== undefined && p.cols && p.rows) ? tab : null;
}

// ---- events ----

/** The last multi-Pane set a stream watched, so a cold load opens on the whole Tab at once. */
const WATCHED = 'tautan.watched';

const watchKeys = (state: State | null, paneKey: string, split: boolean) => {
  // A stale bootstrap state can predate the Pane (a Tab created moments ago), which is the
  // same unknown-Tab case as a failed GET: reuse the last split set that held this Pane.
  if (split && !state?.panes.some((p) => p.key === paneKey)) {
    // The Hub drops a key that no longer resolves, and the stream's own state event
    // corrects a stale set with one reconnect.
    try {
      const last: unknown = JSON.parse(store.get(WATCHED) ?? '[]');
      if (Array.isArray(last) && last.length <= 4 && last.includes(paneKey)) return last as string[];
    } catch {}
  }
  const set = split ? splitSet(state, state?.panes.find((p) => p.key === paneKey)) : null;
  return set ? set.map((p) => p.key).sort() : [paneKey];
};

/**
 * One EventSource for the whole app. It reopens when the watched set changes: a Tab change
 * does, a focus move inside a split Tab does not (the key is the same sorted set).
 */
export function useEvents(pick: (state: State | null) => string[]) {
  const [state, setState] = useState<State | null>(null);
  const [screens, setScreens] = useState<Record<string, ScreenEvent>>({});
  const [screen, setScreen] = useState<ScreenEvent | null>(null);
  const [streamId, setStreamId] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [booted, setBooted] = useState(false);
  const keys = pick(state);
  const watched = keys.join(',');

  // One GET /api/state before any stream opens: with the Tab's Panes known up front, a cold
  // split Tab opens on the whole set at once instead of on one Pane and then on the set.
  // A failed GET still boots; watchKeys then falls back to the remembered set or the Pane.
  useEffect(() => {
    let alive = true;
    fetch('/api/state')
      .then((r) => (r.ok ? (r.json() as Promise<State>) : null))
      .then((value) => {
        if (!alive || !value) return;
        seedSeen(value.panes);
        setState(value);
      })
      .catch(() => {})
      .finally(() => { if (alive) setBooted(true); });
    return () => { alive = false; };
  }, []);

  // Pane to Pane keeps the last Screen until the new Pane's first `screen` event, so the grid
  // swaps instead of blanking; PaneScreen matches `screen.key` to tell the two apart. Leaving
  // the Pane screens drops it, so the next Pane opened from Home never shows a stranger's grid.
  // The per-key map keeps only the watched keys, so a Tab change never shows a stale cell.
  useEffect(() => {
    if (!watched) setScreen(null);
    setScreens((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => keys.includes(k))));
  }, [watched]);

  useEffect(() => {
    if (!booted) return;
    // The Hub still serves `mode=recent`; tautan's UI only ever shows the visible grid, and
    // Wrap reflows it client-side. See docs/DESIGN.md "Terminal width on a phone".
    const url = keys.length ? `/api/events?${keys.map((k) => `pane=${encodeURIComponent(k)}`).join('&')}&mode=visible` : '/api/events';
    const es = new EventSource(url);
    if (keys.length > 1) store.set(WATCHED, JSON.stringify(keys));
    let retry: ReturnType<typeof setTimeout>;
    const on = <T,>(name: string, set: (v: T) => void) =>
      es.addEventListener(name, (e) => {
        setConnected(true);
        set(JSON.parse((e as MessageEvent<string>).data) as T);
      });
    on<{ stream: string }>('hello', (v) => setStreamId(v.stream));
    on<State>('state', value => { seedSeen(value.panes); setState(value); });
    on<ScreenEvent>('screen', (value) => {
      setScreen(value);
      setScreens((prev) => ({ ...prev, [value.key]: value }));
    });
    // ADR 0007: a wake-up for the Chat view, which makes its own `?since=` GET.
    es.addEventListener('chat', (e) => dispatchEvent(new CustomEvent(CHAT_EVENT, { detail: JSON.parse((e as MessageEvent<string>).data) })));
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // The browser only retries a dropped stream. An HTTP error (Hub restarting) closes
      // the EventSource for good, so reopen it ourselves.
      if (es.readyState === EventSource.CLOSED) retry = setTimeout(() => setAttempt((a) => a + 1), 2000);
    };
    return () => {
      clearTimeout(retry);
      es.close();
    };
  }, [watched, attempt, booted]);

  return { state, screen, screens, streamId, connected };
}

// ---- router ----

const path = () => location.hash.slice(1) || '/';
let apply: ((route: string) => void) | null = null;
/** The last screen outside Settings and Hosts: the Pane, in its lens, that closing them returns to. */
let before = '#/';

/** `pane` for `#/pane/<key>`, `` for `#/`: what kind of screen a hash route is. */
const screenOf = (hash: string) => hash.replace(/^#?\/?/, '').split('/')[0];

/**
 * Push a hash route. `pushState` keeps the history entry the iOS edge swipe and the
 * Android back button need, and the View Transition wraps the synchronous re-render.
 * The push plays only when the kind of screen changes (Home ↔ Pane): Pane to Pane swaps
 * the content in place, so the header, the Tab strip and the dock never move.
 */
export function navigate(to: string, { transition = screenOf(to) !== screenOf(location.hash), replace = false } = {}) {
  // Every way out of Settings and Hosts — "All panes", the Panes tab — says `#/`, and means
  // the screen they were opened from. Browser back already lands there.
  if (to === '#/' && screenRoute(path())) to = before;
  if (to === location.hash) return;
  const run = () => {
    if (replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
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
    if (!screenRoute(route)) before = `#${route}`;
  }, [route]);
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
    try { return store.get(SIDEBAR) !== 'closed'; } catch { return true; }
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
        try { store.set(SIDEBAR, was ? 'closed' : 'open'); } catch {}
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

/**
 * One screen that throws shows a small card instead of blanking the app: React unmounts the
 * whole tree on an uncaught render or effect error. Keyed by the route, so navigating away
 * mounts a fresh boundary and the next screen gets its chance.
 */
class ScreenBoundary extends Component<{ children: ReactNode; where: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[tautan] ${this.props.where} crashed:`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-start gap-3 px-6 pt-24">
        <p className="text-title">Something broke on this screen</p>
        <p className="font-mono text-caption text-muted break-words">{this.state.error.message}</p>
        <div className="flex gap-2">
          <button type="button" className="press h-10 rounded-chip bg-accent px-4 text-body font-semibold text-bg" onClick={() => location.reload()}>Reload</button>
          <button type="button" className="press h-10 rounded-chip border border-border px-4 text-body" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}

export function App() {
  const route = useRoute();
  const kitTheme = useKitTheme();
  const paneKey = route.startsWith('/pane/') ? safeDecode(route.slice('/pane/'.length)) : undefined;
  const diffKey = route.startsWith('/diff/') ? safeDecode(route.slice('/diff/'.length)) : undefined;
  const fileRoute = route.startsWith('/file/') ? route.slice('/file/'.length) : '';
  const [encodedFileKey, fileQuery = ''] = fileRoute.split('?', 2);
  const fileKey = encodedFileKey ? safeDecode(encodedFileKey) : undefined;
  const filePath = fileKey ? (new URLSearchParams(fileQuery).get('path') ?? '') : '';
  const desktop = useDesktop();
  const splitPref = useSplitPref();
  // The watched set must not depend on the layout: a lease belongs to its stream, so taking
  // or dropping one (or a resize back to the chips row) may not reopen it. The set is the
  // Tab's Panes whenever a split could show; focus moves inside it keep one sorted key.
  // useEvents holds every stream until the bootstrap state lands, so a first visit to a
  // split Tab opens one stream on the whole set, not one Pane and then the set.
  const { state, screen, screens: paneScreens, streamId, connected } = useEvents(
    (s) => (paneKey ? watchKeys(s, paneKey, desktop && splitPref) : []),
  );
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

  // A reply held while its Agent worked goes out once that Pane is back at a prompt, whichever
  // screen is open: the Status of every Pane is known here, not in one Composer.
  useEffect(() => {
    if (state) autoDeliver(state.panes);
  }, [state]);

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
  // A Pane route is keyed by its Tab, so a focus move between a split's cells keeps the
  // view mounted: no re-fetched Chat, no re-measured grid, no lost scroll.
  const openPane = paneKey ? state?.panes.find((p) => p.key === paneKey) : undefined;
  const screenKey = openPane ? `tab:${openPane.muxKey}/${openPane.tabId}` : route;
  const screens = paneKey ? (
        <PaneScreen paneKey={paneKey} state={state} screen={screen} screens={paneScreens} streamId={streamId} />
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
      <div
        role="status"
        className={`fixed inset-x-0 top-0 z-50 overflow-hidden ${connected ? 'h-0' : 'h-0.5 animate-pulse'}`}
        style={connected ? undefined : { background: tokens[kitTheme].warning }}
        title={connected ? undefined : 'Reconnecting'}
      >
        <span className="sr-only">{connected ? '' : 'Reconnecting'}</span>
      </div>
      <StorageNotice />
      <NeedsCard state={state} openPaneKey={paneKey} onOpen={(key) => navigate(`#/pane/${encodeURIComponent(key)}`)} />
      {desktop ? (
        // The frame is the window: the sidebar and the screen each scroll inside it, so the
        // document itself never does (a tall Settings page used to put a scrollbar on <html>).
        <div className="flex h-dvh overflow-hidden">
          {section ? (
            <ScreenNav hosts={!!hostsAt} current={hostsAt ? (hostId ?? '') : (settingsAt ?? '')} state={state} />
          ) : (
            sidebar && (
              // Not sticky: the frame never scrolls, and a sticky box is a stacking context that
              // held Home's sheets and Close dialog (z 10000) under the Pane column beside it.
              <aside aria-label="All panes" className="flex h-dvh w-[300px] shrink-0 flex-col border-r border-border bg-surface">
                {/* Home scrolls its own list, under a top that stays put. */}
                <div className="min-h-0 flex-1">
                  <ScreenBoundary key="sidebar" where="Pane list"><Home state={state} compact /></ScreenBoundary>
                </div>
                <UsageStrip />
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
          <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain"><ScreenBoundary key={screenKey} where={route}>{screens}</ScreenBoundary></div>
        </div>
      ) : (
        <>
          <ScreenBoundary key={screenKey} where={route}>{screens}</ScreenBoundary>
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

/** `?mock&open=switch` lands a screenshot on an open drawer; `?open=<name>` works without `?mock`. */
export const opensWith = (name: string) => new URLSearchParams(location.search).get('open') === name;
