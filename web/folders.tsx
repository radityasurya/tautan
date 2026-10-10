// Folder list over /api/files/list: the picker in New Tab / New Workspace, and Files. One list, two modes: `files` shows files too and taps open them.
import { useEffect, useState } from 'react';
import { Button, Chip, SearchInput, Skeleton, usePal } from './halaska-kit';
import { crumbs, filesUrl, readRecent, size, writeRecent } from './folders-logic.ts';

export type Entry = { name: string; path: string; kind: 'dir' | 'file'; size?: number; mtime?: number };
type Listing = { path: string; home: string; parent: string | null; entries: Entry[]; truncated: boolean };

const WHY: Record<string, string> = {
  escape: 'That folder is outside the places tautan may read',
  'not found': 'That folder does not exist',
  host: 'That Host is gone',
  'not a directory': 'That path is a file, not a folder',
};

const ROW = 'flex min-h-11 w-full items-center gap-3 px-1 text-left outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)]';

export function FolderBrowser({
  hostId,
  paneKey,
  start,
  files,
  recents,
  onFile,
  onUse,
}: {
  hostId: string;
  paneKey?: string;
  /** Where to open; empty means the Host home. */
  start?: string;
  /** Show files too, and open them with `onFile`. */
  files?: boolean;
  /** Offer the recent folders of this Host above the list, except the one open. */
  recents?: boolean;
  onFile?: (path: string) => void;
  /** The "Use this folder" action; omit it for browse-only. */
  onUse?: (path: string) => void;
}) {
  const pal = usePal();
  const [path, setPath] = useState(start ?? '');
  const [hidden, setHidden] = useState(false);
  const [q, setQ] = useState('');
  const [nonce, setNonce] = useState(0);
  const [list, setList] = useState<Listing | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPath(start ?? '');
  }, [start]);

  useEffect(() => {
    const controller = new AbortController();
    setList(null);
    setError('');
    fetch(filesUrl('list', { host: hostId, path, pane: paneKey, hidden: hidden ? '1' : undefined }), { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.json().then((v: { error?: string }) => v.error ?? `http ${r.status}`, () => `http ${r.status}`));
        setList((await r.json()) as Listing);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      });
    return () => {
      controller.abort();
    };
  }, [hostId, paneKey, path, hidden, nonce]);

  const go = (p: string) => {
    setQ('');
    setPath(p);
  };
  const needle = q.trim().toLowerCase();
  const rows = (list?.entries ?? []).filter((e) => (files || e.kind === 'dir') && (!needle || e.name.toLowerCase().includes(needle)));
  const recent = recents && !needle ? readRecent(hostId).filter((p) => p !== list?.path) : [];

  return (
    <div className="flex flex-col gap-3">
      {list && (
        <nav aria-label="Path" className="hscroll flex gap-1 whitespace-nowrap">
          {crumbs(list.path, list.home).map((c, i, all) => (
            <button
              key={c.path}
              type="button"
              onClick={() => go(c.path)}
              aria-current={i === all.length - 1 ? 'page' : undefined}
              className="min-h-11 shrink-0 px-2 text-body outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)]"
              style={{ color: i === all.length - 1 ? pal.text : pal.accent }}
            >
              {i > 0 && c.path !== '/' ? <span style={{ color: pal.textTertiary }}>/ </span> : null}
              {c.label}
            </button>
          ))}
        </nav>
      )}
      <div className="flex items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={files ? 'Filter' : 'Filter folders'} shortcut="" style={{ flex: 1, height: 44 }} />
        <Chip selected={hidden} onToggle={() => setHidden(!hidden)}>
          Hidden
        </Chip>
      </div>

      {recent.length > 0 && (
        <div className="flex flex-col">
          <p className="text-caption text-muted">Recent</p>
          {recent.map((p) => (
            <button key={p} type="button" className={ROW} onClick={() => go(p)}>
              <span aria-hidden>↺</span>
              <span className="min-w-0 flex-1 truncate font-mono text-caption">{p}</span>
            </button>
          ))}
        </div>
      )}

      {error ? (
        <div role="alert" className="flex flex-col items-start gap-2 py-2">
          <p className="text-body">{WHY[error] ?? `Could not list the folder · ${error}`}</p>
          <div className="flex gap-2">
            {path && (
              <Button variant="outline" size="sm" onClick={() => go('')}>
                Go to home
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setNonce(nonce + 1)}>
              Try again
            </Button>
          </div>
        </div>
      ) : !list ? (
        <div aria-busy className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <ul className="flex flex-col">
          {list.parent && !needle && (
            <li>
              <button type="button" className={ROW} onClick={() => go(list.parent!)}>
                <span aria-hidden>↑</span>
                <span className="text-body">Up</span>
              </button>
            </li>
          )}
          {rows.map((e) => (
            <li key={e.path}>
              <button type="button" className={ROW} onClick={() => (e.kind === 'dir' ? go(e.path) : onFile?.(e.path))}>
                <span aria-hidden style={{ color: pal.textTertiary }}>{e.kind === 'dir' ? '▸' : '·'}</span>
                <span className="min-w-0 flex-1 truncate text-body">{e.name}</span>
                {e.kind === 'file' && <span className="shrink-0 text-caption text-muted">{size(e.size)}</span>}
              </button>
            </li>
          ))}
          {rows.length === 0 && <li className="py-2 text-caption text-muted">{needle ? 'No match' : files ? 'Empty folder' : 'No folders here'}</li>}
          {list.truncated && <li className="py-2 text-caption text-muted">The list is cut short. Type to filter.</li>}
        </ul>
      )}

      {onUse && (
        <div className="sticky bottom-0 -mx-1 bg-bg px-1 pt-2 pb-1">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            disabled={!list}
            onClick={() => {
              if (!list) return;
              writeRecent(hostId, list.path);
              onUse(list.path);
            }}
          >
            Use this folder
          </Button>
        </div>
      )}
    </div>
  );
}
