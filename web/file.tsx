// Full-screen file viewer (#/file/<paneKey>?path=). The Hub reads the file in the Pane cwd.
import { useEffect, useState } from 'react';
import type { State } from '../shared/types.ts';
import { Back } from './icons.tsx';
import { Skeleton } from './halaska-kit';
import { FolderBrowser } from './folders.tsx';
import { absolute, dirname, filesUrl, viewerFor } from './folders-logic.ts';
import { fileView } from './image.tsx';

type FileData = { kind: 'image'; src: string } | { kind: 'text'; text: string } | { kind: 'binary' };

export function FileScreen({ paneKey, path, state }: { paneKey: string; path: string; state: State | null }) {
  const pane = state?.panes.find((item) => item.key === paneKey);
  const mux = state?.muxes.find((item) => item.key === pane?.muxKey);
  const host = state?.hosts.find((item) => item.id === mux?.hostId);
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<FileData | null>(null);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const abs = absolute(path, pane?.cwd);
  const kind = viewerFor(path);
  const raw = (download?: boolean) =>
    host ? filesUrl('raw', { host: host.id, path: abs, pane: paneKey, download: download ? '1' : undefined }) : '';

  useEffect(() => {
    setBrowsing(false);
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    let imageUrl = '';
    setData(null);
    setError('');

    if (!path) {
      setError('not found');
      return () => controller.abort();
    }
    // Media and PDF stream from /api/files/raw (ranges); only text and images are read here.
    if (kind !== 'other') return () => controller.abort();

    fetch(`/api/panes/${encodeURIComponent(paneKey)}/file?path=${encodeURIComponent(path)}`, {
      signal: controller.signal,
    })
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
          setData({ kind: 'image', src: imageUrl });
          return;
        }
        try {
          setData({ kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
        } catch {
          setData({ kind: 'binary' });
        }
      })
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message);
      });

    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [paneKey, path, nonce, kind]);

  const name = path.split('/').filter(Boolean).at(-1) ?? path;
  const context = [pane?.title, host?.label].filter(Boolean).join(' · ') || 'Pane';

  return (
    <div className="mx-auto flex h-dvh w-full max-w-4xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex h-11 shrink-0 items-center gap-1 pr-4 pl-1">
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
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-title tracking-tight">{name || 'File'}</h1>
          <p className="truncate text-caption text-muted">{context}</p>
        </div>
        {host && path && (
          <>
            <button
              type="button"
              aria-pressed={browsing}
              onClick={() => setBrowsing(!browsing)}
              className="flex min-h-11 shrink-0 items-center px-2 text-body font-medium text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]"
            >
              Folder
            </button>
            <a
              href={raw(true)}
              download={name}
              className="flex min-h-11 shrink-0 items-center px-2 text-body font-medium text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]"
            >
              Download
            </a>
          </>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-auto pb-[max(env(safe-area-inset-bottom),12px)]">
        {browsing && host ? (
          <div className="px-4 pt-2">
            <FolderBrowser
              hostId={host.id}
              paneKey={paneKey}
              start={dirname(abs)}
              files
              onFile={(p) => {
                setBrowsing(false); // the same file leaves the hash unchanged, so close the list here
                location.hash = fileView(paneKey, p);
              }}
            />
          </div>
        ) : kind !== 'other' && path ? (
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
        ) : (
          <div className="hscroll w-max min-w-full py-1">
            {data.text.split('\n').map((line, index) => (
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
