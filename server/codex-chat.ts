import { join } from 'node:path';
import type { TranscriptIo } from './chat.ts';

/** The Codex transcript root: `${CODEX_HOME:-$HOME/.codex}` (Wave 12.1). `-p/--profile` layers
 *  a config beside it and moves nothing, so this is the only root; an unknown per-Pane
 *  CODEX_HOME stays unresolved. */
export function codexHome(home: string): string {
  return process.env.CODEX_HOME ?? join(home, '.codex');
}

const threadId = /^[0-9a-f-]{36}$/;

/** Resolve a Codex thread id to its one rollout file, exactly per the Wave 12.1 decision:
 *  under the Codex home, `sessions/` and `archived_sessions/` together must hold exactly one
 *  `rollout-*-${id}.jsonl`, and its first `session_meta` record's `payload.id` must equal the
 *  id. Zero, duplicate, compressed-only or mismatched → `undefined` (the Pane keeps its
 *  Screen). Never cwd, mtime or newest-file. */
export async function resolveCodexPath(io: TranscriptIo, id: string, home: string, target?: string): Promise<string | undefined> {
  if (!threadId.test(id) || !io.find || !io.head) return undefined;
  const pattern = `rollout-*-${id}.jsonl`;
  let found: string[] = [];
  for (const dir of ['sessions', 'archived_sessions']) {
    try { found = [...found, ...await io.find(join(home, dir), pattern, target) ?? []]; } catch { return undefined; }
  }
  if (found.length !== 1) return undefined;
  let line: string | undefined;
  try { line = await io.head(found[0]!, target); } catch { return undefined; }
  try {
    const value: unknown = JSON.parse(line ?? '');
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : {};
    return record.type === 'session_meta' && payload.id === id ? found[0] : undefined; // the type is record-level
  } catch { return undefined; }
}
