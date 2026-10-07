// Pure helpers for the folder picker and the file viewer's folder view.
import { store } from './store.tsx';

/** Breadcrumb steps for an absolute `path`. A path under `home` starts at `~`. */
export function crumbs(path: string, home: string): { label: string; path: string }[] {
  const base = home && (path === home || path.startsWith(`${home}/`)) ? home : '';
  const out = base ? [{ label: '~', path: base }] : [{ label: '/', path: '/' }];
  let at = base;
  for (const part of path.slice(base.length).split('/').filter(Boolean)) {
    at = `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

export const dirname = (path: string) => {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/');
  return cut < 0 ? '' : cut === 0 ? '/' : path.slice(0, cut);
};

/** A viewer path to something the list and raw routes accept: absolute, `~`, or under the Pane cwd. */
export const absolute = (path: string, cwd?: string) =>
  path.startsWith('/') || path.startsWith('~') || !cwd ? path : `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`;

export type Viewer = 'pdf' | 'video' | 'audio' | 'other';
const VIDEO = /\.(mp4|m4v|webm|mov|ogv)$/i;
const AUDIO = /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i;
export const viewerFor = (path: string): Viewer =>
  /\.pdf$/i.test(path) ? 'pdf' : VIDEO.test(path) ? 'video' : AUDIO.test(path) ? 'audio' : 'other';

/** Recent folders, newest first, no duplicates, at most `max`. */
export const pushRecent = (list: string[], path: string, max = 8) =>
  [path, ...list.filter((p) => p !== path)].slice(0, max);

const key = (hostId: string) => `tautan.folders.${hostId}`;
export function readRecent(hostId: string): string[] {
  try {
    const v = JSON.parse(store.get(key(hostId)) ?? '[]');
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}
export function writeRecent(hostId: string, path: string) {
  try {
    store.set(key(hostId), JSON.stringify(pushRecent(readRecent(hostId), path)));
  } catch {
    // ponytail: private mode or a full quota only loses the recents.
  }
}

export const filesUrl = (route: 'list' | 'raw', o: Record<string, string | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) q.set(k, v);
  return `/api/files/${route}?${q}`;
};
