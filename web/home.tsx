import { TopBar } from './header.tsx';
import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, HTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type {
  MoveBody, NewTabBody, NewTabResult, NewWorkspaceBody, NewWorkspaceResult, PluginAction, RenameBody, State, StatePane, StateWorkspace, Status,
} from '../shared/types.ts';
import { api, haptic, Link, navigate, opensWith, reducedMotion, SIDEBAR_KEYS, useDesktop } from './app.tsx';
import { dropMuxOrders, moveWorkspace, muxOrders, orderWorkspaces, readOrder, spliceIndex, writeOrder, type WorkspaceOrder } from './order.ts';
import { Check, ChevronDown, ChevronRight, CollapseAll, ExpandAll, FoldAll, ListHerdr, ListTautan, More, PanelLeft, Plus, Sliders, UnfoldAll } from './icons.tsx';
import { TOOL } from './explorer.tsx';
import { Chip, EmptyState, IconButton, SearchInput, Skeleton, usePal } from './halaska-kit';
import {
  agentRows, bySpace, getAgentGroup, getAgentSort, getPaneList, getShowShells, getSpaceAgentsOnly, getSpaceSort, leavesMenu,
  rollup, setAgentGroup, setAgentSort, setPaneList, setShowShells, setSpaceAgentsOnly, setSpaceSort, sortSpaces, tildePath,
  usePref, type AgentGroup, type AgentSort, type PaneList, type SpaceSort,
} from './spaces.ts';
import { atPointer, ConfirmCloseSheet, menuKey, MenuSheet, NewTabSheet, NewWorkspaceSheet, PluginActionsSheet, RemoveWorktreeSheet, RenameSheet, usePluginActions, why, type MenuAnchor } from './sheets.tsx';
import { actionsFor } from './plugins.ts';
import { isUnseen } from '../shared/seen.ts';
import { yesNoKeys } from '../shared/blocked.ts';
import { fetchExplain, ON_WARN, promptLine, sendBlocked, type ExplainResponse } from './blocked.tsx';
import { store } from './store.tsx';
import { filesHash } from './folders-logic.ts';
import { PROVIDER_LABELS } from './usage.tsx';
import { paneKind, running, statusWord as paneStatusWord } from './pane-label.ts';
import { carry, fromControl, paneDrop, paneSource, paneTarget, spaceTab, WORKSPACE_TYPE, type DropOver, type PaneDrop } from './pane-drag.ts';

// ---- status ----

/** Status → the kit palette. `idle` and `unknown` carry no urgency. */
const COLOR = (pal: ReturnType<typeof usePal>): Record<Status, string> => ({
  blocked: pal.warning,
  working: pal.accent,
  done: pal.success,
  idle: pal.textTertiary,
  unknown: pal.textTertiary,
});

export const statusText: Record<Status, string> = {
  blocked: 'text-warn',
  working: 'text-accent',
  done: 'text-ok',
  idle: 'text-muted',
  unknown: 'text-muted',
};

/** 8 px by default. Filled means unseen; a 1.5 px ring means seen. Decoration only: the
 *  row's `aria-label` and the printed status word carry the fact. */
export function Dot({ status, seen, size = 8 }: { status: Status; seen?: boolean; size?: number }) {
  const c = COLOR(usePal())[status];
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, boxSizing: 'border-box', ...(seen ? { border: `1.5px solid ${c}` } : { background: c }) }}
    />
  );
}

// ---- seen ----
// tautan's own flag, never written back to the Mux. One revision map, read through a module cache.

let seenAt: Record<string, number> | null = null;
const seen = () => (seenAt ??= JSON.parse(store.get('tautan.seen') ?? '{}') as Record<string, number>);

export function markSeen(key: string, revision: number) {
  seen()[key] = revision;
  store.set('tautan.seen', JSON.stringify(seen()));
}

/** Seed a new device from its first snapshot. Blocked remains actionable regardless. */
export function seedSeen(panes: StatePane[]) {
  const current = seen();
  if (Object.keys(current).length) return;
  for (const pane of panes) current[pane.key] = pane.revision;
  store.set('tautan.seen', JSON.stringify(current));
}

/**
 * `idle` means the user already looked (CONTEXT.md) and `unknown` is all tmux can report,
 * so neither can be unseen. Legacy timestamp entries remain readable while each Pane
 * migrates to a revision the next time it is opened.
 */
export const unseen = (p: StatePane) => isUnseen(p, seen());

export function timeAgo(at?: number): string {
  if (!at) return '';
  const s = Math.max(0, Date.now() - at) / 1000;
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const RANK: Record<Status, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const comparePanes = (a: StatePane, b: StatePane) =>
  RANK[a.status] - RANK[b.status] || (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0);
const basename = (cwd?: string) => cwd?.replace(/\/+$/, '').split('/').pop();
/** `~/projects/tautan` → `~/projects`: where a sibling Workspace would go. */
export const parentDir = (cwd?: string) => cwd?.replace(/\/+$/, '').replace(/\/[^/]+$/, '') || undefined;

/** The Agent most of these Panes run, `''` when none does: the New Tab chip to preselect. */
export function commonAgent(panes: StatePane[]): string {
  const tally = new Map<string, number>();
  for (const p of panes) if (p.agent) tally.set(p.agent, (tally.get(p.agent) ?? 0) + 1);
  return [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** Blocked reason, else the last non-empty screen line, else the directory. */
const preview = (p: StatePane) => p.lastLine ?? basename(p.cwd) ?? '';
/** The Agent kind by name: the usage strip's provider names cover `Claude` and `Codex`; pi and
 *  omp have no label there and keep their own ids, as the Chat view spells them. */
const agentName = (agent?: string) => (agent ? (PROVIDER_LABELS[agent] ?? agent) : 'shell');

/** `Workspace · Host`, the Host only when there are several: where a row runs, when no
 *  heading says it. Shared with the Switch drawer. */
export function placeOf(pane: StatePane, state: State | null): string | undefined {
  const workspace = state?.workspaces.find((w) => w.muxKey === pane.muxKey && w.id === pane.workspaceId)?.label;
  const hostId = state?.muxes.find((m) => m.key === pane.muxKey)?.hostId;
  const host = (state?.hosts.length ?? 0) > 1 ? state?.hosts.find((h) => h.id === hostId)?.label : undefined;
  return [workspace, host].filter(Boolean).join(' · ') || undefined;
}

/** Does a row's own text — the Agent's name and type, title, Workspace label — carry the
 *  needle? Shared with the Switch drawer, so one search means one match everywhere. */
export function matchPane(pane: StatePane, needle: string, state?: State | null): boolean {
  if (!needle) return true;
  const workspace = state?.workspaces.find((w) => w.muxKey === pane.muxKey && w.id === pane.workspaceId);
  return `${pane.agentName ?? ''} ${paneKind(pane)} ${pane.title} ${workspace?.label ?? ''}`.toLowerCase().includes(needle);
}

/** A group's Status counts, most urgent first, as `[Status, n]`. `limit` keeps the top ones. */
function tally(panes: StatePane[], limit: number): [Status, number][] {
  return (Object.keys(RANK) as Status[])
    .map((s): [Status, number] => [s, panes.filter((p) => p.status === s).length])
    .filter(([, n]) => n > 0)
    .slice(0, limit);
}

/** The pill's tint per Status: the Status colour at 12 %, and none for the quiet two. */
const PILL: Record<Status, string> = {
  blocked: 'bg-warn/12 text-warn',
  working: 'bg-accent/12 text-accent',
  done: 'bg-ok/12 text-ok',
  idle: 'text-muted',
  unknown: 'text-muted',
};

/** `● 1 blocked`: a Status count as a compact pill. Filled dot for the loud three, ring for the quiet. */
function StatusPill({ status, n }: { status: Status; n: number }) {
  return (
    <span className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium tabular-nums ${PILL[status]}`}>
      <Dot status={status} seen={status === 'idle' || status === 'unknown'} size={6} />
      {n} {status}
    </span>
  );
}

/** Focus ring for the list's own buttons: inside the edge, so a full-width row never clips it. */
const RING = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
/** A row's and a header's side inset: 16 px here; the Switch drawer sets `--row-inset` to its sheet's 24. */
const INSET = 'px-[var(--row-inset,1rem)]';

// ---- rows ----

/** The Agent's own name in front of a title on one line: `auditor · seo audit`. */
const Named = ({ name }: { name: string }) => (
  <>
    <span className="font-medium text-fg">{name}</span>
    <span className="font-normal text-muted"> · </span>
  </>
);

/** The two revealed actions, in px: Rename and Close, 72 each. */
const REVEAL = 144;

/** What a row can do when its Mux writes. Passed in by Home, which owns the sheets. */
export interface RowActions {
  /** `at`: a right-click's point, so the desktop menu opens there */
  onMenu: (pane: StatePane, at?: MenuAnchor) => void;
  onRename: (pane: StatePane) => void;
  onClose: (pane: StatePane) => void;
}

/**
 * Apple-style swipe on a Pane row: drag left to reveal Rename and Close. Touch, not
 * pointer — a horizontal drag makes Chromium fire `pointercancel`, so `pointerup` never
 * arrives (the same lesson as the Tab strip). `touch-action: pan-y` keeps vertical
 * scrolls the page's. A tap on an open row closes it instead of navigating. Long-press
 * opens the same actions as a menu, which is also the desktop path.
 */
export function Row({ pane, first, actions, context, compact, current, paneDrag }: {
  pane: StatePane;
  first?: boolean;
  actions?: RowActions;
  context?: string;
  /** The desktop sidebar: the title over the Agent and where it runs, no preview. */
  compact?: boolean;
  /** The Pane on screen behind the Switch drawer. */
  current?: boolean;
  /** Desktop only: the row drags its Pane to a Space, a Tab or a split cell. */
  paneDrag?: HTMLAttributes<HTMLElement>;
}) {
  const fresh = unseen(pane);
  // UX §7: the dot never carries Status alone. A shell has none from herdr: it reads Running
  // while a program runs and shows no word at its prompt.
  const status = pane.agent ? pane.status : running(pane) ? 'running' : undefined;
  const word = status && status[0]!.toUpperCase() + status.slice(1);
  const when = timeAgo(pane.statusChangedAt);
  const press = useLongPress(() => actions?.onMenu(pane));
  const [x, setX] = useState(0);
  const [live, setLive] = useState(false);
  const drag = useRef({ x: 0, y: 0, from: 0, at: 0, axis: '' });

  const body = (
    <Link
      to={`#/pane/${encodeURIComponent(pane.key)}`}
      aria-label={[pane.agentName, paneKind(pane), pane.title, word, fresh ? 'unseen' : 'seen', when]
        .filter(Boolean)
        .join(', ')}
      onClick={(e) => {
        if (x !== 0) {
          e.preventDefault();
          setLive(false);
          setX(0);
        }
      }}
      aria-current={current ? 'page' : undefined}
      onContextMenu={atPointer(actions && ((at) => actions.onMenu(pane, at)))}
      onKeyDown={menuKey(actions && ((at) => actions.onMenu(pane, at)))}
      className={`press flex items-center [-webkit-touch-callout:none] ${RING} ${INSET} ${compact ? 'min-h-11 gap-2.5 py-1.5' : 'min-h-14 gap-3 py-2.5'} ${
        current ? 'bg-muted/20' : compact ? 'hover:bg-bg active:bg-bg' : 'hover:bg-surface active:bg-surface'
      }`}
      {...(actions ? press : {})}
      {...paneDrag}
    >
      <Dot status={pane.status} seen={!fresh} />
      {compact ? (
        <span aria-hidden className="flex min-w-0 flex-1 flex-col">
          <span className={`truncate text-[13px] ${fresh ? 'font-medium text-fg' : 'text-muted'}`}>
            {pane.agentName && <Named name={pane.agentName} />}
            {pane.title}
          </span>
          <span className="truncate text-caption text-muted">
            {agentName(pane.agent)}
            {context && <span className="text-muted/70"> · {context}</span>}
          </span>
        </span>
      ) : (
        <span aria-hidden className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            {pane.agentName && <span className="max-w-[45%] shrink-0 truncate text-body font-medium text-fg">{pane.agentName}</span>}
            <span className="shrink-0 text-body text-muted">{paneKind(pane)}</span>
            <span className={`truncate text-body ${fresh ? 'font-medium text-fg' : 'text-muted'}`}>{pane.title}</span>
          </span>
          <span className={`truncate text-caption text-muted ${pane.lastLine ? '' : 'font-mono'}`}>
            {/* Status, then where it runs, then the line: a long line truncates last, so the
                Workspace always shows. */}
            {word && <span className={statusText[pane.status]}>{word} · </span>}
            {context && <span className="text-muted/70">{context} · </span>}
            {preview(pane)}
          </span>
        </span>
      )}
      <span aria-hidden className="shrink-0 font-mono text-caption tabular-nums text-muted">
        {when}
      </span>
    </Link>
  );

  if (!actions) return <li className={first ? '' : 'border-t border-border/60'}>{body}</li>;
  return (
    <li className={`relative overflow-hidden ${first ? '' : 'border-t border-border/60'}`}>
      <div className="absolute inset-y-0 right-0 flex" inert={x === 0 ? true : undefined}>
        <button
          type="button"
          aria-label="Rename pane"
          onClick={() => actions.onRename(pane)}
          className="flex w-18 items-center justify-center bg-surface text-[13px] font-medium text-fg active:bg-bg"
        >
          Rename
        </button>
        <button
          type="button"
          aria-label="Close pane"
          onClick={() => actions.onClose(pane)}
          className="flex w-18 items-center justify-center bg-danger text-[13px] font-medium text-bg active:opacity-90"
        >
          Close
        </button>
      </div>
      <div
        className={`relative ${compact ? 'bg-surface' : 'bg-bg'} ${live ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'}`}
        style={{ transform: `translateX(${x}px)`, touchAction: 'pan-y' }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          drag.current = { x: t?.clientX ?? 0, y: t?.clientY ?? 0, from: x, at: x, axis: '' };
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          const d = drag.current;
          const dx = (t?.clientX ?? 0) - d.x;
          const dy = (t?.clientY ?? 0) - d.y;
          if (!d.axis) {
            if (Math.hypot(dx, dy) < 8) return;
            d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
          }
          if (d.axis !== 'x') return;
          setLive(true);
          d.at = Math.min(0, Math.max(-REVEAL, d.from + dx));
          setX(d.at);
        }}
        onTouchEnd={() => {
          // `at`, not the rendered `x`: a fast flick can end before the last move re-renders.
          if (drag.current.axis === 'x') {
            const open = drag.current.at < -REVEAL / 2;
            if (open && drag.current.at !== -REVEAL) haptic();
            setX(open ? -REVEAL : 0);
          }
          drag.current.axis = '';
          setLive(false);
        }}
      >
        {body}
      </div>
    </li>
  );
}

/**
 * A blocked Pane in Needs you: the Agent, its Workspace and Tab, the command from Explain,
 * and the plain Yes / No of the Pane's own blocked card — the same keys through the same
 * stale-prompt guard. A 409 never re-sends: the answers give way to Re-read. Explain loads
 * only here, so only blocked Panes cost a fetch. `compact` is the desktop sidebar: the title
 * over the Agent and where it waits, with Yes only; No stays in the Pane, and the row opens it.
 */
function NeedsYouCard({ pane, where, compact, paneDrag }: { pane: StatePane; where?: string; compact?: boolean; paneDrag?: HTMLAttributes<HTMLElement> }) {
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [changed, setChanged] = useState(false);
  /** The send went through: hold the answers until the prompt on screen is a new one. */
  const [sent, setSent] = useState(false);
  const shown = useRef<ExplainResponse | null>(null);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const queued = useRef(false);

  /** One request in flight per card. A load asked for meanwhile runs when it lands, and the
   *  older answer is dropped by the sequence check. A background load never touches
   *  `changed`: only Re-read clears it. */
  const load = () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    const id = ++seq.current;
    fetchExplain(pane.key)
      .then((next) => {
        if (id !== seq.current || queued.current) return;
        if ((next?.promptId ?? null) !== (shown.current?.promptId ?? null)) setSent(false);
        shown.current = next;
        setExplain(next);
      }, () => {}) // offline: keep the Explain already shown
      .finally(() => {
        inFlight.current = false;
        if (queued.current) {
          queued.current = false;
          load();
        } else setLoaded(true);
      });
  };
  /** The user asked to look again: hold the answers until the fresh Explain lands, so a
   *  tap can never carry the prompt id that was just refused. */
  const reread = () => {
    setChanged(false);
    setSent(false);
    setLoaded(false);
    seq.current++; // whatever is in flight was asked before the user looked again
    load();
  };
  // The card exists only while the Pane is blocked, so mounting is the change into blocked.
  useEffect(load, [pane.key]);
  // A printing Pane moves its revision every second; re-read Explain once it settles for 2 s.
  const revised = useRef(pane.revision);
  useEffect(() => {
    if (revised.current === pane.revision) return;
    revised.current = pane.revision;
    const t = setTimeout(load, 2000);
    return () => clearTimeout(t);
  }, [pane.revision]);

  const yesNo = explain ? yesNoKeys(explain) : null;
  const offer = !loaded || !!yesNo; // on the first load and a Re-read, the answers hold their place, disabled
  const busy = !loaded || sending || sent;
  const answer = async (key: string) => {
    setSending(true);
    try {
      const outcome = await sendBlocked(pane.key, [key], explain?.promptId);
      if (outcome === 'changed') setChanged(true);
      else setSent(true);
    } finally {
      setSending(false);
    }
  };

  const to = `#/pane/${encodeURIComponent(pane.key)}`;
  const agent = pane.agent ?? 'shell';
  const command = explain ? promptLine(explain) : pane.lastLine;
  const when = timeAgo(pane.statusChangedAt);
  const label = [pane.agentName, agent, pane.title, 'needs you', where, command, when].filter(Boolean).join(', ');
  const frame = 'rounded-card border border-warn/35 bg-warn/8';

  if (compact) {
    return (
      <li className="px-2 py-0.5">
        <div className={`flex min-h-11 items-center gap-2 pr-1 ${frame}`}>
          <Link to={to} aria-label={label} title={command} className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch py-1 pl-2" {...paneDrag}>
            <Dot status="blocked" />
            <span aria-hidden className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-fg">
                {pane.agentName && <Named name={pane.agentName} />}
                {pane.title}
              </span>
              <span className="truncate text-caption text-warn">
                {changed ? 'prompt changed' : agentName(pane.agent)}
                {where && <span className="text-muted"> · {where}</span>}
              </span>
            </span>
          </Link>
          {changed ? (
            <button type="button" onClick={reread} className="press h-7 shrink-0 rounded-chip px-2.5 text-[12px] font-medium text-accent">
              Re-read
            </button>
          ) : (
            offer && (
              <button
                type="button"
                aria-label={`Yes to ${pane.title}`}
                disabled={busy}
                onClick={() => yesNo && void answer(yesNo.yes.key)}
                className="press h-7 shrink-0 rounded-chip bg-warn px-2.5 text-[12px] font-semibold disabled:opacity-50"
                style={{ color: ON_WARN }}
              >
                Yes
              </button>
            )
          )}
        </div>
      </li>
    );
  }

  const open = (
    <Link to={to} className="press flex h-11 shrink-0 items-center px-3 text-[13px] font-medium text-accent">
      Open
    </Link>
  );
  return (
    <li className="px-4 py-1.5">
      <div role="group" aria-label={`${pane.title} needs you`} className={`flex flex-col gap-2.5 px-3.5 pt-3 pb-2.5 ${frame}`}>
        <Link to={to} aria-label={label} className="flex min-w-0 flex-col gap-1">
          <span aria-hidden className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-warn">
            <Dot status="blocked" />
            <span className="truncate">Needs you · {agent}{where && <span className="font-normal text-muted"> · {where}</span>}</span>
            <span className="ml-auto shrink-0 font-mono font-normal tabular-nums text-muted">{when}</span>
          </span>
          <span aria-hidden className="truncate text-[15px] font-medium text-fg">
            {pane.agentName && <Named name={pane.agentName} />}
            {pane.title}
          </span>
          {command && (
            <code aria-hidden className="truncate font-mono text-caption text-muted">
              {command}
            </code>
          )}
        </Link>
        {changed ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-caption text-warn">The prompt changed. Read it again before you answer.</p>
            <button type="button" onClick={reread} className="press h-11 shrink-0 rounded-chip border border-border bg-bg px-3 text-caption font-medium text-accent">
              Re-read
            </button>
            {open}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {offer && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => yesNo && void answer(yesNo.yes.key)}
                  className="press h-11 min-w-16 shrink-0 rounded-composer bg-warn px-4 text-[14px] font-semibold disabled:opacity-50"
                  style={{ color: ON_WARN }}
                >
                  Yes
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => yesNo && void answer(yesNo.no.key)}
                  className="press h-11 min-w-16 shrink-0 rounded-composer border border-border bg-surface px-4 text-[14px] text-fg disabled:opacity-50"
                >
                  No
                </button>
              </>
            )}
            <span className="ml-auto" />
            {open}
          </div>
        )}
      </div>
    </li>
  );
}

/** 500 ms, cancelled by 10 px of movement, so a scroll never opens the menu. The main button
 *  only: a right-button press is the context menu's (`atPointer`). */
function useLongPress(fn: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const stop = () => clearTimeout(timer.current);
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      from.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(fn, 500);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 10) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
  };
}

/** Where a dragged Workspace would land relative to the row under it. */
type DropMark = 'above' | 'below' | undefined;
const dropShadow = (d: DropMark) => (d === 'above' ? 'shadow-[inset_0_2px_0_var(--accent)]' : d === 'below' ? 'shadow-[inset_0_-2px_0_var(--accent)]' : '');

/** A Pane drop target under the pointer: an accent wash inside an accent edge. It replaces the
 *  target's own selected or drop-line shadow while it shows. */
export const DROP_ON = 'bg-accent/10! shadow-[inset_0_0_0_2px_var(--accent)]';
/** What a Pane drop there does — Swap, Move here, New Tab — on the target, never in its flow, so
 *  nothing under the pointer moves. The caller places it (`absolute` in a `relative` parent, or `fixed`). */
export function DropHint({ label, className, big, style }: { label: string; className: string; big?: boolean; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      style={style}
      className={`pointer-events-none z-20 rounded-full bg-accent font-semibold whitespace-nowrap text-bg shadow-[0_1px_3px_rgb(0_0_0/0.25)] ${
        big ? 'px-3 py-1 text-[13px] leading-5' : 'px-2 py-0.5 text-[11px] leading-4'
      } ${className}`}
    >
      {label}
    </span>
  );
}
/** The hint's place on a list row: over the counts and ⋯ at its end. A long Tab name in
 *  "Move to …" truncates before it covers more than the row's end. */
const ROW_HINT = 'absolute top-1/2 right-2 max-w-[60%] -translate-y-1/2 truncate';

/**
 * A list group header, one row: chevron, the label (the first thing to truncate), the Host as
 * a muted chip, the Status counts as pills on the right, then ⋯. Workspace groups also open
 * their menu on long-press. With a pointer, the row lights up on hover and ⋯ brightens; it
 * is always there, so nothing moves. `path` runs under the label the way the Spaces list
 * draws it; the Switch drawer passes it.
 */
export function GroupHeader({
  label,
  host,
  path,
  panes,
  open,
  compact,
  onToggle,
  onMenu,
  menuOpen,
  drag,
  drop,
  dropLabel,
}: {
  label: string;
  host?: string;
  /** The Workspace cwd, home already shortened to `~`. */
  path?: string;
  panes: StatePane[];
  open: boolean;
  /** The 300 px sidebar: one pill, the most urgent, so the label keeps its room. */
  compact?: boolean;
  onToggle: () => void;
  /** No point: under ⋯ or the header (a press, a long press); a point: a right-click. */
  onMenu?: (at?: MenuAnchor) => void;
  /** its menu is open, so ⋯ shows pressed and a second press closes it */
  menuOpen?: boolean;
  /** Desktop only: the drag handlers that reorder this Workspace and take a Pane, and where a reorder would land. */
  drag?: HTMLAttributes<HTMLElement>;
  drop?: DropMark;
  /** A Pane is held over the header: what dropping it does. */
  dropLabel?: string;
}) {
  const press = useLongPress(() => onMenu?.());
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <h2
      {...drag}
      onContextMenu={atPointer(onMenu)}
      className={`group/header relative flex items-center ${dropLabel ? DROP_ON : dropShadow(drop)} ${compact ? 'mt-2 hover:bg-bg' : 'mt-4 hover:bg-surface'} ${onMenu ? (compact ? 'pr-1.5' : 'pr-2') : 'pr-[var(--row-inset,1rem)]'}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={menuKey(onMenu)}
        {...(onMenu ? press : {})}
        className={`flex min-w-0 flex-1 items-center gap-2 self-stretch pl-[var(--row-inset,1rem)] text-left [-webkit-touch-callout:none] ${RING} ${
          compact ? 'min-h-9 py-1.5 pointer-coarse:min-h-11' : 'min-h-11 py-2'
        }`}
      >
        <Chevron className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`truncate font-semibold tracking-tight text-fg ${compact ? 'text-[13px]' : 'text-[15px]'}`}>{label}</span>
            {host && (
              <span className="max-w-[45%] shrink-0 truncate rounded-[5px] bg-fg/6 px-1.5 py-px text-[11px] font-medium text-muted">
                {host}
              </span>
            )}
          </span>
          {/* Right to left, so a long path gives up its start and keeps the project at its end. */}
          {path && (
            <span dir="rtl" className="block truncate text-left font-mono text-caption text-muted">
              <bdi>{path}</bdi>
            </span>
          )}
        </span>
        {/* A drop hint takes their place; `invisible` keeps their room, so nothing moves. */}
        <span className={`flex shrink-0 items-center gap-1 ${dropLabel ? 'invisible' : ''}`}>
          {tally(panes, compact ? 1 : 2).map(([s, n]) => (
            <StatusPill key={s} status={s} n={n} />
          ))}
        </span>
      </button>
      {onMenu && (
        <button
          type="button"
          data-nodrag
          aria-label={`${label} actions`}
          aria-haspopup="menu"
          aria-expanded={!!menuOpen}
          onClick={() => onMenu()}
          className={`press ml-0.5 flex shrink-0 items-center justify-center rounded-chip text-muted transition-opacity hover:bg-fg/6 hover:text-fg [@media(hover:hover)]:opacity-60 group-hover/header:opacity-100 focus-visible:opacity-100 ${menuOpen ? 'bg-fg/6 text-fg opacity-100!' : ''} ${dropLabel ? 'invisible' : ''} ${RING} ${
            compact ? 'size-8' : 'size-10'
          }`}
        >
          <More size={18} />
        </button>
      )}
      {dropLabel && <DropHint label={dropLabel} className={ROW_HINT} />}
    </h2>
  );
}

/** A pinned section header — Needs you, Running — collapsible like a Workspace group, and
 *  drawn the same way: chevron, label, and the count where a group has its pills. */
export function PinnedHeader({ label, count, open, compact, onToggle }: { label: string; count: number; open: boolean; compact?: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <h2 className={`flex ${compact ? 'mt-2 hover:bg-bg' : 'mt-3 hover:bg-surface'}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full items-center gap-2 text-left ${INSET} ${RING} ${compact ? 'min-h-9 py-1.5 pointer-coarse:min-h-11' : 'min-h-11 py-2'}`}
      >
        <Chevron className="shrink-0 text-muted" />
        <span className={`font-semibold tracking-tight text-fg ${compact ? 'text-[13px]' : 'text-[15px]'}`}>{label}</span>
        <span className="ml-auto shrink-0 text-[12px] font-medium tabular-nums text-muted">{count}</span>
      </button>
    </h2>
  );
}

// ---- herdr list ----

/** A small section heading. It sits above its section's own scroller, so it never moves. */
function SectionHead({ id, label, count, compact, children }: { id: string; label: string; count?: number; compact?: boolean; children?: ReactNode }) {
  return (
    <div className={`flex shrink-0 items-center gap-2 pr-2 pl-[var(--row-inset,1rem)] ${compact ? 'h-9' : 'h-10'}`}>
      <h2 id={id} className="min-w-0 truncate text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        {label}
      </h2>
      {count !== undefined && <span className="text-[11px] font-medium tabular-nums text-muted/70">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  );
}

/**
 * One Space in the herdr list, after herdr's own `[ui.sidebar.spaces]` row: the rolled-up
 * state icon and the label, then the Host when there are several, and the Agent count; the
 * Workspace path runs under the label. A tap selects it and filters Agents; ⋯ and long-press
 * open the Workspace menu.
 */
function SpaceRow({
  label,
  host,
  path,
  panes,
  selected,
  offline,
  compact,
  onSelect,
  onMenu,
  menuOpen,
  drag,
  drop,
  dropLabel,
}: {
  label: string;
  host?: string;
  /** The Workspace cwd, home already shortened to `~`. */
  path?: string;
  panes: StatePane[];
  selected: boolean;
  offline?: boolean;
  compact?: boolean;
  onSelect: () => void;
  onMenu?: (at?: MenuAnchor) => void;
  menuOpen?: boolean;
  drag?: HTMLAttributes<HTMLElement>;
  drop?: DropMark;
  /** A Pane is held over the row: what dropping it does. */
  dropLabel?: string;
}) {
  const press = useLongPress(() => onMenu?.());
  const top = rollup(panes, unseen);
  const agents = panes.filter((p) => p.agent).length;
  const others = panes.length - agents;
  const count = offline ? 'offline' : agents ? `${agents}` : others ? `${others} shell${others === 1 ? '' : 's'}` : '';
  const state = top ? `${top.status}${top.seen ? '' : ', unseen'}` : 'no Agents';
  return (
    <li
      {...drag}
      onContextMenu={atPointer(onMenu)}
      className={`group/space relative flex items-center ${onMenu ? 'pr-1.5' : 'pr-[var(--row-inset,1rem)]'} ${
        dropLabel ? DROP_ON
        : selected ? `${compact ? 'bg-bg' : 'bg-surface'} ${drop ? dropShadow(drop) : 'shadow-[inset_2px_0_0_var(--accent)]'}`
        : `${dropShadow(drop)} ${compact ? 'hover:bg-bg' : 'hover:bg-surface'}`
      }`}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-label={[label, host, state, offline ? 'offline' : `${agents} Agent${agents === 1 ? '' : 's'}`].filter(Boolean).join(', ')}
        title={path}
        onClick={onSelect}
        onKeyDown={menuKey(onMenu)}
        {...(onMenu ? press : {})}
        className={`flex min-w-0 flex-1 items-center gap-2.5 self-stretch pl-[var(--row-inset,1rem)] text-left [-webkit-touch-callout:none] ${RING} ${
          compact ? 'min-h-11 py-1.5' : 'min-h-11 py-2'
        }`}
      >
        <Dot status={top?.status ?? 'idle'} seen={top?.seen ?? true} />
        <span aria-hidden className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`truncate text-fg ${compact ? 'text-[13px]' : 'text-[15px]'} ${selected ? 'font-semibold' : ''}`}>{label}</span>
            {host && <span className="max-w-[45%] shrink-0 truncate text-caption text-muted">{host}</span>}
          </span>
          {/* Right to left, so a long path gives up its start and keeps the project at its end;
              <bdi> keeps the path itself left to right. */}
          {path && (
            <span dir="rtl" className="truncate text-left font-mono text-caption text-muted">
              <bdi>{path}</bdi>
            </span>
          )}
        </span>
        <span aria-hidden className={`shrink-0 text-[12px] tabular-nums ${offline ? 'text-danger' : agents ? 'text-muted' : 'text-muted/70'} ${dropLabel ? 'invisible' : ''}`}>
          {count}
        </span>
      </button>
      {onMenu && (
        <button
          type="button"
          data-nodrag
          aria-label={`${label} actions`}
          aria-haspopup="menu"
          aria-expanded={!!menuOpen}
          onClick={() => onMenu()}
          className={`press ml-0.5 flex shrink-0 items-center justify-center rounded-chip text-muted transition-opacity hover:bg-fg/6 hover:text-fg [@media(hover:hover)]:opacity-60 group-hover/space:opacity-100 focus-visible:opacity-100 ${menuOpen ? 'bg-fg/6 text-fg opacity-100!' : ''} ${dropLabel ? 'invisible' : ''} ${RING} ${
            compact ? 'size-8' : 'size-10'
          }`}
        >
          <More size={18} />
        </button>
      )}
      {dropLabel && <DropHint label={dropLabel} className={ROW_HINT} />}
    </li>
  );
}

/** The two Pane lists, as icons: the TopBar has no room for their names beside the title. */
const LISTS: { value: PaneList; label: string; Icon: typeof ListTautan }[] = [
  { value: 'tautan', label: 'tautan list, grouped by Workspace', Icon: ListTautan },
  { value: 'herdr', label: 'herdr list, Spaces and Agents', Icon: ListHerdr },
];

/**
 * The Pane list switch in Home's TopBar: the same preference as Settings › Appearance, live
 * in both. On the phone each half is 44 × 36 and reaches 44 px tall through `after:`.
 */
function PaneListSwitch({ compact }: { compact?: boolean }) {
  const list = usePref(getPaneList);
  return (
    <div role="group" aria-label="Pane list" className="mr-1 flex rounded-[10px] bg-fg/6 p-0.5">
      {LISTS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={list === value}
          aria-label={label}
          title={label}
          onClick={() => setPaneList(value)}
          className={`press relative flex items-center justify-center rounded-lg transition-colors ${RING} ${
            compact ? 'h-7 w-8' : "h-9 w-11 after:absolute after:-inset-y-1 after:inset-x-0 after:content-['']"
          } ${list === value ? `bg-elevated text-fg ${compact ? 'shadow-sm' : 'shadow-elevated'}` : 'text-muted hover:text-fg'}`}
        >
          <Icon size={compact ? 16 : 18} />
        </button>
      ))}
    </div>
  );
}

const GROUPS: [AgentGroup, string][] = [['priority', 'Priority'], ['spaces', 'Spaces']];
const SORTS: [AgentSort, string, string][] = [
  ['urgency', 'Urgency', 'Needs you first'],
  ['recent', 'Recent', 'Last change first'],
  ['name', 'Name', 'A to Z'],
];

const SPACE_SORTS: [SpaceSort, string, string][] = [
  ['manual', 'Manual', 'Your drag order'],
  ['urgency', 'Urgency', 'Needs you first'],
  ['recent', 'Recent', 'Last change first'],
  ['name', 'Name', 'A to Z'],
];

const menuItem = (compact?: boolean) => `press flex w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-fg/6 ${RING} ${compact ? 'h-8 text-[13px]' : 'min-h-11 text-body'}`;
const menuLabel = 'mb-1 px-2.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase';

/** One checkmark row in a view menu: a sort choice or a toggle. */
function MenuCheck({ on, name, hint, onClick, compact }: { on: boolean; name: string; hint: ReactNode; onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={menuItem(compact)}>
      <span className="w-4 shrink-0 text-accent">{on && <Check size={16} />}</span>
      <span className="text-fg">{name}</span>
      <span className="ml-auto text-caption tabular-nums text-muted">{hint}</span>
    </button>
  );
}

/**
 * A section's view options behind one icon in its heading. The icon turns accent while
 * anything differs from the default. A small popover, not a sheet: a few short choices,
 * read beside the list they change.
 */
function ViewMenu({ name, said, custom, compact, children }: { name: string; said: string; custom: boolean; compact?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role=dialog] [aria-pressed=true]')?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div
      ref={box}
      className="relative shrink-0"
      onBlur={(e) => {
        if (leavesMenu(e.currentTarget, e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`${name}: ${said}`}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`press relative flex items-center justify-center rounded-chip hover:bg-fg/6 ${RING} ${
          compact ? 'size-7' : "size-9 after:absolute after:-inset-1 after:content-['']"
        } ${custom ? 'text-accent' : 'text-muted hover:text-fg'} ${open ? 'bg-fg/6' : ''}`}
      >
        <Sliders size={compact ? 16 : 18} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={name}
          className="absolute top-full right-0 z-40 mt-1 w-60 rounded-xl border border-border bg-elevated p-1.5 normal-case shadow-elevated backdrop-blur-md"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The Agents section's view options: Group (Priority is herdr's flat attention queue, Spaces
 * one group per Space), Sort within a group, and the shells.
 */
function AgentsView({ shellCount, compact }: { shellCount: number; compact?: boolean }) {
  const group = usePref(getAgentGroup);
  const sort = usePref(getAgentSort);
  const shells = usePref(getShowShells);
  const custom = group !== 'priority' || sort !== 'urgency' || shells;
  const said = `${GROUPS.find(([v]) => v === group)![1]}, sorted by ${SORTS.find(([v]) => v === sort)![1]}${shells ? ', shells shown' : ''}`;
  return (
    <ViewMenu name="Agents view" said={said} custom={custom} compact={compact}>
      <p className={`${menuLabel} pt-1`}>Group</p>
      <div role="group" aria-label="Group" className="grid grid-cols-2 gap-0.5 rounded-[10px] bg-fg/6 p-0.5">
        {GROUPS.map(([v, name]) => (
          <button
            key={v}
            type="button"
            aria-pressed={group === v}
            onClick={() => setAgentGroup(v)}
            className={`press rounded-lg font-medium transition-colors ${RING} ${compact ? 'h-7 text-[12px]' : 'h-10 text-[14px]'} ${
              group === v ? 'bg-bg text-fg shadow-elevated' : 'text-muted hover:text-fg'
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <p className={`${menuLabel} pt-3`}>Sort</p>
      <div role="group" aria-label="Sort">
        {SORTS.map(([v, name, hint]) => (
          <MenuCheck key={v} on={sort === v} name={name} hint={hint} onClick={() => setAgentSort(v)} compact={compact} />
        ))}
      </div>
      <div className="mx-1 my-1.5 border-t border-border" />
      <MenuCheck on={shells} name="Show shells" hint={shellCount || 'none'} onClick={() => setShowShells(!shells)} compact={compact} />
    </ViewMenu>
  );
}

/** The Spaces section's view options: Sort, and hiding Spaces where no Agent runs. */
function SpacesView({ hiddenCount, compact }: { hiddenCount: number; compact?: boolean }) {
  const sort = usePref(getSpaceSort);
  const agentsOnly = usePref(getSpaceAgentsOnly);
  const custom = sort !== 'manual' || agentsOnly;
  const said = `sorted by ${SPACE_SORTS.find(([v]) => v === sort)![1]}${agentsOnly ? ', only with Agents' : ''}`;
  return (
    <ViewMenu name="Spaces view" said={said} custom={custom} compact={compact}>
      <p className={`${menuLabel} pt-1`}>Sort</p>
      <div role="group" aria-label="Sort">
        {SPACE_SORTS.map(([v, name, hint]) => (
          <MenuCheck key={v} on={sort === v} name={name} hint={hint} onClick={() => setSpaceSort(v)} compact={compact} />
        ))}
      </div>
      <div className="mx-1 my-1.5 border-t border-border" />
      <MenuCheck
        on={agentsOnly}
        name="Only with Agents"
        hint={agentsOnly ? (hiddenCount ? `${hiddenCount} hidden` : 'none hidden') : ''}
        onClick={() => setSpaceAgentsOnly(!agentsOnly)}
        compact={compact}
      />
    </ViewMenu>
  );
}

/** `Workspace › Tab · Host`, for a Needs you card; the Host only when there are several. */
function whereOf(p: StatePane, state: State | null): string | undefined {
  const ws = state?.workspaces.find((w) => w.muxKey === p.muxKey && w.id === p.workspaceId)?.label;
  const tab = state?.tabs.find((t) => t.muxKey === p.muxKey && t.workspaceId === p.workspaceId && t.id === p.tabId)?.label;
  const hostId = state?.muxes.find((m) => m.key === p.muxKey)?.hostId;
  const host = (state?.hosts.length ?? 0) > 1 ? state?.hosts.find((h) => h.id === hostId)?.label : undefined;
  return [[ws, tab].filter(Boolean).join(' › '), host].filter(Boolean).join(' · ') || undefined;
}

/**
 * The herdr list: Spaces over Agents, each its own scroller under a heading that stays put.
 * Spaces takes up to 40 % of the height, Agents the rest. Home draws it, and so does the
 * Switch drawer when the herdr list is chosen, so both follow the same view options. The
 * Switch drawer passes no actions: a tap there only picks.
 */
export function SpacesAgents({ state, ordered, host, q, space, onSpace, compact, current, actions, onMenu, menuOpen, drag, drop, dropLabel, paneDrag, pad = 'pb-4' }: {
  state: State;
  /** The Workspaces in the list's order. */
  ordered: StateWorkspace[];
  host: string | null;
  q: string;
  /** The picked Space's key; null is All Spaces. */
  space: string | null;
  onSpace: (key: string | null) => void;
  compact?: boolean;
  /** The Pane on screen behind the Switch drawer. */
  current?: string;
  actions?: (p: StatePane) => RowActions | undefined;
  onMenu?: (w: StateWorkspace, at?: MenuAnchor) => void;
  /** the Workspace whose menu is open */
  menuOpen?: string;
  /** A Space row's drag handlers: a Pane drop always, a reorder only when `reorder` (the Manual sort). */
  drag?: (w: StateWorkspace, reorder: boolean) => HTMLAttributes<HTMLElement> | undefined;
  drop?: (w: StateWorkspace) => DropMark;
  /** A Pane is held over this Space: what dropping it does. */
  dropLabel?: (w: StateWorkspace) => string | undefined;
  /** An Agent row's drag handlers, to drop its Pane on a Space, a Tab or a split cell. */
  paneDrag?: (p: StatePane) => HTMLAttributes<HTMLElement> | undefined;
  /** The Agents list's end padding: the phone pads it past the floating tab bar. */
  pad?: string;
}) {
  const group = usePref(getAgentGroup);
  const sort = usePref(getAgentSort);
  const shells = usePref(getShowShells);
  const spaceSort = usePref(getSpaceSort);
  const spaceAgentsOnly = usePref(getSpaceAgentsOnly);
  // The desktop sidebar and the Switch drawer can both be open, so the heading ids are per list.
  const id = useId();
  const hostOf = (muxKey: string) => state.muxes.find((m) => m.key === muxKey)?.hostId;
  const visible = (muxKey: string) => !host || hostOf(muxKey) === host;
  const many = state.hosts.length > 1;
  const needle = q.trim().toLowerCase();
  const hit = (p: StatePane) => matchPane(p, needle, state);
  const panesOf = (w: StateWorkspace) => state.panes.filter((p) => p.muxKey === w.muxKey && p.workspaceId === w.id).sort(comparePanes);

  const spacesFound = ordered
    .filter((w) => visible(w.muxKey))
    .map((w) => ({ w, all: panesOf(w) }))
    .filter(({ w, all }) => !needle || w.key === space || w.label.toLowerCase().includes(needle) || all.some(hit));
  // The picked Space stays listed even when the filter would hide it, so the Agents below keep a heading.
  const spaces = sortSpaces(
    spaceAgentsOnly ? spacesFound.filter(({ w, all }) => w.key === space || all.some((p) => p.agent)) : spacesFound,
    { sort: spaceSort, unseen },
  );
  const picked = spaces.find((s) => s.w.key === space)?.w;
  const scope = state.panes.filter(
    (p) => visible(p.muxKey) && (!picked || (p.muxKey === picked.muxKey && p.workspaceId === picked.id)),
  );
  const agents = agentRows(scope.filter(hit), { shells, unseen, sort });
  const shellCount = scope.filter((p) => !p.agent).length;
  // One Space picked is one group already, so Spaces grouping only applies to All Spaces.
  const grouped = group === 'spaces' && !picked ? bySpace(agents, spaces.map((s) => s.w)) : null;
  /** Agent rows, blocked as cards. `where` names the Space on a row when no heading does. */
  const agentItems = (rows: StatePane[], where: boolean) =>
    rows.map((p, i) =>
      p.status === 'blocked' ? (
        <NeedsYouCard key={p.key} pane={p} where={whereOf(p, state)} compact={compact} paneDrag={paneDrag?.(p)} />
      ) : (
        <Row
          key={p.key}
          pane={p}
          first={i === 0 || rows[i - 1]!.status === 'blocked'}
          actions={actions?.(p)}
          context={where ? placeOf(p, state) : undefined}
          compact={compact}
          current={p.key === current}
          paneDrag={paneDrag?.(p)}
        />
      ),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section aria-labelledby={`${id}spaces`} className="flex max-h-[40%] shrink-0 flex-col border-b border-border pt-1">
        <SectionHead id={`${id}spaces`} label="Spaces" count={spaces.length} compact={compact}>
          <SpacesView hiddenCount={spacesFound.length - spaces.length} compact={compact} />
        </SectionHead>
        <ul className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain pb-1.5">
          <SpaceRow
            label="All Spaces"
            panes={state.panes.filter((p) => visible(p.muxKey))}
            selected={!picked}
            compact={compact}
            onSelect={() => onSpace(null)}
          />
          {spaces.map(({ w, all }) => {
            const h = state.hosts.find((x) => x.id === hostOf(w.muxKey));
            return (
              <SpaceRow
                key={w.key}
                label={w.label}
                host={many ? h?.label : undefined}
                path={w.cwd && tildePath(w.cwd)}
                panes={all}
                offline={h?.online === false}
                selected={picked?.key === w.key}
                compact={compact}
                onSelect={() => onSpace(picked?.key === w.key ? null : w.key)}
                onMenu={onMenu && ((at) => onMenu(w, at))}
                menuOpen={menuOpen === w.key}
                // A sorted list has no drag order to change: Manual brings the reorder back. A
                // Pane drops on a Space whatever the sort.
                drag={drag?.(w, spaceSort === 'manual')}
                drop={spaceSort === 'manual' ? drop?.(w) : undefined}
                dropLabel={dropLabel?.(w)}
              />
            );
          })}
        </ul>
      </section>
      <section aria-labelledby={`${id}agents`} className="flex min-h-0 flex-1 flex-col pt-1">
        <SectionHead id={`${id}agents`} label={picked ? `Agents · ${picked.label}` : 'Agents'} count={agents.length} compact={compact}>
          <AgentsView shellCount={shellCount} compact={compact} />
        </SectionHead>
        <ul className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain ${pad}`}>
          {agents.length === 0 ? (
            <li className={`${INSET} py-3 text-caption text-muted`}>
              {needle
                ? `Nothing matches “${q.trim()}”`
                : picked
                  ? 'No Agents running in this Space'
                  : 'No Agents running'}
              {!needle && !shells && shellCount > 0 && (
                <span className="text-muted/70"> · {shellCount} shell{shellCount === 1 ? '' : 's'} hidden</span>
              )}
            </li>
          ) : grouped ? (
            grouped.map(({ space: s, rows }) => (
              <li key={s.key}>
                <h3
                  id={`${id}in-${s.key}`}
                  className={`flex items-baseline gap-1.5 ${INSET} text-[12px] font-medium text-muted ${compact ? 'pt-2.5 pb-1' : 'pt-4 pb-1.5'}`}
                >
                  <span className="min-w-0 truncate">{s.label}</span>
                  {many && (
                    <span className="max-w-[45%] shrink-0 truncate font-normal text-muted/70">
                      {state.hosts.find((h) => h.id === hostOf(s.muxKey))?.label}
                    </span>
                  )}
                  <span className="shrink-0 font-normal tabular-nums text-muted/70">{rows.length}</span>
                </h3>
                <ul aria-labelledby={`${id}in-${s.key}`}>{agentItems(rows, false)}</ul>
              </li>
            ))
          ) : (
            agentItems(agents, !picked)
          )}
        </ul>
      </section>
    </div>
  );
}

// ---- screen ----

const COLLAPSED = 'tautan.collapsed';
const readCollapsed = (): string[] => JSON.parse(store.get(COLLAPSED) ?? '[]') as string[];
/** Fold keys for the two pinned sections. */
const NEEDS = '@needs';
const RUNNING = '@running';

/** `compact` is the desktop sidebar: the same list, without the phone column or the tab bar's room. */
// ponytail: module-level so the Host filter survives the sidebar toggle and a resize across
// `lg`; it resets on reload. Move it to the URL or localStorage if that ever matters.
let hostFilter: string | null = null;
/** The selected Space in the herdr list, kept the same way and for the same reason. */
let spaceFilter: string | null = null;

export function Home({ state, compact, onHide }: {
  state: State | null;
  compact?: boolean;
  /** The desktop sidebar's Hide sidebar button. */
  onHide?: () => void;
}) {
  const [host, setHostState] = useState<string | null>(hostFilter);
  const setHost = (h: string | null) => { hostFilter = h; setHostState(h); };
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const layout = usePref(getPaneList);
  const [space, setSpaceState] = useState<string | null>(spaceFilter);
  const setSpace = (k: string | null) => { spaceFilter = k; setSpaceState(k); };
  const [newWorkspace, setNewWorkspace] = useState(() => opensWith('newworkspace'));
  const [newTab, setNewTab] = useState<StateWorkspace | null>(null);
  const [menu, setMenu] = useState<StateWorkspace | null>(null);
  const [rename, setRename] = useState<StateWorkspace | null>(null);
  const [close, setClose] = useState<StateWorkspace | null>(null);
  const [removeWorktree, setRemoveWorktree] = useState<StateWorkspace | null>(null);
  const [paneMenu, setPaneMenu] = useState<StatePane | null>(null);
  /** Where the open menu (Workspace or Pane) was asked for: a right-click's point, else none. */
  const [menuAt, setMenuAt] = useState<MenuAnchor | null>(null);
  /** A ⋯ pressed again while its own menu is open closes it. */
  const openMenu = (w: StateWorkspace, at?: MenuAnchor) => {
    setMenuAt(at ?? null);
    setMenu(menu?.key === w.key && !at ? null : w);
  };
  const openPaneMenu = (p: StatePane, at?: MenuAnchor) => {
    setMenuAt(at ?? null);
    setPaneMenu(p);
  };
  const [paneRename, setPaneRename] = useState<StatePane | null>(null);
  const [paneClose, setPaneClose] = useState<StatePane | null>(null);
  /** The Workspace whose plugin actions sheet is open (Wave 21), with the list as the menu had
   *  it when Plugin actions… was tapped: the live read empties when its Pane changes key. */
  const [actionsIn, setActionsIn] = useState<{ ws: StateWorkspace; actions: PluginAction[] } | null>(null);
  const [q, setQ] = useState('');
  // The Workspace this screen just created: it stays listed until State fills it with a
  // Pane, and scrolls itself into view the first time State carries it.
  const [created, setCreated] = useState<string | null>(null);
  // The Workspace order (ADR 0009): herdr's own, moved through the Hub; a tmux Workspace's is
  // this device's, never sent to a Mux. A failed move says why under the search for 4 s.
  const desktop = useDesktop();
  const [order, setOrder] = useState<WorkspaceOrder>(readOrder);
  const [drag, setDrag] = useState<{ key: string; over: string | null } | null>(null);
  /** A Pane held over a Space row or Workspace header (desktop): its key and the drop's label. */
  const [paneOver, setPaneOver] = useState<DropOver>(null);
  const [moveFailed, setMoveFailed] = useState('');
  const sections = useRef(new Map<string, HTMLElement>());
  const scrolled = useRef(false);
  const pal = usePal();

  const write = (next: string[]) => {
    setCollapsed(next);
    store.set(COLLAPSED, JSON.stringify(next));
  };
  const toggle = (key: string) =>
    write(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);

  useEffect(() => {
    const el = created && sections.current.get(created);
    if (!el || scrolled.current) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [state, created]);

  // A herdr Mux's stored order goes once it is seen, so its Workspaces list as herdr has them.
  const local = state ? dropMuxOrders(order, state.muxes) : order;
  useEffect(() => {
    if (local === order) return;
    setOrder(local);
    writeOrder(local);
  }, [local, order]);
  const ordered = orderWorkspaces(state?.workspaces ?? [], local);
  const slot = (w: StateWorkspace) => ordered.filter((x) => x.muxKey === w.muxKey);
  const place = (w: StateWorkspace) => slot(w).findIndex((x) => x.id === w.id);
  /** A failed move — a reorder or a Pane drop — says why under the search for 4 s. */
  const failed = (e: unknown) => {
    setMoveFailed(why((e instanceof Error && e.message) || 'network'));
    setTimeout(() => setMoveFailed(''), 4000);
  };
  /** Move `w` to slot `at` of its Mux's list. herdr: the Hub writes and refreshes before it
   *  replies, so the list changes with the next `state` event, never here first. */
  const reorder = (w: StateWorkspace, at: number) => {
    const from = place(w);
    if (from < 0 || at < 0 || at >= slot(w).length || at === from) return;
    if (!muxOrders(state?.muxes.find((m) => m.key === w.muxKey)?.kind)) {
      const next = moveWorkspace(ordered, local, w, at);
      setOrder(next);
      writeOrder(next);
      return;
    }
    api<void>(`/api/workspaces/${encodeURIComponent(w.key)}/move`, { index: spliceIndex(from, at) }).catch(failed);
  };
  // ponytail: native drag and drop on the row, desktop only. Firefox fires no dragstart on a
  // <button> (bug 568313), so there a row drags only from its edges; Chromium and WebKit drag
  // from anywhere but ⋯. Pointer-driven drag if that ever bites.
  const dragging = ordered.find((w) => w.key === drag?.key);
  const dragProps = (w: StateWorkspace): HTMLAttributes<HTMLElement> | undefined =>
    desktop && !needle
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            if (fromControl(e)) return;
            carry(e, WORKSPACE_TYPE, w.key);
            setDrag({ key: w.key, over: null });
          },
          onDragOver: (e: DragEvent) => {
            if (!dragging || dragging.key === w.key || dragging.muxKey !== w.muxKey) return;
            e.preventDefault();
            if (drag?.over !== w.key) setDrag({ key: dragging.key, over: w.key });
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dragging && dragging.muxKey === w.muxKey && dragging.key !== w.key) reorder(dragging, place(w));
            setDrag(null);
          },
          onDragEnd: () => setDrag(null),
        }
      : undefined;
  const dropAt = (w: StateWorkspace): DropMark =>
    dragging && drag?.over === w.key ? (slot(w).indexOf(dragging) > slot(w).indexOf(w) ? 'above' : 'below') : undefined;

  // A Pane row drags to a Space row or Workspace header (desktop): into that Workspace's open
  // Tab (else its first), split right, on the same Mux. The Pane on screen moved follows to
  // its new key, as the Pane's Move to… does; a failure says why under the search, like a
  // reorder's.
  const paneDrag = (p: StatePane) => (desktop ? paneSource(p) : undefined);
  const movePane = (src: StatePane, d: PaneDrop) => {
    if (d.verb !== 'Move') return;
    haptic();
    api<{ paneKey: string }>(`/api/panes/${encodeURIComponent(src.key)}/move`, d.to satisfies MoveBody).then(({ paneKey }) => {
      if (decodeURIComponent(location.hash) === `#/pane/${src.key}`) navigate(`#/pane/${encodeURIComponent(paneKey)}`, { replace: true, transition: false });
    }, failed);
  };
  /** A Space row or Workspace header: it takes a Pane, and reorders unless a sort holds the list. */
  const spaceDrag = (w: StateWorkspace, manual = true) =>
    desktop
      ? paneTarget({
          id: w.key,
          decide: (src) => paneDrop(src, { kind: 'space', space: w, tab: spaceTab(w, state?.tabs ?? []) }, state?.panes ?? []),
          setOver: setPaneOver,
          onDrop: movePane,
          rest: manual ? dragProps(w) : undefined,
        })
      : undefined;
  const spaceDropLabel = (w: StateWorkspace) => (paneOver?.id === w.key ? paneOver.label : undefined);

  const hostOf = (muxKey: string) => state?.muxes.find((m) => m.key === muxKey)?.hostId;
  const hostLabel = (muxKey: string) => state?.hosts.find((h) => h.id === hostOf(muxKey))?.label;
  const panesOf = (w: StateWorkspace) =>
    (state?.panes ?? []).filter((p) => p.muxKey === w.muxKey && p.workspaceId === w.id).sort(comparePanes);

  const visible = (muxKey: string) => !host || hostOf(muxKey) === host;
  /** Only herdr writes. tmux answers 501, so tautan never offers the action. */
  const writable = (muxKey?: string) => state?.muxes.find((m) => m.key === muxKey)?.kind === 'herdr';
  const needle = q.trim().toLowerCase();
  const hit = (p: StatePane) => matchPane(p, needle, state);
  const wsLabel = (p: StatePane) => state?.workspaces.find((w) => w.muxKey === p.muxKey && w.id === p.workspaceId)?.label;
  const needsYou = (state?.panes ?? [])
    .filter((p) => visible(p.muxKey) && unseen(p) && (p.status === 'blocked' || p.status === 'done') && hit(p))
    .sort(comparePanes); // blocked cards first, then the done rows
  /** Working Panes pinned beside Needs you, most recently changed first. */
  const running = (state?.panes ?? [])
    .filter((p) => visible(p.muxKey) && p.status === 'working' && hit(p))
    .sort((a, b) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0));
  const pinned = new Set([...needsYou, ...running].map((p) => p.key));
  const groups = ordered
    .filter((w) => visible(w.muxKey))
    .map((w) => {
      const hostId = hostOf(w.muxKey);
      return {
        w,
        host: state?.hosts.find((h) => h.id === hostId),
        all: panesOf(w),
        panes: panesOf(w).filter((p) => !pinned.has(p.key) && hit(p)),
      };
    })
    // A Workspace whose Panes all sit in a pinned section keeps its header — its summary
    // still says what it holds, and the group menu stays reachable. While searching, an
    // empty section is noise instead, so it goes.
    .filter((g) => g.panes.length > 0 || (!needle && g.all.length > 0) || g.host?.online === false || g.w.key === created);
  /** A search must show what it found, so a folded section opens while the needle is set. */
  const openSection = (key: string) => !!needle || !collapsed.includes(key);

  const tabIn = newTab ?? (opensWith('newtab') ? (groups[0]?.w ?? null) : null);
  // A new Workspace lands on the Mux the list already shows, next to the Workspace it was
  // started from: one herdr Mux is the common case, and nothing here asks which.
  const beside = groups.find((g) => writable(g.w.muxKey))?.w ?? state?.workspaces.find((w) => writable(w.muxKey));

  const createTab = async (w: StateWorkspace, o: { label?: string; cwd?: string; agent?: string }) => {
    const { paneKey } = await api<NewTabResult>(`/api/muxes/${encodeURIComponent(w.muxKey)}/tabs`, {
      workspaceId: w.id,
      ...o,
    } satisfies NewTabBody);
    navigate(`#/pane/${encodeURIComponent(paneKey)}`);
  };

  const createWorkspace = async (o: { cwd: string; label?: string; branch?: string }) => {
    const { workspaceKey } = await api<NewWorkspaceResult>(
      `/api/muxes/${encodeURIComponent(beside!.muxKey)}/workspaces`,
      o satisfies NewWorkspaceBody,
    );
    write(collapsed.filter((k) => k !== workspaceKey));
    scrolled.current = false;
    setCreated(workspaceKey);
  };
  const counts = state && `${state.hosts.length} host${state.hosts.length === 1 ? '' : 's'} · ${state.panes.length} panes`;
  // Collapse all folds the pinned sections with the Workspace groups; the two only exist
  // when they hold rows, which is exactly when folding them means something. The herdr
  // list folds nothing.
  const keys = layout === 'herdr' ? [] : [...groups.map((g) => g.w.key), ...(needsYou.length ? [NEEDS] : []), ...(running.length ? [RUNNING] : [])];
  const allShut = keys.length > 0 && keys.every((k) => collapsed.includes(k));
  // A Workspace action runs through one of its Panes: the first in herdr's own order (the
  // tree carries no active Tab). The list is asked for, fresh, when the menu opens: the row
  // shows when a workspace action fits, and the sheet takes the same list.
  const actionsWs = actionsIn?.ws ?? menu;
  const actionsPane = actionsWs && state?.panes.find((p) => p.muxKey === actionsWs.muxKey && p.workspaceId === actionsWs.id);
  const wsActions = actionsFor(usePluginActions(writable(actionsWs?.muxKey) ? actionsPane?.key : undefined, menu !== null), 'workspace');
  const rowActions = (p: StatePane): RowActions | undefined =>
    writable(p.muxKey) ? { onMenu: openPaneMenu, onRename: setPaneRename, onClose: setPaneClose } : undefined;

  const listed = state && (needsYou.length > 0 || running.length > 0 || groups.length > 0);
  const foldAll = () => write(allShut ? collapsed.filter((k) => !keys.includes(k)) : [...new Set([...collapsed, ...keys])]);
  // Desktop draws the Files Explorer's Fold all glyph: the phone's converging chevrons read as
  // a close there, beside the mouse.
  const FoldIcon = desktop ? (allShut ? UnfoldAll : FoldAll) : allShut ? ExpandAll : CollapseAll;
  const moveLine = moveFailed && (
    // The Pane strip's `<verb> failed` line, here because the sticky top is the one place a
    // phone always shows; the menu that asked has closed by the time the Hub answers.
    <p role="status" title={moveFailed} className={`truncate px-4 text-[12px] text-danger ${compact ? 'py-2' : 'pb-2'}`}>
      Move failed · {moveFailed}
    </p>
  );
  // The top: title and search. In the sidebar it stays put while only the list under it
  // scrolls, and it lines up with the screen beside it, as the Files Explorer's header does:
  // the title row is the 56 px of the Pane and Files headers, the search band the Tab strip's
  // 47 px, so the Host chips scroll with the list there. Two rows, two jobs: the sidebar
  // itself (hide it, what it holds, add to it), then finding and arranging the list. On the
  // phone the window scrolls and the TopBar is sticky, so neither part may be wrapped there.
  const top = compact ? (
    <header className="shrink-0 border-b border-border">
      <div className="flex h-14 items-center gap-1 border-b border-border px-2">
        {onHide && (
          <button type="button" aria-label="Hide sidebar" title={`Hide sidebar · ${SIDEBAR_KEYS}`} onClick={onHide} className={TOOL}>
            <PanelLeft size={16} />
          </button>
        )}
        <div className="flex min-w-0 flex-1 flex-col px-1">
          <h1 className="truncate text-title tracking-tight">tautan</h1>
          {counts && <p className="truncate text-caption text-muted">{counts}</p>}
        </div>
        {beside && (
          <button type="button" aria-label="New Workspace" title="New Workspace" onClick={() => setNewWorkspace(true)} className={TOOL}>
            <Plus size={18} />
          </button>
        )}
      </div>
      {state && (
        // The band is the field: flat, edge to edge, with an accent line like the open Tab's
        // while it has focus; the list's own controls sit at its end.
        <div className="relative flex items-center gap-1 pr-2 after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent after:opacity-0 after:transition-opacity focus-within:after:opacity-100">
          <div className="min-w-0 flex-1">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search panes"
              shortcut={null}
              style={{ width: '100%', height: 46, padding: '0 8px 0 16px', gap: 10, border: 'none', borderRadius: 0, background: 'transparent' }}
            />
          </div>
          <PaneListSwitch compact />
          {keys.length > 0 && (
            <button type="button" aria-label={allShut ? 'Expand all' : 'Collapse all'} title={allShut ? 'Expand all' : 'Collapse all'} onClick={foldAll} className={TOOL}>
              <FoldIcon size={15} />
            </button>
          )}
        </div>
      )}
      {moveLine}
    </header>
  ) : (
      <TopBar
        title="tautan"
        right={
          <>
            {/* A 390 px phone cannot hold the counts beside the switch and Collapse all; they come back from 412 px. */}
            <span className={`mr-1.5 text-caption tabular-nums text-muted ${keys.length > 0 ? 'hidden @min-[380px]:inline' : ''}`}>
              {counts}
            </span>
            <PaneListSwitch />
            {state && keys.length > 0 && (
              <IconButton
                size={40}
                label={allShut ? 'Expand all' : 'Collapse all'}
                onClick={foldAll}
                icon={<FoldIcon size={18} />}
              />
            )}
            {beside && (
              <IconButton
                size={40}
                label="New Workspace"
                onClick={() => setNewWorkspace(true)}
                icon={<Plus size={20} />}
                style={{ color: pal.accent }}
              />
            )}
          </>
        }
        below={
          state ? (
            <>
              <div className="px-4 pb-2">
                <SearchInput value={q} onChange={setQ} placeholder="Search panes" shortcut={null} style={{ width: '100%', height: 40 }} />
              </div>
              {moveLine}
            </>
          ) : undefined
        }
      />
  );
  const hostChips = (
    <>
      {state && state.hosts.length > 1 && (
        <div role="group" aria-label="Filter by Host" className={`hscroll flex gap-2 px-4 pb-0.5 ${compact ? 'pt-2.5' : 'pt-1.5'}`}>
          {[{ id: null, label: 'All', online: true }, ...state.hosts].map((h) => (
            <Chip key={h.id ?? 'all'} selected={host === h.id} onToggle={() => setHost(h.id)}>
              {h.label}
            </Chip>
          ))}
        </div>
      )}
    </>
  );

  const list = (
    <>
      {!state ? (
        <ul aria-busy className="pt-6">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex min-h-14 items-center gap-3 px-4 py-2.5">
              <Skeleton width={8} height={8} rounded />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton width="50%" height={14} />
                <Skeleton width="75%" height={12} />
              </div>
            </li>
          ))}
        </ul>
      ) : !listed ? (
        <div className="pt-6">
          {needle ? (
            <EmptyState title={`Nothing matches “${q.trim()}”`} description="Try an agent, a title or a Workspace label." />
          ) : (
            <EmptyState
              title="No panes yet"
              description="Add a Host and its Muxes appear here."
              action={
                <Link to="#/hosts" className="text-body font-medium text-accent">
                  Add a Host
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <>
          {needsYou.length > 0 && (
            <section>
              <PinnedHeader label="Needs you" count={needsYou.length} compact={compact} open={openSection(NEEDS)} onToggle={() => toggle(NEEDS)} />
              {openSection(NEEDS) && (
                <ul>
                  {needsYou.map((p, i) =>
                    p.status === 'blocked' ? (
                      <NeedsYouCard key={p.key} pane={p} where={whereOf(p, state)} compact={compact} paneDrag={paneDrag(p)} />
                    ) : (
                      <Row
                        key={p.key}
                        pane={p}
                        first={i === 0 || needsYou[i - 1]!.status === 'blocked'}
                        actions={rowActions(p)}
                        context={placeOf(p, state)}
                        compact={compact}
                        paneDrag={paneDrag(p)}
                      />
                    ),
                  )}
                </ul>
              )}
            </section>
          )}

          {running.length > 0 && (
            <section>
              <PinnedHeader label="Running" count={running.length} compact={compact} open={openSection(RUNNING)} onToggle={() => toggle(RUNNING)} />
              {openSection(RUNNING) && (
                <ul>
                  {running.map((p, i) => (
                    <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} context={placeOf(p, state)} compact={compact} paneDrag={paneDrag(p)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {groups.map(({ w, host: h, panes, all }) => {
                const shut = collapsed.includes(w.key);
                return (
                  <section
                    key={w.key}
                    ref={(el) => {
                      if (el) sections.current.set(w.key, el);
                      else sections.current.delete(w.key);
                    }}
                  >
                    <GroupHeader
                      label={w.label}
                      host={h?.label}
                      panes={all}
                      compact={compact}
                      open={!shut}
                      onToggle={() => toggle(w.key)}
                      onMenu={(at) => openMenu(w, at)}
                      menuOpen={menu?.key === w.key}
                      drag={spaceDrag(w)}
                      drop={dropAt(w)}
                      dropLabel={spaceDropLabel(w)}
                    />
                    {!shut && (
                      <ul>
                        {panes.map((p, i) => (
                          <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} compact={compact} paneDrag={paneDrag(p)} />
                        ))}
                        {h?.online === false && (
                          <li>
                            <Link
                              to="#/hosts"
                              className="flex min-h-11 items-center gap-3 px-4 py-2.5 active:bg-surface"
                              aria-label={`${h.label} unreachable, ${h.error ?? 'offline'}. Open Hosts`}
                            >
                              <span aria-hidden className="size-2 shrink-0 rounded-full bg-danger" />
                              <span aria-hidden className="min-w-0 flex-1 truncate text-[13px] text-muted">
                                <span className="text-danger">{h.label} unreachable</span> · {h.error}
                              </span>
                              <span aria-hidden className="shrink-0 text-caption text-accent">
                                Hosts ›
                              </span>
                            </Link>
                          </li>
                        )}
                      </ul>
                    )}
                  </section>
                );
          })}
        </>
      )}
    </>
  );

  // ---- the herdr list: Spaces over Agents ----
  const herdr = layout === 'herdr' && !!state && state.workspaces.some((w) => visible(w.muxKey));
  // On the phone the Agents list runs on under the floating tab bar and pads its end by the
  // bar's height, so the last row clears it.
  const herdrBody = herdr && (
    <SpacesAgents
      state={state}
      ordered={ordered}
      host={host}
      q={q}
      space={space}
      onSpace={setSpace}
      compact={compact}
      actions={rowActions}
      onMenu={openMenu}
      menuOpen={menu?.key}
      drag={spaceDrag}
      drop={dropAt}
      dropLabel={spaceDropLabel}
      paneDrag={paneDrag}
      pad={compact ? 'pb-4' : 'pb-[calc(env(safe-area-inset-bottom)+76px)]'}
    />
  );

  return (
    <div
      className={
        compact ? 'flex h-full min-h-0 flex-col'
        : herdr ? 'mx-auto flex h-dvh max-w-2xl flex-col overflow-hidden'
        : 'mx-auto max-w-2xl pb-28'
      }
    >
      {top}
      {(!compact || herdr) && hostChips}
      {herdr ? (
        herdrBody
      ) : compact ? (
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-4">
          {hostChips}
          {list}
        </div>
      ) : (
        list
      )}

      <NewWorkspaceSheet
        open={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        cwd={parentDir(beside?.cwd)}
        hostId={beside ? hostOf(beside.muxKey) : undefined}
        paneKey={beside ? panesOf(beside)[0]?.key : undefined}
        onSubmit={createWorkspace}
      />
      <NewTabSheet
        open={tabIn !== null}
        onClose={() => setNewTab(null)}
        cwd={tabIn?.cwd}
        hostId={tabIn ? hostOf(tabIn.muxKey) : undefined}
        paneKey={tabIn ? panesOf(tabIn)[0]?.key : undefined}
        agent={commonAgent(tabIn ? panesOf(tabIn) : [])}
        where={
          <>
            in <span className="text-fg">{tabIn?.label}</span> · {hostLabel(tabIn?.muxKey ?? '')}
          </>
        }
        onSubmit={(o) => createTab(tabIn!, o)}
      />
      <MenuSheet
        open={menu !== null}
        title={menu?.label ?? ''}
        at={menuAt}
        meta={menu && [hostLabel(menu.muxKey), `${panesOf(menu).length} Pane${panesOf(menu).length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
        onClose={() => setMenu(null)}
        items={[
          ...(writable(menu?.muxKey)
            ? [
                { label: 'New Tab', onClick: () => setNewTab(menu) },
                { label: 'Rename', onClick: () => setRename(menu) },
              ]
            : []),
          // Files reads through a Pane; the Workspace's first one will do.
          ...(menu && panesOf(menu)[0] ? [{ label: 'Files', onClick: () => navigate(filesHash(panesOf(menu)[0]!.key)) }] : []),
          { label: 'Diff', onClick: () => menu && navigate(`#/diff/${encodeURIComponent(menu.key)}`) },
          { label: collapsed.includes(menu?.key ?? '') ? 'Expand' : 'Collapse', onClick: () => menu && toggle(menu.key) },
          // herdr moves it in herdr; a tmux Workspace moves in this device's order (ADR 0009).
          // This is the phone's way to reorder; a drag fights scrolling on touch (ADR 0008).
          ...(menu && slot(menu).length > 1
            ? [
                { label: 'Move up', hint: 'earlier in the list', disabled: place(menu) === 0, onClick: () => reorder(menu, place(menu) - 1) },
                { label: 'Move down', hint: 'later in the list', disabled: place(menu) === slot(menu).length - 1, onClick: () => reorder(menu, place(menu) + 1) },
              ]
            : []),
          // Last, so it can arrive after the menu opens without moving a row under a finger.
          ...(menu && wsActions.length ? [{ label: 'Plugin actions…', onClick: () => setActionsIn({ ws: menu, actions: wsActions }) }] : []),
          // herdr's linked worktrees only: herdr removes the checkout and closes the Workspace.
          ...(menu?.worktree && writable(menu.muxKey) ? [{ label: 'Remove worktree…', danger: true, onClick: () => setRemoveWorktree(menu) }] : []),
          ...(writable(menu?.muxKey) ? [{ label: 'Close Workspace', danger: true, onClick: () => menu && setClose(menu) }] : []),
        ]}
      />
      <PluginActionsSheet
        open={actionsIn !== null}
        onClose={() => setActionsIn(null)}
        meta={actionsIn?.ws.label}
        menu="workspace"
        actions={actionsIn?.actions}
        paneKey={actionsPane?.key}
        state={state}
      />
      <RenameSheet
        open={rename !== null}
        kind="Workspace"
        current={rename?.label ?? ''}
        onClose={() => setRename(null)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: rename!.muxKey, workspaceId: rename!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={close !== null}
        kind="Workspace"
        title={close?.label ?? ''}
        onClose={() => setClose(null)}
        onConfirm={() => api<void>(`/api/workspaces/${encodeURIComponent(close!.key)}/close`)}
      />
      <RemoveWorktreeSheet open={removeWorktree !== null} workspace={removeWorktree} onClose={() => setRemoveWorktree(null)} />
      <MenuSheet
        open={paneMenu !== null}
        title={paneMenu?.title ?? ''}
        at={menuAt}
        meta={paneMenu && [paneKind(paneMenu), paneStatusWord(paneMenu), wsLabel(paneMenu)].filter(Boolean).join(' · ')}
        onClose={() => setPaneMenu(null)}
        items={[
          { label: 'Rename', onClick: () => paneMenu && setPaneRename(paneMenu) },
          { label: 'Close Pane', danger: true, onClick: () => paneMenu && setPaneClose(paneMenu) },
        ]}
      />
      <RenameSheet
        open={paneRename !== null}
        kind="Pane"
        current={paneRename?.title ?? ''}
        onClose={() => setPaneRename(null)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: paneRename!.muxKey, paneId: paneRename!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={paneClose !== null}
        title={paneClose?.title ?? ''}
        onClose={() => setPaneClose(null)}
        onConfirm={() => api<void>(`/api/panes/${encodeURIComponent(paneClose!.key)}/close`)}
      />
    </div>
  );
}
