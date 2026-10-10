// Files (#/file/<paneKey>[?dir=][&worktree=]) and the viewer (#/file/<paneKey>?path=). With no
// `path` the screen is Files: the folder list at `dir`, else the Workspace cwd, else the Pane
// cwd. The Hub reads a file through the Pane. `worktree` is another checkout of the
// Workspace's repository; it only steers the branch chip and the Diff link.
import { lazy, Suspense, useEffect, useState } from 'react';
import type { State, StateHost, StatePane, StateWorkspace } from '../shared/types.ts';
import { Link, navigate } from './app.tsx';
import { BranchChip } from './diff.tsx';
import { Back, Download, Folder, Lock } from './icons.tsx';
import { SegmentedControl, Skeleton } from './halaska-kit';
import { FolderBrowser } from './folders.tsx';
import { absolute, basename, dirname, filesHash, filesUrl, size, splitBom, viewerFor } from './folders-logic.ts';
import { Markdown } from './markdown.tsx';
import { FRAME, FullPreview } from './preview.tsx';
import { tildePath } from './spaces.ts';

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

const ACTION = 'flex min-h-11 shrink-0 items-center text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]';

function BackLink() {
  return (
    <a
      href="#/"
      aria-label="Back"
      onClick={(event) => {
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
  const pane = state?.panes.find((item) => item.key === paneKey);
  const mux = state?.muxes.find((item) => item.key === pane?.muxKey);
  const host = state?.hosts.find((item) => item.id === mux?.hostId);
  const ws = state?.workspaces.find((item) => item.muxKey === pane?.muxKey && item.id === pane?.workspaceId);
  return path ? (
    <FileView paneKey={paneKey} path={path} worktree={worktree} pane={pane} host={host} />
  ) : (
    <Files paneKey={paneKey} dir={dir} worktree={worktree} state={state} pane={pane} ws={ws} host={host} />
  );
}

function Files({
  paneKey,
  dir,
  worktree,
  state,
  pane,
  ws,
  host,
}: {
  paneKey: string;
  dir?: string;
  worktree?: string;
  state: State | null;
  pane?: StatePane;
  ws?: StateWorkspace;
  host?: StateHost;
}) {
  // A branch switch changes the files under the list, so it starts over.
  const [round, setRound] = useState(0);
  const start = dir || ws?.cwd || pane?.cwd || '';
  const diff = ws && `#/diff/${encodeURIComponent(ws.key)}${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ''}`;
  const open = (file: string) => {
    // Back from the file lands on its folder, not on wherever Files first opened.
    history.replaceState(null, '', filesHash(paneKey, { dir: dirname(file), worktree }));
    navigate(filesHash(paneKey, { path: file, worktree }));
  };

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-1 lg:h-14">
        <BackLink />
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
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-[max(env(safe-area-inset-bottom),12px)]">
        {host ? (
          <FolderBrowser key={round} hostId={host.id} paneKey={paneKey} start={start} files onFile={open} />
        ) : state ? (
          <div className="flex flex-col items-start gap-3 pt-8">
            <p className="text-body">{pane ? 'Host not available' : 'Pane is gone'}</p>
            {!pane && (
              <a href="#/" className="text-body text-accent">
                ‹ All panes
              </a>
            )}
          </div>
        ) : (
          <div aria-busy className="flex flex-col gap-2 pt-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </main>
    </div>
  );
}

function FileView({
  paneKey,
  path,
  worktree,
  pane,
  host,
}: {
  paneKey: string;
  path: string;
  worktree?: string;
  pane?: StatePane;
  host?: StateHost;
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
  const showPreview = rendered && view === 'Preview';

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex h-11 shrink-0 items-center gap-0.5 pr-1 pl-1 lg:h-14">
        <BackLink />
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-title tracking-tight">{name}</h1>
          <p className="flex min-w-0 font-mono text-caption text-muted">
            {/* The folder truncates from the left, so the end of the path stays readable. */}
            <span dir="rtl" className="min-w-0 truncate text-left">
              <bdi>{tildePath(dirname(abs))}</bdi>
            </span>
            {data && <span className="shrink-0">&nbsp;· {size(data.bytes)}</span>}
          </p>
        </div>
        {version && (
          <button type="button" onClick={() => setEditing(true)} className={`${ACTION} px-2.5 text-body font-semibold`}>
            Edit
          </button>
        )}
        {host && (
          <>
            <Link
              to={filesHash(paneKey, { dir: dirname(abs), worktree })}
              aria-label="Folder"
              title="Folder"
              className={`${ACTION} w-10 justify-center text-muted`}
            >
              <Folder />
            </Link>
            <a href={raw({ download: true })} download={name} aria-label="Download" title="Download" className={`${ACTION} w-10 justify-center text-muted`}>
              <Download />
            </a>
          </>
        )}
      </header>

      {rendered && (
        // The kit control is 30 px tall; taller buttons keep each half a 44 px target.
        <div className="shrink-0 px-4 pt-1 pb-3 [&_button]:min-h-[38px]">
          <SegmentedControl options={['Preview', 'Source']} value={view} onChange={setView} />
        </div>
      )}

      <main
        className={`min-h-0 flex-1 pb-[max(env(safe-area-inset-bottom),12px)] ${
          showPreview && html ? 'flex flex-col' : 'overflow-auto overscroll-contain'
        }`}
      >
        {kind !== 'other' ? (
          !host ? (
            <p className="px-4 pt-8 text-body">Host not available</p>
          ) : kind === 'pdf' ? (
            // ponytail: Chrome's PDF viewer refuses every sandboxed frame (probed on Chrome 1228: '', allow-scripts,
            // allow-same-origin and both together all blank it), so this frame is unsandboxed.
            // The Hub sends the PDF as application/pdf from our own origin, never as HTML.
            <iframe title={name} src={raw()} className="size-full min-h-[70dvh] border-0" />
          ) : kind === 'video' ? (
            <video src={raw()} controls playsInline preload="metadata" className="max-h-full w-full bg-black" />
          ) : (
            <div className="flex flex-col gap-3 px-4 pt-8">
              <audio src={raw()} controls preload="metadata" className="w-full" />
            </div>
          )
        ) : error ? (
          <div className="flex flex-col items-start gap-3 px-4 pt-8">
            <p className="text-body">
              {error === 'not found' ? 'File not found' : error === 'too large' ? 'File is too large' : 'Could not read the file'}
            </p>
            {error !== 'not found' && error !== 'too large' && (
              <>
                <p className="text-caption text-muted">{error}</p>
                <button type="button" onClick={() => setNonce((value) => value + 1)} className="text-body font-medium text-accent">
                  Try again
                </button>
              </>
            )}
          </div>
        ) : !data ? (
          <div aria-busy className="flex flex-col gap-2 px-4 pt-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ) : data.kind === 'binary' ? (
          <p className="px-4 pt-8 font-mono text-caption text-muted">Binary file</p>
        ) : data.kind === 'image' ? (
          <div className="flex min-h-full items-start justify-center p-4">
            <img src={data.src} alt={name} className="h-auto max-w-full" />
          </div>
        ) : showPreview && html ? (
          <div className="mx-3 flex min-h-[50dvh] flex-1 flex-col overflow-hidden rounded-card border border-border lg:mx-4">
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface pl-3 text-caption text-muted">
              <Lock className="shrink-0" />
              {/* It wraps rather than truncates: the note is the safety claim. */}
              <span className="min-w-0 flex-1 py-1.5 leading-snug">{SANDBOX_NOTE}</span>
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
            {host && <iframe key={version} {...FRAME} src={raw({ v: version })} title={`Preview of ${name}`} className="min-h-0 w-full flex-1 border-0 bg-white" />}
            {full && host && <FullPreview src={raw({ v: version })} title={name} note={SANDBOX_NOTE} onClose={() => setFull(false)} />}
          </div>
        ) : showPreview ? (
          // A document reads at document scale; the Markdown component's headings are sized for Chat turns.
          <article className="mx-3 rounded-card border border-border bg-elevated px-4 py-5 text-body lg:mx-4 lg:px-6 [&_h1]:text-[24px] [&_h1]:leading-tight [&_h2]:text-[19px]">
            <Markdown text={data.text} />
          </article>
        ) : (
          <div className="hscroll w-max min-w-full py-1">
            {data.text.split(/\r\n?|\n/).map((line, index) => (
              <div key={index} className="flex font-mono text-caption text-fg">
                <span aria-hidden className="w-9 shrink-0 px-1.5 text-right tabular-nums text-muted select-none">
                  {index + 1}
                </span>
                <span className="pr-4 whitespace-pre">{line}</span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
