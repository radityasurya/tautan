import { useState } from 'react';
import { offeredKeys } from '../shared/blocked.ts';
import { BOX } from '../shared/layout.ts';
import type { Explain } from '../shared/types.ts';
import { keyGlyph } from './keys.ts';
import { Ansi } from './pane.tsx';

/** GET /api/panes/:key/explain — the Hub stamps the id of the prompt it derived this from. */
export type ExplainResponse = Explain & { promptId?: string };

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

/** The box-frame class lives in shared/layout.ts, one definition for card and grid. */
const boxFrame = new RegExp(BOX.source, 'g');

/**
 * The detection as prose: strip the agent's own box frame, drop the empty rows, keep the
 * ANSI so the excerpt reads in the agent's own colours.
 */
const content = (detection: string) =>
  detection
    .split(/\r?\n/)
    .map((l) => l.replace(boxFrame, '').trim())
    .filter((l) => plain(l).trim());

/**
 * The prompt as one line, for a surface with no room for the card (the desktop header).
 * Claude Code heads its box `Bash command` and prints the command under it; any other box
 * leads with its question.
 */
// ponytail: only the `… command` head is special-cased; add a head per App profile when a
// second agent's box reads wrong here.
export function promptLine(explain: Explain): string {
  const [head = 'Blocked', next] = content(explain.detection).map((l) => plain(l).trim());
  return /command$/i.test(head) && next ? next : head;
}

/**
 * The blocked moment as flat rows in the dock: herdr's offered keys are the options, no row
 * is chosen by default (herdr has no ground to recommend one), a pick takes the accent, and
 * Send posts the chosen key with the prompt id the card was drawn from. A 409 swaps the
 * action for Re-read: the prompt moved on, so the answer must not land.
 */
export function Blocked({ explain, agent, stale, onSend, onReread }: {
  explain: ExplainResponse;
  agent?: string;
  /** A 409 from another surface (the desktop header) answering this same prompt. */
  stale?: boolean;
  onSend: (keys: string[], promptId?: string) => Promise<'sent' | 'changed'>;
  onReread: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [head = 'Blocked', ...rest] = content(explain.detection);
  const options = offeredKeys(explain).slice(0, 4);

  const send = async () => {
    if (!picked) return;
    if (await onSend([picked], explain.promptId) === 'changed') setChanged(true);
  };

  return (
    <section
      role="region"
      aria-label="Blocked"
      className="rise flex max-h-[max(60dvh,240px)] flex-col gap-2 overflow-hidden rounded-card border border-border bg-elevated px-3.5 pb-2.5 pt-2.5 shadow-elevated"
    >
      <header className="flex shrink-0 items-baseline justify-between gap-2">
        <p className="truncate text-caption text-muted">{agent ? `${agent} needs your call` : 'Needs your call'}</p>
        <span className="shrink-0 text-caption font-medium text-warn">Blocked</span>
      </header>
      <p className="shrink-0 text-body font-medium text-fg">{plain(head).trim()}</p>

      <div role="group" aria-label="Options" className="flex shrink-0 flex-col gap-1.5">
        {options.map((option) => {
          const on = picked === option.key;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPicked(on ? null : option.key)}
              className={`press flex w-full items-center gap-2.5 rounded-chip border px-2.5 py-2 text-left ${on ? 'border-accent bg-accent/10' : 'border-border bg-bg'}`}
            >
              <span
                aria-hidden
                className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-chip border px-1 font-mono text-caption ${on ? 'border-accent bg-accent text-bg' : 'border-border bg-surface text-fg'}`}
              >
                {keyGlyph(option.key)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-fg">{option.label}</span>
                <span className="block truncate text-caption text-muted">{option.key}</span>
              </span>
            </button>
          );
        })}
      </div>

      <pre
        aria-label="Detection"
        className="min-h-[calc(1.35em*2)] max-h-[calc(1.35em*6)] flex-1 shrink overflow-y-auto rounded-chip bg-surface px-2.5 py-1.5 font-mono text-caption whitespace-pre-wrap text-muted"
        style={{ overscrollBehavior: 'contain' }}
      >
        <Ansi text={rest.join('\n')} />
      </pre>

      {changed || stale ? (
        <div className="flex shrink-0 items-center justify-between gap-2 pt-0.5">
          <p className="text-caption text-warn">The prompt changed. Read it again before you answer.</p>
          <button type="button" onClick={onReread} className="press shrink-0 rounded-chip border border-border bg-bg px-3 py-2 text-caption font-medium text-accent">
            Re-read
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 justify-end pt-0.5">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!picked}
            className={`press rounded-chip px-4 py-2 text-caption font-semibold ${picked ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}
          >
            Send
          </button>
        </div>
      )}
    </section>
  );
}
