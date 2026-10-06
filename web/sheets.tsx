import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, ReactNode } from 'react';

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
 * `flush` hands the body to the child: no scroll wrapper, so it can bleed to the panel's
 * edges (`FLUSH_BODY`) and pin its own top over its own scroller.
 */
export function Sheet({
  open,
  title,
  meta,
  onClose,
  flush,
  children,
}: {
  open: boolean;
  title: string;
  meta?: ReactNode;
  onClose: () => void;
  flush?: boolean;
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
          {flush ? (
            children
          ) : (
            <div style={{ maxHeight: 'calc(100dvh - 120px)', overflowY: 'auto', overscrollBehavior: 'contain' }}>{children}</div>
          )}
        </>
      )}
    </KitSheet>
  );
}

/**
 * A `flush` body: undoes the kit panel's 24 px padding on the sides and the bottom, and
 * fills the height under the kit's title row (24 padding + 32 row + 20 gap = 76 px).
 * ponytail: tied to the kit's Sheet metrics; measure the title row if the kit changes them.
 */
export const FLUSH_BODY = { margin: '0 -24px -24px', height: 'calc(100dvh - 76px)' } as const;

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

const WORKTREE_ADJECTIVES = ['bold', 'bright', 'calm', 'clever', 'quick', 'solar', 'steady', 'swift'];
const WORKTREE_NOUNS = ['badger', 'comet', 'falcon', 'maple', 'otter', 'river', 'sable', 'willow'];

function suggestedWorktreeBranch() {
  const random = crypto.getRandomValues(new Uint16Array(3));
  return `worktree/${WORKTREE_ADJECTIVES[random[0]! % WORKTREE_ADJECTIVES.length]!}-${WORKTREE_NOUNS[random[1]! % WORKTREE_NOUNS.length]!}-${random[2]!.toString(16).padStart(4, '0')}`;
}

function workspaceLabel(branch: string) {
  const name = branch.startsWith('worktree/') ? branch.slice('worktree/'.length) : branch;
  const label = name.replaceAll('-', ' ');
  return label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : 'Optional';
}

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

/** A menu row runs edge to edge like a Switch row; the inset is its own padding. */
const MENU_ROW = 'flex min-h-12 w-full items-center gap-3 px-6 py-1.5 text-left';
/** A menu section heading: the Settings small caps, inset like the rows. */
const MENU_HEADING = 'px-6 pt-3 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  hint?: string;
  sub?: string;
  danger?: boolean;
  disabled?: boolean;
  /** A small heading over this row and the ones after it that share it. */
  group?: string;
}

/** `Wrap: on` → `['Wrap', true]`: a setting row, drawn with a switch instead of the word. */
// ponytail: read from the label, so callers keep passing one string; add an `on` field to
// MenuItem if a setting ever needs a label that does not end in `: on` / `: off`.
const setting = (label: string) => {
  const m = /^(.+): (on|off)$/.exec(label);
  return m ? ([m[1]!, m[2] === 'on'] as const) : undefined;
};

function MenuRow({ it, onClose }: { it: MenuItem; onClose: () => void }) {
  const toggle = setting(it.label);
  // A hint with words is a sentence and goes under the label; a bare value (`80×24`) sits right.
  const aside = it.hint && !/\s/.test(it.hint) ? it.hint : undefined;
  const sub = it.sub ?? (aside ? undefined : it.hint);
  return (
    <li>
      <button
        type="button"
        disabled={it.disabled}
        {...(toggle ? { role: 'switch', 'aria-checked': toggle[1] } : {})}
        onClick={() => {
          it.onClick?.();
          onClose();
        }}
        className={`${MENU_ROW} text-body outline-none focus-visible:bg-bg focus-visible:shadow-[inset_2px_0_0_var(--accent)] disabled:cursor-default disabled:opacity-40 ${
          it.danger ? 'text-danger' : 'text-fg'
        } ${it.disabled ? '' : 'hover:bg-bg active:bg-bg'}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {toggle ? toggle[0] : it.label}
            {/* The word stays in the text for screen readers and for getByText; the switch shows it. */}
            {toggle && <span className="sr-only">: {toggle[1] ? 'on' : 'off'}</span>}
          </span>
          {/* Where a setting's value came from, in the same place a Toggle says it. */}
          {sub && <span className="mt-0.5 block text-caption text-muted">{sub}</span>}
        </span>
        {aside && <span className="shrink-0 font-mono text-caption tabular-nums text-muted">{aside}</span>}
        {toggle && (
          <span
            aria-hidden
            className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 ${toggle[1] ? 'bg-accent' : 'bg-border'}`}
          >
            <span
              className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow-sm transition-[left] duration-150 motion-reduce:transition-none ${
                toggle[1] ? 'left-[16px]' : 'left-0.5'
              }`}
            />
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * A list of actions, from the ⋯ button and from a long-press. The same frame as the Switch
 * drawer: the title, the context line and `head` stay put; one full-width list scrolls under
 * them. Rows group under their `group` heading in the order given, and the destructive ones
 * always come last, apart, whatever order the caller listed them in.
 */
export function MenuSheet({
  open,
  title,
  meta,
  onClose,
  items,
  head,
}: {
  open: boolean;
  title: string;
  /** One line of context under the title, such as the Host or the Agent and its Status. */
  meta?: ReactNode;
  onClose: () => void;
  items: MenuItem[];
  /** Anything the menu shows before its rows, such as the Pane sheet's theme picker. */
  head?: ReactNode;
}) {
  const sections: { group?: string; rows: MenuItem[] }[] = [];
  for (const it of items.filter((i) => !i.danger)) {
    const last = sections.at(-1);
    if (last && last.group === it.group) last.rows.push(it);
    else sections.push({ group: it.group, rows: [it] });
  }
  const danger = items.filter((i) => i.danger);
  return (
    <Sheet open={open} title={title} onClose={onClose} flush>
      <div className="flex flex-col" style={FLUSH_BODY}>
        <div className={`shrink-0 border-b border-border px-6 ${meta || head ? 'pb-3' : ''}`}>
          {/* Pulled up under the kit's title row, the same place Sheet puts its meta. */}
          {meta && (
            <div className="-mt-3.5 truncate">
              <Caption>{meta}</Caption>
            </div>
          )}
          {head && <div className={meta ? 'mt-3' : ''}>{head}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-1.5 pb-6" style={{ scrollbarGutter: 'stable' }}>
          {sections.map((sec, i) => (
            <section key={sec.group ?? i} className={i > 0 && !sec.group ? 'mt-1.5 border-t border-border/60 pt-1.5' : ''}>
              {sec.group && <h3 className={MENU_HEADING}>{sec.group}</h3>}
              <ul>
                {sec.rows.map((it) => (
                  <MenuRow key={it.label} it={it} onClose={onClose} />
                ))}
              </ul>
            </section>
          ))}
          {danger.length > 0 && (
            <ul className={sections.length ? 'mt-1.5 border-t border-border/60 pt-1.5' : ''}>
              {danger.map((it) => (
                <MenuRow key={it.label} it={it} onClose={onClose} />
              ))}
            </ul>
          )}
        </div>
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
  const [selectSuggestedBranch, setSelectSuggestedBranch] = useState(false);
  useEffect(() => {
    if (open) {
      setDir(cwd ?? '');
      setLabel('');
      setBranch('');
      setWorktree(false);
      setSelectSuggestedBranch(false);
    }
  }, [open, cwd]);

  return (
    <Sheet open={open} title="New Workspace" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput value={dir} onChange={setDir} label="Directory" placeholder="/home/user/projects/tautan" />
        <TextInput value={label} onChange={setLabel} label="Label" placeholder={workspaceLabel(branch)} />
        {/* A branch only means something with the switch on, so the field arrives with it. */}
        <Toggle
          label="As git worktree"
          hint="Checks the branch out beside the directory"
          checked={worktree}
          onChange={(next) => {
            if (next && !branch) {
              setBranch(suggestedWorktreeBranch());
              setSelectSuggestedBranch(true);
            }
            setWorktree(next);
          }}
        />
        {worktree && (
          <TextInput
            value={branch}
            onChange={setBranch}
            label="Branch"
            placeholder="feature/tabs"
            autoFocus={selectSuggestedBranch}
            onFocus={(event: FocusEvent<HTMLInputElement>) => {
              if (selectSuggestedBranch) event.currentTarget.select();
              setSelectSuggestedBranch(false);
            }}
          />
        )}
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

/** A destructive confirm: the kit AlertDialog, which no swipe can dismiss. A refused
 *  write briefly closes it, then reopens with the Hub's reason and the right retry. */
export function ConfirmCloseSheet({
  open,
  onClose,
  onConfirm,
  title,
  kind = 'Pane',
  cost,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: Submit<void>;
  title: string;
  kind?: 'Pane' | 'Tab' | 'Workspace';
  cost?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [overruled, setOverruled] = useState(false);
  const pending = useRef(false);
  const gen = useRef(0);
  useEffect(() => {
    if (!open) {
      gen.current++;
      pending.current = false;
      setBusy(false);
      setError('');
      setOverruled(false);
    }
  }, [open]);

  const recoverable = /dirty_worktree_requires_force|dirty (?:checkout|worktree)|modified or untracked files|uncommitted (?:changes|files)|agents?.*\brunning\b|\brunning agents?\b/i.test(error);
  const consequence =
    kind === 'Workspace'
      ? 'The Workspace and everything running in it stops.'
      : kind === 'Tab'
        ? 'Every Pane in the Tab stops.'
        : 'The Pane and anything running in it stops.';
  const submit = (anyway: boolean) => {
    const at = gen.current;
    pending.current = true;
    setBusy(true);
    setError('');
    if (anyway) setOverruled(true);
    Promise.resolve()
      .then(onConfirm)
      .then(
        () => {
          if (gen.current !== at) return;
          pending.current = false;
          setBusy(false);
          onClose();
        },
        (e: unknown) => {
          if (gen.current !== at) return;
          pending.current = false;
          setBusy(false);
          setError((e instanceof Error && e.message) || 'network');
        },
      );
  };

  return (
    <AlertDialog
      open={open && !busy}
      onClose={() => {
        if (!pending.current) onClose();
      }}
      variant="danger"
      title={`Close ${kind}`}
      description={error || `Close “${title}”? ${cost || consequence}`}
      confirmLabel={error ? (recoverable && !overruled ? 'Close anyway' : 'Retry') : 'Close'}
      cancelLabel="Cancel"
      onConfirm={() => submit(recoverable && !overruled)}
    />
  );
}

