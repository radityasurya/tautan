import type { Explain } from '../shared/types.ts';
import { ApprovalCardPattern } from './halaska-kit';
import { Ansi } from './pane.tsx';

const BOX = /[─-╿▀-▟]/g;

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The detection as prose: strip the agent's own box frame, drop the empty rows, keep the
 * ANSI so the excerpt reads in the agent's own colours.
 */
const content = (detection: string) =>
  detection
    .split(/\r?\n/)
    .map((l) => l.replace(BOX, '').trim())
    .filter((l) => plain(l).trim());

/**
 * The blocked moment as the kit's approval card: herdr's offered keys become the radio
 * rows, Approve sends the chosen key, Skip holds. The detection excerpt rides under the
 * card, still in the agent's own colours. Sending is the caller's job: this card never
 * talks to the Hub.
 */
export function Blocked({ explain, agent, onSend }: { explain: Explain; agent?: string; onSend: (keys: string[]) => void }) {
  const [head = 'Blocked', ...rest] = content(explain.detection);
  const title = plain(head).trim();
  const options = (explain.hintKeys.length ? explain.hintKeys : [{ key: 'enter', label: 'Continue' }])
    .slice(0, 4)
    .map((h) => ({ id: h.key, title: h.label, sub: h.key }));

  return (
    <section role="region" aria-label="Blocked" className="rise mx-3 mb-2.5 flex flex-col gap-2.5">
      <ApprovalCardPattern
        eyebrow={agent ? `${agent} needs your call` : 'Needs your call'}
        badgeLabel="Blocked"
        question={title}
        options={options}
        approveLabel="Send"
        skipLabel="Hold"
        approvedText={(o: { title: string }) => `Sent · ${o.title}`}
        onApprove={(o: { id: string }) => onSend([o.id])}
      />
      {rest.length > 0 && (
        <pre className="overflow-hidden rounded-card bg-elevated px-3.5 py-2.5 font-mono text-caption text-ellipsis whitespace-pre-wrap text-muted shadow-elevated">
          <Ansi text={rest.slice(0, 2).join('\n')} />
        </pre>
      )}
    </section>
  );
}
