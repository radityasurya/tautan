import { TopBar } from './header.tsx';
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type {
  NewTabBody, NewTabResult, NewWorkspaceBody, NewWorkspaceResult, RenameBody, State, StatePane, StateWorkspace, Status,
} from '../shared/types.ts';
import { api, haptic, Link, navigate, opensWith, reducedMotion } from './app.tsx';
import { ChevronDown, ChevronRight, CollapseAll, ExpandAll, More, Plus } from './icons.tsx';
import { Chip, EmptyState, IconButton, SearchInput, SegmentedControl, Skeleton, usePal } from './halaska-kit';
import { ConfirmCloseSheet, MenuSheet, NewTabSheet, NewWorkspaceSheet, RenameSheet } from './sheets.tsx';
import { isUnseen } from '../shared/seen.ts';

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
const seen = () => (seenAt ??= JSON.parse(localStorage.getItem('tautan.seen') ?? '{}') as Record<string, number>);

export function markSeen(key: string, revision: number) {
  seen()[key] = revision;
  localStorage.setItem('tautan.seen', JSON.stringify(seen()));
}

/** Seed a new device from its first snapshot. Blocked remains actionable regardless. */
export function seedSeen(panes: StatePane[]) {
  const current = seen();
  if (Object.keys(current).length) return;
  for (const pane of panes) current[pane.key] = pane.revision;
  localStorage.setItem('tautan.seen', JSON.stringify(current));
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

/** Does a row's own text — agent, title, Workspace label — carry the needle? Shared with
 *  the Switch drawer, so one search means one match everywhere. */
export function matchPane(pane: StatePane, needle: string, state?: State | null): boolean {
  if (!needle) return true;
  const workspace = state?.workspaces.find((w) => w.muxKey === pane.muxKey && w.id === pane.workspaceId);
  return `${pane.agent ?? 'shell'} ${pane.title} ${workspace?.label ?? ''}`.toLowerCase().includes(needle);
}

/** The most urgent status present, as the collapsed group's one-line summary. */
function summary(panes: StatePane[]): string {
  for (const s of Object.keys(RANK) as Status[]) {
    const n = panes.filter((p) => p.status === s).length;
    if (n) return `${n} ${s}`;
  }
  return '';
}

// ---- rows ----

/** The two revealed actions, in px: Rename and Close, 72 each. */
const REVEAL = 144;

/** What a row can do when its Mux writes. Passed in by Home, which owns the sheets. */
export interface RowActions {
  onMenu: (pane: StatePane) => void;
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
function Row({ pane, first, actions, context }: { pane: StatePane; first?: boolean; actions?: RowActions; context?: string }) {
  const fresh = unseen(pane);
  const word = pane.status[0]!.toUpperCase() + pane.status.slice(1); // UX §7: the dot never carries Status alone
  const when = timeAgo(pane.statusChangedAt);
  const press = useLongPress(() => actions?.onMenu(pane));
  const [x, setX] = useState(0);
  const [live, setLive] = useState(false);
  const drag = useRef({ x: 0, y: 0, from: 0, at: 0, axis: '' });

  const body = (
    <Link
      to={`#/pane/${encodeURIComponent(pane.key)}`}
      aria-label={[pane.agent ?? 'shell', pane.title, pane.status, fresh ? 'unseen' : 'seen', when]
        .filter(Boolean)
        .join(', ')}
      onClick={(e) => {
        if (x !== 0) {
          e.preventDefault();
          setLive(false);
          setX(0);
        }
      }}
      className="press flex min-h-14 items-center gap-3 px-4 py-2.5 active:bg-surface [-webkit-touch-callout:none]"
      {...(actions ? press : {})}
    >
      <Dot status={pane.status} seen={!fresh} />
      <span aria-hidden className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-body text-muted">{pane.agent ?? 'shell'}</span>
          <span className={`truncate text-body ${fresh ? 'font-medium text-fg' : 'text-muted'}`}>{pane.title}</span>
        </span>
        <span className={`truncate text-caption text-muted ${pane.lastLine ? '' : 'font-mono'}`}>
          {word && <span className={statusText[pane.status]}>{word} · </span>}
          {preview(pane)}
          {context && <span className="text-muted/70"> · {context}</span>}
        </span>
      </span>
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
        className={`relative bg-bg ${live ? '' : 'transition-transform duration-200 ease-out motion-reduce:transition-none'}`}
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

/** 500 ms, cancelled by 10 px of movement, so a scroll never opens the menu. */
function useLongPress(fn: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const stop = () => clearTimeout(timer.current);
  useEffect(() => stop, []);
  return {
    onPointerDown: (e: ReactPointerEvent) => {
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

/** A list group header. Workspace groups also open their menu on long-press or ⋯. */
function GroupHeader({
  label,
  secondary,
  host,
  summary,
  open,
  onToggle,
  onMenu,
}: {
  label: string;
  secondary?: string;
  host?: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  onMenu?: () => void;
}) {
  const press = useLongPress(() => onMenu?.());
  return (
    <h2 className="flex items-end">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        {...(onMenu ? press : {})}
        className={`label-caps flex min-w-0 flex-1 px-4 pt-6 pb-1.5 text-left [-webkit-touch-callout:none] ${secondary ? 'items-start' : 'items-center'}`}
      >
        {open ? (
          <ChevronDown className={`mr-1.5 shrink-0 ${secondary ? 'mt-0.5' : ''}`} />
        ) : (
          <ChevronRight className={`mr-1.5 shrink-0 ${secondary ? 'mt-0.5' : ''}`} />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center">
            <span className="truncate">{label}</span>
            {host && <span className="ml-1.5 shrink-0 font-medium tracking-normal normal-case text-muted">· {host}</span>}
          </span>
          {secondary && (
            <span title={secondary} className="mt-0.5 block truncate font-mono text-caption font-normal tracking-normal normal-case text-muted">
              {secondary}
            </span>
          )}
        </span>
        <span className="shrink-0 pl-2 font-medium tracking-normal normal-case text-muted">{summary}</span>
      </button>
      {onMenu && (
        <button
          type="button"
          aria-label={`${label} actions`}
          onClick={onMenu}
          className="press -mr-1 mb-0.5 flex size-11 shrink-0 items-center justify-center text-muted"
        >
          <More size={18} />
        </button>
      )}
    </h2>
  );
}

/** A pinned section header — Needs you, Running — collapsible like a Workspace group. */
function PinnedHeader({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <h2>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="label-caps flex w-full items-center px-4 pt-3.5 pb-1.5 text-left"
      >
        {open ? <ChevronDown className="mr-1.5 shrink-0" /> : <ChevronRight className="mr-1.5 shrink-0" />}
        {label}
        <span className="ml-auto shrink-0 pl-2 font-medium tracking-normal normal-case tabular-nums text-muted">{count}</span>
      </button>
    </h2>
  );
}

// ---- screen ----

const COLLAPSED = 'tautan.collapsed';
const GROUPING = 'tautan.grouping';
type Grouping = 'workspace' | 'folder';
const readCollapsed = (): string[] => JSON.parse(localStorage.getItem(COLLAPSED) ?? '[]') as string[];
const readGrouping = (): Grouping => (localStorage.getItem(GROUPING) === 'folder' ? 'folder' : 'workspace');
const folderFoldKey = (host: string, path: string) => `@folder/${encodeURIComponent(host)}/${encodeURIComponent(path)}`;
/** Fold keys for the two pinned sections. */
const NEEDS = '@needs';
const RUNNING = '@running';

export function Home({ state }: { state: State | null }) {
  const [host, setHost] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [grouping, setGrouping] = useState(readGrouping);
  const [newWorkspace, setNewWorkspace] = useState(() => opensWith('newworkspace'));
  const [newTab, setNewTab] = useState<StateWorkspace | null>(null);
  const [menu, setMenu] = useState<StateWorkspace | null>(null);
  const [rename, setRename] = useState<StateWorkspace | null>(null);
  const [close, setClose] = useState<StateWorkspace | null>(null);
  const [paneMenu, setPaneMenu] = useState<StatePane | null>(null);
  const [paneRename, setPaneRename] = useState<StatePane | null>(null);
  const [paneClose, setPaneClose] = useState<StatePane | null>(null);
  const [q, setQ] = useState('');
  // The Workspace this screen just created: it stays listed until State fills it with a
  // Pane, and scrolls itself into view the first time State carries it.
  const [created, setCreated] = useState<string | null>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const scrolled = useRef(false);
  const pal = usePal();

  const write = (next: string[]) => {
    setCollapsed(next);
    localStorage.setItem(COLLAPSED, JSON.stringify(next));
  };
  const toggle = (key: string) =>
    write(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
  const groupBy = (next: Grouping) => {
    setGrouping(next);
    localStorage.setItem(GROUPING, next);
  };

  useEffect(() => {
    const el = created && sections.current.get(created);
    if (!el || scrolled.current) return;
    scrolled.current = true;
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [state, created]);

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
  const needsYou = (state?.panes ?? []).filter((p) => visible(p.muxKey) && unseen(p) && (p.status === 'blocked' || p.status === 'done') && hit(p));
  /** Working Panes pinned beside Needs you, most recently changed first. */
  const running = (state?.panes ?? [])
    .filter((p) => visible(p.muxKey) && p.status === 'working' && hit(p))
    .sort((a, b) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0));
  const pinned = new Set([...needsYou, ...running].map((p) => p.key));
  const groups = (state?.workspaces ?? [])
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
  const folderGroups = (() => {
    const byFolder = new Map<
      string,
      { key: string; path: string; host?: State['hosts'][number]; all: StatePane[]; panes: StatePane[] }
    >();
    for (const pane of state?.panes ?? []) {
      if (!visible(pane.muxKey)) continue;
      const hostId = hostOf(pane.muxKey) ?? '';
      const path = pane.cwd ?? '';
      const key = folderFoldKey(hostId, path);
      const group = byFolder.get(key) ?? {
        key,
        path,
        host: state?.hosts.find((h) => h.id === hostId),
        all: [],
        panes: [],
      };
      group.all.push(pane);
      if (!pinned.has(pane.key) && hit(pane)) group.panes.push(pane);
      byFolder.set(key, group);
    }
    return [...byFolder.values()]
      .map((group) => ({ ...group, all: group.all.sort(comparePanes), panes: group.panes.sort(comparePanes) }))
      .filter((group) => group.panes.length > 0 || (!needle && group.all.length > 0));
  })();
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
  // Collapse all folds the pinned sections with the active grouping; the two only exist
  // when they hold rows, which is exactly when folding them means something.
  const groupKeys = grouping === 'workspace' ? groups.map((g) => g.w.key) : folderGroups.map((g) => g.key);
  const keys = [...groupKeys, ...(needsYou.length ? [NEEDS] : []), ...(running.length ? [RUNNING] : [])];
  const allShut = keys.length > 0 && keys.every((k) => collapsed.includes(k));
  const rowActions = (p: StatePane): RowActions | undefined =>
    writable(p.muxKey) ? { onMenu: setPaneMenu, onRename: setPaneRename, onClose: setPaneClose } : undefined;

  return (
    <div className="mx-auto max-w-2xl pb-28">
      <TopBar
        title="tautan"
        right={
          <>
            <span className="mr-1.5 text-caption tabular-nums text-muted">{counts}</span>
            {state && keys.length > 0 && (
              <IconButton
                size={40}
                label={allShut ? 'Expand all' : 'Collapse all'}
                onClick={() => write(allShut ? collapsed.filter((k) => !keys.includes(k)) : [...new Set([...collapsed, ...keys])])}
                icon={allShut ? <ExpandAll size={18} /> : <CollapseAll size={18} />}
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
            <div className="px-4 pb-2">
              <SearchInput
                value={q}
                onChange={setQ}
                placeholder="Search panes"
                shortcut={null}
                style={{ width: '100%', height: 40 }}
              />
            </div>
          ) : undefined
        }
      />

      {state && state.hosts.length > 1 && (
        <div role="group" aria-label="Filter by Host" className="hscroll flex gap-2 px-4 pt-1.5 pb-0.5">
          {[{ id: null, label: 'All', online: true }, ...state.hosts].map((h) => (
            <Chip key={h.id ?? 'all'} selected={host === h.id} onToggle={() => setHost(h.id)}>
              {h.label}
            </Chip>
          ))}
        </div>
      )}

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
      ) : needsYou.length === 0 && running.length === 0 && groups.length === 0 ? (
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
              <PinnedHeader label="Needs you" count={needsYou.length} open={openSection(NEEDS)} onToggle={() => toggle(NEEDS)} />
              {openSection(NEEDS) && (
                <ul>
                  {needsYou.map((p, i) => (
                    <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} context={wsLabel(p)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {running.length > 0 && (
            <section>
              <PinnedHeader label="Running" count={running.length} open={openSection(RUNNING)} onToggle={() => toggle(RUNNING)} />
              {openSection(RUNNING) && (
                <ul>
                  {running.map((p, i) => (
                    <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} context={wsLabel(p)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          <div role="group" aria-label="Group panes by" className="flex justify-end px-4 pt-3">
            <div className="w-52">
              <SegmentedControl
                options={['Workspace', 'Folder']}
                value={grouping === 'workspace' ? 'Workspace' : 'Folder'}
                onChange={(value: string) => groupBy(value === 'Folder' ? 'folder' : 'workspace')}
              />
            </div>
          </div>

          {grouping === 'workspace'
            ? groups.map(({ w, host: h, panes, all }) => {
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
                      summary={summary(all)}
                      open={!shut}
                      onToggle={() => toggle(w.key)}
                      onMenu={() => setMenu(w)}
                    />
                    {!shut && (
                      <ul>
                        {panes.map((p, i) => (
                          <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} />
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
              })
            : folderGroups.map(({ key, path, host: h, panes, all }) => {
                const shut = collapsed.includes(key);
                return (
                  <section key={key}>
                    <GroupHeader
                      label={basename(path) || path || 'Unknown folder'}
                      secondary={path || 'No directory reported'}
                      host={h?.label}
                      summary={summary(all)}
                      open={!shut}
                      onToggle={() => toggle(key)}
                    />
                    {!shut && (
                      <ul>
                        {panes.map((p, i) => (
                          <Row key={p.key} pane={p} first={i === 0} actions={rowActions(p)} context={wsLabel(p)} />
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
        </>
      )}

      <NewWorkspaceSheet
        open={newWorkspace}
        onClose={() => setNewWorkspace(false)}
        cwd={parentDir(beside?.cwd)}
        onSubmit={createWorkspace}
      />
      <NewTabSheet
        open={tabIn !== null}
        onClose={() => setNewTab(null)}
        cwd={tabIn?.cwd}
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
        onClose={() => setMenu(null)}
        items={[
          ...(writable(menu?.muxKey)
            ? [
                { label: 'New Tab', onClick: () => setNewTab(menu) },
                { label: 'Rename', onClick: () => setRename(menu) },
                { label: 'Close Workspace', danger: true, onClick: () => menu && setClose(menu) },
              ]
            : []),
          { label: 'Diff', onClick: () => menu && navigate(`#/diff/${encodeURIComponent(menu.key)}`) },
          { label: collapsed.includes(menu?.key ?? '') ? 'Expand' : 'Collapse', onClick: () => menu && toggle(menu.key) },
        ]}
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
      <MenuSheet
        open={paneMenu !== null}
        title={paneMenu?.title ?? ''}
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
