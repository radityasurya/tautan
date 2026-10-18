// The Chat view folds a run of finished tool rows into one line, the way Claude Code prints
// "Ran 2 shell commands, read 3 files". Pure, so the splitting and the words are testable.
import type { Tool } from '../shared/chat.ts';

/** One entry of a turn's tool list: a row on its own, or the indexes of a folded run. */
export type ToolItem = { row: number } | { run: number[] };

/** The rows in order, every run of two or more consecutive rows that `alone` lets fold made
 *  one item. A row `alone` keeps out also ends the run before it. */
export function toolRuns(count: number, alone: (index: number) => boolean): ToolItem[] {
  const items: ToolItem[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) items.push({ run });
    else for (const row of run) items.push({ row });
    run = [];
  };
  for (let index = 0; index < count; index++) {
    if (!alone(index)) { run.push(index); continue; }
    flush();
    items.push({ row: index });
  }
  flush();
  return items;
}

/** A kind of call, the verb its run says, and what it counts. `files` kinds count distinct
 *  paths (the row's brief), so two reads of one file say "read 1 file". Claude, pi and Codex
 *  names; anything else is "used N other tools". */
const KINDS: { test: RegExp; verb: string; noun: string; files?: true }[] = [
  { test: /^(?:bash|exec|exec_command|shell|local_shell_call)$/i, verb: 'ran', noun: 'shell command' },
  { test: /^read$/i, verb: 'read', noun: 'file', files: true },
  { test: /^(?:edit|multiedit|notebookedit)$/i, verb: 'edited', noun: 'file', files: true },
  { test: /^write$/i, verb: 'wrote', noun: 'file', files: true },
  { test: /^(?:grep|glob|find)$/i, verb: 'searched', noun: 'pattern' },
  { test: /^webfetch$/i, verb: 'fetched', noun: 'page' },
];

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A folded run in words, kinds in the order they first ran: "Ran 3 shell commands, read 2
 *  files, used 1 other tool"; "Used 4 tools" when no kind is known. And how many failed. */
export function runSummary(tools: Tool[]): { text: string; failed: number } {
  const seen = new Map<(typeof KINDS)[number], Set<string> | number>();
  let other = 0;
  for (const tool of tools) {
    const kind = tool.via ? undefined : KINDS.find((k) => k.test.test(tool.name));
    if (!kind) { other++; continue; }
    const count = seen.get(kind) ?? (kind.files ? new Set<string>() : 0);
    seen.set(kind, typeof count === 'number' ? count + 1 : count.add(tool.brief));
  }
  const parts = [...seen].map(([kind, count]) => `${kind.verb} ${plural(typeof count === 'number' ? count : count.size, kind.noun)}`);
  if (other) parts.push(parts.length ? `used ${plural(other, 'other tool')}` : `used ${plural(other, 'tool')}`);
  const text = parts.join(', ');
  return { text: text[0]!.toUpperCase() + text.slice(1), failed: tools.filter((tool) => tool.isError).length };
}
