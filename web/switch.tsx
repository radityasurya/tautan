import { useState, type ReactNode } from 'react';
import type { State, StatePane } from '../shared/types.ts';
import { FLUSH_BODY, Sheet } from './sheets.tsx';
import { navigate } from './app.tsx';
import { Dot, matchPane, timeAgo, unseen } from './home.tsx';
import { Chip, SearchInput } from './halaska-kit';

/** A Switch row runs edge to edge; the inset is its own padding, so the scroller has none. */
export const SWITCH_ROW = 'flex min-h-11 w-full items-center gap-2.5 px-6 text-left';
/** A Switch section heading, inset like the rows. */
export const SWITCH_HEADING = 'label-caps px-6 pt-3.5 pb-1';

/** One Pane row, shared by every section: dot, agent, title, and how long ago it changed. */
function PaneRow({ pane, currentKey, onPick }: { pane: StatePane; currentKey: string; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          navigate(`#/pane/${encodeURIComponent(pane.key)}`);
          onPick();
        }}
        aria-current={pane.key === currentKey ? 'true' : undefined}
        className={`${SWITCH_ROW} ${pane.key === currentKey ? 'bg-muted/20' : 'hover:bg-bg active:bg-bg'}`}
      >
        <Dot status={pane.status} seen={!unseen(pane)} />
        <span className="shrink-0 text-body text-muted">{pane.agent ?? 'shell'}</span>
        <span className="min-w-0 flex-1 truncate text-body">{pane.title}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{timeAgo(pane.statusChangedAt)}</span>
      </button>
    </li>
  );
}

/**
 * Two taps to any Pane on any Host: search, Host chips, then the same shape Home uses —
 * Needs you first, Running under it, everything else grouped by Workspace. Opened from the
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

  const hostOf = (muxKey: string) => state?.muxes.find((m) => m.key === muxKey)?.hostId;
  const needle = q.trim().toLowerCase();
  const pick = () => {
    onPick?.();
    onClose();
  };
  // One match rule with Home's search: agent, title, Workspace label.
  const matches = (state?.panes ?? []).filter((p) => (!host || hostOf(p.muxKey) === host) && matchPane(p, needle, state));

  // The same two pinned sections Home draws, over the whole Host-filtered list.
  const needsYou = matches.filter((p) => unseen(p) && (p.status === 'blocked' || p.status === 'done'));
  const running = matches
    .filter((p) => p.status === 'working')
    .sort((a, b) => (b.statusChangedAt ?? 0) - (a.statusChangedAt ?? 0));
  const rest = matches.filter((p) => !needsYou.includes(p) && p.status !== 'working');
  const groups = (state?.workspaces ?? [])
    .map((w) => {
      const mux = state?.muxes.find((m) => m.key === w.muxKey);
      return {
        w,
        mux,
        host: state?.hosts.find((h) => h.id === mux?.hostId),
        panes: rest.filter((p) => p.muxKey === w.muxKey && p.workspaceId === w.id),
      };
    })
    .filter((g) => g.panes.length > 0);
  return (
    <Sheet open={open} title={title} onClose={onClose} flush>
      {/* The search and the Host chips stay put; only the list under them scrolls. The
          gutter is reserved, so a scrollbar that comes and goes never moves the rows. */}
      <div className="flex flex-col" style={FLUSH_BODY}>
        <div className="shrink-0 border-b border-border px-6 pb-3">
          <SearchInput value={q} onChange={setQ} placeholder="Switch to…" shortcut={null} style={{ width: '100%' }} />

          <div role="group" aria-label="Filter by Host" className="hscroll mt-3 flex shrink-0 gap-2">
            {[{ id: null, label: 'All', online: true }, ...(state?.hosts ?? [])].map((h) => (
              <Chip key={h.id ?? 'all'} selected={host === h.id} onToggle={() => setHost(h.id)}>
                {h.label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-6" style={{ scrollbarGutter: 'stable' }}>
          {head && !needle && head}
          {matches.length === 0 && <p className="px-6 py-6 text-body text-muted">Nothing matches “{q}”.</p>}
          {needsYou.length > 0 && (
            <section>
              <h3 className={SWITCH_HEADING}>Needs you</h3>
              <ul>
                {needsYou.map((p) => (
                  <PaneRow key={p.key} pane={p} currentKey={currentKey} onPick={pick} />
                ))}
              </ul>
            </section>
          )}
          {running.length > 0 && (
            <section>
              <h3 className={SWITCH_HEADING}>Running</h3>
              <ul>
                {running.map((p) => (
                  <PaneRow key={p.key} pane={p} currentKey={currentKey} onPick={pick} />
                ))}
              </ul>
            </section>
          )}
          {groups.map(({ w, mux, host: h, panes }) => (
            <section key={w.key}>
              <h3 className={`${SWITCH_HEADING} flex`}>
                <span className="min-w-0 truncate">{w.label}</span>
                <span className="ml-1.5 shrink-0 font-medium tracking-normal normal-case text-muted">
                  · {h?.label}
                  {mux?.kind === 'tmux' && ' · tmux'}
                </span>
              </h3>
              <ul>
                {panes.map((p) => (
                  <PaneRow key={p.key} pane={p} currentKey={currentKey} onPick={pick} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
