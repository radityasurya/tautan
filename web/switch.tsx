import { useState, type ReactNode } from 'react';
import type { State, StatePane } from '../shared/types.ts';
import { FLUSH_BODY, Sheet } from './sheets.tsx';
import { GroupHeader, matchPane, PinnedHeader, placeOf, Row, unseen } from './home.tsx';
import { orderWorkspaces, readOrder } from './order.ts';
import { agentRows, getAgentSort, getSpaceSort, sortSpaces, tildePath, usePref } from './spaces.ts';
import { Chip, SearchInput } from './halaska-kit';

/** A Switch row runs edge to edge; the inset is its own padding, so the scroller has none. */
export const SWITCH_ROW = 'flex min-h-11 w-full items-center gap-2.5 px-6 text-left';
/** A Switch section heading, inset like the rows, in the type of Home's sidebar headers. */
export const SWITCH_HEADING = 'mt-2 flex min-h-9 items-center px-6 text-[13px] font-semibold tracking-tight text-fg';

/** Fold keys for the two pinned sections, as Home names them. */
const NEEDS = '@needs';
const RUNNING = '@running';

/**
 * Two taps to any Pane on any Host, drawn with the desktop sidebar's own rows and headers on
 * every device — the sheet is 320 px wide, the sidebar's width: search, Host chips when there
 * are several, then Needs you, Running, and everything else grouped by Workspace with its path. Groups follow
 * the Spaces sort and rows the Agents sort, so the drawer reads in Home's order. A header
 * folds its section, a search opens every fold, and a pick closes the drawer. Opened from the
 * Pane status line. The Tab picker opens it at Tab level: `head` lists the Workspace's Tabs
 * above the Pane sections, and stays out of the way while a search is typed.
 */
export function SwitchDrawer({
  open,
  onClose,
  state,
  currentKey,
  onPick,
  title = 'Switch Pane',
  head,
}: {
  title?: string;
  head?: ReactNode;
  open: boolean;
  onClose: () => void;
  state: State | null;
  currentKey: string;
  onPick?: () => void;
}) {
  const [q, setQ] = useState('');
  const [host, setHost] = useState<string | null>(null);
  // ponytail: folds live as long as the Pane screen, not in localStorage like Home's; a
  // switcher that opens folded hides the Pane you came for.
  const [shut, setShut] = useState<string[]>([]);
  const spaceSort = usePref(getSpaceSort);
  const sort = usePref(getAgentSort);

  const hostOf = (muxKey: string) => state?.muxes.find((m) => m.key === muxKey)?.hostId;
  const needle = q.trim().toLowerCase();
  const pick = () => {
    onPick?.();
    onClose();
  };
  const toggle = (key: string) => setShut(shut.includes(key) ? shut.filter((k) => k !== key) : [...shut, key]);
  const unfolded = (key: string) => !!needle || !shut.includes(key);
  // One match rule with Home's search: agent, title, Workspace label.
  const hit = (p: StatePane) => matchPane(p, needle, state);
  const matches = (state?.panes ?? []).filter((p) => (!host || hostOf(p.muxKey) === host) && hit(p));

  // The same two pinned sections Home draws, over the whole Host-filtered list.
  const needsYou = agentRows(
    matches.filter((p) => unseen(p) && (p.status === 'blocked' || p.status === 'done')),
    { shells: true, unseen },
  );
  const running = matches
    .filter((p) => p.status === 'working')
    .sort((a, b) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0));
  const pinned = new Set([...needsYou, ...running]);
  const groups = sortSpaces(
    orderWorkspaces(state?.workspaces ?? [], readOrder())
      .filter((w) => !host || hostOf(w.muxKey) === host)
      .map((w) => ({ w, all: (state?.panes ?? []).filter((p) => p.muxKey === w.muxKey && p.workspaceId === w.id) })),
    { sort: spaceSort, unseen },
  )
    .map((g) => ({ ...g, panes: agentRows(g.all.filter((p) => !pinned.has(p) && hit(p)), { shells: true, unseen, sort }) }))
    .filter((g) => g.panes.length > 0);

  /** Home's rows. `place` names the Workspace on a row when no group header does. */
  const rows = (panes: StatePane[], place?: boolean) => (
    <ul>
      {panes.map((p, i) => (
        <Row
          key={p.key}
          pane={p}
          first={i === 0}
          context={place ? placeOf(p, state) : undefined}
          compact
          current={p.key === currentKey}
        />
      ))}
    </ul>
  );
  const many = (state?.hosts.length ?? 0) > 1;
  return (
    <Sheet open={open} title={title} onClose={onClose} flush>
      {/* The search and the Host chips stay put; only the list under them scrolls. The
          gutter is reserved, so a scrollbar that comes and goes never moves the rows. */}
      <div className="flex flex-col" style={FLUSH_BODY}>
        <div className="shrink-0 border-b border-border px-6 pb-3">
          <SearchInput value={q} onChange={setQ} placeholder="Switch to…" shortcut={null} style={{ width: '100%' }} />

          {many && (
            <div role="group" aria-label="Filter by Host" className="hscroll mt-3 flex shrink-0 gap-2">
              {[{ id: null, label: 'All', online: true }, ...(state?.hosts ?? [])].map((h) => (
                <Chip key={h.id ?? 'all'} selected={host === h.id} onToggle={() => setHost(h.id)}>
                  {h.label}
                </Chip>
              ))}
            </div>
          )}
        </div>

        {/* Home's rows are links, so a tap that reaches a link here is a pick; the rows run
            in the sheet's 24 px inset instead of Home's 16. */}
        <div
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-6 [--row-inset:1.5rem]"
          style={{ scrollbarGutter: 'stable' }}
          onClick={(e) => {
            if ((e.target as Element).closest('a')) pick();
          }}
        >
          {head && !needle && head}
          {matches.length === 0 && (
            <p className="px-6 py-6 text-body text-muted">{needle ? `Nothing matches “${q.trim()}”.` : 'No panes yet.'}</p>
          )}
          {needsYou.length > 0 && (
            <section>
              <PinnedHeader label="Needs you" count={needsYou.length} compact open={unfolded(NEEDS)} onToggle={() => toggle(NEEDS)} />
              {unfolded(NEEDS) && rows(needsYou, true)}
            </section>
          )}
          {running.length > 0 && (
            <section>
              <PinnedHeader label="Running" count={running.length} compact open={unfolded(RUNNING)} onToggle={() => toggle(RUNNING)} />
              {unfolded(RUNNING) && rows(running, true)}
            </section>
          )}
          {groups.map(({ w, all, panes }) => (
            <section key={w.key}>
              <GroupHeader
                label={w.label}
                host={state?.hosts.find((h) => h.id === hostOf(w.muxKey))?.label}
                path={w.cwd && tildePath(w.cwd)}
                panes={all}
                compact
                open={unfolded(w.key)}
                onToggle={() => toggle(w.key)}
              />
              {unfolded(w.key) && rows(panes)}
            </section>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
