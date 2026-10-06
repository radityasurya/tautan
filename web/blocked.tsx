import { useState } from 'react';
import { offeredKeys } from '../shared/blocked.ts';
import { BOX } from '../shared/layout.ts';
import type { Explain } from '../shared/types.ts';
import { keyGlyph } from './keys.ts';
import { Ansi } from './pane.tsx';
import { tokens } from './halaska-kit';

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

/** The dark ink on a warning fill, as the header's Yes uses it. */
const ON_WARN = tokens.dark.bg;

/**
 * The blocked moment, in the composer's place of the suggestions. The phone (`rows`) keeps
 * the pick-then-Send flow on full-width 44 px rows, so a stray tap while scrolling never
 * answers. The desktop (`row`) puts the choices on one line and answers on one
 * click, like the header's quick answer. Both send through `onSend` with the prompt id
 * the card was drawn from; a 409 swaps the choices for Re-read.
 */
export function Blocked({ explain, agent, stale, layout = 'rows', onSend, onReread }: {
  explain: ExplainResponse;
  agent?: string;
  /** A 409 from another surface (the desktop header) answering this same prompt. */
  stale?: boolean;
  layout?: 'rows' | 'row';
  onSend: (keys: string[], promptId?: string) => Promise<'sent' | 'changed'>;
  onReread: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [sending, setSending] = useState(false);
  const [head = 'Blocked', ...rest] = content(explain.detection);
  const options = offeredKeys(explain).slice(0, 4);
  const moved = changed || stale;

  const send = async (key = picked) => {
    if (!key) return;
    setSending(true);
    try {
      if (await onSend([key], explain.promptId) === 'changed') setChanged(true);
    } finally {
      setSending(false);
    }
  };

  const refusal = (
    <>
      <p className="text-caption text-warn">The prompt changed. Read it again before you answer.</p>
      <button type="button" onClick={onReread} className="press shrink-0 rounded-chip border border-border bg-bg px-3 py-2 text-caption font-medium text-accent">
        Re-read
      </button>
    </>
  );
  const asks = (
    <p className="flex items-center gap-2 truncate text-[12px] font-semibold text-warn">
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />
      {agent ? `${agent} needs your call` : 'Needs your call'}
    </p>
  );

  if (layout === 'row') {
    const line = promptLine(explain);
    return (
      <section
        role="region"
        aria-label="Blocked"
        className="rise flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-warn/35 bg-warn/8 px-4 py-3.5"
      >
        <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1.5">
          {asks}
          <code title={line} className="truncate font-mono text-[13px] text-fg">{line}</code>
        </div>
        {moved ? (
          <div className="flex items-center gap-3">{refusal}</div>
        ) : (
          // ponytail: each choice is labelled with the key it sends, not `1 2 3`. Numbered
          // labels (and digit shortcuts) wait for a mapping that matches the Agent's own
          // numbering — Claude Code's 1 Yes, 2 Always, 3 No — which offeredKeys() does not give.
          <div role="group" aria-label="Options" className="flex flex-wrap items-center gap-2">
            {options.map((option, i) => {
              const yes = i === 0 && option.key === 'enter';
              const no = option.key === 'esc';
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-label={`${option.label}, key ${option.key}`}
                  disabled={sending}
                  onClick={() => void send(option.key)}
                  className={`press flex h-9 shrink-0 items-center gap-2 rounded-composer px-3.5 text-[13px] disabled:opacity-50 ${
                    yes ? 'bg-warn font-semibold' : no ? 'border border-border text-danger' : 'bg-surface text-fg'
                  }`}
                  style={yes ? { color: ON_WARN } : undefined}
                >
                  {option.label}
                  <kbd
                    className={`rounded-[4px] border px-[5px] font-mono text-[10.5px] font-normal ${
                      yes ? 'border-current/25' : 'border-border text-muted'
                    }`}
                  >
                    {keyGlyph(option.key)}
                  </kbd>
                </button>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label="Blocked"
      className="rise flex max-h-[max(60dvh,240px)] flex-col gap-2.5 overflow-hidden rounded-card border border-warn/35 bg-warn/8 p-3.5"
    >
      {asks}
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
              aria-label={`${option.label}, key ${option.key}`}
              onClick={() => setPicked(on ? null : option.key)}
              className={`press flex h-11 w-full items-center gap-2.5 rounded-composer border px-3.5 text-left ${
                on ? 'border-accent bg-accent/10' : 'border-border bg-bg'
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{option.label}</span>
              <kbd
                aria-hidden
                className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-chip border px-1 font-mono text-[11px] ${
                  on ? 'border-accent bg-accent text-bg' : 'border-border text-muted'
                }`}
              >
                {keyGlyph(option.key)}
              </kbd>
            </button>
          );
        })}
      </div>

      <pre
        aria-label="Detection"
        className="min-h-[calc(1.35em*2)] max-h-[calc(1.35em*6)] flex-1 shrink overflow-y-auto rounded-chip bg-bg px-2.5 py-1.5 font-mono text-caption whitespace-pre-wrap text-muted"
        style={{ overscrollBehavior: 'contain' }}
      >
        <Ansi text={rest.join('\n')} />
      </pre>

      {moved ? (
        <div className="flex shrink-0 items-center justify-between gap-2 pt-0.5">{refusal}</div>
      ) : (
        <div className="flex shrink-0 justify-end pt-0.5">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!picked || sending}
            className={`press rounded-chip px-4 py-2 text-caption font-semibold ${picked ? 'bg-accent text-bg' : 'bg-surface text-muted'}`}
          >
            Send
          </button>
        </div>
      )}
    </section>
  );
}
