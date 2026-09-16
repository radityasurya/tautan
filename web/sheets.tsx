import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Toggle } from './hosts.tsx';
import { AlertDialog, Button, Caption, Chip, Sheet as KitSheet, TextInput, usePal } from './halaska-kit';

// One kit surface for every sheet: Halaska's side panel, with the title row it brings.
// The forms inside are kit inputs (controlled), so a sheet is state, not FormData.

/**
 * The write contract is unchanged from the vaul era: `onSubmit` may return a Promise. The
 * sheet closes when it resolves and shows the reason when it rejects, so a failed write
 * never loses what was typed.
 */
type Submit<T> = (value: T) => void | Promise<void>;

export function useWrite<T>(open: boolean, run: Submit<T>, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const last = useRef<{ value: T } | null>(null);
  const gen = useRef(0); // ponytail: bumped on close so a stale promise can't touch the reopened sheet

  // A reopened sheet starts clean, whatever the last attempt did.
  useEffect(() => {
    if (!open) {
      gen.current++;
      setBusy(false);
      setError('');
    }
  }, [open]);

  const submit = (value: T) => {
    const at = gen.current;
    last.current = { value };
    setBusy(true);
    setError('');
    Promise.resolve(run(value)).then(
      () => {
        if (gen.current !== at) return;
        setBusy(false);
        onClose();
      },
      (e: unknown) => {
        if (gen.current !== at) return;
        setBusy(false);
        setError((e instanceof Error && e.message) || 'network');
      },
    );
  };

  return {
    busy,
    error,
    submit,
    retry: () => {
      if (last.current) submit(last.current.value);
    },
  };
}

/**
 * The kit Sheet, sized for a phone: full height, scrollable inside, and the meta line
 * (the "in tautan · mbp" context) under the title where the kit's header row leaves room.
 * The kit keeps a closed panel mounted and focusable off-screen, so the wrapper mounts
 * on open and unmounts once the slide-out has played; content unmounts immediately.
 */
export function Sheet({
  open,
  title,
  meta,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
    else {
      const t = setTimeout(() => setMounted(false), 450);
      return () => clearTimeout(t);
    }
  }, [open]);
  if (!mounted) return null;
  return (
    <KitSheet open={open} onClose={onClose} title={title}>
      {open && (
        <>
          {meta && (
            <div style={{ marginTop: -14, marginBottom: 14 }}>
              <Caption>{meta}</Caption>
            </div>
          )}
          <div style={{ maxHeight: 'calc(100dvh - 120px)', overflowY: 'auto', overscrollBehavior: 'contain' }}>{children}</div>
        </>
      )}
    </KitSheet>
  );
}

/** The error codes the Hub sends, in words. Anything else is shown with its code. */
const WHY: Record<string, string> = {
  network: 'No connection to the Hub',
  body: 'Check the name and the directory',
  unsupported: 'This Mux does not support that',
  'mux not found': 'Mux is gone',
  'pane not found': 'Pane is gone',
  'workspace not found': 'Workspace is gone',
  agent_not_ready: 'Agent did not start',
  target: 'Enter a target like user@host',
  hosts: 'Check the SSH target',
  login: 'That login is not the one this request carries',
};
const why = (code: string) => WHY[code] ?? `That did not work · ${code}`;

export function ErrorLine({ error, busy, onRetry }: { error: string; busy: boolean; onRetry: () => void }) {
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: usePal().danger }}>{why(error)}</span>
      <Button variant="ghost" size="sm" onClick={onRetry} disabled={busy}>
        Retry
      </Button>
    </div>
  );
}

/** A list of actions, from the ⋯ button and from a long-press. */
export function MenuSheet({
  open,
  title,
  onClose,
  items,
  head,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  items: { label: string; onClick?: () => void; hint?: string; sub?: string; danger?: boolean; disabled?: boolean }[];
  /** Anything the menu shows before its rows, such as the Pane sheet's theme picker. */
  head?: ReactNode;
}) {
  const pal = usePal();
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {head && <div style={{ marginBottom: 12 }}>{head}</div>}
      <div>
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              gap: 12,
              minHeight: 48,
              padding: '6px 2px',
              background: 'transparent',
              border: 'none',
              borderTop: `1px solid ${pal.borderSubtle}`,
              textAlign: 'left',
              cursor: it.disabled ? 'default' : 'pointer',
              fontSize: 15,
              fontFamily: 'inherit',
              color: it.danger ? pal.danger : pal.text,
              opacity: it.disabled ? 0.4 : 1,
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block' }}>{it.label}</span>
              {/* Where a setting's value came from, in the same place a Toggle says it. */}
              {it.sub && (
                <span style={{ display: 'block', marginTop: 2, fontSize: 12, color: pal.textTertiary }}>{it.sub}</span>
              )}
            </span>
            {it.hint && (
              <span style={{ fontFamily: 'var(--halaska-mono, Geist Mono), monospace', fontSize: 12, color: pal.textTertiary }}>{it.hint}</span>
            )}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/** One chip per agent plus "shell only". `selected` is the Agent this Workspace mostly
 *  runs, `''` for shell; an Agent the chips do not list falls back to shell. */
function AgentChips({ agents, selected = '', onPick }: { agents: string[]; selected?: string; onPick: (a: string) => void }) {
  const on = agents.includes(selected) ? selected : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Caption>Start</Caption>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {[...agents, ''].map((a) => (
          <Chip key={a || 'shell'} selected={a === on} onToggle={() => onPick(a)}>
            {a ? `✻ ${a}` : 'shell only'}
          </Chip>
        ))}
      </div>
    </div>
  );
}

export function NewTabSheet({
  open,
  onClose,
  onSubmit,
  where,
  cwd,
  agent,
  agents = ['claude', 'pi', 'codex'],
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: Submit<{ label?: string; cwd?: string; agent?: string }>;
  where?: ReactNode;
  cwd?: string;
  agent?: string;
  agents?: string[];
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [label, setLabel] = useState('');
  const [dir, setDir] = useState('');
  const [pick, setPick] = useState('');
  useEffect(() => {
    if (open) {
      setLabel('');
      setDir(cwd ?? '');
      setPick(agent ?? '');
    }
  }, [open, cwd, agent]);
  return (
    <Sheet open={open} title="New Tab" meta={where} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput value={label} onChange={setLabel} label="Label" placeholder="Optional" />
        <TextInput
          value={dir}
          onChange={setDir}
          label="Directory"
          placeholder="/home/user/projects/tautan"
        />
        <AgentChips agents={agents} selected={pick} onPick={setPick} />
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <Button variant="primary" size="lg" fullWidth loading={busy} onClick={() => submit({ label: label.trim() || undefined, cwd: dir.trim() || undefined, agent: pick || undefined })}>
          {busy ? 'Creating…' : 'Create tab'}
        </Button>
      </div>
    </Sheet>
  );
}

export function NewWorkspaceSheet({
  open,
  onClose,
  onSubmit,
  cwd,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: Submit<{ cwd: string; label?: string; branch?: string }>;
  cwd?: string;
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [dir, setDir] = useState('');
  const [label, setLabel] = useState('');
  const [branch, setBranch] = useState('');
  const [worktree, setWorktree] = useState(false);
  useEffect(() => {
    if (open) {
      setDir(cwd ?? '');
      setLabel('');
      setBranch('');
      setWorktree(false);
    }
  }, [open, cwd]);

  return (
    <Sheet open={open} title="New Workspace" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput value={dir} onChange={setDir} label="Directory" placeholder="/home/user/projects/tautan" />
        <TextInput value={label} onChange={setLabel} label="Label" placeholder="Optional" />
        {/* A branch only means something with the switch on, so the field arrives with it. */}
        <Toggle label="As git worktree" hint="Checks the branch out beside the directory" checked={worktree} onChange={setWorktree} />
        {worktree && <TextInput value={branch} onChange={setBranch} label="Branch" placeholder="feature/tabs" />}
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={busy}
          disabled={!dir.trim() || (worktree && !branch.trim())}
          onClick={() => submit({ cwd: dir.trim(), label: label.trim() || undefined, branch: worktree ? branch.trim() : undefined })}
        >
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
      </div>
    </Sheet>
  );
}

export function RenameSheet({
  open,
  onClose,
  onSubmit,
  current,
  kind,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: Submit<string>;
  current: string;
  kind: 'Workspace' | 'Tab' | 'Pane';
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName(current);
  }, [open]); // current as it was when the sheet opened; typing is never clobbered
  return (
    <Sheet open={open} title={`Rename ${kind}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput value={name} onChange={setName} label="Name" placeholder="Name" />
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <Button variant="primary" size="lg" fullWidth loading={busy} disabled={!name.trim()} onClick={() => submit(name.trim())}>
          {busy ? 'Renaming…' : 'Rename'}
        </Button>
      </div>
    </Sheet>
  );
}

/** A destructive confirm: the kit AlertDialog, which no swipe can dismiss. The write
 *  runs on Confirm; the dialog closes either way, and a failed close leaves the row in
 *  place, so acting again is the retry. */
export function ConfirmCloseSheet({
  open,
  onClose,
  onConfirm,
  title,
  kind = 'Pane',
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: Submit<void>;
  title: string;
  kind?: 'Pane' | 'Workspace';
}) {
  return (
    <AlertDialog
      open={open}
      onClose={onClose}
      variant="danger"
      title={`Close ${kind}`}
      description={`Close “${title}”? ${
        kind === 'Workspace' ? 'The Workspace and everything running in it stops.' : 'The Pane and anything running in it stops.'
      }`}
      confirmLabel="Close"
      cancelLabel="Cancel"
      onConfirm={() => void onConfirm()}
    />
  );
}

