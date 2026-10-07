import { useEffect, useState } from 'react';

import type { StatePane, StateTab, StateWorkspace } from '../shared/types.ts';
import { Button } from './halaska-kit';
import { MenuSheet, Sheet, ErrorLine } from './sheets.tsx';

/** One Resize step on the phone (ADR 0008): whole cells, the direction the Pane grows. */
export const RESIZE_STEP = 5;

type Dir = 'left' | 'right' | 'up' | 'down';
const DIRS: { dir: Dir; label: string }[] = [
  { dir: 'left', label: 'Grow left' },
  { dir: 'right', label: 'Grow right' },
  { dir: 'up', label: 'Grow up' },
  { dir: 'down', label: 'Grow down' },
];

/** Where "Move to…" can put a Pane: another Tab on the same Mux, a new Tab, or a new Workspace. */
export function MoveSheet({
  open,
  onClose,
  tab,
  tabs,
  workspaces,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  /** the Pane's own Tab, left out of the list */
  tab?: StateTab;
  /** every Tab on the Pane's Mux */
  tabs: StateTab[];
  workspaces: StateWorkspace[];
  onMove: (to: { tab: string } | { newTab: true } | { newWorkspace: true }) => void;
}) {
  const label = (id: string) => workspaces.find((w) => w.id === id)?.label ?? '';
  return (
    <MenuSheet
      open={open}
      title="Move to…"
      meta="This Pane leaves its Tab"
      onClose={onClose}
      items={[
        { label: 'New Tab', hint: 'in this Workspace', group: 'New', onClick: () => onMove({ newTab: true }) },
        { label: 'New Workspace', group: 'New', onClick: () => onMove({ newWorkspace: true }) },
        // Below the Pane it joins: a phone is taller than wide, so stacking fits.
        ...tabs
          .filter((t) => t.key !== tab?.key)
          .map((t) => ({ label: t.label, sub: 'below its Panes', group: label(t.workspaceId) || 'Tabs', onClick: () => onMove({ tab: t.key }) })),
      ]}
    />
  );
}

/** Swap with another Pane of the same Tab. */
export function SwapSheet({
  open,
  onClose,
  panes,
  onSwap,
}: {
  open: boolean;
  onClose: () => void;
  /** the Tab's other Panes */
  panes: StatePane[];
  onSwap: (target: string) => void;
}) {
  return (
    <MenuSheet
      open={open}
      title="Swap with…"
      meta="The two Panes trade places"
      onClose={onClose}
      items={panes.map((p) => ({ label: p.title, sub: `${p.agent ?? 'shell'} · ${p.status}`, onClick: () => onSwap(p.key) }))}
    />
  );
}

/**
 * Four steps of RESIZE_STEP cells. The sheet stays open between steps, because a divider
 * rarely lands in one; each step is one write, and a failed one shows its reason in place.
 */
export function ResizeSheet({ open, onClose, onResize }: { open: boolean; onClose: () => void; onResize: (dir: Dir, amount: number) => Promise<void> }) {
  const [busy, setBusy] = useState<Dir | null>(null);
  const [error, setError] = useState('');
  const [last, setLast] = useState<Dir | null>(null);
  useEffect(() => {
    if (!open) {
      setBusy(null);
      setError('');
    }
  }, [open]);
  const step = (dir: Dir) => {
    setBusy(dir);
    setLast(dir);
    setError('');
    onResize(dir, RESIZE_STEP).then(
      () => setBusy(null),
      (e: unknown) => {
        setBusy(null);
        setError((e instanceof Error && e.message) || 'network');
      },
    );
  };
  return (
    <Sheet open={open} title="Resize" meta={`${RESIZE_STEP} cells a step.`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div role="group" aria-label="Grow the Pane" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {DIRS.map(({ dir, label }) => (
            <Button key={dir} variant="outline" size="lg" fullWidth disabled={busy !== null} loading={busy === dir} onClick={() => step(dir)}>
              {label}
            </Button>
          ))}
        </div>
        {error && last && <ErrorLine error={error} busy={busy !== null} onRetry={() => step(last)} />}
        <Button variant="ghost" size="lg" fullWidth onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
