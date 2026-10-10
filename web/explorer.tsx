// Files laid out like a code host: the Explorer tree beside the content on desktop, a folder
// as a table with its README under it, and Go to file over the Pane's repository.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, navigate } from './app.tsx';
import { Chip, Skeleton } from './halaska-kit';
import { ChevronRight, FileDoc, Folder, Search } from './icons.tsx';
import { Markdown } from './markdown.tsx';
import { WHY, type Entry } from './folders.tsx';
import { absolute, crumbs, dirname, filesHash, filesUrl, homeOf, modified, README, size } from './folders-logic.ts';

export type Listing = { path: string; home: string; parent: string | null; entries: Entry[]; truncated: boolean };

/** One folder from the Hub. Rejects with the Hub's error code. */
export async function fetchListing(o: { host: string; path: string; pane?: string; hidden?: boolean }, signal?: AbortSignal): Promise<Listing> {
  const r = await fetch(filesUrl('list', { host: o.host, path: o.path, pane: o.pane, hidden: o.hidden ? '1' : undefined }), { signal });
  if (!r.ok) throw new Error(await r.json().then((v: { error?: string }) => v.error ?? `http ${r.status}`, () => `http ${r.status}`));
  return (await r.json()) as Listing;
}

const FOCUS = 'outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)]';

/** A folder's or a file's glyph: folders in the accent, files muted. */
export const EntryIcon = ({ dir }: { dir: boolean }) =>
  dir ? <Folder size={16} className="shrink-0 text-accent" /> : <FileDoc size={16} className="shrink-0 text-muted" />;

/**
 * The tree, VS Code's Explorer: `root` and its folders unfold on demand, each listed once. The
 * open file's or folder's ancestors unfold by themselves, so the selection is always in view.
 * A folder row opens that folder on the right and unfolds it; its chevron only folds.
 */
export function Explorer({
  host,
  paneKey,
  root,
  at,
  file,
  hidden,
  worktree,
}: {
  host: string;
  paneKey: string;
  root: string;
  /** The open file or folder, absolute. */
  at: string;
  /** `at` is a file: its folder unfolds, not the file. */
  file: boolean;
  hidden: boolean;
  worktree?: string;
}) {
  const [nodes, setNodes] = useState<Record<string, Listing | 'error'>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
  const asked = useRef(new Set<string>());
  const round = useRef(0);

  // A new root or the hidden toggle lists everything again.
  useEffect(() => {
    round.current += 1;
    asked.current = new Set();
    setNodes({});
  }, [host, root, hidden]);

  // A `~/…` root lists as an absolute path, and every entry under it is absolute.
  const top = nodes[root];
  const real = top && top !== 'error' ? top.path : root;
  useEffect(() => {
    if (at !== real && !at.startsWith(`${real}/`)) return;
    setOpen((was) => {
      const next = new Set(was);
      for (let d = file ? dirname(at) : at; d.length > real.length; d = dirname(d)) next.add(d);
      return next.size === was.size ? was : next;
    });
  }, [real, at, file]);

  useEffect(() => {
    const mine = round.current;
    for (const dir of open) {
      if (asked.current.has(dir)) continue;
      asked.current.add(dir);
      fetchListing({ host, path: dir, pane: paneKey, hidden }).then(
        (list) => mine === round.current && setNodes((n) => ({ ...n, [dir]: list })),
        () => mine === round.current && setNodes((n) => ({ ...n, [dir]: 'error' })),
      );
    }
  }, [open, host, paneKey, hidden]);

  const fold = (dir: string, to?: boolean) =>
    setOpen((was) => {
      const next = new Set(was);
      if (to ?? !next.has(dir)) next.add(dir);
      else next.delete(dir);
      return next;
    });

  const rows = (dir: string, depth: number): ReactNode => {
    const node = nodes[dir];
    const pad = { paddingLeft: 8 + depth * 14 };
    if (!node) return <li aria-busy className="py-1.5 pr-3" style={pad}><Skeleton className="h-3 w-24" /></li>;
    if (node === 'error') return <li className="py-1 pr-3 text-caption text-muted" style={pad}>Could not list</li>;
    if (!node.entries.length) return <li className="py-1 pr-3 text-caption text-muted" style={pad}>Empty</li>;
    return node.entries.map((e) => {
      const current = e.path === at;
      const row = `flex h-7 min-w-0 items-center gap-1.5 pr-3 text-[13px] ${FOCUS} ${current ? 'bg-accent/12 text-fg' : 'text-fg hover:bg-fg/5'}`;
      if (e.kind === 'file') {
        return (
          <li key={e.path}>
            <Link to={filesHash(paneKey, { path: e.path, worktree })} aria-current={current ? 'page' : undefined} className={row} style={{ paddingLeft: pad.paddingLeft + 18 }}>
              <EntryIcon dir={false} />
              <span className="truncate">{e.name}</span>
            </Link>
          </li>
        );
      }
      const unfolded = open.has(e.path);
      return (
        <li key={e.path}>
          <div className={row} style={pad}>
            <button
              type="button"
              aria-label={unfolded ? `Fold ${e.name}` : `Unfold ${e.name}`}
              aria-expanded={unfolded}
              onClick={() => fold(e.path)}
              className="-my-1 flex size-[18px] shrink-0 items-center justify-center rounded-sm text-muted hover:text-fg"
            >
              <ChevronRight size={14} className={`transition-transform duration-100 ${unfolded ? 'rotate-90' : ''}`} />
            </button>
            <Link
              to={filesHash(paneKey, { dir: e.path, worktree })}
              aria-current={current ? 'page' : undefined}
              onClick={() => fold(e.path, true)}
              className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch outline-none"
            >
              <EntryIcon dir />
              <span className="truncate">{e.name}</span>
            </Link>
          </div>
          {unfolded && <ul>{rows(e.path, depth + 1)}</ul>}
        </li>
      );
    });
  };

  return (
    <nav aria-label="Explorer" className="flex min-h-0 flex-1 flex-col">
      <Link
        to={filesHash(paneKey, { dir: root, worktree })}
        aria-current={at === root || at === real ? 'page' : undefined}
        className={`flex h-8 shrink-0 items-center px-3 text-[11px] font-semibold uppercase tracking-[0.06em] ${at === root || at === real ? 'text-fg' : 'text-muted'} ${FOCUS}`}
      >
        <span className="truncate">{root.split('/').at(-1) || root}</span>
      </Link>
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">{rows(root, 0)}</ul>
    </nav>
  );
}

/**
 * Go to file: the Pane's repository files (the same list `@` completes from), narrowed as you
 * type. ↑/↓ move, Enter opens, Esc clears. Paths are relative to the Pane cwd.
 */
export function GoToFile({ paneKey, cwd, worktree, desktop }: { paneKey: string; cwd: string; worktree?: string; desktop: boolean }) {
  const [q, setQ] = useState('');
  // null while the Hub has not answered for this text: no "No file matches" flash.
  const [items, setItems] = useState<string[] | null>(null);
  const [active, setActive] = useState(0);
  const needle = q.trim().toLowerCase();

  useEffect(() => {
    setItems(null);
    if (!needle) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/panes/${encodeURIComponent(paneKey)}/complete?kind=file&q=${encodeURIComponent(needle)}&limit=200`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((body: { items?: { value?: unknown; dir?: boolean }[] }) => {
          // The Hub ranks the rest after the matches; only matches belong here.
          const found = (body.items ?? []).flatMap((i) => (typeof i.value === 'string' && !i.dir && i.value.toLowerCase().includes(needle) ? [i.value] : []));
          setItems(found.slice(0, 50));
          setActive(0);
        })
        .catch(() => !ctl.signal.aborted && setItems([]));
    }, 120);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [paneKey, needle]);

  const go = (file: string) => {
    setQ('');
    navigate(filesHash(paneKey, { path: absolute(file, cwd), worktree }));
  };
  const listId = 'go-to-file';

  return (
    <div className="relative">
      <label className="flex h-9 items-center gap-2 rounded-chip border border-border bg-bg px-2.5 focus-within:border-accent/60">
        <Search size={15} className="shrink-0 text-muted" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQ('');
            if (!items?.length) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
            }
            if (e.key === 'Enter') go(items[active]!);
          }}
          placeholder="Go to file"
          aria-label="Go to file"
          role="combobox"
          aria-expanded={Boolean(needle)}
          aria-controls={listId}
          aria-activedescendant={items?.length ? `${listId}-${active}` : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[16px] placeholder:text-muted focus:outline-none lg:text-[13px]"
        />
      </label>
      {needle && items && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Files"
          className={`overflow-y-auto overscroll-contain rounded-card border border-border bg-bg py-1 shadow-[0_8px_24px_rgb(0_0_0/0.18)] ${
            desktop ? 'absolute inset-x-0 top-full z-20 mt-1 max-h-[60vh]' : 'mt-2 max-h-[50dvh]'
          }`}
        >
          {items.length === 0 && <li className="px-3 py-2 text-caption text-muted">No file matches</li>}
          {items.map((file, i) => (
            <li
              key={file}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => go(file)}
              onPointerMove={(e) => e.pointerType !== 'touch' && setActive(i)}
              className={`flex min-h-9 cursor-pointer items-center gap-2 px-3 font-mono text-[13px] ${i === active ? 'bg-accent/12' : ''}`}
            >
              <span className="truncate">
                {dirname(file) && <span className="text-muted">{dirname(file)}/</span>}
                {file.split('/').at(-1)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A path as clickable steps: every folder opens in Files, the last step is where you are. */
export function Crumbs({ paneKey, path, worktree, file }: { paneKey: string; path: string; worktree?: string; file?: string }) {
  const steps = crumbs(path, homeOf(path));
  return (
    <nav aria-label="Path" className="hscroll flex min-w-0 items-center whitespace-nowrap text-body">
      {steps.map((c, i) => {
        const last = !file && i === steps.length - 1;
        return (
          <span key={c.path} className="flex shrink-0 items-center">
            {i > 0 && c.path !== '/' && <span className="px-1 text-muted">/</span>}
            {last ? (
              <span aria-current="page" className="font-semibold">{c.label}</span>
            ) : (
              <Link to={filesHash(paneKey, { dir: c.path, worktree })} className="text-accent outline-none hover:underline focus-visible:underline">
                {c.label}
              </Link>
            )}
          </span>
        );
      })}
      {file && (
        <span className="flex shrink-0 items-center">
          <span className="px-1 text-muted">/</span>
          <span aria-current="page" className="font-semibold">{file}</span>
        </span>
      )}
    </nav>
  );
}

/**
 * A folder as GitHub shows one: the path, a table of folders then files with their size and
 * age, and the folder's README rendered under it.
 */
export function FolderPanel({
  host,
  paneKey,
  path,
  hidden,
  onHidden,
  worktree,
  desktop,
}: {
  host: string;
  paneKey: string;
  path: string;
  hidden: boolean;
  onHidden: (on: boolean) => void;
  worktree?: string;
  desktop: boolean;
}) {
  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setList(null);
    setError('');
    fetchListing({ host, path, pane: paneKey, hidden }, ctl.signal).then(setList, (e: Error) => e.name !== 'AbortError' && setError(e.message));
    return () => ctl.abort();
  }, [host, paneKey, path, hidden, nonce]);

  const readme = list?.entries.find((e) => e.kind === 'file' && README.test(e.name));
  const cell = 'shrink-0 text-right text-caption tabular-nums text-muted';
  const row = `flex min-h-11 items-center gap-3 px-3 lg:min-h-10 ${FOCUS} hover:bg-fg/5`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Crumbs paneKey={paneKey} path={list?.path ?? path} worktree={worktree} />
        </div>
        <Chip selected={hidden} onToggle={() => onHidden(!hidden)}>
          Hidden
        </Chip>
      </div>

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-card border border-border px-4 py-4">
          <p className="text-body">{WHY[error] ?? `Could not list the folder · ${error}`}</p>
          <button type="button" onClick={() => setNonce((n) => n + 1)} className="min-h-9 text-body font-medium text-accent">
            Try again
          </button>
        </div>
      ) : (
        <section aria-label="Folder contents" className="overflow-hidden rounded-card border border-border">
          {desktop && (
            <div className="flex h-9 items-center gap-3 border-b border-border bg-surface px-3 text-caption font-medium text-muted">
              <span className="flex-1 pl-7">Name</span>
              <span className="w-20 text-right">Size</span>
              <span className="w-32 text-right">Modified</span>
            </div>
          )}
          {!list ? (
            <div aria-busy className="flex flex-col gap-3 px-3 py-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/5" />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {list.parent && (
                <li>
                  <Link to={filesHash(paneKey, { dir: list.parent, worktree })} aria-label="Parent folder" className={row}>
                    <span className="w-4 shrink-0" />
                    <span className="flex-1 font-mono text-body text-muted">..</span>
                  </Link>
                </li>
              )}
              {list.entries.map((e) => (
                <li key={e.path}>
                  <Link to={filesHash(paneKey, e.kind === 'dir' ? { dir: e.path, worktree } : { path: e.path, worktree })} className={row}>
                    <EntryIcon dir={e.kind === 'dir'} />
                    <span className="min-w-0 flex-1 truncate text-body">{e.name}</span>
                    {e.kind === 'file' && <span className={`${cell} w-20`}>{size(e.size)}</span>}
                    {desktop && <span className={`${cell} w-32`}>{modified(e.mtime)}</span>}
                  </Link>
                </li>
              ))}
              {list.entries.length === 0 && <li className="px-3 py-3 text-caption text-muted">Empty folder</li>}
              {list.truncated && <li className="px-3 py-3 text-caption text-muted">The list is cut short. Use Go to file.</li>}
            </ul>
          )}
        </section>
      )}

      {readme && <Readme paneKey={paneKey} file={readme} />}
    </div>
  );
}

/** A README under its folder: read through the Pane, rendered, skipped if it will not read. */
function Readme({ paneKey, file }: { paneKey: string; file: Entry }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    setText(null);
    fetch(`/api/panes/${encodeURIComponent(paneKey)}/file?path=${encodeURIComponent(file.path)}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : ''))
      .then(setText, () => undefined);
    return () => ctl.abort();
  }, [paneKey, file.path, file.mtime]);
  if (text === '') return null;
  return (
    <section aria-label={file.name} className="overflow-hidden rounded-card border border-border">
      <div className="flex h-10 items-center gap-2 border-b border-border bg-surface px-3 text-caption font-semibold">
        <FileDoc size={15} className="text-muted" />
        {file.name}
      </div>
      {text === null ? (
        <div aria-busy className="flex flex-col gap-2 px-5 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : (
        <article className="px-4 py-4 text-body lg:px-8 lg:py-6 [&_h1]:text-[24px] [&_h1]:leading-tight [&_h2]:text-[19px]">
          <Markdown text={text} />
        </article>
      )}
    </section>
  );
}
