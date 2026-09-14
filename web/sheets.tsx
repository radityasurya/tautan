import { useEffect, useRef, useState } from 'react';
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react';

import { Toggle } from './hosts.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx';

// One inset-control look and one primary button look for every sheet. The drawer surface
// is `--elevated`, so a field inset into it reads as `--bg`.
export const field =
  'min-h-11 w-full rounded-composer border border-border bg-bg px-3.5 text-body text-fg placeholder:text-muted';
export const primary =
  'flex h-12 w-full items-center justify-center rounded-composer bg-accent text-body font-semibold text-bg active:opacity-90';

export function Field({
  label,
  hint,
  className,
  ...input
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-caption text-muted">{label}</span>
      <input {...input} className={className ?? field} />
      {hint && <span className="text-caption text-muted">{hint}</span>}
    </label>
  );
}

/** Reads the trimmed value of a named field, or undefined when it is empty. */
const values = (form: HTMLFormElement) => {
  const data = new FormData(form);
  return (name: string) => String(data.get(name) ?? '').trim() || undefined;
};

// ---- writes ----
// Every write sheet works the same way: it stays open until the Hub answers, disables its
// action while the call is out, and prints one line with a Retry when the call fails.

/** The error codes the Hub sends, in words. Anything else is shown with its code. */
const WHY: Record<string, string> = {
  network: 'No connection to the Hub',
  body: 'Check the name and the directory',
  unsupported: 'This Mux does not support that',
  'mux not found': 'Mux is gone',
  'pane not found': 'Pane is gone',
  agent_not_ready: 'Agent did not start',
  target: 'Enter a target like user@host',
  hosts: 'Check the SSH target',
  login: 'That login is not the one this request carries',
};
const why = (code: string) => WHY[code] ?? `That did not work · ${code}`;

export function ErrorLine({ error, busy, onRetry }: { error: string; busy: boolean; onRetry: () => void }) {
  return (
    <p role="alert" className="-my-1 flex items-center gap-2 text-[13px] text-danger">
      <span className="min-w-0 flex-1">{why(error)}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        className="flex min-h-11 shrink-0 items-center px-1 font-medium text-accent disabled:opacity-50"
      >
        Retry
      </button>
    </p>
  );
}

/**
 * The submit contract: `onSubmit` may return a Promise. The sheet closes when it resolves
 * and shows the reason when it rejects, so a failed write never loses what was typed.
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
 * Bottom sheet: the shadcn Drawer (vaul). Swipe to dismiss, scroll lock, focus trap and
 * Escape all come from vaul; tautan only supplies the surface, the title and the meta line.
 * ponytail: `repositionInputs` is off because the viewport meta already asks the browser
 * for `interactive-widget=resizes-content`, which moves the drawer for us. Turn it back
 * on if a browser without that support ever hides a focused field behind the keyboard.
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
  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} repositionInputs={false}>
      {/* No description: every sheet is a titled form. Telling Radix so keeps it quiet. */}
      <DrawerContent aria-describedby={undefined}>
        <div className="flex items-center justify-between px-4 pt-1 pb-3.5">
          <DrawerTitle className="text-title tracking-tight">{title}</DrawerTitle>
          {meta && <span className="text-caption text-muted">{meta}</span>}
        </div>
        <div className="overflow-y-auto overscroll-contain px-4 pb-1">{children}</div>
      </DrawerContent>
    </Drawer>
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
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {head && <div className="-mx-4 pb-3">{head}</div>}
      <ul className="pb-2">
        {items.map((it) => (
          <li key={it.label}>
            <button
              type="button"
              disabled={it.disabled}
              onClick={() => {
                it.onClick?.();
                onClose();
              }}
              className={`flex min-h-12 w-full items-center gap-3 rounded-chip px-1 text-left text-body active:bg-surface disabled:opacity-40 ${
                it.danger ? 'text-danger' : 'text-fg'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{it.label}</span>
                {/* Where a setting's value came from, in the same place a Toggle says it. */}
                {it.sub && <span className="mt-px block text-caption text-muted">{it.sub}</span>}
              </span>
              {it.hint && <span className="font-mono text-caption text-muted">{it.hint}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

/**
 * One chip per agent plus "shell only", as radio inputs so the form still reads
 * `agent` from FormData. The chip is the label; the input stays screen-reader only.
 * `selected` is the Agent this Workspace mostly runs, `''` for shell; an Agent the chips
 * do not list falls back to shell rather than leaving nothing checked.
 */
function AgentChips({ agents, selected = '' }: { agents: string[]; selected?: string }) {
  const on = agents.includes(selected) ? selected : '';
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-caption text-muted">Start</legend>
      <div className="flex flex-wrap gap-2">
        {[...agents, ''].map((a) => (
          <label key={a || 'shell'} className="block">
            <input type="radio" name="agent" value={a} defaultChecked={a === on} className="peer sr-only" />
            <span className="flex items-center gap-1.5 rounded-chip border border-border bg-bg px-3.5 py-2 text-[13px] text-fg peer-checked:border-accent peer-checked:bg-accent peer-checked:font-semibold peer-checked:text-bg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
              {a && <span aria-hidden>✻</span>}
              {a || 'shell only'}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
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
  return (
    <Sheet open={open} title="New Tab" meta={where} onClose={onClose}>
      <form
        className="flex flex-col gap-3.5 pb-2"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const v = values(e.currentTarget);
          submit({ label: v('label'), cwd: v('cwd'), agent: v('agent') });
        }}
      >
        <Field label="Label" name="label" placeholder="Optional" />
        <Field
          label="Directory"
          name="cwd"
          defaultValue={cwd}
          placeholder="/home/user/projects/tautan"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`${field} font-mono text-[13px]`}
        />
        <AgentChips agents={agents} selected={agent} />
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <button type="submit" disabled={busy} className={`${primary} mt-1 disabled:opacity-60`}>
          {busy ? 'Creating…' : 'Create tab'}
        </button>
      </form>
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
  // A branch only means something with the switch on, so the field arrives with it.
  const [worktree, setWorktree] = useState(false);
  useEffect(() => {
    if (!open) setWorktree(false);
  }, [open]);

  return (
    <Sheet open={open} title="New Workspace" onClose={onClose}>
      <form
        className="flex flex-col gap-3.5 pb-2"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const v = values(e.currentTarget);
          submit({ cwd: v('cwd')!, label: v('label'), branch: worktree ? v('branch') : undefined });
        }}
      >
        <Field
          label="Directory"
          name="cwd"
          required
          defaultValue={cwd}
          placeholder="/home/user/projects/tautan"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`${field} font-mono text-[13px]`}
        />
        <Field label="Label" name="label" placeholder="Optional" />
        {/* Full-bleed, so the switch lines up with the field labels above it. */}
        <div className="-mx-4">
          <Toggle
            label="As git worktree"
            hint="Checks the branch out beside the directory"
            checked={worktree}
            onChange={setWorktree}
          />
        </div>
        {worktree && (
          <Field
            label="Branch"
            name="branch"
            required
            placeholder="feature/tabs"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        )}
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <button type="submit" disabled={busy} className={`${primary} mt-1 disabled:opacity-60`}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
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
  return (
    <Sheet open={open} title={`Rename ${kind}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3.5 pb-2"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          submit(values(e.currentTarget)('label')!);
        }}
      >
        <Field
          label="Name"
          name="label"
          required
          maxLength={80}
          defaultValue={current}
          autoCapitalize="none"
          autoCorrect="off"
        />
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <button type="submit" disabled={busy} className={`${primary} mt-1 disabled:opacity-60`}>
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </form>
    </Sheet>
  );
}

/** A destructive confirm is a Dialog, not a drawer: it must not be swipe-dismissible. */
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
  const { busy, error, submit, retry } = useWrite<void>(open, onConfirm, onClose);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {kind}</DialogTitle>
          <DialogDescription className="text-fg">Close “{title}”?</DialogDescription>
        </DialogHeader>
        <p className="mt-1 text-body text-muted">
          {kind === 'Workspace' ? 'The Workspace and everything running in it stops.' : 'The Pane and anything running in it stops.'}
        </p>
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 flex-1 rounded-chip bg-surface text-body font-medium active:opacity-90"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => submit(undefined)}
            className="min-h-11 flex-1 rounded-chip bg-danger text-body font-medium text-bg active:opacity-90 disabled:opacity-60"
          >
            {busy ? 'Closing…' : 'Close'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
