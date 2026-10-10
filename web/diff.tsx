// Diff review (#/diff/<workspaceKey>[?worktree=<path>]). The Hub parses `git diff` in the
// Workspace cwd, or in that worktree, and sends `DiffResult`; this file is the whole renderer —
// a table of rows, no highlighting. The branch chip lives here too: Files shows it as well.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BranchList, DiffFile, DiffResult, DiffScope, State, SwitchBody, Worktree } from '../shared/types.ts';
import { api, Link, navigate, useDesktop } from './app.tsx';
import { Back, ChevronDown, ChevronRight, Refresh } from './icons.tsx';
import { FADE } from './composer.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';
import { basename, filesHash } from './folders-logic.ts';
import { BranchSheet } from './sheets.tsx';
import { tildePath } from './spaces.ts';

const SCOPES: [DiffScope, string][] = [
  ['working', 'Changes'],
  ['staged', 'Staged'],
  ['base', 'vs base'],
];

/** The empty line in the scope's own words, so "No changes" always says which changes. */
const nothing = (scope: DiffScope, base?: string) =>
  scope === 'working'
    ? 'No unstaged changes'
    : scope === 'staged'
      ? 'No staged changes'
      : `No changes vs ${base ?? 'base'}`;

/** `web/diff.tsx` → `['web/', 'diff.tsx']`: the directory truncates, the file name never does. */
function split(path: string): [string, string] {
  const cut = path.lastIndexOf('/');
  return [path.slice(0, cut + 1), path.slice(cut + 1)];
}

const MARK = { add: '+', del: '-', ctx: ' ', meta: ' ' } as const;
const TINT = { add: 'diff-add', del: 'diff-del', ctx: '', meta: '' } as const;
const MARK_COLOR = { add: 'text-ok', del: 'text-danger', ctx: 'text-muted', meta: 'text-muted' } as const;

/** git names an old path for every file, so only a different, real one is a rename. */
const renamedFrom = (file: DiffFile) =>
  file.oldPath && file.oldPath !== file.path && file.oldPath !== '/dev/null' ? file.oldPath : undefined;

function Path({ file }: { file: DiffFile }) {
  const [dir, name] = split(file.path);
  const from = renamedFrom(file);
  return (
    <span className="flex min-w-0 flex-1 items-baseline font-mono text-caption">
      {from && (
        <>
          <span className="truncate text-muted">{from}</span>
          <span className="shrink-0 px-1 text-muted">→</span>
        </>
      )}
      <span className="truncate text-muted">{dir}</span>
      <span className="shrink-0 text-fg">{name}</span>
    </span>
  );
}

/** `+12 −3`, always in that order, so two files line up down the list. */
function Counts({ file }: { file: DiffFile }) {
  return (
    <span className="shrink-0 font-mono text-caption tabular-nums">
      <span className="text-ok">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
    </span>
  );
}

function FileSection({
  file,
  open,
  onToggle,
  wrap,
  cut,
  onWhole,
}: {
  file: DiffFile;
  open: boolean;
  onToggle: () => void;
  wrap: boolean;
  cut: boolean;
  onWhole: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fade, setFade] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Same rule as the Pane grid: wider than the column is a fade, not a scrollbar.
  // ponytail: measured on scroll and on a change, not on a resize; a rotation re-renders
  // the screen anyway. Add a listener if a desktop resize ever leaves it stale.
  const measure = () => {
    const el = box.current;
    if (!el) return;
    setFade(el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useLayoutEffect(measure, [wrap, open, file]);

  return (
    <section className="border-t border-border/60">
      <h2 className="sticky top-0 z-20 border-b border-border/60 bg-bg">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="press flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left active:bg-surface"
        >
          {open ? <ChevronDown className="shrink-0 text-muted" /> : <ChevronRight className="shrink-0 text-muted" />}
          <Path file={file} />
          <Counts file={file} />
        </button>
      </h2>

      {open &&
        (file.binary ? (
          <p className="px-4 pb-3 pl-10 font-mono text-caption text-muted">Binary file</p>
        ) : (
          <>
            <div
              ref={box}
              onScroll={measure}
              className={`hscroll pb-1 ${wrap ? 'overflow-x-hidden' : ''}`}
              style={fade ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
            >
              <div className={wrap ? 'w-full' : 'w-max min-w-full'}>
                {file.hunks.map((hunk, h) => (
                  <Fragment key={h}>
                    <div className="bg-surface px-3 py-1 font-mono text-caption text-muted">{hunk.header}</div>
                    {hunk.lines.map((line, i) => (
                      <div key={i} className={`flex font-mono text-caption ${TINT[line.type]}`}>
                        <span aria-hidden className="w-9 shrink-0 px-1.5 text-right tabular-nums text-muted select-none">
                          {line.oldNo ?? ''}
                        </span>
                        <span aria-hidden className="w-9 shrink-0 px-1.5 text-right tabular-nums text-muted select-none">
                          {line.newNo ?? ''}
                        </span>
                        <span className={`w-3.5 shrink-0 text-center select-none ${MARK_COLOR[line.type]}`}>
                          {MARK[line.type]}
                        </span>
                        <span
                          className={`pr-4 ${line.type === 'meta' ? 'text-muted italic' : 'text-fg'} ${
                            wrap ? 'min-w-0 flex-1 break-all whitespace-pre-wrap' : 'whitespace-pre'
                          }`}
                        >
                          {line.text}
                        </span>
                      </div>
                    ))}
                  </Fragment>
                ))}
              </div>
            </div>

            {cut && (
              <div className="px-4 pt-1 pb-3 pl-10">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setFailed(false);
                    onWhole()
                      .catch(() => setFailed(true))
                      .finally(() => setBusy(false));
                  }}
                  className="press flex min-h-9 items-center rounded-chip border border-border px-3 text-caption font-medium text-accent disabled:opacity-50"
                >
                  {busy ? 'Loading…' : failed ? 'Try again' : 'Show whole file'}
                </button>
              </div>
            )}
          </>
        ))}
    </section>
  );
}

/** A box's width, rounded. The kit's SegmentedControl measures its indicator once (and on a
 *  window resize), so a control whose box changes width is keyed on it to measure again. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** The Workspace's first Pane: Files needs a Pane to read through, and any Pane of it will do. */
const firstPane = (state: State | null, workspaceKey: string) => {
  const ws = state?.workspaces.find((w) => w.key === workspaceKey);
  return state?.panes.find((p) => p.muxKey === ws?.muxKey && p.workspaceId === ws?.id);
};

/**
 * The checkout's branch as a chip that opens the branch sheet. It renders nothing until the
 * Hub answers and nothing on any error, so a folder outside a repository has no chip. With
 * `worktree` it asks about that checkout. `paneKey` is the Pane Files reads through; the
 * Workspace's first Pane when absent.
 */
export function BranchChip({
  workspaceKey,
  worktree,
  paneKey,
  state,
  onSwitched,
}: {
  workspaceKey: string;
  worktree?: string;
  paneKey?: string;
  state: State | null;
  onSwitched?: (list: BranchList) => void;
}) {
  const ws = state?.workspaces.find((w) => w.key === workspaceKey);
  const host = state?.hosts.find((h) => h.id === state.muxes.find((m) => m.key === ws?.muxKey)?.hostId);
  const pane = firstPane(state, workspaceKey);
  const via = paneKey ?? pane?.key;
  const [list, setList] = useState<BranchList | null>(null);
  const [open, setOpen] = useState(false);
  const base = `/api/workspaces/${encodeURIComponent(workspaceKey)}`;
  const url = `${base}/branches${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''}`;

  useEffect(() => {
    let live = true;
    setList(null);
    api<BranchList>(url, undefined, 'GET').then(
      (value) => live && setList(value),
      () => live && setList(null),
    );
    return () => {
      live = false;
    };
  }, [url]);

  if (!list) return null;
  const here = list.worktrees.find((w) => w.current);
  const label = list.current ?? (here ? `@${here.head.slice(0, 7)}` : 'detached');

  /** The checkout the Workspace itself sits in: the deepest worktree holding its cwd. Files
   *  opens that one plainly, without `worktree=`, so its branch can still be switched. */
  const own = (w: Worktree) => {
    const cwd = ws?.cwd ?? pane?.cwd;
    if (!cwd) return false;
    const at = tildePath(cwd);
    const holds = (p: string) => at === tildePath(p) || at.startsWith(`${tildePath(p)}/`);
    const deepest = list.worktrees.filter((x) => holds(x.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return deepest?.path === w.path;
  };

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          // Agents move branches; the sheet opens on a fresh list, and keeps the old one on a miss.
          api<BranchList>(url, undefined, 'GET').then(setList, () => {});
        }}
        // A 44 px target around a 26 px chip, so the header keeps its height.
        className="group press flex min-h-11 max-w-[9.5rem] min-w-0 shrink items-center outline-none lg:max-w-[16rem]"
      >
        <span className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-chip border border-border px-2 font-mono text-[11px] text-fg group-hover:border-muted/50 group-focus-visible:ring-2 group-focus-visible:ring-accent">
          <span className="sr-only">Branch </span>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown size={10} className="shrink-0 text-muted" />
        </span>
      </button>
      <BranchSheet
        open={open}
        onClose={() => setOpen(false)}
        list={list}
        meta={[ws?.label, host?.label].filter(Boolean).join(' · ')}
        worktree={worktree}
        onSwitch={async (branch) => {
          const next = await api<BranchList>(`${base}/switch`, { branch } satisfies SwitchBody);
          setList(next);
          onSwitched?.(next);
        }}
        onOpen={(w) => {
          setOpen(false);
          if (via) navigate(filesHash(via, own(w) ? {} : { dir: w.path, worktree: w.path }));
        }}
      />
    </>
  );
}

export function Diff({ workspaceKey, worktree, state }: { workspaceKey: string; worktree?: string; state: State | null }) {
  const ws = state?.workspaces.find((w) => w.key === workspaceKey);
  const pane = firstPane(state, workspaceKey);
  const [scope, setScope] = useState<DiffScope>('working');
  const [wrap, setWrap] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<DiffResult | null>(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const url = (extra = '') =>
    `/api/workspaces/${encodeURIComponent(workspaceKey)}/diff?scope=${scope}${worktree ? `&worktree=${encodeURIComponent(worktree)}` : ''}${extra}`;

  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    api<DiffResult>(url(), undefined, 'GET').then(
      (result) => {
        if (!live) return;
        setData(result);
        // Three files open is about one phone screen of context; the rest wait for a tap.
        setCollapsed(new Set(result.files.slice(3).map((f) => f.path)));
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [workspaceKey, worktree, scope, nonce]);

  /** Replace one cut file with its whole diff. The list stays as it is. */
  const whole = async (path: string) => {
    const result = await api<DiffResult>(url(`&file=${encodeURIComponent(path)}`), undefined, 'GET');
    const full = result.files[0];
    if (full) setData((d) => d && { ...d, files: d.files.map((f) => (f.path === path ? full : f)) });
  };

  const toggle = (path: string) =>
    setCollapsed((set) => {
      const next = new Set(set);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const desktop = useDesktop();
  const [scopeBox, scopeWidth] = useWidth();
  const chip = <BranchChip workspaceKey={workspaceKey} worktree={worktree} state={state} onSwitched={() => setNonce((n) => n + 1)} />;
  const files = data?.files ?? [];
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col pt-[env(safe-area-inset-top)] lg:max-w-4xl">
      <header className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-1">
        {/* Back to wherever Diff was opened from: the Pane, or the Agents list. */}
        <a
          href="#/"
          aria-label="Back"
          onClick={(e) => {
            if (history.length > 1) {
              e.preventDefault();
              history.back();
            }
          }}
          className="flex size-11 shrink-0 items-center justify-center text-accent"
        >
          <Back />
        </a>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-title tracking-tight">{ws?.label ?? 'Diff'}</h1>
          <p className="truncate text-caption text-muted">
            {worktree && `worktree ${basename(worktree)} · `}
            {data ? (
              files.length === 0 ? (
                'no changes'
              ) : (
                <>
                  {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
                  <span className="tabular-nums">
                    <span className="text-ok">+{added}</span> <span className="text-danger">−{removed}</span>
                  </span>
                </>
              )
            ) : (
              (ws?.cwd ?? 'Diff')
            )}
          </p>
        </div>
        {desktop && chip}
        {pane && (
          <Link
            to={filesHash(pane.key, worktree ? { dir: worktree, worktree } : {})}
            className="flex min-h-11 shrink-0 items-center px-2 text-body font-medium text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]"
          >
            Files
          </Link>
        )}
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
          className={`press shrink-0 rounded-chip border px-2.5 py-[5px] font-mono text-[11px] ${
            wrap ? 'border-accent bg-accent font-semibold text-bg' : 'border-border text-muted'
          }`}
        >
          wrap
        </button>
        <button
          type="button"
          aria-label="Refresh"
          onClick={() => setNonce((n) => n + 1)}
          className="flex h-11 w-10 shrink-0 items-center justify-center text-muted"
        >
          <Refresh />
        </button>
      </header>

      {/* The phone header has no room for the chip beside Files, wrap and Refresh; it leads the scope row. */}
      <div className="flex shrink-0 items-center gap-2 px-4 pt-1 pb-2">
        {!desktop && chip}
        <div ref={scopeBox} aria-label="Scope" className="min-w-0 flex-1">
          <SegmentedControl
            key={scopeWidth}
            options={SCOPES.map(([, label]) => label)}
            value={SCOPES.find(([value]) => value === scope)![1]}
            onChange={(label: string) => setScope(SCOPES.find(([, l]) => l === label)![0])}
          />
        </div>
      </div>

      {scope === 'base' && data?.base && <p className="shrink-0 px-4 pb-2 text-caption text-muted">vs {data.base}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto pb-[max(env(safe-area-inset-bottom),12px)]">
        {error ? (
          <div className="flex flex-col items-start gap-3 px-4 pt-8">
            <p className="text-body">
              {error === 'not-a-repo'
                ? 'Not a git repository'
                : error === 'unknown-workspace'
                  ? 'Workspace is gone'
                  : error === 'worktree'
                    ? 'That worktree is gone'
                    : error === 'no-base'
                      ? 'No base branch to compare with'
                      : 'Could not read the diff'}
            </p>
            {error === 'not-a-repo' || error === 'worktree' ? (
              <p className="font-mono text-caption text-muted">{error === 'worktree' ? worktree : ws?.cwd}</p>
            ) : error === 'unknown-workspace' ? (
              <a href="#/" className="text-body text-accent">
                ‹ All panes
              </a>
            ) : (
              <>
                <p className="text-caption text-muted">{error}</p>
                <button type="button" onClick={() => setNonce((n) => n + 1)} className="text-body font-medium text-accent">
                  Try again
                </button>
              </>
            )}
          </div>
        ) : !data ? (
          <div aria-busy className="flex flex-col gap-5 px-4 pt-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            ))}
          </div>
        ) : files.length === 0 ? (
          <p className="px-4 pt-8 text-body text-muted">{nothing(scope, data.base)}</p>
        ) : (
          <>
            {data.truncated && (
              <p className="px-4 pb-2 text-caption text-muted">
                Large diff · the list is cut. Load a file in full below.
              </p>
            )}
            {files.map((file) => (
              <FileSection
                key={file.path}
                file={file}
                open={!collapsed.has(file.path)}
                onToggle={() => toggle(file.path)}
                wrap={wrap}
                cut={data.truncated}
                onWhole={() => whole(file.path)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
