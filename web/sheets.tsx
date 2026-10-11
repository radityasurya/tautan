import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FocusEvent, ReactNode, RefObject } from 'react';

import type { BranchList, PluginAction, PluginRun, State, Worktree } from '../shared/types.ts';
import { api, navigate } from './app.tsx';
import { Toggle } from './hosts.tsx';
import { actionsFor, appeared, byPlugin, keysIn, NEW_PANE_MS, type PaneWatch } from './plugins.ts';
import { FolderBrowser } from './folders.tsx';
import { basename } from './folders-logic.ts';
import { Check } from './icons.tsx';
import { tildePath } from './spaces.ts';
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

// ---- focus back to the opener (21.4.4) ----
// A tap does not focus a button on iOS Safari, so `document.activeElement` is the body when a
// sheet opens there. The opener is the element under the last press instead: the pointer's
// target, or the focused element for a key. A press on a row of a sheet that closed under it
// (⋯ › Rename) stands for that sheet's own opener, so the follow-up sheet gives focus back
// to the ⋯ button too.
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';
// ponytail: the last press, however old. Every sheet today opens from a press; if one ever
// opens on its own later, give `pressed` a timestamp and ignore a stale one.
let pressed: { el: HTMLElement; sheet: Element | null } | null = null;
const openers = new WeakMap<Element, RefObject<HTMLElement | null>>();
const press = (target: EventTarget | null) => {
  const el = target instanceof Element ? target.closest<HTMLElement>(FOCUSABLE) : null;
  pressed = el && { el, sheet: el.closest('[data-sheet]') };
};
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => press(e.target), true);
  document.addEventListener('keydown', () => press(document.activeElement), true);
}
const sheetOpener = (p: NonNullable<typeof pressed>) => (p.sheet && openers.get(p.sheet)?.current) || null;
const openerNow = () => (!pressed ? null : pressed.el.isConnected ? pressed.el : sheetOpener(pressed));
/**
 * For a dialog that is not a Sheet (Find in terminal): what it gives focus back to, read in
 * the click of the menu row that opens it. A row in a sheet stands for that sheet's opener.
 */
export const menuOpener = () => (pressed && (sheetOpener(pressed) ?? pressed.el)) || null;
/** Sheets opened so far, so a closing sheet can tell that a follow-up opened with it. */
let opened = 0;

/**
 * Gives focus back to the opener when `open` turns false, if it is still on the page and
 * nothing else took focus meanwhile (the next sheet's field). `root` is the sheet's own
 * element: focus inside it (the kit's ✕) still counts as nothing else. When a follow-up
 * sheet opens as this one closes (⋯ › Rename), focus waits for that one to close instead,
 * so Enter does not reopen the menu behind it.
 */
function useFocusBack(open: boolean, root?: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    opened++;
    const from = (opener.current = openerNow());
    return () => {
      const at = opened;
      // After the commit's other effects, where a follow-up sheet counts itself in.
      queueMicrotask(() => {
        const now = document.activeElement;
        if (opened !== at || !from?.isConnected) return;
        if (!now || now === document.body || root?.current?.contains(now)) from.focus({ preventScroll: true });
      });
    };
  }, [open]);
  return opener;
}

/**
 * The kit Sheet, sized for a phone: full height, scrollable inside, and the meta line
 * (the "in tautan · mbp" context) under the title where the kit's header row leaves room.
 * The kit keeps a closed panel mounted and focusable off-screen, so the wrapper mounts
 * on open and unmounts once the slide-out has played; content unmounts immediately.
 * `flush` hands the body to the child: no scroll wrapper, so it can bleed to the panel's
 * edges (`FLUSH_BODY`) and pin its own top over its own scroller.
 * Closing gives focus back to whatever opened it, on every sheet (`useFocusBack`).
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
  const root = useRef<HTMLDivElement | null>(null);
  const opener = useFocusBack(open, root);
  if (!mounted) return null;
  return (
    // No box of its own: it marks the sheet for `useFocusBack` and `openerNow`.
    <div
      data-sheet
      style={{ display: 'contents' }}
      ref={(el) => {
        root.current = el;
        if (el) openers.set(el, opener);
      }}
    >
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
    </div>
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
  timeout: 'git took too long, so tautan stopped waiting',
  branch: 'That branch is gone',
  'not-a-repo': 'Not a git repository',
  'unknown-workspace': 'Workspace is gone',
  'unknown-tab': 'Tab is gone',
  tab_move_failed: 'The order changed. Try again',
  workspace_move_failed: 'The order changed. Try again',
  worktree: 'That worktree is gone',
};
export const why = (code: string) => WHY[code] ?? `That did not work · ${code}`;

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

/**
 * herdr's plugin actions, for the Workspace ⋯ menu: asked each time that menu opens (`open`),
 * past the Hub's 30 s cache, so a plugin linked a moment ago is listed. The menu shows its row
 * when an action fits and hands the list to the sheet, which then does not ask again. Empty
 * until the Hub answers, and when it refuses (tmux answers 501).
 */
export function usePluginActions(paneKey: string | undefined, open: boolean): PluginAction[] {
  const [got, setGot] = useState<{ key: string; actions: PluginAction[] } | null>(null);
  const asked = useRef('');
  useEffect(() => {
    if (!paneKey || (!open && asked.current === paneKey)) return;
    asked.current = paneKey;
    let live = true;
    api<{ actions: PluginAction[] }>(`/api/panes/${encodeURIComponent(paneKey)}/actions?fresh=1`, undefined, 'GET').then(
      (r) => live && setGot({ key: paneKey, actions: r.actions }),
      () => live && setGot({ key: paneKey, actions: [] }),
    );
    return () => {
      live = false;
    };
  }, [paneKey, open]);
  return got && got.key === paneKey ? got.actions : [];
}

const actionKey = (a: PluginAction) => `${a.pluginId}/${a.actionId}`;

/** What went wrong with a run: a line in the danger tint, and herdr's own text under it. */
interface Trouble {
  head: string;
  detail?: string;
}

// ---- the notice for a run that ended after its sheet closed (21.4.1) ----
// ponytail: one notice at a time, the newest wins; a queue if runs ever overlap.
let notice: Trouble | null = null;
const noticeListeners = new Set<() => void>();
const setNotice = (next: Trouble | null) => {
  notice = next;
  noticeListeners.forEach((fn) => fn());
};
const NOTICE_MS = 8_000;

/**
 * A plugin action that failed after its sheet closed, at the top of the screen where the
 * NeedsCard shows: what failed, then herdr's text. It goes after NOTICE_MS, or on ×.
 */
export function RunNotice() {
  const shown = useSyncExternalStore(
    (fn) => {
      noticeListeners.add(fn);
      return () => void noticeListeners.delete(fn);
    },
    () => notice,
  );
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [shown]);
  return (
    <div role="alert" className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-[60] flex justify-center p-2">
      {shown && (
        <div className="pointer-events-auto flex w-full max-w-md items-start gap-1 rounded-card bg-elevated py-2.5 pl-3.5 shadow-elevated">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-[13px] font-semibold text-danger">{shown.head}</p>
            {shown.detail && <p className="font-mono text-[11.5px] leading-normal break-words text-muted">{shown.detail}</p>}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            className="-my-1.5 flex size-9 shrink-0 items-center justify-center text-muted outline-none hover:text-fg focus-visible:text-fg"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

/** herdr's own message, as against a code the Hub sends (`why` puts those in words). */
const herdrText = (error: string) => !(error in WHY) && !/^http \d+$/.test(error);

/**
 * Plugin actions, grouped under each plugin's name, read fresh from herdr each time the sheet
 * opens (21.4.2), or as the menu that opened it did, so a plugin linked a moment ago is listed.
 * One runs at a time: its row says
 * so and the rest wait. The Hub answers when the run ends, up to 10 s later (21.4.1): a run
 * that succeeded closes the sheet; one that failed shows its exit code and herdr's last
 * stderr line here, or in a RunNotice when the sheet has closed meanwhile. herdr's refusal
 * shows above the list, which stays open. A Pane that appears in the Workspace within
 * NEW_PANE_MS of the tap opens. Focus goes back to the ⋯ button (`Sheet` does it).
 */
export function PluginActionsSheet({
  open,
  onClose,
  meta,
  menu,
  actions: given,
  paneKey,
  state,
}: {
  open: boolean;
  onClose: () => void;
  meta?: string;
  /** Which menu opened it: `actionsFor` keeps the actions that fit it. */
  menu: 'pane' | 'workspace';
  /** The list the menu already read fresh as it opened (the Workspace ⋯), held from the tap
   *  that opened the sheet; then the sheet does not ask. */
  actions?: PluginAction[];
  /** The Pane an action runs from: the Pane itself, or one of the Workspace's. */
  paneKey?: string;
  state: State | null;
}) {
  const latest = useRef(state);
  latest.current = state;
  const watch = useRef<PaneWatch | null>(null);
  const follow = () => {
    const w = watch.current;
    if (!w) return;
    const key = appeared(w, latest.current?.panes ?? [], Date.now());
    if (key || Date.now() > w.until) watch.current = null;
    if (key) navigate(`#/pane/${encodeURIComponent(key)}`);
  };
  useEffect(follow, [state]);

  // The list: null while herdr is asked.
  const [read, setRead] = useState<PluginAction[] | null>(null);
  const [listError, setListError] = useState('');
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    if (!open || !paneKey || given) return;
    let live = true;
    setRead(null);
    setListError('');
    api<{ actions: PluginAction[] }>(`/api/panes/${encodeURIComponent(paneKey)}/actions?fresh=1`, undefined, 'GET').then(
      (r) => live && setRead(actionsFor(r.actions, menu)),
      (e: unknown) => live && setListError((e instanceof Error && e.message) || 'network'),
    );
    return () => {
      live = false;
    };
  }, [open, paneKey, asks]);

  // The run. `gen` moves on when the sheet closes or goes, so a late answer becomes a notice.
  const gen = useRef(0);
  const [running, setRunning] = useState('');
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<Trouble | null>(null);
  useEffect(() => {
    if (open) return;
    gen.current++;
    setRunning('');
    setError('');
    setFailed(null);
    // So a reopened sheet starts on "Asking herdr…", not one frame of the last list.
    setRead(null);
    setListError('');
  }, [open]);
  useEffect(() => () => void gen.current++, []);

  const run = (a: PluginAction) => {
    const panes = latest.current?.panes ?? [];
    const pane = panes.find((p) => p.key === paneKey);
    if (!pane) return setError('pane not found');
    // The watch starts at the tap: herdr can open the new Pane well before the run ends.
    watch.current = { muxKey: pane.muxKey, workspaceId: pane.workspaceId, before: keysIn(panes, pane.muxKey, pane.workspaceId), until: Date.now() + NEW_PANE_MS };
    const at = gen.current;
    setRunning(actionKey(a));
    setError('');
    setFailed(null);
    api<PluginRun>(`/api/panes/${encodeURIComponent(pane.key)}/actions/${encodeURIComponent(a.actionId)}`, { pluginId: a.pluginId }).then(
      (r) => {
        follow(); // the Hub refreshes before it replies, so the new Pane may already be here
        // `running` (still going after 10 s) and `unknown` say nothing, like a success.
        const trouble = r.status === 'failed' ? { head: `${a.title} failed${r.exitCode === undefined ? '' : ` · exit ${r.exitCode}`}`, detail: r.message || undefined } : null;
        if (gen.current !== at) return trouble && setNotice(trouble);
        setRunning('');
        if (trouble) setFailed(trouble);
        else onClose();
      },
      (e: unknown) => {
        const code = (e instanceof Error && e.message) || 'network';
        if (gen.current !== at) return setNotice({ head: `${a.title} did not run`, detail: herdrText(code) ? code : why(code) });
        setRunning('');
        setError(code);
      },
    );
  };

  const busy = running !== '';
  // A known code reads as a sentence; anything else is herdr's own message.
  const refused = Boolean(error) && herdrText(error);
  const actions = given ? actionsFor(given, menu) : read;
  const groups = byPlugin(actions ?? []);
  const trouble: Trouble | null = failed ?? (refused ? { head: 'herdr refused the action', detail: error } : null);
  return (
    <Sheet open={open} title="Plugin actions" onClose={onClose} flush>
      <div className="flex flex-col" style={FLUSH_BODY}>
        <div className="shrink-0 border-b border-border px-6 pb-3">
          <div className="-mt-3.5 truncate">
            <Caption>{meta}</Caption>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pt-1.5 pb-6" style={{ scrollbarGutter: 'stable' }}>
          {trouble && (
            <div role="alert" className="mx-6 mt-1.5 mb-1 flex flex-col gap-1.5 rounded-chip bg-danger/10 p-3">
              <p className="text-[13px] font-semibold text-danger">{trouble.head}</p>
              {trouble.detail && <pre className="font-mono text-[11.5px] leading-normal whitespace-pre-wrap text-danger [overflow-wrap:anywhere]">{trouble.detail}</pre>}
            </div>
          )}
          {error && !refused && (
            <p role="alert" className="px-6 pt-1.5 pb-1 text-caption text-danger">
              {why(error)}
            </p>
          )}
          {listError ? (
            <div className="px-6 pt-3">
              <ErrorLine error={listError} busy={false} onRetry={() => setAsks((n) => n + 1)} />
            </div>
          ) : actions === null ? (
            <p role="status" className="px-6 pt-3 text-caption text-muted">
              Asking herdr…
            </p>
          ) : (
            groups.length === 0 && (
              <div className="flex flex-col gap-1 px-6 pt-3">
                <p className="text-body text-fg">No plugin actions for this {menu === 'pane' ? 'Pane' : 'Workspace'}</p>
                <p className="text-caption text-muted">
                  A linked herdr plugin with {menu === 'pane' ? 'a pane or tab' : 'a workspace'} action shows up here.
                </p>
              </div>
            )
          )}
          {groups.map((g, i) => (
            <section key={g.pluginId} className={i > 0 ? 'mt-1.5 border-t border-border/60 pt-1.5' : ''}>
              <h3 className={MENU_HEADING}>{g.plugin}</h3>
              <ul>
                {g.actions.map((a) => {
                  // The running row stays focusable (aria-disabled, not disabled), so focus
                  // does not drop to the page while herdr runs it.
                  const mine = busy && running === actionKey(a);
                  return (
                    <li key={actionKey(a)}>
                      <button
                        type="button"
                        disabled={busy && !mine}
                        aria-disabled={mine || undefined}
                        aria-busy={mine || undefined}
                        onClick={() => {
                          if (!busy) run(a);
                        }}
                        className={`${MENU_ROW} text-body text-fg outline-none focus-visible:bg-bg focus-visible:shadow-[inset_2px_0_0_var(--accent)] disabled:cursor-default disabled:opacity-40 ${
                          mine ? 'cursor-default bg-bg' : busy ? '' : 'hover:bg-bg active:bg-bg'
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{a.title}</span>
                          {a.description && <span className="mt-0.5 block text-caption text-muted">{a.description}</span>}
                        </span>
                        {mine && <span className="shrink-0 text-caption text-muted">Running…</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** A worktree's `locked` or `prunable` mark, in the warn tint. */
function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-warn/12 px-1.5 py-px text-[11px] text-[color-mix(in_srgb,var(--warn)_65%,var(--fg))]">{children}</span>
  );
}

/**
 * The branch chip's sheet: the repository's local branches, the current one checked and
 * disabled, and, when there is more than one checkout, its worktrees. Tapping a branch
 * switches the Workspace's own checkout; one checked out in another worktree opens that
 * worktree instead. While Files browses a worktree (`worktree` set) switching is off, as the
 * switch route only ever moves the Workspace's own checkout. git's refusal shows verbatim.
 */
export function BranchSheet({
  open,
  onClose,
  list,
  meta,
  worktree,
  onSwitch,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  list: BranchList;
  meta: string;
  worktree?: string;
  onSwitch: Submit<string>;
  onOpen: (worktree: Worktree) => void;
}) {
  const { busy, error, submit } = useWrite(open, onSwitch, onClose);
  const [pick, setPick] = useState('');
  const many = list.worktrees.length > 1;
  // A known code reads as a sentence; anything else the Hub sent is git's own stderr.
  const refused = Boolean(error) && !(error in WHY) && !/^http \d+$/.test(error);
  return (
    <Sheet open={open} title="Switch branch" onClose={onClose} flush>
      <div className="flex flex-col" style={FLUSH_BODY}>
        <div className="shrink-0 border-b border-border px-6 pb-3">
          <div className="-mt-3.5 truncate">
            <Caption>{many ? meta : `${meta} · local branches`}</Caption>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-4">
          {many && <h3 className={MENU_HEADING}>Branches</h3>}
          {worktree && <p className="px-6 pt-1.5 pb-1 text-caption text-muted">Switching applies to the Workspace’s own checkout</p>}
          <ul className={many ? '' : 'pt-1.5'}>
            {list.branches.map((branch) => {
              const current = branch === list.current;
              const elsewhere = current ? undefined : list.worktrees.find((w) => w.branch === branch && !w.current);
              const failed = Boolean(error) && pick === branch;
              return (
                <li key={branch}>
                  <button
                    type="button"
                    disabled={current || (!elsewhere && (Boolean(worktree) || busy))}
                    aria-current={current ? 'true' : undefined}
                    onClick={() => {
                      if (elsewhere) onOpen(elsewhere);
                      else {
                        setPick(branch);
                        submit(branch);
                      }
                    }}
                    className={`${MENU_ROW} font-mono text-[14px] text-fg outline-none focus-visible:bg-bg focus-visible:shadow-[inset_2px_0_0_var(--accent)] disabled:cursor-default ${
                      current ? 'bg-surface' : 'hover:bg-bg active:bg-bg disabled:opacity-40'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{branch}</span>
                    {current ? (
                      <>
                        <span className="font-sans text-caption text-muted">current</span>
                        <Check size={16} className="shrink-0 text-accent" />
                      </>
                    ) : elsewhere ? (
                      <span className="shrink-0 font-sans text-caption text-muted">in {basename(elsewhere.path)}</span>
                    ) : busy && pick === branch ? (
                      <span className="font-sans text-caption text-muted">Switching…</span>
                    ) : failed ? (
                      <span className="font-sans text-caption text-danger">not switched</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {error &&
            (refused ? (
              <div role="alert" className="mx-6 mt-2.5 flex flex-col gap-1.5 rounded-chip bg-danger/10 p-3">
                <p className="text-[13px] font-semibold text-danger">git refused the switch</p>
                <pre className="font-mono text-[11.5px] leading-normal whitespace-pre-wrap text-danger [overflow-wrap:anywhere]">{error}</pre>
              </div>
            ) : (
              <p role="alert" className="px-6 pt-2 text-caption text-danger">
                {why(error)}
              </p>
            ))}
          {many && (
            <>
              <h3 className={`${MENU_HEADING} mt-1.5 border-t border-border/60`}>Worktrees</h3>
              <ul>
                {list.worktrees.map((w) => (
                  <li key={w.path}>
                    <button
                      type="button"
                      aria-current={w.current ? 'true' : undefined}
                      onClick={() => onOpen(w)}
                      className={`flex min-h-12 w-full flex-col justify-center gap-0.5 px-6 py-1.5 text-left outline-none focus-visible:bg-bg focus-visible:shadow-[inset_2px_0_0_var(--accent)] ${
                        w.current ? 'bg-surface' : 'hover:bg-bg active:bg-bg'
                      }`}
                    >
                      <span className="flex w-full min-w-0 items-baseline gap-2">
                        <span className="min-w-0 truncate text-body text-fg">{basename(w.path)}</span>
                        {/* A short SHA never truncates; a long branch name may. */}
                        <span className={`font-mono text-caption text-muted ${w.branch ? 'min-w-0 truncate' : 'shrink-0'}`}>{w.branch ?? `@${w.head.slice(0, 7)}`}</span>
                        <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
                          {w.locked && <Tag>locked</Tag>}
                          {w.prunable && <Tag>prunable</Tag>}
                          {w.current && <span className="text-caption text-muted">current</span>}
                        </span>
                      </span>
                      <span dir="rtl" className="block w-full truncate text-left font-mono text-caption text-muted">
                        <bdi>{tildePath(w.path)}</bdi>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <p className="shrink-0 border-t border-border px-6 pt-3 pb-[max(env(safe-area-inset-bottom),24px)] text-caption text-muted">
          {many
            ? 'Tap a worktree to browse its files and its diff. Agents create these with git worktree; tautan never creates or removes one.'
            : 'Switching changes the files every Pane in this Workspace sees. tautan never creates, commits or stashes.'}
        </p>
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

/**
 * The Directory field with a Browse button. While `browsing`, the sheet swaps its form for
 * the folder list (a second sheet would sit inside the first one's transform).
 */
function DirField({ value, onChange, hostId, onBrowse }: { value: string; onChange: (v: string) => void; hostId?: string; onBrowse: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <TextInput value={value} onChange={onChange} label="Directory" placeholder="/home/user/projects/tautan" />
      </div>
      {hostId && (
        <Button variant="outline" size="lg" onClick={onBrowse} aria-label="Browse folders" style={{ minHeight: 44, minWidth: 44 }}>
          Browse
        </Button>
      )}
    </div>
  );
}

function Browse({ hostId, paneKey, start, onUse, onBack }: { hostId: string; paneKey?: string; start: string; onUse: (path: string) => void; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} style={{ minHeight: 44 }}>
          ← Back
        </Button>
      </div>
      <FolderBrowser hostId={hostId} paneKey={paneKey} start={start} recents onUse={onUse} />
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
  hostId,
  paneKey,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: Submit<{ label?: string; cwd?: string; agent?: string }>;
  where?: ReactNode;
  cwd?: string;
  agent?: string;
  agents?: string[];
  /** Host to browse for the Directory; no Browse button without it. */
  hostId?: string;
  paneKey?: string;
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [browsing, setBrowsing] = useState(false);
  const [label, setLabel] = useState('');
  const [dir, setDir] = useState('');
  const [pick, setPick] = useState('');
  useEffect(() => {
    if (open) {
      setBrowsing(false);
      setLabel('');
      setDir(cwd ?? '');
      setPick(agent ?? '');
    }
  }, [open, cwd, agent]);
  return (
    <Sheet open={open} title={browsing ? 'Choose a folder' : 'New Tab'} meta={browsing ? undefined : where} onClose={onClose}>
      {browsing && hostId ? (
        <Browse hostId={hostId} paneKey={paneKey} start={dir.trim()} onUse={(p) => { setDir(p); setBrowsing(false); }} onBack={() => setBrowsing(false)} />
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput value={label} onChange={setLabel} label="Label" placeholder="Optional" />
        <DirField value={dir} onChange={setDir} hostId={hostId} onBrowse={() => setBrowsing(true)} />
        <AgentChips agents={agents} selected={pick} onPick={setPick} />
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <Button variant="primary" size="lg" fullWidth loading={busy} onClick={() => submit({ label: label.trim() || undefined, cwd: dir.trim() || undefined, agent: pick || undefined })}>
          {busy ? 'Creating…' : 'Create tab'}
        </Button>
      </div>
      )}
    </Sheet>
  );
}

export function NewWorkspaceSheet({
  open,
  onClose,
  onSubmit,
  cwd,
  hostId,
  paneKey,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: Submit<{ cwd: string; label?: string; branch?: string }>;
  cwd?: string;
  /** Host to browse for the Directory; no Browse button without it. */
  hostId?: string;
  paneKey?: string;
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [browsing, setBrowsing] = useState(false);
  const [dir, setDir] = useState('');
  const [label, setLabel] = useState('');
  const [branch, setBranch] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [selectSuggestedBranch, setSelectSuggestedBranch] = useState(false);
  useEffect(() => {
    if (open) {
      setBrowsing(false);
      setDir(cwd ?? '');
      setLabel('');
      setBranch('');
      setWorktree(false);
      setSelectSuggestedBranch(false);
    }
  }, [open, cwd]);

  return (
    <Sheet open={open} title={browsing ? 'Choose a folder' : 'New Workspace'} onClose={onClose}>
      {browsing && hostId ? (
        <Browse hostId={hostId} paneKey={paneKey} start={dir.trim()} onUse={(p) => { setDir(p); setBrowsing(false); }} onBack={() => setBrowsing(false)} />
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <DirField value={dir} onChange={setDir} hostId={hostId} onBrowse={() => setBrowsing(true)} />
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
      )}
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
  /** `Agent` names the Pane's Agent, and an empty name clears it (Wave 21). */
  kind: 'Workspace' | 'Tab' | 'Pane' | 'Agent';
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName(current);
  }, [open]); // current as it was when the sheet opened; typing is never clobbered
  const clears = kind === 'Agent' && !name.trim();
  return (
    <Sheet open={open} title={`Rename ${kind}`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput
          value={name}
          onChange={setName}
          label="Name"
          placeholder={kind === 'Agent' ? 'No name' : 'Name'}
          caption={kind === 'Agent' ? 'Leave it empty to clear the name.' : undefined}
        />
        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <Button variant="primary" size="lg" fullWidth loading={busy} disabled={!name.trim() && (kind !== 'Agent' || !current)} onClick={() => submit(name.trim())}>
          {clears ? (busy ? 'Clearing…' : 'Clear name') : busy ? 'Renaming…' : 'Rename'}
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
  // A kit dialog, not a Sheet, so it asks for focus back itself. After a close that worked,
  // the ⋯ button has usually gone with its row.
  useFocusBack(open);

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

