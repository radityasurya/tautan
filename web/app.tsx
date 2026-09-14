import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AnchorHTMLAttributes } from 'react';
import type { ScreenEvent, State } from '../shared/types.ts';
import { Diff } from './diff.tsx';
import { Home, seedSeen, unseen } from './home.tsx';
import { Hosts } from './hosts.tsx';
import { AgentsTab, HostsTab, SettingsTab } from './icons.tsx';
import { mockOpen } from './mock.ts';
import { PaneScreen } from './pane.tsx';
import { setBadge } from './push.ts';
import { Settings } from './settings.tsx';

// ---- theme ----

export const THEMES = ['system', 'light', 'dark', 'latte', 'frappe', 'macchiato', 'mocha'] as const;
export type Theme = (typeof THEMES)[number];

const dark = matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): Theme {
  // `?mock&theme=latte` forces a theme, so a screenshot can reach one without touching storage.
  const forced = new URLSearchParams(location.search).get('theme') as Theme | null;
  if (forced && THEMES.includes(forced)) return forced;
  const t = localStorage.getItem('tautan.theme') as Theme | null;
  return t && THEMES.includes(t) ? t : 'system';
}

export function setTheme(theme: Theme) {
  localStorage.setItem('tautan.theme', theme);
  applyTheme(theme);
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme === 'system' ? (dark.matches ? 'dark' : 'light') : theme;
}

applyTheme(getTheme());
dark.addEventListener('change', () => applyTheme(getTheme()));

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

  useEffect(() => setScreen(null), [paneKey]);

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

/**
 * Push a hash route. `pushState` keeps the history entry the iOS edge swipe and the
 * Android back button need, and the View Transition wraps the synchronous re-render.
 */
export function navigate(to: string) {
  if (to === location.hash) return;
  const run = () => {
    history.pushState(null, '', to);
    flushSync(() => apply?.(path()));
  };
  const start = (document as { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
  if (start && !reducedMotion()) start.call(document, run);
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

const TABS = [
  { to: '#/', label: 'Agents', Icon: AgentsTab },
  { to: '#/hosts', label: 'Hosts', Icon: HostsTab },
  { to: '#/settings', label: 'Settings', Icon: SettingsTab },
];

function TabBar({ route, badge }: { route: string; badge: number }) {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    // The keyboard must never cover a focused composer. One rule, both platforms.
    const is = (t: EventTarget | null) => t instanceof HTMLElement && t.matches('input, textarea, [contenteditable]');
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
        const on = to === `#${route}` || (to === '#/' && route === '/');
        return (
          <Link
            key={to}
            to={to}
            aria-current={on ? 'page' : undefined}
            className={`relative flex w-22 flex-col items-center gap-0.5 ${on ? 'text-accent' : 'text-muted'}`}
          >
            <Icon />
            <span className={`text-[10px] tracking-[0.02em] ${on ? 'font-semibold' : 'font-medium'}`}>{label}</span>
            {label === 'Agents' && badge > 0 && (
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

// ---- app ----

export function App() {
  const route = useRoute();
  const paneKey = route.startsWith('/pane/') ? decodeURIComponent(route.slice('/pane/'.length)) : undefined;
  const diffKey = route.startsWith('/diff/') ? decodeURIComponent(route.slice('/diff/'.length)) : undefined;
  const { state, screen, connected } = useEvents(paneKey);
  const needsYou = state?.panes.filter((p) => p.status === 'blocked' && unseen(p)).length ?? 0;

  // The app icon counts what the Needs you section holds: unseen `blocked` and `done`.
  // The tab badge stays stricter, because only `blocked` is worth a push.
  useEffect(() => {
    setBadge(state?.panes.filter((p) => (p.status === 'blocked' || p.status === 'done') && unseen(p)).length ?? 0);
  }, [state]);

  return (
    <>
      <DebugOverlay />
      {!connected && (
        <div role="status" className="fixed inset-x-0 top-0 z-50 h-0.5 animate-pulse bg-warn" title="Reconnecting">
          <span className="sr-only">Reconnecting</span>
        </div>
      )}
      {paneKey ? (
        <PaneScreen paneKey={paneKey} state={state} screen={screen} />
      ) : diffKey ? (
        <Diff workspaceKey={diffKey} state={state} />
      ) : route === '/hosts' ? (
        <Hosts state={state} />
      ) : route === '/settings' ? (
        <Settings />
      ) : (
        <Home state={state} />
      )}
      {!paneKey && !diffKey && <TabBar route={route} badge={needsYou} />}
    </>
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
