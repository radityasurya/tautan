import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { findAffordances } from '../shared/affordances.ts';
import { parseAnsi } from '../shared/ansi.ts';
import { classify } from '../shared/layout.ts';
import type {
  NewTabBody, NewTabResult, RenameBody, ScreenEvent, SeenBody, Span, State, StatePane, Status,
} from '../shared/types.ts';
import { AffordanceLayer, useCell, useMouseForward } from './affordances.tsx';

import { api, haptic, navigate, opensWith, post, reducedMotion, useDesktop } from './app.tsx';
import { yesNoKeys } from '../shared/blocked.ts';
import { fetchExplain, promptLine, sendBlocked, type ExplainResponse } from './blocked.tsx';
import { Chat, readLens, writeLens, type LensMode } from './chat.tsx';
import { Composer, FADE } from './composer.tsx';
import { PaneHeader } from './header.tsx';
import { mouseAllowed, profileFor, setMouseOverride } from './profiles.ts';
import { commonAgent, Dot, markSeen } from './home.tsx';
import { ChevronDown, Down, Plus } from './icons.tsx';
import { ConfirmCloseSheet, MenuSheet, NewTabSheet, RenameSheet } from './sheets.tsx';
import { IconButton, Skeleton } from './halaska-kit';
import { ThemePicker } from './settings.tsx';
import { SwitchDrawer } from './switch.tsx';

// ---- themed terminal colours ----
// A 256-colour or truecolour span carries the palette the agent picked, which is nobody's
// theme. Snapped on, every such colour becomes the nearest of the theme's own 16, so one
// Pane reads as one picture. Indices 0–15 already resolve through `--ansi-*` and are left be.
let themed = localStorage.getItem('tautan.themedColors') !== 'off';
export const themedColors = () => themed;
export function setThemedColors(on: boolean) {
  themed = on;
  localStorage.setItem('tautan.themedColors', on ? 'on' : 'off');
}

const EXTRA_TOKENS = ['--warn', '--ok', '--danger', '--accent'] as const;
let paletteTheme: string | null = null;
let palette: [number, number, number][] = [];
/** One answer per distinct colour string: a screen repeats the same few thousands of times. */
const snapped = new Map<string, string>();

function parseColor(css: string): [number, number, number] | null {
  const s = css.trim();
  if (s.startsWith('#')) {
    const hex = s.length === 4 ? [...s.slice(1)].map((c) => c + c).join('') : s.slice(1);
    if (hex.length < 6) return null;
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  const n = s.match(/\d+/g);
  return n && n.length >= 3 ? [+n[0]!, +n[1]!, +n[2]!] : null;
}

/** The nearest `--ansi-*` by squared RGB distance. The palette is read once per theme. */
function nearestAnsi(css: string): string {
  const theme = document.documentElement.dataset.theme ?? '';
  if (theme !== paletteTheme) {
    const style = getComputedStyle(document.documentElement);
    // The sixteen ANSI slots plus the theme's semantic tokens: Catppuccin has no orange among
    // its sixteen, so without --warn a peach permission frame would snap to pink.
    palette = [
      ...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`),
      ...EXTRA_TOKENS,
    ].map((v) => parseColor(style.getPropertyValue(v)) ?? [0, 0, 0]);
    paletteTheme = theme;
    snapped.clear();
  }
  const hit = snapped.get(css);
  if (hit) return hit;
  const want = parseColor(css);
  let best = css;
  if (want) {
    let bestAt = 0;
    let bestBy = Infinity;
    palette.forEach((p, i) => {
      const d = (p[0] - want[0]) ** 2 + (p[1] - want[1]) ** 2 + (p[2] - want[2]) ** 2;
      if (d < bestBy) {
        bestBy = d;
        bestAt = i;
      }
    });
    best = `var(${bestAt < 16 ? `--ansi-${bestAt}` : EXTRA_TOKENS[bestAt - 16]})`;
  }
  snapped.set(css, best);
  return best;
}

const color = (c: number | string | undefined) =>
  typeof c === 'number' ? `var(--ansi-${c})` : c && themed ? nearestAnsi(c) : c;

/** The one ANSI-span style function. blocked.tsx renders the detection with it too. */
export function spanStyle(s: Span): CSSProperties {
  let fg = color(s.fg);
  let bg = color(s.bg);
  if (s.inverse) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--fg)'];
  const lines = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ');
  return {
    color: fg,
    background: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.6 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: lines || undefined,
  };
}

/** Styled ANSI text. Shared by the grid and the blocked card's detection excerpt. */
export function Ansi({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((spans, i) => (
        <Fragment key={i}>
          {spans.map((s, j) => (
            <span key={j} style={spanStyle(s)}>
              {s.text}
            </span>
          ))}
          {'\n'}
        </Fragment>
      ))}
    </>
  );
}

const ROLL: Status[] = ['blocked', 'working', 'done', 'idle', 'unknown'];
const rollUp = (panes: StatePane[]): Status => ROLL.find((s) => panes.some((p) => p.status === s)) ?? 'unknown';

/** The Pane a Tab reopens to, so switching back lands where you left. */
const lastPane = new Map<string, string>();

/** The same 500 ms hold and 10 px movement threshold as Home's row menus. */
function useLongPress(fn: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const stop = () => clearTimeout(timer.current);
  useEffect(() => stop, []);
  return {
    press: {
      onPointerDown: (e: ReactPointerEvent) => {
        fired.current = false;
        from.current = { x: e.clientX, y: e.clientY };
        timer.current = setTimeout(() => {
          fired.current = true;
          fn();
        }, 500);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 10) stop();
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    },
    consume: () => {
      const held = fired.current;
      fired.current = false;
      return held;
    },
  };
}

/** The phone's underline Tab (variant A): 40 px tall, the slide underline drawn by the strip. */
function TabStripButton({
  label,
  status,
  paneCount,
  selected,
  onOpen,
  onMenu,
}: {
  label: string;
  status: Status;
  paneCount: number;
  selected: boolean;
  onOpen: () => void;
  onMenu?: () => void;
}) {
  const hold = useLongPress(() => onMenu?.());
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={(e) => {
        if (hold.consume()) return e.preventDefault();
        onOpen();
      }}
      onContextMenu={onMenu ? (e) => e.preventDefault() : undefined}
      className={`press flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-[13px] whitespace-nowrap ${
        onMenu ? '[-webkit-touch-callout:none]' : ''
      } ${selected ? 'font-semibold text-fg' : 'font-medium text-muted'}`}
      {...(onMenu ? hold.press : {})}
    >
      <Dot status={status} seen={status === 'idle' || status === 'unknown'} size={6} />
      {label}
      {paneCount > 1 && <span className="ml-0.5 font-mono text-[10px] text-muted">{paneCount}</span>}
    </button>
  );
}

/**
 * The desktop browser Tab (variant A): the open Tab takes the Pane's background and a 2 px
 * accent top edge; close shows on hover and always on the open Tab. Right-click is the menu.
 */
function DesktopTab({
  label,
  status,
  paneCount,
  selected,
  onOpen,
  onClose,
  onMenu,
}: {
  label: string;
  status: Status;
  paneCount: number;
  selected: boolean;
  onOpen: () => void;
  onClose?: () => void;
  onMenu?: () => void;
}) {
  return (
    <div
      role="presentation"
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(); } : undefined}
      className={`group flex h-[38px] shrink-0 items-center rounded-t-[10px] ${
        selected ? 'bg-bg text-fg shadow-[0_1px_0_var(--bg),inset_0_2px_0_var(--accent)]' : 'text-muted hover:bg-bg/50'
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onOpen}
        className={`flex h-full items-center gap-2 text-[13px] whitespace-nowrap ${onClose ? 'pr-1.5 pl-3.5' : 'px-3.5'} ${
          selected ? 'font-medium' : ''
        }`}
      >
        <Dot status={status} seen={status === 'idle' || status === 'unknown'} size={7} />
        {label}
        {paneCount > 1 && <span className="font-mono text-[10px] text-muted">{paneCount}</span>}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className={`mr-2.5 flex size-5 items-center justify-center rounded-[5px] text-muted hover:bg-surface hover:text-fg focus-visible:opacity-100 ${
            selected ? '' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** The picker dots: Status colour per Tab, the open Tab a 14 px accent pill. */
const PICKER_DOT: Record<Status, string> = {
  blocked: 'bg-warn',
  working: 'bg-accent',
  done: 'bg-ok',
  idle: 'bg-border',
  unknown: 'bg-border',
};

/** Past five Tabs the phone strip becomes one picker button (variant C). Long-press is the
 *  open Tab's menu, the same gesture as a strip Tab. */
function TabPicker({
  label,
  status,
  n,
  of,
  blocked,
  onOpen,
  onMenu,
}: {
  label: string;
  status: Status;
  n: number;
  of: number;
  blocked: number;
  onOpen: () => void;
  onMenu?: () => void;
}) {
  const hold = useLongPress(() => onMenu?.());
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`${label}, Tab ${n} of ${of}${blocked ? `, ${blocked} blocked` : ''}. Switch Tab`}
      onClick={(e) => {
        if (hold.consume()) return e.preventDefault();
        onOpen();
      }}
      onContextMenu={onMenu ? (e) => e.preventDefault() : undefined}
      className="press flex h-10 min-w-0 flex-1 items-center gap-2 rounded-composer bg-surface px-3 text-left text-[14px] [-webkit-touch-callout:none]"
      {...(onMenu ? hold.press : {})}
    >
      <Dot status={status} seen={status === 'idle' || status === 'unknown'} size={7} />
      <span className="truncate font-semibold text-fg">{label}</span>
      <span className="shrink-0 text-[12px] text-muted">
        Tab {n} of {of}
      </span>
      {blocked > 0 && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[12px] text-warn">
          <Dot status="blocked" size={6} />
          {blocked} blocked
        </span>
      )}
      <span aria-hidden className={`flex shrink-0 text-muted ${blocked ? '' : 'ml-auto'}`}>
        <ChevronDown size={14} />
      </span>
    </button>
  );
}

/** The open Tab's Panes, shown only for a split Tab. Same row at both widths until lane
 *  10.8 puts split Panes side by side. */
function PaneChips({ panes, paneKey, className }: { panes: StatePane[]; paneKey: string; className: string }) {
  return (
    <div role="group" aria-label="Panes in this Tab" className={`hscroll flex gap-1.5 ${className}`}>
      {panes.map((p) => (
        <button
          key={p.key}
          type="button"
          aria-current={p.key === paneKey ? 'true' : undefined}
          onClick={() => {
            haptic();
            navigate(`#/pane/${encodeURIComponent(p.key)}`);
          }}
          className={`press flex h-7 shrink-0 items-center gap-1.5 rounded-chip px-2.5 text-[12px] whitespace-nowrap ${
            p.key === paneKey ? 'bg-surface font-medium text-fg' : 'text-muted'
          }`}
        >
          <Dot status={p.status} size={6} seen={p.key !== paneKey} />
          {p.agent ?? 'shell'}
        </button>
      ))}
    </div>
  );
}

/** The shortcut hint shows on a Mac only: elsewhere Meta belongs to the OS. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

function closeTabCost(panes: StatePane[], lastTab: boolean): string {
  const active = panes
    .filter((p) => p.agent && (p.status === 'working' || p.status === 'blocked'))
    .map((p) => `“${p.title}” is ${p.status === 'blocked' ? 'waiting for you' : 'still working'} and will stop.`);
  if (lastTab) active.push('The Workspace will have no Tabs left.');
  return active.join(' ');
}


/** How long a switch keeps the last Pane's Screen before the skeleton takes the grid. */
const HOLD_MS = 800;

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');


/** The last block the agent printed, for read-aloud. */
function lastBlock(text?: string): string {
  if (!text) return '';
  const blocks = plain(text)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.at(-1) ?? '';
}

export function PaneScreen({ paneKey, state, screen }: { paneKey: string; state: State | null; screen: ScreenEvent | null }) {
  const pane = state?.panes.find((p) => p.key === paneKey);
  const ws = state?.workspaces.find((w) => w.muxKey === pane?.muxKey && w.id === pane?.workspaceId);
  const mux = state?.muxes.find((m) => m.key === pane?.muxKey);
  const host = state?.hosts.find((h) => h.id === mux?.hostId);
  /** Only herdr writes. tmux answers 501, so New Tab, Rename and Close are not offered. */
  const writable = mux?.kind === 'herdr';
  // A switch keeps the last Pane's Screen on the grid until this Pane's first `screen`
  // event, so the grid swaps rather than blanks. After HOLD_MS with nothing, the skeleton.
  const current = screen?.key === paneKey ? screen : null;
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    if (current) return;
    const t = setTimeout(() => setWaited(true), HOLD_MS);
    return () => clearTimeout(t);
  }, [paneKey, !current]);
  const held = !current && !waited ? screen : null;
  const shown = current ?? held;
  const lines = useMemo(() => (shown ? parseAnsi(shown.text) : []), [shown]);

  // Wrap is the default reading mode for an agent and never for a shell, where the columns
  // are the layout (htop, logs). Remembered per kind, not per Pane.
  const kind = pane?.agent ? 'agent' : 'shell';
  const [wraps, setWraps] = useState(() => ({
    agent: localStorage.getItem('tautan.wrap.agent') !== 'off',
    shell: localStorage.getItem('tautan.wrap.shell') === 'on',
  }));
  const wrap = wraps[kind];
  const setWrap = (v: boolean) => {
    localStorage.setItem(`tautan.wrap.${kind}`, v ? 'on' : 'off');
    setWraps((w) => ({ ...w, [kind]: v }));
  };
  // Fit is off until the user asks for it: the column grows to the grid's own width on a
  // desktop, so scaling is a phone answer, not the default. The scale is min(1, …), so a
  // grid that already fits is left alone even then.
  const [fit, setFitState] = useState(() => localStorage.getItem('tautan.fit') === 'on');
  const setFit = (v: boolean) => { localStorage.setItem('tautan.fit', v ? 'on' : 'off'); setFitState(v); };
  const [scale, setScale] = useState(1);
  const [fade, setFade] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [showSwitch, setShowSwitch] = useState(() => opensWith('switch'));
  const [showMore, setShowMore] = useState(() => opensWith('more'));
  const [showNewTab, setShowNewTab] = useState(() => opensWith('newtab'));
  // Off means the agent's own 256-colour and truecolour values render as sent.
  const [themedOn, setThemedOn] = useState(themedColors);
  const [rename, setRename] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [tabMenu, setTabMenu] = useState<string | null>(null);
  const [tabRename, setTabRename] = useState<string | null>(null);
  const [tabClose, setTabClose] = useState<string | null>(null);
  const desktop = useDesktop();
  /** The Tab picker opens Switch at Tab level; the header's trigger opens it at Pane level. */
  const [switchTabs, setSwitchTabs] = useState(false);
  /** The prompt id whose answer came back 409, from the card or the header alike. */
  const [stalePrompt, setStalePrompt] = useState<string | null>(null);
  /** The header's Yes or No is on its way: both stay disabled, so one tap is one answer. */
  const [answering, setAnswering] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const [lensChoice, setLensChoice] = useState<{ paneKey: string; mode: LensMode }>(() => ({
    paneKey,
    mode: readLens(paneKey),
  }));
  const lens = lensChoice.paneKey === paneKey ? lensChoice.mode : readLens(paneKey);
  const setLens = useCallback((mode: LensMode) => {
    writeLens(paneKey, mode);
    setLensChoice({ paneKey, mode });
  }, [paneKey]);
  const showScreen = useCallback(() => setLens('screen'), [setLens]);

  // Keep the view pinned to the bottom unless the user scrolled up.
  const box = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const [room, setRoom] = useState(0);

  const measure = () => {
    const el = box.current;
    if (!el) return;
    setFade(el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    else if (lines.length) setFresh(true);
    measure();
  }, [lines]);

  // The Pane's own width feeds the Fit scale, so a rotation, a window resize or the sidebar
  // toggling re-fits the grid. At `lg` the Pane sits beside a 300 px sidebar, so the window
  // is the wrong ruler.
  const frame = useRef<HTMLDivElement>(null);
  const [viewportW, setViewportW] = useState(() => innerWidth);
  // The mono subset swaps in after first paint and changes every column's width with it, so
  // the grid is measured again once the fonts are settled.
  const [fonts, setFonts] = useState(false);
  useEffect(() => {
    void document.fonts?.ready.then(() => {
      setFonts(true);
    });
  }, []);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setViewportW(el.clientWidth); measure(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- interactive screen (ADR 0003) ----
  // The App profile is the gate: it says which Hints to look for, which keys the dock
  // carries, and whether this program reads a mouse report at all.
  const profile = useMemo(() => profileFor(pane), [pane?.agent, pane?.command]);
  const affordances = useMemo(() => findAffordances(lines, profile), [lines, profile]);
  const cell = useCell(pre, scale, fonts);
  // ---- phone width (ADR 0004) ----
  const [phoneWidth, setPhoneWidth] = useState(false);
  useEffect(() => { setPhoneWidth(false); }, [paneKey]); // the Hub's reaper releases on leave
  const togglePhoneWidth = async () => {
    haptic();
    if (phoneWidth) {
      setPhoneWidth(false);
      await fetch(`/api/panes/${encodeURIComponent(paneKey)}/lease`, { method: 'DELETE' }).catch(() => {});
      return;
    }
    // This screen's own readable geometry, the same cells the grid is drawn with.
    const cols = Math.max(10, Math.min(500, Math.floor((room || 374) / Math.max(4, cell.cw))));
    const rows = Math.max(4, Math.min(200, Math.floor(window.innerHeight / Math.max(8, cell.rh)) - 8));
    const response = await fetch(`/api/panes/${encodeURIComponent(paneKey)}/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cols, rows }),
    }).catch(() => null);
    if (response?.ok) setPhoneWidth(true);
  };
  // `room` excludes the scroller's padding, so add it back for a like-for-like grid check.
  // A held Screen has no Pane record: unknown columns stay wrapped. The room is the space
  // the scroller COULD take, not the column wrap has already shrunk it to — otherwise a
  // grid narrower than the viewport stays reflowed because wrap shrank its own measuring
  // stick (the column sizes to the longest line while wrapped).
  const potentialRoom = Math.max(room, (viewportW || 0) - 32);
  const gridWidth = pane?.cols ? pane.cols * cell.cw + 34 : 0;
  const fits = !!gridWidth && !!potentialRoom && gridWidth <= potentialRoom + 34;
  const effectiveWrap = wrap && !fits;
  const kinds = useMemo(
    () => effectiveWrap
      ? classify(lines.map((spans) => spans.map((span) => span.text).join('')).join('\n'), pane?.cols)
      : null,
    [effectiveWrap, lines, pane?.cols],
  );
  /** Bumped by the ⋯ switch, so the per-Pane override is re-read without a second store. */
  const [override, setOverride] = useState(0);
  const mouseOn = useMemo(() => mouseAllowed(paneKey, pane), [paneKey, pane?.agent, pane?.command, override]);
  // Cell coordinates need the grid, so both mechanisms stop at Wrap.
  const forwarding = mouseOn && !effectiveWrap;
  /** The row window the overlay draws, in tens of rows, so scrolling repaints it rarely. */
  const [band, setBand] = useState(0);
  const mouse = useMouseForward({
    paneKey,
    on: forwarding,
    pre,
    cell,
    scale,
    cols: pane?.cols ?? 80,
    rows: pane?.rows ?? lines.length,
  });

  useEffect(() => {
    const el = pre.current;
    if (!el || !el.parentElement) return setScale(1);
    // The scroller carries the grid's padding, so the room the `<pre>` actually has is
    // narrower than the scroller. Measuring against `clientWidth` alone left Fit on and the
    // last column still cut off.
    const pad = getComputedStyle(el.parentElement);
    const nextRoom = el.parentElement.clientWidth - parseFloat(pad.paddingLeft || '0') - parseFloat(pad.paddingRight || '0');
    setRoom((prev) => (Math.abs(prev - nextRoom) < 0.01 ? prev : nextRoom));
    setScale(fit ? Math.min(1, nextRoom / el.scrollWidth) : 1);
    measure();
  }, [fit, effectiveWrap, lines, viewportW, fonts, cell.cw]);

  // Mark Seen once the screen settles: Seen is tautan's own flag, never written to the Mux.
  useEffect(() => {
    if (!current) return;
    markSeen(paneKey, current.revision);
    const t = setTimeout(() => void post(paneKey, 'seen', { revision: current.revision } satisfies SeenBody), 1000);
    return () => clearTimeout(t);
  }, [paneKey, current?.revision]);

  useEffect(() => {
    if (pane) lastPane.set(`${pane.muxKey}/${pane.tabId}`, pane.key);
  }, [pane?.key]);

  // The blocked card outlives the status by 150 ms, so it fades instead of vanishing.
  const loadExplain = () => fetchExplain(paneKey).then(setExplain).catch(() => {});
  useEffect(() => {
    if (pane?.status === 'blocked') {
      loadExplain();
      return;
    }
    if (!explain) return;
    const t = setTimeout(() => setExplain(null), 150);
    return () => clearTimeout(t);
  }, [paneKey, pane?.status, pane?.revision]);

  const tabs = useMemo(() => {
    if (!state || !pane) return [];
    const mine = state.panes.filter((p) => p.muxKey === pane.muxKey && p.workspaceId === pane.workspaceId);
    const listed = state.tabs.filter((t) => t.muxKey === pane.muxKey && t.workspaceId === pane.workspaceId);
    const ids = listed.length ? listed.map((t) => [t.id, t.label] as const) : [...new Set(mine.map((p) => p.tabId))].map((id) => [id, ''] as const);
    return ids.map(([id, label]) => {
      const panes = mine.filter((p) => p.tabId === id);
      return { id, label: label || panes[0]?.title || id, panes, status: rollUp(panes) };
    });
  }, [state, pane?.muxKey, pane?.workspaceId]);

  // One underline that slides, rather than a border that jumps: measured from the selected
  // tab, so a relabelled or newly created Tab moves it without a second source of truth.
  const strip = useRef<HTMLDivElement>(null);
  const [underline, setUnderline] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const on = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    setUnderline(on ? { x: on.offsetLeft, w: on.offsetWidth } : { x: 0, w: 0 });
  }, [tabs, pane?.tabId, viewportW]);

  const openTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    const next = lastPane.get(`${pane?.muxKey}/${id}`) ?? tab?.panes[0]?.key;
    if (!next || next === paneKey) return;
    haptic();
    navigate(`#/pane/${encodeURIComponent(next)}`);
  };

  const closeTab = async (tab: (typeof tabs)[number]) => {
    const next = tabs.find((t) => t.id !== tab.id);
    const nextKey = next && (lastPane.get(`${pane?.muxKey}/${next.id}`) ?? next.panes[0]?.key);
    for (const p of tab.panes) await api<void>(`/api/panes/${encodeURIComponent(p.key)}/close`);
    if (tab.id === pane?.tabId) navigate(nextKey ? `#/pane/${encodeURIComponent(nextKey)}` : '#/');
  };

  /** Phase 14's rule: a Tab whose close would stop work asks first; anything else just goes. */
  const requestCloseTab = (tab: (typeof tabs)[number]) => {
    if (closeTabCost(tab.panes, tabs.length === 1)) setTabClose(tab.id);
    else void closeTab(tab);
  };

  // `⌘1–9` opens Tab n and `⌘T` New Tab, at `lg` only. Meta only: Ctrl+T and Ctrl+digits
  // belong to the browser (and to the terminal), so there is no Ctrl fallback. `code`, not
  // `key`, so an AZERTY row still reads as digits.
  useEffect(() => {
    if (!desktop) return;
    const on = (e: KeyboardEvent) => {
      if (e.altKey || e.shiftKey || e.ctrlKey || !e.metaKey) return;
      const digit = /^Digit([1-9])$/.exec(e.code);
      const tab = digit && tabs[Number(digit[1]) - 1];
      if (tab) {
        e.preventDefault();
        openTab(tab.id);
      } else if (e.code === 'KeyT' && writable) {
        e.preventDefault();
        setShowNewTab(true);
      }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [desktop, tabs, writable, paneKey]);

  const menuTab = tabs.find((t) => t.id === tabMenu);
  const renameTab = tabs.find((t) => t.id === tabRename);
  const closingTab = tabs.find((t) => t.id === tabClose);

  /** The one answer path for a blocked prompt: the card and the desktop header both send
   *  through it, so a 409 from either shows Re-read on both. */
  const answer = async (names: string[], promptId?: string) => {
    const outcome = await sendBlocked(paneKey, names, promptId);
    if (outcome === 'changed') setStalePrompt(promptId ?? '');
    return outcome;
  };
  const reread = () => {
    setStalePrompt(null);
    void loadExplain();
  };

  /** Review (phone, blocked): bring the card into view and put focus on its first option. */
  const review = () => {
    haptic();
    const el = card.current;
    el?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true });
  };

  const speak = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (synth.speaking) return synth.cancel();
    synth.speak(new SpeechSynthesisUtterance(lastBlock(current?.text)));
  };

  // Touch, not pointer: the moment a horizontal drag starts, Chromium hands the gesture to
  // the nearest scroller and fires `pointercancel`, so `pointerup` never arrives on a phone.
  // `touchend` always does. The strip's own scroll position guards the ambiguous case —
  // with more Tabs than fit, dragging scrolls the strip and must not also switch Tab.
  const swipe = useRef({ x: 0, scroll: 0 });

  if (state && !pane) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-4 pt-[calc(env(safe-area-inset-top)+4rem)] lg:max-w-4xl">
        <p className="text-body">Pane closed</p>
        <a href="#/" className="text-body text-accent">
          ‹ All panes
        </a>
      </div>
    );
  }

  const agent = pane?.agent;
  const status = pane?.status ?? 'unknown';
  const active = tabs.find((t) => t.id === pane?.tabId);
  const activeIndex = active ? tabs.indexOf(active) : -1;
  // Past five Tabs the phone strip turns into a picker. Desktop tabs scroll instead.
  const manyTabs = !desktop && tabs.length > 5 && !!active;
  const tabMenuFor = (id: string) => (writable ? () => {
    haptic();
    setTabMenu(id);
  } : undefined);
  // Desktop's quick answer: only the plain Yes and No of a yes/no prompt (the card's own
  // preset keys), never an Always-type hint key.
  const yesNo = explain && status === 'blocked' ? yesNoKeys(explain) : null;
  const stale = !!explain && stalePrompt === (explain.promptId ?? '');
  const quick = desktop && explain && yesNo
    ? {
        command: promptLine(explain),
        choices: [yesNo.yes, yesNo.no],
        stale,
        sending: answering,
        onAnswer: (key: string) => {
          setAnswering(true);
          void answer([key], explain.promptId).finally(() => setAnswering(false));
        },
        onReread: reread,
      }
    : null;
  const mouseChip = forwarding && (
    // Taps on the grid are going to the program, not to tautan.
    <span className="shrink-0 rounded-chip border border-border px-1.5 py-0.5 font-mono text-[10px] text-accent">
      mouse
    </span>
  );
  const newTab = writable && (
    <button
      type="button"
      aria-label="New Tab"
      onClick={() => setShowNewTab(true)}
      className={
        desktop
          ? 'press mb-0.5 flex size-[34px] shrink-0 items-center justify-center rounded-chip text-accent hover:bg-bg/50'
          : manyTabs
            ? 'press flex size-10 shrink-0 items-center justify-center rounded-composer bg-surface text-accent'
            : 'press flex h-10 w-9 shrink-0 items-center justify-center text-accent'
      }
    >
      <Plus size={desktop ? 16 : 18} />
    </button>
  );
  const grid = pane?.cols && pane.rows ? `${pane.cols}×${pane.rows}` : 'fit';
  // The App profile decides for every Pane running that program; the switch decides for
  // this one. Effective Wrap wins over both, so the row says so rather than lying about it.
  const mouseSource =
    mouseOn && effectiveWrap
      ? 'off while Wrap is on'
      : localStorage.getItem(`tautan.mouse.${paneKey}`)
        ? 'overridden'
        : `from ${pane?.command ?? pane?.agent ?? 'the generic'} profile`;
  // At `lg` the frame (app.tsx) gives the Pane the space beside the sidebar and the Pane
  // fills it; the old content-sized, centred column is gone. A phone is simply the window.
  const skeleton = !shown && waited;

  return (
    <div
      ref={frame}
      className="flex h-dvh w-full flex-col"
    >
      <PaneHeader
        desktop={desktop}
        title={pane?.title ?? '…'}
        path={[host?.label, ws?.label, active?.label]}
        status={status}
        agent={agent}
        tab={active?.label}
        lens={lens}
        onLens={agent ? setLens : undefined}
        onSwitch={() => {
          setSwitchTabs(false);
          setShowSwitch(true);
        }}
        onSpeak={agent ? speak : undefined}
        onMore={() => setShowMore(true)}
        onReview={review}
        reviewReady={!!explain}
        quick={quick}
      />

      {desktop ? (
        /* Browser tabs. The tablist sits a pixel into the bar's bottom border, so the open
           Tab's 1 px background shadow covers the line under it and the Tab joins the Pane. */
        <div className="shrink-0">
          <div className="flex items-end gap-1 border-b border-border bg-surface px-3 pt-2">
            <div role="tablist" aria-label="Tabs" className="hscroll -mb-px flex min-w-0 items-end gap-0.5 pb-px">
              {tabs.map((t) => (
                <DesktopTab
                  key={t.id}
                  label={t.label}
                  status={t.status}
                  paneCount={t.panes.length}
                  selected={t.id === pane?.tabId}
                  onOpen={() => openTab(t.id)}
                  onClose={writable ? () => requestCloseTab(t) : undefined}
                  onMenu={tabMenuFor(t.id)}
                />
              ))}
            </div>
            {newTab}
            <span className="flex-1" />
            <span className="mb-2.5 flex shrink-0 items-center gap-3 text-[12px] text-muted">
              {mouseChip}
              {MAC && (
                <span>
                  <span className="font-mono">⌘1–9</span> switch
                  {writable && (
                    <>
                      {' · '}
                      <span className="font-mono">⌘T</span> new
                    </>
                  )}
                </span>
              )}
            </span>
          </div>
          {/* ponytail: lane 10.8 deferred split Panes side by side; desktop keeps the chips row. */}
          {active && active.panes.length > 1 && (
            <PaneChips panes={active.panes} paneKey={paneKey} className="px-4 py-2" />
          )}
        </div>
      ) : (
        /* The strip is one section of two rows: the Workspace's Tabs, and the open Tab's
           Panes under them. Swipe here, never on the grid. */
        <div
          className="shrink-0 px-3 pb-1.5"
          onTouchStart={(e) => {
            swipe.current = { x: e.touches[0]?.clientX ?? 0, scroll: strip.current?.scrollLeft ?? 0 };
          }}
          onTouchEnd={(e) => {
            const dx = (e.changedTouches[0]?.clientX ?? 0) - swipe.current.x;
            const scrolled = Math.abs((strip.current?.scrollLeft ?? 0) - swipe.current.scroll) > 4;
            if (scrolled || Math.abs(dx) < 40 || !active) return;
            const i = tabs.indexOf(active) + (dx < 0 ? 1 : -1);
            if (tabs[i]) openTab(tabs[i].id);
          }}
        >
          {manyTabs ? (
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex items-center gap-2">
                <TabPicker
                  label={active!.label}
                  status={active!.status}
                  n={activeIndex + 1}
                  of={tabs.length}
                  blocked={tabs.filter((t) => t.status === 'blocked').length}
                  onOpen={() => {
                    setSwitchTabs(true);
                    setShowSwitch(true);
                  }}
                  onMenu={tabMenuFor(active!.id)}
                />
                {mouseChip}
                {newTab}
              </div>
              {/* Where the swipe is and what each Tab is doing, without the labels. */}
              <div aria-hidden className="flex justify-center gap-[5px]">
                {tabs.map((t, i) => (
                  <span
                    key={t.id}
                    className={`h-[5px] rounded-full transition-[width] duration-200 motion-reduce:transition-none ${
                      i === activeIndex ? 'w-3.5 bg-accent' : `w-[5px] ${PICKER_DOT[t.status]}`
                    }`}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1 border-b border-border">
              <div ref={strip} role="tablist" aria-label="Tabs" className="hscroll relative flex min-w-0 flex-1 items-end gap-0.5">
                {tabs.map((t) => (
                  <TabStripButton
                    key={t.id}
                    label={t.label}
                    status={t.status}
                    paneCount={t.panes.length}
                    selected={t.id === pane?.tabId}
                    onOpen={() => openTab(t.id)}
                    onMenu={tabMenuFor(t.id)}
                  />
                ))}
                <span
                  aria-hidden
                  data-testid="tab-underline"
                  className="absolute bottom-[-1px] left-0 h-0.5 bg-accent transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
                  style={{ width: underline.w, transform: `translateX(${underline.x}px)` }}
                />
              </div>
              {mouseChip}
              {newTab}
            </div>
          )}

          {/* Row two: the Panes of the open Tab, only when the Tab is split. */}
          {active && active.panes.length > 1 && <PaneChips panes={active.panes} paneKey={paneKey} className="pt-2" />}
        </div>
      )}

      {agent && lens === 'chat' ? (
        <Chat key={paneKey} paneKey={paneKey} revision={pane?.revision ?? 0} onUnavailable={showScreen} />
      ) : (
        <div className="relative min-h-0 flex-1">
          <div
          ref={box}
          {...mouse}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (pinned.current) setFresh(false);
            setBand(Math.floor(el.scrollTop / Math.max(1, cell.rh * scale) / 10));
            measure();
          }}
          className="h-full overflow-auto pt-1 pb-2 pl-4 lg:pr-4"
          style={{
            ...(fade ? { maskImage: FADE, WebkitMaskImage: FADE } : null),
            // A vertical drag is the app's wheel while forwarding; sideways stays the
            // scroller's, so a 120-column grid can still be read across.
            ...(forwarding ? { touchAction: 'pan-x' as const } : null),
          }}
        >
          <pre
            ref={pre}
            className={`relative text-caption lg:mx-auto ${
              // Wrapped text takes the column; unwrapped text keeps the grid's own width.
              // `w-max` would be max-content, which never wraps, so Wrap needs `w-full`.
              effectiveWrap ? 'w-full break-words whitespace-pre-wrap' : 'w-max min-w-full whitespace-pre lg:min-w-0'
            }`}
            // The grid keeps tautan-box first: box-drawing and Braille come from the subset,
            // everything else falls through to Geist Mono.
            style={{
              fontFamily: '"tautan-box", "Geist Mono", ui-monospace, monospace',
              // Never reflow wider than the Pane itself: the agent wrote for `cols` columns.
              maxWidth: effectiveWrap && pane?.cols ? `${pane.cols}ch` : undefined,
              ...(scale < 1 ? { transform: `scale(${scale})`, transformOrigin: 'top left' } : null),
            }}
          >
            {lines.map((spans, i) =>
              effectiveWrap ? (
                <span
                  key={i}
                  className={`block min-h-[1lh] ${
                    kinds?.[i] === 'structure' ? 'w-max whitespace-pre' : 'break-words whitespace-pre-wrap'
                  }`}
                >
                  {spans.map((sp, j) => (
                    <span key={j} style={spanStyle(sp)}>
                      {sp.text}
                    </span>
                  ))}
                </span>
              ) : (
                <Fragment key={i}>
                  {spans.map((sp, j) => (
                    <span key={j} style={spanStyle(sp)}>
                      {sp.text}
                    </span>
                  ))}
                  {'\n'}
                </Fragment>
              ),
            )}
            {/* Inside the `<pre>`, so the Fit transform scales the boxes with the text. A held
                Screen is the last Pane's, so its Affordances would type into the wrong Pane. */}
            {!effectiveWrap && current && affordances.length > 0 && (
              <AffordanceLayer
                paneKey={paneKey}
                list={affordances}
                cell={cell}
                scale={scale}
                from={band * 10 - 10}
                to={band * 10 + 60}
              />
            )}
          </pre>
          {skeleton && (
            <div aria-busy aria-label="Loading screen" className="flex flex-col gap-2 pt-1 pr-4">
              <Skeleton width="66%" height={12} />
              <Skeleton width="100%" height={12} />
              <Skeleton width="92%" height={12} />
              <Skeleton width="75%" height={12} />
            </div>
          )}
        </div>
          {fresh && (
            <button
              type="button"
              onClick={() => {
                const el = box.current;
                if (el) el.scrollTop = el.scrollHeight;
                pinned.current = true;
                setFresh(false);
              }}
              className="absolute inset-x-0 bottom-2 mx-auto flex w-max items-center gap-1.5 rounded-chip bg-elevated px-3 py-1.5 text-caption font-medium text-fg shadow-elevated"
            >
              <Down />
              New output
            </button>
          )}
        </div>
      )}

      <Composer
        paneKey={paneKey}
        pane={pane}
        desktop={desktop}
        profile={profile}
        affordances={affordances}
        lines={current ? lines : null}
        explain={explain}
        stale={stale}
        onAnswer={answer}
        onReread={reread}
        cardRef={card}
      />

      <SwitchDrawer
        open={showSwitch}
        onClose={() => setShowSwitch(false)}
        state={state}
        currentKey={paneKey}
        onPick={haptic}
        title={switchTabs ? 'Switch Tab' : 'Switch Pane'}
        head={switchTabs && (
          <section>
            <h3 className="label-caps px-3 pt-3.5 pb-1">Tabs in {ws?.label ?? 'this Workspace'}</h3>
            <ul>
              {tabs.map((t, i) => (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-current={t.id === pane?.tabId ? 'true' : undefined}
                    onClick={() => {
                      setShowSwitch(false);
                      openTab(t.id);
                    }}
                    className={`flex min-h-11 w-full items-center gap-2.5 rounded-chip px-3 text-left ${
                      t.id === pane?.tabId ? 'bg-muted/20' : 'active:bg-bg'
                    }`}
                  >
                    <Dot status={t.status} seen={t.status === 'idle' || t.status === 'unknown'} />
                    <span className="min-w-0 flex-1 truncate text-body">{t.label}</span>
                    {t.status === 'blocked' && <span className="shrink-0 text-caption text-warn">needs you</span>}
                    {t.panes.length > 1 && <span className="shrink-0 text-caption text-muted">{t.panes.length} Panes</span>}
                    <span className="w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">{i + 1}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      />
      <MenuSheet
        open={menuTab !== undefined}
        title={menuTab?.label ?? 'Tab'}
        onClose={() => setTabMenu(null)}
        items={[
          ...(menuTab && menuTab.panes.length > 1
            ? menuTab.panes.map((p) => ({
                label: p.title,
                sub: `${p.agent ?? 'shell'} · ${p.status}`,
                onClick: () => {
                  haptic();
                  navigate(`#/pane/${encodeURIComponent(p.key)}`);
                },
              }))
            : []),
          { label: 'Rename tab', onClick: () => menuTab && setTabRename(menuTab.id) },
          { label: 'Close tab', danger: true, onClick: () => menuTab && requestCloseTab(menuTab) },
        ]}
      />
      <RenameSheet
        open={renameTab !== undefined}
        kind="Tab"
        current={renameTab?.label ?? ''}
        onClose={() => setTabRename(null)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: pane!.muxKey, tabId: renameTab!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={closingTab !== undefined}
        kind="Tab"
        title={closingTab?.label ?? ''}
        cost={closingTab ? closeTabCost(closingTab.panes, tabs.length === 1) : ''}
        onClose={() => setTabClose(null)}
        onConfirm={() => closingTab ? closeTab(closingTab) : undefined}
      />
      <MenuSheet
        open={showMore}
        title={pane?.title ?? 'Pane'}
        onClose={() => setShowMore(false)}
        head={<ThemePicker />}
        items={[
          // The phone header has no room for it; at `lg` it sits in the header.
          ...(agent && !desktop ? [{ label: 'Read aloud', onClick: speak }] : []),
          { label: wrap ? 'Wrap: on' : 'Wrap: off', onClick: () => setWrap(!wrap) },
          {
            // ADR 0004: a geometry lease makes the agent draw at this screen's columns; the
            // desktop's copy of the Pane narrows until it is released. Releasing on leave is
            // the Hub reaper's job; this toggle only asks.
            label: phoneWidth ? 'Phone width: on' : 'Phone width: off',
            hint: 'the pane draws at your columns',
            onClick: () => void togglePhoneWidth(),
          },
          { label: fit ? 'Fit to width: on' : 'Fit to width: off', hint: grid, onClick: () => setFit(!fit) },
          {
            label: themedOn ? 'Theme colors: on' : 'Theme colors: off',
            onClick: () => {
              setThemedColors(!themedOn);
              setThemedOn(!themedOn);
            },
          },
          {
            label: mouseOn ? 'Mouse taps: on' : 'Mouse taps: off',
            sub: mouseSource,
            onClick: () => {
              setMouseOverride(paneKey, mouseOn ? 'off' : 'on');
              setOverride((n) => n + 1);
            },
          },
          ...(ws ? [{ label: 'Diff', onClick: () => navigate(`#/diff/${encodeURIComponent(ws.key)}`, { transition: false }) }] : []),
          ...(writable
            ? [
                { label: 'Rename', onClick: () => setRename(true) },
                { label: 'Close Pane', danger: true, onClick: () => setConfirmClose(true) },
              ]
            : []),
          { label: 'Resize to phone', hint: 'v2', disabled: true },
        ]}
      />
      <NewTabSheet
        open={showNewTab}
        onClose={() => setShowNewTab(false)}
        cwd={ws?.cwd}
        agent={commonAgent(state?.panes.filter((p) => p.muxKey === pane?.muxKey && p.workspaceId === pane?.workspaceId) ?? [])}
        where={
          <>
            in <span className="text-fg">{ws?.label}</span> · {host?.label}
          </>
        }
        onSubmit={async (o) => {
          const { paneKey: created } = await api<NewTabResult>(
            `/api/muxes/${encodeURIComponent(pane!.muxKey)}/tabs`,
            { workspaceId: pane!.workspaceId, ...o } satisfies NewTabBody,
          );
          navigate(`#/pane/${encodeURIComponent(created)}`);
        }}
      />
      <RenameSheet
        open={rename}
        kind="Pane"
        current={pane?.title ?? ''}
        onClose={() => setRename(false)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: pane!.muxKey, paneId: pane!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={confirmClose}
        title={pane?.title ?? ''}
        onClose={() => setConfirmClose(false)}
        onConfirm={async () => {
          await api<void>(`/api/panes/${encodeURIComponent(paneKey)}/close`);
          navigate('#/');
        }}
      />
    </div>
  );
}
