import { useState } from 'react';
import type { State, StatePane } from '../shared/types.ts';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx';
import { navigate } from './app.tsx';
import { Dot, timeAgo, unseen } from './home.tsx';
import { Search } from './icons.tsx';

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
        className={`flex min-h-11 w-full items-center gap-2.5 rounded-chip px-3 text-left ${
          pane.key === currentKey ? 'bg-muted/20' : 'active:bg-bg'
        }`}
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
 * Pane status line.
 */
export function SwitchDrawer({
  open,
  onClose,
  state,
  currentKey,
  onPick,
}: {
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
  const matches = (state?.panes ?? []).filter((p) => {
    if (host && hostOf(p.muxKey) !== host) return false;
    if (!needle) return true;
    const w = state?.workspaces.find((item) => item.muxKey === p.muxKey && item.id === p.workspaceId);
    return `${p.agent ?? 'shell'} ${p.title} ${w?.label ?? ''}`.toLowerCase().includes(needle);
  });

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
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} repositionInputs={false}>
      <DrawerContent aria-describedby={undefined} className="h-[85dvh] max-h-[85dvh] px-3">
        <DrawerTitle className="sr-only">Switch Pane</DrawerTitle>

        <label className="mt-1 flex min-h-11 items-center gap-2.5 rounded-composer border border-border bg-bg px-3.5 text-muted">
          <Search />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Switch to…"
            aria-label="Switch to"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-body text-fg placeholder:text-muted focus:outline-none"
          />
        </label>

        <div role="group" aria-label="Filter by Host" className="hscroll mt-3 flex shrink-0 gap-2">
          {[{ id: null, label: 'All', online: true }, ...(state?.hosts ?? [])].map((h) => (
            <button
              key={h.id ?? 'all'}
              type="button"
              aria-pressed={host === h.id}
              onClick={() => setHost(h.id)}
              className={`shrink-0 rounded-chip px-3 py-1.5 text-caption ${
                host === h.id ? 'bg-accent font-semibold text-bg' : 'bg-bg font-medium text-muted'
              } ${h.online ? '' : 'line-through'}`}
            >
              {h.label}
            </button>
          ))}
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          {matches.length === 0 && <p className="px-3 py-6 text-body text-muted">Nothing matches “{q}”.</p>}
          {needsYou.length > 0 && (
            <section>
              <h3 className="label-caps px-3 pt-3.5 pb-1">Needs you</h3>
              <ul>
                {needsYou.map((p) => (
                  <PaneRow key={p.key} pane={p} currentKey={currentKey} onPick={pick} />
                ))}
              </ul>
            </section>
          )}
          {running.length > 0 && (
            <section>
              <h3 className="label-caps px-3 pt-3.5 pb-1">Running</h3>
              <ul>
                {running.map((p) => (
                  <PaneRow key={p.key} pane={p} currentKey={currentKey} onPick={pick} />
                ))}
              </ul>
            </section>
          )}
          {groups.map(({ w, mux, host: h, panes }) => (
            <section key={w.key}>
              <h3 className="label-caps flex px-3 pt-3.5 pb-1">
                {w.label}
                <span className="ml-1.5 font-medium tracking-normal normal-case text-muted">
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
      </DrawerContent>
    </Drawer>
  );
}
