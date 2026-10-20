// Files (#/file/<paneKey>[?dir=][&worktree=]) and the viewer (#/file/<paneKey>?path=). With no
// `path` the screen is Files: the folder at `dir`, else the Workspace cwd, else the Pane cwd.
// Desktop keeps the Explorer tree beside either; the phone shows one at a time. The Hub reads a
// file through the Pane. `worktree` is another checkout of the Workspace's repository: the
// tree's root, the branch chip's and the Diff link's checkout.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { State, StateHost, StatePane } from '../shared/types.ts';
import { Link, navigate, useDesktop } from './app.tsx';
import { BranchChip } from './diff.tsx';
import { Back, Download, External, Folder, Lock, PanelLeft, Pencil } from './icons.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';
import { Crumbs, Explorer, FolderPanel, GoToFile } from './explorer.tsx';
import { absolute, basename, dirname, filesHash, filesUrl, size, splitBom, viewerFor } from './folders-logic.ts';
import type { Run } from './highlight.ts';
import { codeLang, Markdown, useRuns } from './markdown.tsx';
import { FRAME, FullPreview } from './preview.tsx';
import { tildePath } from './spaces.ts';
import { store } from './store.tsx';

type FileData =
  | { kind: 'image'; src: string; bytes: number }
  | { kind: 'text'; text: string; bom: boolean; version?: string; bytes: number }
  | { kind: 'binary'; bytes: number };

// CodeMirror and the editor are their own `lazy-*` chunks, fetched on the first Edit tap.
const Editor = lazy(() => import('./editor.tsx'));

/** Files that read better rendered: they open in Preview, with Source one tap away. */
const RENDERED = /\.(md|markdown|html?)$/i;
const HTML = /\.html?$/i;
const SANDBOX_NOTE = 'Sandboxed · scripts and outside requests off';

// `?mock&open=edit` lands a screenshot in the editor, once. The mock gate is the one
// installMock() uses, so a real page never opens the editor on its own.
const params = new URLSearchParams(location.search);
let autoEdit = (params.has('mock') || import.meta.env.VITE_MOCK === '1') && params.get('open') === 'edit';

/** The Explorer beside Files on desktop: shown unless hidden from its root row. */
const EXPLORER = 'tautan.explorer';

/** Coloured runs cut at line breaks: one list per line, for the numbered rows. */
function byLine(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const [text, cls] of runs) {
    text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1)!.push([part, cls]);
    });
  }
  return lines;
}

const ACTION = 'flex min-h-11 shrink-0 items-center text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]';

/** Back one screen. With `leave` (desktop Files) it leaves Files in one press, past every file
 *  and folder opened in it, to the screen Files was opened from; a Files tab opened by its URL
 *  has none, so it goes to `leave`, its Pane. */
function BackLink({ leave }: { leave?: string }) {
  return (
    <a
      href="#/"
      aria-label="Back"
      onClick={(event) => {
        const state = history.state as { filesFrom?: number; mark?: string } | null;
        // The editor's own entry: its guard asks about unsaved changes before anything leaves.
        if (leave && !state?.mark) {
          event.preventDefault();
          if (state?.filesFrom) history.go(-state.filesFrom);
          else navigate(`#/pane/${encodeURIComponent(leave)}`, { replace: true });
          return;
        }
        if (history.length > 1) {
          event.preventDefault();
          history.back();
        }
      }}
      className="flex size-11 shrink-0 items-center justify-center text-accent"
    >
      <Back />
    </a>
  );
}

export function FileScreen({
  paneKey,
  path,
  dir,
  worktree,
  state,
}: {
  paneKey: string;
  path: string;
  dir?: string;
  worktree?: string;
  state: State | null;
}) {
  const desktop = useDesktop();
  const [hidden, setHidden] = useState(false);
  const [explorer, setExplorer] = useState(() => store.get(EXPLORER) !== 'hidden');
  const showExplorer = (on: boolean) => {
    store.set(EXPLORER, on ? 'shown' : 'hidden');
    setExplorer(on);
  };
  // A branch switch changes the files under the list, so it starts over.
  const [round, setRound] = useState(0);
  const pane = state?.panes.find((item) => item.key === paneKey);
  const mux = state?.muxes.find((item) => item.key === pane?.muxKey);
  const host = state?.hosts.find((item) => item.id === mux?.hostId);
  const ws = state?.workspaces.find((item) => item.muxKey === pane?.muxKey && item.id === pane?.workspaceId);
  const root = worktree || ws?.cwd || pane?.cwd || '';
  const folder = dir || root;
  const abs = path ? absolute(path, pane?.cwd) : '';
  const diff = ws && `#/diff/${encodeURIComponent(ws.key)}${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''}`;
  // Go to file searches the Pane's own repository, which a worktree is not.
  const goTo = !worktree && pane?.cwd ? <GoToFile paneKey={paneKey} cwd={pane.cwd} desktop={desktop} /> : null;

  // The phone gives a file the whole screen, its name in the header; Back is its folder.
  if (path && !desktop) return <FileView paneKey={paneKey} path={path} worktree={worktree} pane={pane} host={host} desktop={false} />;

  return (
    <div className="flex h-dvh w-full flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-1 lg:h-14 lg:border-b lg:border-border lg:pr-4">
        <BackLink leave={desktop ? paneKey : undefined} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-title tracking-tight">{ws?.label ?? 'Files'}</h1>
          <p className="truncate text-caption text-muted">
            {['Files', host?.label, worktree && `worktree ${basename(worktree)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        {ws && <BranchChip workspaceKey={ws.key} worktree={worktree} paneKey={paneKey} state={state} onSwitched={() => setRound((n) => n + 1)} />}
        {diff && (
          <Link to={diff} className={`${ACTION} px-2 text-body font-medium`}>
            Diff
          </Link>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        {desktop && host && root && (explorer ? (
          <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface xl:w-72">
            <Explorer key={round} host={host.id} paneKey={paneKey} root={root} at={abs || folder} file={Boolean(path)} hidden={hidden} worktree={worktree} onHide={() => showExplorer(false)} search={goTo} />
          </aside>
        ) : (
          // The rail keeps the toggle where the Explorer's header had it.
          <aside aria-label="Explorer" className="flex w-12 shrink-0 flex-col border-r border-border bg-surface">
            <div className="flex h-11 shrink-0 items-center border-b border-border px-2">
              <button
                type="button"
                aria-label="Show Explorer"
                title="Show Explorer"
                onClick={() => showExplorer(true)}
                className="flex size-8 items-center justify-center rounded-chip text-muted outline-none hover:bg-fg/5 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <PanelLeft size={16} />
              </button>
            </div>
          </aside>
        ))}
        <main className={`min-w-0 flex-1 ${path ? 'flex flex-col' : 'overflow-y-auto overscroll-contain'}`}>
          {path ? (
            // Keyed by file: an open editor or a Source choice belongs to the file it was made on.
            <FileView key={path} paneKey={paneKey} path={path} worktree={worktree} pane={pane} host={host} desktop />
          ) : host ? (
            // Desktop is full bleed under its breadcrumb bar, as a file is; the phone keeps a column.
            <div className={desktop ? 'flex flex-col pb-6' : 'mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 pt-1 pb-[max(env(safe-area-inset-bottom),16px)]'}>
              {!desktop && goTo}
              <FolderPanel key={round} host={host.id} paneKey={paneKey} path={folder} hidden={hidden} onHidden={setHidden} worktree={worktree} desktop={desktop} />
            </div>
          ) : state ? (
            <div className="flex flex-col items-start gap-3 px-4 pt-8">
              <p className="text-body">{pane ? 'Host not available' : 'Pane is gone'}</p>
              {!pane && (
                <a href="#/" className="text-body text-accent">
                  ‹ All panes
                </a>
              )}
            </div>
          ) : (
            <div aria-busy className="flex flex-col gap-2 px-4 pt-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function FileView({
  paneKey,
  path,
  worktree,
  pane,
  host,
  desktop,
}: {
  paneKey: string;
  path: string;
  worktree?: string;
  pane?: StatePane;
  host?: StateHost;
  /** Beside the Explorer, under the Files header: a breadcrumb instead of a header. */
  desktop: boolean;
}) {
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'Preview' | 'Source'>('Preview');
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState(false);
  const abs = absolute(path, pane?.cwd);
  const kind = viewerFor(path);
  const fileUrl = `/api/panes/${encodeURIComponent(paneKey)}/file?path=${encodeURIComponent(path)}`;
  const raw = (o: { download?: boolean; v?: string } = {}) =>
    host ? filesUrl('raw', { host: host.id, path: abs, pane: paneKey, download: o.download ? '1' : undefined, v: o.v }) : '';

  useEffect(() => {
    const controller = new AbortController();
    let imageUrl = '';
    setData(null);
    setError('');

    // Media and PDF stream from /api/files/raw (ranges); only text and images are read here.
    if (kind !== 'other') return () => controller.abort();

    fetch(fileUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const code = await response
            .json()
            .then((value) => (value as { error?: string }).error)
            .catch(() => undefined);
          throw new Error(code || `http ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase() ?? '';
        if (mediaType.startsWith('image/')) {
          imageUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
          setData({ kind: 'image', src: imageUrl, bytes: bytes.byteLength });
          return;
        }
        try {
          // `ignoreBOM` keeps a byte order mark in the text, so a save can put it back.
          const { bom, text } = splitBom(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
          setData({ kind: 'text', text, bom, version: response.headers.get('etag') ?? undefined, bytes: bytes.byteLength });
        } catch {
          setData({ kind: 'binary', bytes: bytes.byteLength });
        }
      })
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message);
      });

    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [fileUrl, nonce, kind]);

  const text = data?.kind === 'text' ? data : null;
  // No etag means the Host cannot tell versions apart (a remote without `cksum`): no safe save.
  const version = text?.version;

  useEffect(() => {
    if (autoEdit && version) {
      autoEdit = false;
      setEditing(true);
    }
  }, [version]);

  const name = basename(path);
  const lines = useMemo(() => (text ? text.text.split(/\r\n?|\n/) : []), [text]);
  const source = useMemo(() => lines.join('\n'), [lines]);
  // Source in the editor's colours, as fenced code in Chat: by extension, plain until loaded.
  const runs = useRuns(text && !(RENDERED.test(path) && view === 'Preview') ? codeLang(name.match(/\.([^.]+)$/)?.[1] ?? '', source) : undefined, source);
  const lineRuns = useMemo(() => (runs ? byLine(runs) : undefined), [runs]);

  if (editing && text && version) {
    return (
      <Suspense
        fallback={
          <div aria-busy className="flex flex-col gap-2 px-4 pt-16">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        }
      >
        <Editor
          name={name}
          path={path}
          text={text.text}
          bom={text.bom}
          version={version}
          url={fileUrl}
          onDone={(saved) => {
            setEditing(false);
            if (saved) setData({ ...text, ...saved });
          }}
          onReload={() => {
            setEditing(false);
            setNonce((n) => n + 1);
          }}
        />
      </Suspense>
    );
  }

  const rendered = Boolean(text) && RENDERED.test(path);
  const html = HTML.test(path);
  // Past the read cap there is no text, but the raw route has no cap: HTML still previews.
  const tooLarge = error === 'too large';
  const showHtml = html && ((rendered && view === 'Preview') || tooLarge);
  const showPreview = rendered && view === 'Preview';
  const facts = text ? `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} · ${size(text.bytes)}` : data ? size(data.bytes) : '';
  // Desktop draws the bar compact, as a code host does; the phone keeps 44 px targets.
  const RING = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/60';
  const icon = desktop
    ? `flex size-8 shrink-0 items-center justify-center rounded-chip text-muted hover:bg-fg/5 hover:text-fg ${RING}`
    : `${ACTION} w-10 justify-center text-muted hover:text-fg`;
  const glyph = desktop ? 16 : 18;

  // The file's own bar, in GitHub's order: the view switch and what the file is on the left;
  // Open and Download, then Edit, the one labelled action, on the right.
  const bar = (
    <div className={`flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-surface ${desktop ? 'px-3' : 'pr-1 pl-2'}`}>
      {rendered && (
        // The kit sets the halves' padding inline, so the compact one overrides it.
        <div className={`shrink-0 ${desktop ? 'w-[136px] [&_button]:py-[2px]!' : 'w-44 [&_button]:min-h-[34px]'}`}>
          <SegmentedControl options={['Preview', 'Source']} value={view} onChange={setView} />
        </div>
      )}
      <span className="min-w-0 flex-1 truncate px-1.5 font-mono text-caption text-muted">{facts}</span>
      {host && (
        <>
          <a href={raw()} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab" className={icon}>
            <External size={glyph} />
          </a>
          <a href={raw({ download: true })} download={name} aria-label="Download" title="Download" className={icon}>
            <Download size={glyph} />
          </a>
        </>
      )}
      {version && (
        <>
          {host && <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={desktop
              ? `flex h-7 shrink-0 items-center gap-1.5 rounded-chip border border-border bg-bg px-2.5 text-[13px] font-medium text-fg hover:bg-fg/5 ${RING}`
              : `${ACTION} px-2.5 text-body font-semibold`}
          >
            {desktop && <Pencil size={14} />}
            Edit
          </button>
        </>
      )}
    </div>
  );

  const body =
    kind !== 'other' ? (
      !host ? (
        <p className="px-4 pt-8 text-body">Host not available</p>
      ) : kind === 'pdf' ? (
        // ponytail: Chrome's PDF viewer refuses every sandboxed frame (probed on Chrome 1228: '', allow-scripts,
        // allow-same-origin and both together all blank it), so this frame is unsandboxed.
        // The Hub sends the PDF as application/pdf from our own origin, never as HTML.
        <iframe title={name} src={raw()} className="size-full min-h-[70dvh] flex-1 border-0" />
      ) : kind === 'video' ? (
        <video src={raw()} controls playsInline preload="metadata" className="max-h-full w-full bg-black" />
      ) : (
        <div className="flex flex-col gap-3 px-4 py-8">
          <audio src={raw()} controls preload="metadata" className="w-full" />
        </div>
      )
    ) : showHtml ? (
      <>
        <div className="flex shrink-0 items-center gap-2 border-b border-border pl-3 text-caption text-muted">
          <Lock className="shrink-0" />
          {/* It wraps rather than truncates: the note is the safety claim. */}
          <span className="min-w-0 flex-1 py-1.5 leading-snug">{tooLarge ? `${SANDBOX_NOTE} · too large for Source and Edit` : SANDBOX_NOTE}</span>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setFull(true)}
            className="flex min-h-11 shrink-0 items-center px-2.5 font-semibold text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]"
          >
            Full screen
          </button>
        </div>
        {/* Keyed and versioned, so a save reloads the page instead of showing a cached one. */}
        {host && <iframe key={version} {...FRAME} src={raw({ v: version })} title={`Preview of ${name}`} className="min-h-[50dvh] w-full flex-1 border-0 bg-white" />}
        {full && host && <FullPreview src={raw({ v: version })} title={name} note={SANDBOX_NOTE} onClose={() => setFull(false)} />}
      </>
    ) : error ? (
      <div className="flex flex-col items-start gap-3 px-4 py-8">
        <p className="text-body">
          {error === 'not found' ? 'File not found' : tooLarge ? 'This file is too large to show here' : 'Could not read the file'}
        </p>
        {tooLarge && host ? (
          <div className="flex gap-4">
            <a href={raw()} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center text-body font-medium text-accent">
              Open in a new tab
            </a>
            <a href={raw({ download: true })} download={name} className="flex min-h-11 items-center text-body font-medium text-accent">
              Download
            </a>
          </div>
        ) : error !== 'not found' && (
          <>
            <p className="text-caption text-muted">{error}</p>
            <button type="button" onClick={() => setNonce((value) => value + 1)} className="text-body font-medium text-accent">
              Try again
            </button>
          </>
        )}
      </div>
    ) : !data ? (
      <div aria-busy className="flex flex-col gap-2 px-4 py-4">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    ) : data.kind === 'binary' ? (
      <p className="px-4 py-8 font-mono text-caption text-muted">Binary file</p>
    ) : data.kind === 'image' ? (
      <div className="flex min-h-full items-start justify-center p-4">
        <img src={data.src} alt={name} className="h-auto max-w-full" />
      </div>
    ) : showPreview ? (
      // A document reads at document scale; the Markdown component's headings are sized for Chat turns.
      <article className="px-4 py-5 text-body lg:px-8 lg:py-6 [&_h1]:text-[24px] [&_h1]:leading-tight [&_h2]:text-[19px]">
        <Markdown text={data.text} />
      </article>
    ) : (
      <div className="hscroll w-max min-w-full py-2">
        {lines.map((line, index) => (
          <div key={index} className="flex font-mono text-[13px] leading-5 text-fg">
            <span
              aria-hidden
              style={{ width: `calc(${String(lines.length).length}ch + 2rem)` }}
              className="shrink-0 pr-4 text-right tabular-nums text-muted/70 select-none"
            >
              {index + 1}
            </span>
            <span className="pr-4 whitespace-pre">
              {lineRuns?.length === lines.length ? lineRuns[index]!.map(([part, cls], n) => (cls ? <span key={n} className={cls}>{part}</span> : part)) : line}
            </span>
          </div>
        ))}
      </div>
    );

  // One card at both widths: the bar over the content, the content scrolling inside it. A
  // frame or a player fills the card instead of scrolling.
  const filled = showHtml || kind === 'pdf';
  const card = (
    <section aria-label={name} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-bg">
      {bar}
      <div className={`min-h-0 flex-1 ${filled ? 'flex flex-col' : 'overflow-auto overscroll-contain'}`}>{body}</div>
    </section>
  );

  // Desktop is full bleed, as a code host draws a file: the breadcrumb bar, the file's bar,
  // then the content edge to edge.
  if (desktop) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-11 shrink-0 items-center border-b border-border px-4">
          <Crumbs paneKey={paneKey} path={dirname(abs)} worktree={worktree} file={name} />
        </div>
        {bar}
        <div className={`min-h-0 flex-1 ${filled ? 'flex flex-col' : 'overflow-auto overscroll-contain'}`}>{body}</div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex h-11 shrink-0 items-center gap-0.5 pr-1 pl-1">
        <BackLink />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-title tracking-tight">{name}</h1>
          <p className="flex min-w-0 font-mono text-caption text-muted">
            {/* The folder truncates from the left, so the end of the path stays readable. */}
            <span dir="rtl" className="min-w-0 truncate text-left">
              <bdi>{tildePath(dirname(abs))}</bdi>
            </span>
          </p>
        </div>
        {host && (
          <Link to={filesHash(paneKey, { dir: dirname(abs), worktree })} aria-label="Folder" title="Folder" className={`${ACTION} w-10 justify-center text-muted`}>
            <Folder />
          </Link>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)]">{card}</div>
    </div>
  );
}
