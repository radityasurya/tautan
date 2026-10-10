import { useState } from 'react';
import { offeredKeys, readBox } from '../shared/blocked.ts';
import type { Explain, InputBody } from '../shared/types.ts';
import { haptic } from './app.tsx';
import { keyGlyph } from './keys.ts';
import { Ansi } from './pane.tsx';
import { tokens } from './halaska-kit';

/** GET /api/panes/:key/explain — the Hub stamps the id of the prompt it derived this from. */
export type ExplainResponse = Explain & { promptId?: string };

/** Explain for one Pane, null when it is not blocked. Rejects when offline, so a caller can
 *  keep the Explain it already shows. */
export const fetchExplain = (paneKey: string): Promise<ExplainResponse | null> =>
  fetch(`/api/panes/${encodeURIComponent(paneKey)}/explain`).then((r) => r.json() as Promise<ExplainResponse | null>);

/**
 * The one send for an answer to a blocked prompt: the Pane's card, the Chat view's approval
 * row and the Pane list all use it. The `promptId` makes the Hub refuse with 409 when the prompt on
 * screen moved on, and the caller must see that, so the outcome comes back instead of being
 * swallowed the way `post` does.
 */
export async function sendBlocked(paneKey: string, keys: string[], promptId?: string): Promise<'sent' | 'changed'> {
  haptic();
  try {
    const response = await fetch(`/api/panes/${encodeURIComponent(paneKey)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keys, ...(promptId !== undefined ? { promptId } : {}) } satisfies InputBody),
    });
    return response.status === 409 ? 'changed' : 'sent';
  } catch {
    return 'sent'; // offline: the reconnect bar owns the error, and the card stays honest
  }
}

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

/** One answer on the card: a numbered menu row, or a key the Mux offered. */
interface Choice { id: string; label: string; detail?: string; keys: string[]; glyph: string }

/** The Agent's own numbered menu when the box has one (`1. Yes`, `2. Always`, a question's
 *  options), else the keys the Mux offered. */
const choicesOf = (explain: Explain, menu: ReturnType<typeof readBox>['menu']): Choice[] =>
  menu.length
    ? menu.map((option) => ({ id: option.number, label: option.label, detail: option.detail, keys: option.keys, glyph: option.number }))
    : offeredKeys(explain).slice(0, 4).map((option) => ({ id: option.key, label: option.label, keys: [option.key], glyph: keyGlyph(option.key) }));

/**
 * The prompt as one line, for a surface with no room for the card (the Pane list).
 * Claude Code heads its box `Bash command` and prints the command under it; any other box
 * leads with its question.
 */
// ponytail: only the `… command` head is special-cased; add a head per App profile when a
// second agent's box reads wrong here.
export function promptLine(explain: Explain): string {
  const { head, rest } = readBox(explain.detection);
  const next = rest[0] && plain(rest[0]).trim();
  return /command$/i.test(plain(head)) && next ? next : plain(head).trim();
}

/** The dark ink on a warning fill, as the header's Yes uses it. */
export const ON_WARN = tokens.dark.bg;

/**
 * The blocked moment, in the composer's place of the suggestions. The phone (`rows`) keeps
 * the pick-then-Send flow on full-width 44 px rows, so a stray tap while scrolling never
 * answers. The desktop (`row`) puts the choices on one line and answers on one
 * click. Both send through `onSend` with the prompt id the card was drawn from; a 409 swaps
 * the choices for Re-read. `bare` drops the frame, the heading and the excerpt, for a host
 * that already shows what is asked (the Chat view's approval row).
 */
export function Blocked({ explain, agent, stale, layout = 'rows', bare, onSend, onReread }: {
  explain: ExplainResponse;
  agent?: string;
  /** A 409 from another surface (the Pane list) answering this same prompt. */
  stale?: boolean;
  layout?: 'rows' | 'row';
  bare?: boolean;
  onSend: (keys: string[], promptId?: string) => Promise<'sent' | 'changed'>;
  onReread: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [sending, setSending] = useState(false);
  const { head, rest, menu } = readBox(explain.detection);
  const options = choicesOf(explain, menu);
  const moved = changed || stale;

  const send = async (id = picked) => {
    const choice = options.find((option) => option.id === id);
    if (!choice) return;
    setSending(true);
    try {
      if (await onSend(choice.keys, explain.promptId) === 'changed') setChanged(true);
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
    const choices = moved ? (
      <div className="flex items-center gap-3">{refusal}</div>
    ) : (
      // A numbered menu keeps the Agent's own numbers; a menu row goes out as arrows to it,
      // then enter. Without a menu, each choice is labelled with the key it sends.
      <div role="group" aria-label="Options" className="flex flex-wrap items-center gap-2">
        {options.map((option, i) => {
          const yes = i === 0 && (menu.length ? /^(yes|allow|accept|approve)\b/i.test(option.label) : option.id === 'enter');
          const no = option.id === 'esc' || /^no\b/i.test(option.label);
          return (
            <button
              key={option.id}
              type="button"
              title={option.detail}
              aria-label={menu.length ? `${option.glyph}. ${option.label}` : `${option.label}, key ${option.id}`}
              disabled={sending}
              onClick={() => void send(option.id)}
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
                {option.glyph}
              </kbd>
            </button>
          );
        })}
      </div>
    );
    if (bare) return choices;
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
        {choices}
      </section>
    );
  }

  const group = (
    <div role="group" aria-label="Options" className="flex min-h-[5.5rem] shrink flex-col gap-1.5 overflow-y-auto overscroll-contain">
      {options.map((option) => {
        const on = picked === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={menu.length ? `${option.glyph}. ${option.label}` : `${option.label}, key ${option.id}`}
            aria-description={option.detail}
            onClick={() => setPicked(on ? null : option.id)}
            className={`press flex min-h-11 w-full items-center gap-2.5 rounded-composer border px-3.5 py-1.5 text-left ${
              on ? 'border-accent bg-accent/10' : 'border-border bg-bg'
            }`}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[14px] text-fg">{option.label}</span>
              {option.detail && <span className="line-clamp-2 text-caption text-muted">{option.detail}</span>}
            </span>
            <kbd
              aria-hidden
              className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-chip border px-1 font-mono text-[11px] ${
                on ? 'border-accent bg-accent text-bg' : 'border-border text-muted'
              }`}
            >
              {option.glyph}
            </kbd>
          </button>
        );
      })}
    </div>
  );
  const footer = moved ? (
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
  );
  if (bare) {
    return (
      <div className="flex flex-col gap-2">
        {group}
        {footer}
      </div>
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

      {group}

      <pre
        aria-label="Detection"
        className="min-h-[calc(1.35em*2)] max-h-[calc(1.35em*6)] flex-1 shrink overflow-y-auto rounded-chip bg-bg px-2.5 py-1.5 font-mono text-caption whitespace-pre-wrap text-muted"
        style={{ overscrollBehavior: 'contain' }}
      >
        <Ansi text={rest.join('\n')} />
      </pre>

      {footer}
    </section>
  );
}
