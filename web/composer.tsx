import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type HTMLAttributes, type RefObject } from 'react';
import type { Affordance, InputBody, Span, StatePane } from '../shared/types.ts';
import { hintPills } from './affordances.tsx';
import { haptic, post, reducedMotion } from './app.tsx';
import { Blocked, type ExplainResponse, type SendOutcome } from './blocked.tsx';
import { Attach, Keyboard, Mic, ScreenLens, Send } from './icons.tsx';
import { applyKeyPrefs, capInput, directKey, editableCaps, enterAction, modified, MODIFIERS, moveRow, moveRowTo, parseKeyPrefs, pastedFiles, toKeyPrefs, trayGroups, type Cap, type KeyPrefs, type Modifier } from './keys.ts';
import { applyPick, Picker, tokenAt, useComplete, type Item } from './complete.tsx';
import { toolbarFromScreen, type Profile } from './profiles.ts';
import { quickReplies, type Pill } from './replies.ts';
import { deliver, dropPending, flushHeld, heldOf, isFlushing, pendingSnapshot, runsOutside, subscribePending, trackPending } from './pending.ts';
import { showingSubagent, subscribeShowing } from './subagents.ts';
import { store } from './store.tsx';

/** "Wider than the viewport" is a fade, not a scrollbar. The grid and the Diff screen reuse it. */
export const FADE = 'linear-gradient(to right,#000 calc(100% - 24px),transparent)';

/**
 * The two trays above the input, remembered per kind, one open at a time. An Agent opens on its
 * suggestions; a shell opens on its keys, and its recent commands live in the suggestions tray.
 */
type Tray = 'suggest' | 'keys';
const TRAY_DEFAULT: Record<'agent' | 'shell', Record<Tray, boolean>> = {
  agent: { suggest: true, keys: false },
  shell: { suggest: false, keys: true },
};
const readTray = (kind: 'agent' | 'shell', tray: Tray): boolean => {
  const v = store.get(`tautan.tray.${tray}.${kind}`);
  return v === null ? TRAY_DEFAULT[kind][tray] : v === 'on';
};

/** sessionStorage that never throws: a blocked store loses the draft, never the typing. A
 *  draft survives a reload and dies with the tab. */
const draftKey = (paneKey: string) => `tautan.draft.${paneKey}`;
const readDraft = (paneKey: string): string => {
  try { return sessionStorage.getItem(draftKey(paneKey)) ?? ''; } catch { return ''; }
};
const writeDraft = (paneKey: string, text: string) => {
  try {
    if (text) sessionStorage.setItem(draftKey(paneKey), text);
    else sessionStorage.removeItem(draftKey(paneKey));
  } catch {}
};

/** Slash commands that open a menu or a prompt on the Screen and write nothing to the
 *  transcript until they finish, so the Chat view would show nothing while they wait.
 *  ponytail: a fixed list of Claude's and pi's; extend it when another one turns up. */
const SCREEN_COMMAND = /^\/(login|logout|model|config|settings|permissions|resume|agents|mcp|hooks|status|theme|tree|fork|hotkeys|plugin|help|usage|cost|context|skills|tasks|export|effort|memory|ide|add-dir|rewind|workflows)$/;

/** The Pane the Composer types straight into, whether its field has focus, and how to give it
 *  focus: the Screen draws its caret from this, and a tap on the Screen focuses the field. */
export interface Typing { paneKey: string; focused: boolean; focus: () => void }
let typing: Typing | null = null;
const typingListeners = new Set<() => void>();
export const subscribeTyping = (fn: () => void) => {
  typingListeners.add(fn);
  return () => { typingListeners.delete(fn); };
};
export const typingSnapshot = () => typing;
const setTyping = (next: Typing | null) => {
  typing = next;
  typingListeners.forEach((fn) => fn());
};

/** The key bar the user chose, per kind. */
/** Agents whose own prompt queues a reply typed mid-run (pi steers with it). */
const QUEUES = new Set(['claude', 'pi', 'omp']);
const keysKey = (kind: 'agent' | 'shell') => `tautan.keys.${kind}`;
const readKeyPrefs = (kind: 'agent' | 'shell'): KeyPrefs | null => parseKeyPrefs(store.get(keysKey(kind)));

/** `1.2 MB` for the composer chip. */
const human = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;

// ponytail: the attach reply is three fields, so it is declared here instead of imported
// from shared/types.ts; the Hub owns its own copy of the same shape.
interface Attached {
  path: string;
  bytes: number;
  display: string;
}

interface Upload {
  id: number;
  file: File;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  path?: string;
  display?: string;
  reason?: string;
}

// ponytail: a module counter, only a React key and an XHR map key; it never leaves the tab.
let uploadId = 0;

/** The Hub's `error` field as one short phrase. Anything else is simply a failed upload. */
const REASONS: Record<string, string> = {
  'too large': 'too large',
  body: 'empty file',
  origin: 'blocked by the Hub',
  'pane not found': 'Pane is gone',
};

const whyFailed = (xhr: XMLHttpRequest): string => {
  try {
    return REASONS[(JSON.parse(xhr.responseText) as { error?: string }).error ?? ''] ?? 'upload failed';
  } catch {
    return 'upload failed';
  }
};

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

// ---- shell history ----
// ponytail: one list for every shell Pane, kept on this device, of what was sent from the
// composer — the Mux has no shell history to read. Per-Host lists if one list gets noisy.
const HISTORY = 'tautan.history';
const HISTORY_MAX = 8;
const readHistory = (): string[] => {
  try {
    const list = JSON.parse(store.get(HISTORY) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
};
// ponytail: a secret prompt is guessed from the Screen's last non-empty line by keyword; a
// prompt that does not say password, PIN, token or secret is not caught. That keyword list is
// the ceiling; the upgrade is asking the Mux whether the tty has echo off.
const SECRET_PROMPT = /pass(word|phrase)|PIN|token|secret/i;
/** Record only when the Screen is known and its prompt line does not ask for a secret. */
export const mayRemember = (lines: string[] | null): boolean => {
  if (!lines) return false;
  const last = [...lines].reverse().find((l) => l.trim());
  return !SECRET_PROMPT.test(last ?? '');
};
const remember = (command: string): string[] => {
  const list = [command, ...readHistory().filter((c) => c !== command)].slice(0, HISTORY_MAX);
  store.set(HISTORY, JSON.stringify(list));
  return list;
};

function RecordingPill({
  analyser,
  onCancel,
  onDone,
}: {
  analyser: AnalyserNode | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [calm] = useState(reducedMotion);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState(() => Array(calm ? 1 : 5).fill(0) as number[]);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const sample = () => {
      analyser.getByteFrequencyData(data);
      const count = calm ? 1 : 5;
      setLevels(Array.from({ length: count }, (_, i) => {
        const from = Math.floor(i * data.length / count);
        const to = Math.floor((i + 1) * data.length / count);
        let total = 0;
        for (let j = from; j < to; j += 1) total += data[j]!;
        return total / Math.max(1, to - from) / 255;
      }));
    };
    sample();
    const timer = setInterval(sample, calm ? 250 : 80);
    return () => clearInterval(timer);
  }, [analyser, calm]);

  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div className="rise flex min-h-10 items-center gap-2 rounded-composer border border-border bg-surface px-1.5">
      <button type="button" onClick={onCancel} className="press min-h-9 px-2 text-caption font-medium text-muted">
        Cancel
      </button>
      <span aria-live="polite" className="text-caption font-semibold text-fg">Recording</span>
      {analyser && (
        <span aria-hidden className="flex h-5 flex-1 items-center justify-center gap-0.5">
          {levels.map((level, i) => (
            <span
              key={i}
              className="w-1 rounded-full bg-accent transition-[height] duration-75 ease-out motion-reduce:transition-none"
              style={{ height: `${Math.max(4, Math.round(level * 20))}px` }}
            />
          ))}
        </span>
      )}
      <time className={`font-mono text-caption tabular-nums text-muted ${analyser ? '' : 'ml-auto'}`}>{time}</time>
      <button type="button" onClick={onDone} className="press min-h-9 px-2 text-caption font-semibold text-accent">
        Done
      </button>
    </div>
  );
}

/** The context ring: the share LEFT until auto-compact, drawn as the filled arc. */
function ContextLeft({ left }: { left: number }) {
  const arc = 2 * Math.PI * 14;
  return (
    <span title="Context left until auto-compact" className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
      <svg aria-hidden width="14" height="14" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="14" fill="none" stroke="var(--border)" strokeWidth="5" />
        <circle
          cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="5"
          strokeDasharray={`${(arc * Math.min(100, left)) / 100} ${arc}`}
          transform="rotate(-90 18 18)"
        />
      </svg>
      {left}% context left
    </span>
  );
}

/** Every composer control: a surface fill and `fg` ink on hover (Tailwind's `hover:` only
 *  matches a pointer that hovers, so a phone never sticks on it), and a visible focus ring. */
const RING =
  'outline-none transition-[transform,background-color,color,border-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
const HOVER = `${RING} hover:bg-surface hover:text-fg`;

/** The hairline between toolbar groups. */
const Divider = () => <span aria-hidden className="mx-1 h-[18px] w-px shrink-0 bg-border" />;

/** A dock control keeps the keyboard up: the press never takes focus from the field. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** A touch screen: Return breaks the line and the Send button sends, because a reply typed on
 *  a phone keyboard is easy to send half-written. */
export const COARSE = matchMedia('(pointer: coarse)').matches;

/**
 * The dock under the Screen, at both widths. Two toggles, Suggestions and Keys, each open
 * their own tray, one at a time; both closed leave the input alone. Send (Run for a shell) is
 * always the right-most control and stands alone. On the phone the trays sit above a rounded
 * box, and its toolbar holds the toggles, an Agent's esc and ^C, attach, `/` and `@`, mic.
 * On desktop (`lg`) the box is the whole dock, flush with the column under one hairline: the
 * open tray is a strip inside it above the field, and the bar holds the toggles, then the
 * model and context read off the Screen, attach and mic; esc, ^C and ⇧⇥ live in Keys.
 * A blocked prompt keeps its card on top; a Pane with no Agent gets a `$` prompt, and its
 * recent commands are its suggestions. No dock control takes focus from the field, so the
 * phone's keyboard stays up through a tap on a key or a pill.
 */
export function Composer({
  paneKey,
  pane,
  desktop,
  profile,
  affordances,
  lines,
  explain,
  stale,
  onAnswer,
  onReread,
  cardRef,
  hideCard,
  onScreenCommand,
  dropZone,
}: {
  paneKey: string;
  pane?: StatePane;
  desktop: boolean;
  profile: Profile;
  /** The Hints of the Screen on the grid, for the key pills. */
  affordances: Affordance[];
  /** This Pane's own Screen, or null while the last Pane's is still held on the grid. */
  lines: Span[][] | null;
  explain: ExplainResponse | null;
  /** The last answer to this prompt came back 409, from the card or the header. */
  stale: boolean;
  onAnswer: (keys: string[], promptId?: string) => Promise<SendOutcome>;
  onReread: () => void;
  /** The card's live region, so the header's Review can bring it into view. */
  cardRef: RefObject<HTMLDivElement | null>;
  /** The Chat view shows the prompt in the transcript: the card stays out, the text box stays. */
  hideCard?: boolean;
  /** A command whose whole UI is on the Screen (`/login`) went out from the Chat view. */
  onScreenCommand?: () => void;
  /** The Chat view above the box: a file dropped anywhere on it attaches here. */
  dropZone?: RefObject<HTMLElement | null>;
}) {
  const agent = pane?.agent;
  const status = pane?.status ?? 'unknown';
  const kind = agent ? 'agent' : 'shell';
  const subagentOpen = useSyncExternalStore(subscribeShowing, () => showingSubagent(paneKey)) !== undefined;

  const [trays, setTrays] = useState(() => ({
    agent: { suggest: readTray('agent', 'suggest'), keys: readTray('agent', 'keys') },
    shell: { suggest: readTray('shell', 'suggest'), keys: readTray('shell', 'keys') },
  }));
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [paneKey, status]);

  // Smart replies are the phone's own switch; Settings writes it and tells the Hub too.
  const [smart] = useState(() => store.get('tautan.smart') === 'on');

  // The Hub drafts on a Status change, so a Pane that blocked before the switch went on
  // has none. Ask once per revision; a Hub with Smart replies off answers with the Pane
  // unchanged and nothing leaves it.
  const asked = useRef('');
  useEffect(() => {
    const stamp = `${paneKey}@${pane?.revision}`;
    if (!smart || !pane?.agent || pane.status !== 'blocked' || pane.suggestions?.length || asked.current === stamp) return;
    asked.current = stamp;
    void post(paneKey, 'suggest', {});
  }, [smart, paneKey, pane?.agent, pane?.status, pane?.revision, pane?.suggestions?.length]);

  // Mode, model and context come off this Pane's own Screen; a held Screen states nothing.
  const screenText = useMemo(() => lines?.map((spans) => spans.map((s) => s.text).join('')) ?? null, [lines]);
  const toolbar = useMemo(() => (screenText ? toolbarFromScreen(profile, screenText) : {}), [profile, screenText]);

  const [history, setHistory] = useState(readHistory);

  // The frame changes tree shape at 1024 px, so a resize remounts the Composer: the draft
  // lives outside it, per Pane, and a Pane switch brings back that Pane's own draft.
  const [text, setText] = useState(() => readDraft(paneKey));
  const draftPane = useRef(paneKey);
  useEffect(() => {
    if (draftPane.current !== paneKey) {
      draftPane.current = paneKey;
      setText(readDraft(paneKey));
      return;
    }
    writeDraft(paneKey, text); // a send clears the field, and with it the draft
  }, [paneKey, text]);
  // Held replies live in web/pending.ts, not here: they outlive this Composer and go out on
  // their own when the Pane is idle again (autoDeliver, driven by the App).
  const heldMessages = heldOf(useSyncExternalStore(subscribePending, pendingSnapshot), paneKey);
  const sendingHeld = isFlushing(paneKey);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    // Phone: 4 rows at line-height 20 plus padding. Desktop: about eight rows of 22.
    el.style.height = `${Math.min(el.scrollHeight, desktop ? 184 : 96)}px`;
  }, [text, desktop, kind]);

  // ctrl and alt are one-shot: armed, the next cap or typed character goes out with it.
  const [armed, setArmed] = useState<Modifier | null>(null);
  useEffect(() => setArmed(null), [paneKey, kind]);

  // ---- typing straight into the Pane ----
  // On the Screen (and a shell), the field can stop composing a line: each key goes out as it
  // is typed, as in a terminal, and the field stays empty. Remembered per kind. `hideCard` is
  // true exactly while the Chat view shows this Pane, where a line is what the Agent reads.
  // A shell is a terminal, so it types directly until the user turns that off; an Agent composes.
  const [direct, setDirect] = useState(() => ({ agent: store.get('tautan.direct.agent') === 'on', shell: store.get('tautan.direct.shell') !== 'off' }));
  const directOn = direct[kind] && !hideCard;
  const toggleDirect = () => {
    haptic();
    const on = !direct[kind];
    store.set(`tautan.direct.${kind}`, on ? 'on' : 'off');
    setDirect((d) => ({ ...d, [kind]: on }));
    setText('');
    input.current?.focus();
  };
  /** One lane per Composer, so keys reach the Pane in the order they were typed. Text typed
   *  while a request is out joins the one waiting its turn: a burst goes as one request, not
   *  one round trip per key. */
  const lane = useRef<Promise<unknown>>(Promise.resolve());
  const queuedInput = useRef<{ paneKey: string; body: InputBody } | null>(null);
  const typeRaw = (body: InputBody) => {
    const next = queuedInput.current;
    if (next?.paneKey === paneKey && next.body.text !== undefined && !next.body.keys && body.text !== undefined && !body.keys) {
      next.body.text += body.text;
      return;
    }
    const queued = { paneKey, body };
    queuedInput.current = queued;
    lane.current = lane.current.then(() => {
      if (queuedInput.current === queued) queuedInput.current = null;
      return post(queued.paneKey, 'input', body);
    });
  };
  const composing = useRef(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!directOn) return;
    setTyping({ paneKey, focused, focus: () => input.current?.focus() });
    return () => setTyping(null);
  }, [directOn, paneKey, focused]);
  // React's onBeforeInput carries no inputType; the native event does.
  useEffect(() => {
    const el = input.current;
    if (!el || !directOn) return;
    const on = (event: InputEvent) => {
      if (event.inputType === 'insertCompositionText') return; // compositionend sends it whole
      if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
        event.preventDefault();
        return typeRaw({ keys: ['enter'] });
      }
      if (!event.inputType.startsWith('insert')) return event.preventDefault(); // nothing to delete
      const data = event.data ?? event.dataTransfer?.getData('text/plain');
      event.preventDefault();
      if (!data) return;
      if (armed && [...data].length === 1) {
        setArmed(null);
        return typeRaw({ keys: [modified(armed, data)] });
      }
      typeRaw({ text: data });
    };
    el.addEventListener('beforeinput', on);
    return () => el.removeEventListener('beforeinput', on);
  }, [directOn, armed, paneKey]);

  // ---- completion ----
  // `/` at the start and `@` anywhere complete from the Hub; a shell has neither. Esc closes
  // the picker for as long as the text stays as it was.
  const [caret, setCaret] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const token = agent && !armed && closedAt !== text ? tokenAt(text, caret) : null;
  const found = useComplete(paneKey, token);
  const items = token ? found : [];
  const open = items.length > 0;
  useEffect(() => { setClosedAt(null); }, [paneKey]);
  useEffect(() => { setActive(0); }, [found, token?.kind]);
  const place = useRef<number | null>(null);
  useEffect(() => {
    const at = place.current;
    place.current = null;
    if (at === null) return;
    input.current?.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);
  const pick = (item: Item) => {
    if (!token) return;
    haptic();
    if (token.kind === 'model' || token.kind === 'effort') return send(`/${token.kind} ${item.value}`);
    const next = applyPick(text, token, item);
    place.current = next.caret;
    setText(next.text);
    input.current?.focus();
  };
  const pickerId = 'composer-complete';

  // ---- attachments ----
  // `post()` is JSON only. An upload wants progress and an abort, so it goes out on XHR:
  // the browser sets Origin either way, which is what the Hub checks.
  const [uploads, setUploads] = useState<Upload[]>([]);
  /** A file is dragged over the box. The Keys tray's own cap drag carries no files. */
  const [fileOver, setFileOver] = useState(false);
  const carriesFiles = (e: { dataTransfer: DataTransfer | null }) => !directOn && !!e.dataTransfer?.types.includes('Files');
  const picker = useRef<HTMLInputElement>(null);
  const running = useRef(new Map<number, XMLHttpRequest>());

  /** An Agent's reply also goes to the Chat view as a pending turn. Claude and pi queue a reply
   *  typed while they work, so it goes out at once; any other Agent's is held while it works,
   *  and goes out by itself once the Pane is idle or done again. */
  const say = (body: string, now = false) => {
    if (status === 'working' && !QUEUES.has(agent ?? '')) trackPending(paneKey, body, true);
    else void deliver(trackPending(paneKey, body), now);
  };

  /** Claude works: Enter queues a reply, and Ctrl+Enter sends it with the queue at once. */
  const claudeWorking = status === 'working' && /^claude/i.test(agent ?? '');

  /** `now` is Claude's Ctrl+Enter, only ever set while it works. With nothing typed it still
   *  sends whatever Claude has queued, as Claude's own box does. */
  const send = (override?: string, now = false) => {
    const raw = override ?? text;
    const sent = raw.trim();
    if (!sent) {
      if (now) keys(['ctrl+enter']);
      return;
    }
    // A bare `/model` opens the card first; the same text with a space sends it as typed.
    // `/effort` does the same on Claude, the one Agent the Hub lists effort levels for. The
    // caret goes after the space, or the token under it is still the command.
    if (override === undefined && agent && (raw === '/model' || (raw === '/effort' && /^claude/i.test(agent)))) {
      place.current = raw.length + 1;
      return setText(`${raw} `);
    }
    // A stray Return at the end (the phone's Return breaks the line) does not go out.
    const body = raw.replace(/\n+$/, '');
    haptic();
    // A shell has no transcript, and neither has a command the Agent runs outside its own:
    // the line goes straight to the Pane, and the Screen shows what it did.
    // ponytail: one an Agent holds (it does not queue, and it works) still goes through `say`.
    const outside = !!agent && runsOutside(agent, sent) && (status !== 'working' || QUEUES.has(agent));
    if (agent && !outside) say(body, now);
    else void post(paneKey, 'input', { text: body, keys: ['enter'] } satisfies InputBody);
    if (agent && hideCard && (outside || SCREEN_COMMAND.test(sent))) onScreenCommand?.();
    if (!agent && mayRemember(screenText)) setHistory(remember(sent));
    setText('');
    writeDraft(paneKey, '');
    // The paths went with the text. A chip still uploading keeps its place. Focus stays where
    // it was: Send keeps it in the field, and a ✦ draft sent from a phone keeps the keyboard down.
    setUploads((list) => list.filter((u) => u.status === 'uploading'));
  };

  const keys = (names: string[]) => {
    haptic();
    void post(paneKey, 'input', { keys: names } satisfies InputBody);
  };

  const arm = (mod: Modifier) => {
    haptic();
    setArmed((a) => (a === mod ? null : mod));
  };
  const press = (cap: Cap) => {
    haptic();
    setArmed(null);
    if (armed && cap.keys?.join() === 'esc') return; // esc while armed only disarms
    void post(paneKey, 'input', capInput(cap, armed) satisfies InputBody);
  };

  /** A ✦ draft is not an answer yet: it lands in the composer for review. On a phone the field
   *  is not focused, so the keyboard stays down and Send is one tap away. */
  const fill = (reply: string) => {
    haptic();
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${reply}`);
    if (!COARSE) input.current?.focus();
    setCaret(Infinity); // the reply lands at the end
  };

  /** A preset is a whole reply: one tap sends it (held while the Agent works), and whatever is
   *  half-typed in the field stays there. */
  const preset = (reply: string) => {
    haptic();
    say(reply);
  };

  /** `/` and `@` type their character at the caret and send nothing: the Agent's own TUI
   *  draws its menu once the text reaches it. */
  const typeAtCaret = (ch: string) => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setRangeText(ch, el.selectionStart, el.selectionEnd, 'end');
    setText(el.value);
    setCaret(el.selectionStart);
  };

  // A path is only good on the Host that wrote it, so nothing follows a Pane switch.
  useEffect(() => {
    const flight = running.current;
    return () => {
      for (const xhr of flight.values()) xhr.abort();
      flight.clear();
      setUploads([]);
    };
  }, [paneKey]);

  const patch = (id: number, fields: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...fields } : u)));

  const upload = (u: Upload) => {
    const xhr = new XMLHttpRequest();
    running.current.set(u.id, xhr);
    xhr.open('POST', `/api/panes/${encodeURIComponent(paneKey)}/attach`);
    // ponytail: setRequestHeader throws above Latin-1 and the Hub flattens everything
    // outside [A-Za-z0-9._-] anyway, so a non-ASCII name is flattened here first.
    xhr.setRequestHeader('X-Name', u.file.name.replace(/[^\x20-\x7e]/g, '_'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(u.id, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      running.current.delete(u.id);
      if (xhr.status !== 200) return patch(u.id, { status: 'error', reason: whyFailed(xhr) });
      const { path, display } = JSON.parse(xhr.responseText) as Attached;
      patch(u.id, { status: 'done', progress: 1, path, display });
      // Claude Code and Pi read an absolute path out of the prompt, so `path` goes in the
      // field and `display` stays on the chip.
      setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${path}`);
    };
    xhr.onerror = () => {
      running.current.delete(u.id);
      patch(u.id, { status: 'error', reason: 'upload failed' });
    };
    xhr.send(u.file);
  };

  const attach = (files: FileList | File[] | null) => {
    for (const file of Array.from(files ?? [])) {
      const u: Upload = { id: (uploadId += 1), file, progress: 0, status: 'uploading' };
      setUploads((list) => [...list, u]);
      upload(u);
    }
  };

  // The Chat view takes a dropped file as the box does, and the box's ring shows where it goes.
  useEffect(() => {
    const zone = dropZone?.current;
    if (!zone) return;
    const over = (e: globalThis.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      setFileOver(true);
    };
    const leave = (e: globalThis.DragEvent) => {
      if (!zone.contains(e.relatedTarget as Node | null)) setFileOver(false);
    };
    const drop = (e: globalThis.DragEvent) => {
      setFileOver(false);
      if (!carriesFiles(e)) return;
      e.preventDefault();
      attach(e.dataTransfer!.files);
    };
    zone.addEventListener('dragover', over);
    zone.addEventListener('dragleave', leave);
    zone.addEventListener('drop', drop);
    return () => {
      zone.removeEventListener('dragover', over);
      zone.removeEventListener('dragleave', leave);
      zone.removeEventListener('drop', drop);
    };
  }, [dropZone, directOn]);

  const retry = (u: Upload) => {
    patch(u.id, { progress: 0, status: 'uploading', reason: undefined });
    upload(u);
  };

  const drop = (u: Upload) => {
    running.current.get(u.id)?.abort();
    running.current.delete(u.id);
    setUploads((list) => list.filter((x) => x.id !== u.id));
    const path = u.path;
    // The token goes out exactly as it went in: with its separating space, either side.
    if (path) setText((t) => t.replace(`${path} `, '').replace(` ${path}`, '').replace(path, ''));
  };

  const inFlight = uploads.filter((u) => u.status === 'uploading');
  const progress = inFlight.length ? inFlight.reduce((n, u) => n + u.progress, 0) / inFlight.length : 0;

  // ---- dictation ----
  const rec = useRef<Recognition | null>(null);
  const transcript = useRef('');
  const keepTranscript = useRef(true);
  const mic = useRef<{ stream: MediaStream; context: AudioContext } | null>(null);
  const [listening, setListening] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const releaseMic = () => {
    const active = mic.current;
    mic.current = null;
    try { active?.stream.getTracks().forEach((track) => track.stop()); } catch {}
    try { if (active) void active.context.close().catch(() => {}); } catch {}
    setAnalyser(null);
  };

  const stopDictation = (keep: boolean) => {
    keepTranscript.current = keep;
    const active = rec.current;
    if (!active) return;
    try {
      active.stop();
    } catch {
      active.onend?.();
    }
  };

  const dictate = () => {
    if (rec.current) return stopDictation(true);
    const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    transcript.current = '';
    keepTranscript.current = true;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      transcript.current = Array.from(e.results, (result) => result[0]?.transcript ?? '').join(' ').replace(/\s+/g, ' ').trim();
    };
    r.onend = () => {
      if (rec.current !== r) return;
      rec.current = null;
      if (keepTranscript.current && transcript.current) {
        setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${transcript.current}`);
      }
      transcript.current = '';
      setListening(false);
      releaseMic();
    };
    rec.current = r;
    setListening(true);
    void (async () => {
      let stream: MediaStream | null = null;
      let context: AudioContext | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (rec.current !== r) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        context = new AudioContext();
        const next = context.createAnalyser();
        next.fftSize = 64;
        context.createMediaStreamSource(stream).connect(next);
        await context.resume();
        mic.current = { stream, context };
        setAnalyser(next);
      } catch {
        try { stream?.getTracks().forEach((track) => track.stop()); } catch {}
        try { if (context) await context.close(); } catch {}
      }
    })();
    try {
      r.start();
    } catch {
      r.onend();
    }
  };

  useEffect(() => () => {
    const active = rec.current;
    rec.current = null;
    if (active) {
      active.onresult = null;
      active.onend = null;
      try { active.stop(); } catch {}
    }
    const audio = mic.current;
    mic.current = null;
    try { audio?.stream.getTracks().forEach((track) => track.stop()); } catch {}
    try { if (audio) void audio.context.close().catch(() => {}); } catch {}
  }, [paneKey]);

  // ---- derived ----
  // The card's 150 ms exit leaves only the caption visible. An active blocked prompt always
  // keeps the held messages readable, because that is when the user must choose what to do.
  const heldFolded = !!explain && status !== 'blocked';
  // No engine, no button: Send stays in place, disabled, rather than a mic that does nothing.
  const canDictate = 'webkitSpeechRecognition' in window;
  const hasText = !!text.trim();
  const Agent = agent ? `${agent[0]!.toUpperCase()}${agent.slice(1)}` : '';
  const replies = agent ? quickReplies({ agent, explain, suggestions: pane?.suggestions, smart, blocked: status === 'blocked' }) : [];
  // The keys the blocked prompt offers stay first, because answering it is why the Pane is
  // open; then the Hints the Screen itself printed, then the quick replies. Deduped, so a
  // Hint that repeats the prompt's own `esc to cancel` is listed once. The mode's own Hint
  // (`auto mode ⇧⇥`) is how the bar cycles the mode; the Keys tray has ⇧⇥ too.
  // While the card is up it carries the prompt's own keys, so the tray does not repeat them.
  const pills: Pill[] = [
    ...replies.filter((p) => p.kind === 'key' && !explain),
    ...hintPills(affordances, replies),
    ...replies.filter((p) => p.kind === 'text'),
  ];
  const commands = agent ? [] : history;
  // Control, the App profile's own keys, Navigate, Edit; the Modifiers are drawn here.
  const defaults = useMemo(
    () => trayGroups({ shell: !agent, claude: !!agent?.toLowerCase().includes('claude'), pi: agent === 'pi' || agent === 'omp', profileKeys: profile.keys.all }),
    [agent, profile],
  );
  // The user's own bar, per kind; null is the defaults.
  const [keyPrefs, setKeyPrefs] = useState(() => ({ agent: readKeyPrefs('agent'), shell: readKeyPrefs('shell') }));
  const [editing, setEditing] = useState(false);
  // A key row in Edit keys on its way to a new place: where it came from, where it would land.
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  useEffect(() => { setEditing(false); }, [paneKey, kind]);
  const prefs = keyPrefs[kind];
  const groups = useMemo(() => applyKeyPrefs(defaults, prefs), [defaults, prefs]);
  const rows = editableCaps(defaults, prefs);
  const saveRows = (next: typeof rows) => {
    const chosen = toKeyPrefs(next);
    store.set(keysKey(kind), JSON.stringify(chosen));
    setKeyPrefs((k) => ({ ...k, [kind]: chosen }));
  };
  const resetKeys = () => {
    try { store.remove(keysKey(kind)); } catch {}
    setKeyPrefs((k) => ({ ...k, [kind]: null }));
  };
  const waiting = pills.length + commands.length;

  // One tray at a time, so the field moves by one tray at most: opening one closes the other.
  // A blocked prompt opens the suggestions while they hold a draft for it, without touching
  // the remembered choice, unless the keys are open: the user opened those on purpose. With
  // nothing to offer it leaves the tray as it was. Closing them then dismisses only this
  // prompt's opening.
  const forced = status === 'blocked' && !dismissed && pills.some((p) => p.generated);
  const showKeys = trays[kind].keys;
  const showSuggest = !showKeys && (trays[kind].suggest || forced);
  const keep = (next: Partial<Record<Tray, boolean>>) => {
    for (const [tray, v] of Object.entries(next)) store.set(`tautan.tray.${tray}.${kind}`, v ? 'on' : 'off');
    setTrays((t) => ({ ...t, [kind]: { ...t[kind], ...next } }));
  };
  const toggleTray = (tray: Tray) => {
    haptic();
    if (tray === 'keys') return keep(showKeys ? { keys: false } : { keys: true, suggest: false });
    if (!showSuggest) return keep({ suggest: true, keys: false });
    if (trays[kind].suggest) keep({ suggest: false });
    if (status === 'blocked') setDismissed(true);
  };

  // ---- parts ----
  // Desktop pills stand as tall as the bar's buttons, so the suggestions strip is one bar high.
  const chip = desktop
    ? 'press flex h-8 shrink-0 items-center gap-1.5 px-3 text-[13px] whitespace-nowrap'
    : 'press flex h-9 shrink-0 items-center gap-1.5 px-3 text-[13px] whitespace-nowrap';
  // Replies are round on desktop (the Claude Code box); keys and commands stay 8 px caps.
  const pill = `${chip} ${desktop ? 'rounded-full' : 'rounded-chip'}`;

  const pillButtons = pills.map((p, i) =>
    p.kind === 'key' ? (
      <button
        key={`${p.label}-${i}`}
        type="button"
        aria-label={p.aria}
        onPointerDown={keepFocus}
        onClick={() => keys(p.keys!)}
        className={`${pill} ${
          i === 0 ? 'bg-accent font-semibold text-bg' : 'border border-border bg-bg font-medium text-fg active:bg-surface'
        }`}
      >
        {p.label}
        {p.glyph && <span className={`font-mono text-[11px] ${i === 0 ? 'opacity-70' : 'text-muted'}`}>{p.glyph}</span>}
      </button>
    ) : p.generated ? (
      <button
        key={`${p.label}-${i}`}
        type="button"
        aria-label={p.aria}
        onPointerDown={keepFocus}
        onClick={() => fill(p.label)}
        className={`${pill} border border-border bg-bg text-fg active:bg-surface`}
      >
        <span aria-hidden className="text-accent">✦</span>
        {p.label}
      </button>
    ) : (
      // A preset sends: it reads like the secondary key pills, with Send's arrow as its glyph.
      <button
        key={`${p.label}-${i}`}
        type="button"
        aria-label={status === 'working' ? `${p.label}, sends when ${Agent} is idle` : p.aria}
        onPointerDown={keepFocus}
        onClick={() => preset(p.label)}
        className={`${pill} border border-border bg-bg font-medium text-fg active:bg-surface`}
      >
        {p.label}
        <Send size={12} className="text-muted" />
      </button>
    ),
  );

  // A recent command replaces the field rather than adding to it: it is a whole line.
  const commandButtons = commands.map((c) => (
    <button
      key={c}
      type="button"
      aria-label={`${c}, fills the command line`}
      onPointerDown={keepFocus}
      onClick={() => {
        haptic();
        setText(c);
        input.current?.focus();
      }}
      className={`${chip} rounded-chip bg-surface font-mono text-[12px] text-fg`}
    >
      {c}
    </button>
  ));

  // The toggles: accent tint while open. Closed, an outline on the phone; on desktop a quiet
  // ghost, like attach and the mic, so the bar reads as one row.
  const toggle = (on: boolean) =>
    `press flex shrink-0 items-center justify-center gap-1.5 rounded-composer border font-medium ${
      desktop ? 'h-8 px-2.5 text-[12px]' : 'h-9 min-w-10 px-2.5 text-[13px]'
    } ${
      on ? `${RING} border-accent/45 bg-accent/12 text-accent hover:bg-accent/20`
      : desktop ? `${HOVER} border-transparent text-muted` : `${HOVER} border-border bg-bg text-fg`
    }`;
  const suggestToggle = (
    <button
      type="button"
      aria-label={`Suggestions, ${waiting} waiting`}
      aria-pressed={showSuggest}
      aria-controls="pane-suggestions"
      onPointerDown={keepFocus}
      onClick={() => toggleTray('suggest')}
      className={toggle(showSuggest)}
    >
      <span aria-hidden>✦</span>
      {desktop && 'Suggestions'}
      {waiting > 0 && <span className={`tabular-nums ${desktop ? 'opacity-70' : ''}`}>{waiting}</span>}
    </button>
  );
  const keysToggle = (
    <button
      type="button"
      aria-label="Keys"
      aria-pressed={showKeys}
      aria-controls="pane-keys"
      onPointerDown={keepFocus}
      onClick={() => toggleTray('keys')}
      className={toggle(showKeys)}
    >
      <Keyboard size={desktop ? 15 : 17} />
      {desktop && 'Keys'}
    </button>
  );
  // The rest of the bar while typing directly: what the keys do now, and a tap that brings the
  // keyboard back. The caret blinks on the Screen only, where the typing shows.
  const typingStatus = (
    <button
      type="button"
      onClick={() => input.current?.focus()}
      className={`press flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 text-left text-caption ${focused ? 'text-fg' : 'text-muted'}`}
    >
      <span className="truncate">{focused ? 'Typing into the Pane' : desktop ? 'Click here or the Screen to type' : 'Tap to type'}</span>
    </button>
  );
  const directToggle = !hideCard && (
    <button
      type="button"
      aria-label="Type directly"
      aria-pressed={directOn}
      title={directOn ? 'Each key goes straight to the Pane. Tap to compose a line again.' : 'Send each key as you type it, as in a terminal'}
      onPointerDown={keepFocus}
      onClick={toggleDirect}
      className={toggle(directOn)}
    >
      <ScreenLens size={desktop ? 15 : 17} />
      {desktop && 'Type directly'}
    </button>
  );

  // Desktop labels are a step smaller: there the trays are strips inside the box.
  const groupLabel = `${desktop ? 'text-[9px] leading-3' : 'text-[10px]'} font-semibold uppercase tracking-[0.06em] text-muted`;
  // Two lines per cap: the key as its footer prints it, and under it what it does here.
  const capClass = `press flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-chip border whitespace-nowrap ${
    desktop ? 'h-9 min-w-10 px-2' : 'h-12 px-1'
  }`;
  // A lone glyph (⌫, ␣, ▲) needs a size step to read like the word caps beside it.
  const capSize = (label: string) =>
    [...label].length === 1 ? (desktop ? 'text-[13px]' : 'text-[16px]') : desktop ? 'text-[11.5px]' : 'text-[13px]';
  const capRow = desktop ? 'flex flex-wrap gap-1' : 'grid grid-cols-4 gap-1.5';
  const capFace = (label: string, hint?: string) => (
    <>
      <span className={`font-mono leading-none ${capSize(label)}`}>{label}</span>
      {hint && <span className={`max-w-full truncate leading-none text-muted ${desktop ? 'text-[9.5px]' : 'text-[10px]'}`}>{hint}</span>}
    </>
  );
  const capButton = (cap: Cap) => (
    <button
      key={cap.label}
      type="button"
      aria-label={cap.name}
      title={cap.name}
      onPointerDown={keepFocus}
      onClick={() => press(cap)}
      className={`${capClass} ${RING} border-border bg-surface hover:bg-border/60 active:bg-border ${cap.danger ? 'text-danger' : 'text-fg'}`}
    >
      {capFace(cap.label, cap.hint)}
    </button>
  );

  // Edit keys: every cap in a list, a switch for whether it shows and ▲▼ to move it; on desktop
  // a row also drags to its new place. Each change saves at once; Reset puts the defaults back.
  // ponytail: native drag and drop, desktop only, as the Tab strip does: a touch drag would fight
  // the tray's own scroll, so the phone keeps ▲▼. The drag carries its own type and no text,
  // so a drop on the field types nothing into the Pane.
  const rowDrag = (i: number): HTMLAttributes<HTMLLIElement> | undefined =>
    desktop
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData('application/x-tautan-key', rows[i]!.cap.label);
            e.dataTransfer.effectAllowed = 'move';
            setDrag({ from: i, over: i });
          },
          onDragOver: (e: DragEvent) => {
            if (!drag) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (drag.over !== i) setDrag({ from: drag.from, over: i });
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (drag) saveRows(moveRowTo(rows, drag.from, i));
            setDrag(null);
          },
          onDragEnd: () => setDrag(null),
        }
      : undefined;
  const smallBtn = `press flex shrink-0 items-center justify-center rounded-chip border border-border text-fg ${RING} disabled:opacity-40 ${
    desktop ? 'size-7 text-[10px] hover:bg-surface' : 'size-9'
  }`;
  const keysEditor = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={groupLabel}>Edit keys</span>
        {desktop && <span className="min-w-0 truncate text-[11px] text-muted">Drag a key to move it, or use ▲ ▼</span>}
        <span className="flex-1" />
        <button type="button" onClick={() => { haptic(); resetKeys(); }} disabled={!prefs} className={`press min-h-8 rounded-chip px-1.5 text-caption font-medium text-muted disabled:opacity-40 ${HOVER}`}>
          Reset
        </button>
        <button type="button" onClick={() => { haptic(); setEditing(false); }} className={`press min-h-8 rounded-chip px-1.5 text-caption font-semibold text-accent ${RING}`}>
          Done
        </button>
      </div>
      {/* Desktop: the list flows down in columns, so ▲ and ▼ still mean earlier and later. The
          wrapper scrolls; a height on the columns themselves would spill them sideways. */}
      <div className={desktop ? 'max-h-[min(40vh,18rem)] overflow-y-auto overscroll-contain [scrollbar-width:thin]' : ''}>
        <ul className={desktop ? 'columns-[15rem] gap-x-6' : 'flex flex-col'}>
          {rows.map((row, i) => (
            <li
              key={row.cap.label}
              data-keyrow
              {...rowDrag(i)}
              className={`relative flex items-center gap-2 ${
                desktop ? 'min-h-9 cursor-grab break-inside-avoid rounded-chip pl-1 hover:bg-surface' : 'min-h-10 border-t border-border/60 first:border-t-0'
              } ${drag?.from === i ? 'opacity-40' : ''}`}
            >
              {/* The drop marker: the cap lands in this row's place, pushing it the other way. */}
              {drag && drag.over === i && drag.from !== i && (
                <span aria-hidden className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent ${drag.from > i ? '-top-px' : '-bottom-px'}`} />
              )}
              {desktop && <span aria-hidden className="font-mono text-[12px] leading-none text-muted/70">⠿</span>}
              <label className={`flex min-w-0 flex-1 items-center gap-2.5 ${desktop ? 'min-h-9' : 'min-h-10'}`}>
                <input
                  type="checkbox"
                  checked={row.on}
                  onChange={() => saveRows(rows.map((r, j) => (j === i ? { ...r, on: !r.on } : r)))}
                  className="size-4 shrink-0 accent-[var(--accent)]"
                />
                <span className={`shrink-0 font-mono text-fg ${desktop ? 'text-[12px]' : 'text-[13px]'}`}>{row.cap.label}</span>
                <span className="min-w-0 truncate text-caption text-muted">{row.cap.name}</span>
              </label>
              <button type="button" aria-label={`Move ${row.cap.name} up`} disabled={i === 0} onClick={() => saveRows(moveRow(rows, i, -1))} className={smallBtn}>
                ▲
              </button>
              <button type="button" aria-label={`Move ${row.cap.name} down`} disabled={i === rows.length - 1} onClick={() => saveRows(moveRow(rows, i, 1))} className={smallBtn}>
                ▼
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

  const capGroups = (
    <>
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label} className={`flex min-w-0 flex-col ${desktop ? 'gap-0.5' : 'gap-1'}`}>
          <span aria-hidden className={groupLabel}>{group.label}</span>
          <div className={capRow}>{group.caps.map(capButton)}</div>
        </div>
      ))}
      <div role="group" aria-label="Modifiers" className={`flex min-w-0 flex-col ${desktop ? 'gap-0.5' : 'gap-1'}`}>
        <span aria-hidden className={groupLabel}>Modifiers</span>
        <div className={capRow}>
          {MODIFIERS.map((mod) => (
            <button
              key={mod}
              type="button"
              aria-label={`${armed === mod ? 'Disarm' : 'Arm'} ${mod === 'ctrl' ? 'Control' : 'Alt'}`}
              aria-pressed={armed === mod}
              onPointerDown={keepFocus}
              onClick={() => arm(mod)}
              className={`${capClass} ${RING} ${armed === mod ? 'border-accent/45 bg-accent/12 text-accent' : 'border-border bg-surface text-fg hover:bg-border/60 active:bg-border'}`}
            >
              {capFace(mod, armed === mod ? 'armed' : 'next key')}
            </button>
          ))}
        </div>
      </div>
    </>
  );
  const editKeys = (
    <button type="button" onClick={() => { haptic(); setEditing(true); }} className={`press min-h-8 shrink-0 self-start rounded-chip px-1.5 text-caption font-medium text-muted ${HOVER}`}>
      Edit keys
    </button>
  );
  // Desktop: one strip of groups, three rows high at most, scrolling inside past that, with Edit
  // keys in its corner. Phone: a four-column grid per group, scrolling inside past 44% of the screen.
  const keysTray = (
    <div
      id="pane-keys"
      role="group"
      aria-label="Keys"
      className={`rise ${desktop ? 'flex items-start gap-3 px-4 pt-2.5' : 'flex max-h-[44vh] flex-col gap-2 overflow-y-auto overscroll-contain px-4'}`}
    >
      {editing ? keysEditor : desktop ? (
        <>
          <div className="flex max-h-[162px] min-w-0 flex-1 flex-wrap content-start gap-x-4 gap-y-1.5 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            {capGroups}
          </div>
          {editKeys}
        </>
      ) : (
        <>
          {capGroups}
          {editKeys}
        </>
      )}
    </div>
  );

  /** The replies (or a shell's recent commands) in one row that scrolls sideways. On desktop a
   *  strip with its label, as tall as the bar's buttons whatever the count. */
  const suggestTray = (
    <div
      id="pane-suggestions"
      role="group"
      aria-label={agent ? 'Suggestions' : 'Recent commands'}
      className={`rise ${desktop ? 'flex items-center gap-3 pt-2.5 pl-4' : ''}`}
    >
      {waiting === 0 ? (
        <p className={`text-caption text-muted ${desktop ? 'flex h-8 items-center' : 'px-4'}`}>{agent ? 'No suggestions yet' : 'Commands you run show up here'}</p>
      ) : (
        <>
          {desktop && <span aria-hidden className={`${groupLabel} shrink-0`}>{agent ? 'Suggested' : 'Recent'}</span>}
          <div
            className={`hscroll flex min-w-0 flex-1 items-center gap-1.5 ${desktop ? 'pr-4' : 'px-4'}`}
            style={{ maskImage: FADE, WebkitMaskImage: FADE }}
            // A mouse wheel has no sideways axis; the row takes its turn as one.
            onWheel={desktop ? (e) => { if (!e.deltaX) e.currentTarget.scrollLeft += e.deltaY; } : undefined}
          >
            {pillButtons}
            {commandButtons}
          </div>
        </>
      )}
    </div>
  );

  // On the phone an Agent Pane keeps esc and ^C one tap away beside the toggles in every
  // Status: esc backs out of a menu or a prompt, ^C stops the run. Never beside Send, where a
  // slip would interrupt instead of reply. On desktop they lead the Keys tray's Control group,
  // and a shell's keys live in its tray, which opens by default.
  const inlineKey = (label: string, name: string, key: string, danger?: boolean) => (
    <button
      type="button"
      aria-label={name}
      title={`Sends ${label}`}
      onPointerDown={keepFocus}
      onClick={() => keys([key])}
      className={`press flex shrink-0 items-center justify-center rounded-composer border font-mono ${RING} ${
        desktop ? 'h-8 px-2.5 text-[11px]' : 'h-9 px-2 text-[12px]'
      } ${danger ? 'border-danger/40 text-danger hover:border-danger/60 hover:bg-danger/10' : 'border-border bg-bg text-fg hover:bg-surface'}`}
    >
      {label}
    </button>
  );
  // pi aborts on esc and only clears its editor on ^C, so there esc is the stop key.
  const stopKeys = agent && (agent === 'pi' || agent === 'omp' ? (
    <>
      {inlineKey('esc', 'Abort, escape', 'esc', true)}
      {inlineKey('^C', 'Clear editor, control C', 'ctrl+c')}
    </>
  ) : (
    <>
      {inlineKey('esc', 'Escape', 'esc')}
      {inlineKey('^C', 'Interrupt, control C', 'ctrl+c', true)}
    </>
  ));

  const fileInput = (
    <input
      ref={picker}
      type="file"
      // ponytail: no `capture` — the button opens the library, never the camera.
      // `image/*` is what makes iOS hand over a JPEG for a HEIC pick; see docs/UI.md.
      accept="image/*,video/*"
      multiple
      hidden
      onChange={(e) => {
        attach(e.target.files);
        e.target.value = ''; // so the same file can be picked twice
      }}
    />
  );
  const attachButton = (
    <button
      type="button"
      aria-label="Attach"
      onClick={() => picker.current?.click()}
      className={`press flex shrink-0 items-center justify-center rounded-chip text-muted ${HOVER} ${desktop ? 'size-8' : 'size-9'}`}
    >
      <Attach size={desktop ? 17 : 18} />
    </button>
  );
  // The one control on the right. Dim, not gone, while the field is empty, so it never moves.
  const sendLook = `press flex shrink-0 items-center justify-center rounded-chip ${RING} ${
    hasText ? 'bg-accent text-bg hover:bg-accent/85' : 'bg-surface text-muted opacity-60'
  }`;
  const sendButton = agent || !desktop ? (
    <button
      type="button"
      onPointerDown={keepFocus}
      onClick={() => send()}
      disabled={!hasText}
      aria-label={agent ? 'Send' : 'Run'}
      title={desktop ? undefined : agent ? 'Send' : 'Run'}
      className={`${sendLook} ${desktop ? 'size-8' : 'size-9'}`}
    >
      <Send size={desktop ? 17 : 18} />
    </button>
  ) : (
    <button
      type="button"
      onPointerDown={keepFocus}
      onClick={() => send()}
      disabled={!hasText}
      className={`${sendLook} h-8 gap-1.5 px-3 text-[12px] ${hasText ? 'font-medium' : ''}`}
    >
      Run <kbd className="font-mono text-[10.5px] opacity-70">↵</kbd>
    </button>
  );
  const micButton = canDictate && (
    <button
      type="button"
      onClick={dictate}
      aria-label={listening ? 'Done dictating' : 'Dictate'}
      aria-pressed={listening}
      className={`press flex shrink-0 items-center justify-center rounded-chip ${desktop ? 'size-8' : 'size-9'} ${
        listening ? `${RING} text-accent hover:bg-surface` : `${HOVER} text-muted`
      }`}
    >
      <Mic size={desktop ? 17 : 18} />
    </button>
  );

  // A subagent's conversation is on screen, but a send always types into the Pane.
  const placeholder = armed
    ? desktop ? `${armed} + the next key or letter` : `${armed} + next key`
    : agent
    ? explain
      ? desktop ? `Or tell ${agent} what to do instead` : 'Or type an answer'
      : subagentOpen ? desktop ? 'Reply goes to the main Agent' : 'Reply to main Agent…'
      : desktop && claudeWorking ? `Reply to ${Agent} — Enter queues it, Ctrl+Enter sends now`
      : desktop ? `Reply to ${Agent} — / for commands, @ for files` : `Reply to ${Agent}…`
    : 'Type a command';
  const returnBreaks = COARSE && !!agent;
  const directHint = directOn ? (desktop ? 'Typing goes straight to the Pane' : 'Keys go straight to the Pane') : placeholder;
  const textarea = (
    <textarea
      ref={input}
      rows={desktop && agent ? 2 : 1}
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(e) => {
        composing.current = false;
        if (!directOn) return;
        if (e.data) typeRaw({ text: e.data });
        setText('');
      }}
      onChange={(e) => {
        const el = e.target;
        if (directOn) return void setText(composing.current ? el.value : '');
        const at = el.selectionStart;
        // Armed, one typed character is a chord, not text: it goes out as ctrl+r and the field stays.
        if (armed && el.value.length === text.length + 1 && at > 0 && el.value.slice(0, at - 1) + el.value.slice(at) === text) {
          haptic();
          setArmed(null);
          void post(paneKey, 'input', { keys: [modified(armed, el.value[at - 1]!)] } satisfies InputBody);
          return;
        }
        setCaret(at);
        setText(el.value);
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
      // A pasted screenshot goes up as Attach would send it. Typing directly has no Attach.
      onPaste={(e) => {
        const files = directOn ? [] : pastedFiles(Array.from(e.clipboardData.files), e.clipboardData.getData('text/plain'));
        if (!files.length) return;
        e.preventDefault();
        attach(files);
      }}
      // Desktop: Enter sends and Shift+Enter breaks the line. A touch screen's Return breaks the
      // line for an Agent and Send sends; a shell's Return still runs the line. Every other
      // key, Ctrl included, is the field's own. Safari ends an IME composition with an Enter
      // whose `isComposing` is already false, so keyCode 229 counts as composing too.
      onKeyDown={(e) => {
        const composing = e.nativeEvent.isComposing || e.keyCode === 229;
        if (directOn) {
          const sent = composing ? null : directKey({ key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, shiftKey: e.shiftKey, selected: !!getSelection()?.toString() });
          if (sent) {
            e.preventDefault();
            if (armed) setArmed(null);
            typeRaw(sent);
          }
          return;
        }
        const enter = composing ? null : enterAction(e, { working: claudeWorking, returnBreaks });
        // Ctrl+Enter goes past the picker: it sends what is typed, as typed.
        if (enter && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          send(undefined, enter === 'now');
          return;
        }
        if (open && !composing) {
          const item = items[active]!;
          // Already typed in full: Enter sends it, where Enter sends at all.
          const typed = !returnBreaks && token?.kind === 'slash' && item.value === text.trim();
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
            return;
          }
          if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !typed)) {
            e.preventDefault();
            pick(item);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setClosedAt(text);
            return;
          }
        }
        if (enter === 'send') {
          e.preventDefault();
          send();
        }
      }}
      role={open ? 'combobox' : undefined}
      aria-expanded={open ? true : undefined}
      aria-controls={open ? pickerId : undefined}
      aria-activedescendant={open ? `${pickerId}-${active}` : undefined}
      aria-autocomplete={open ? 'list' : undefined}
      enterKeyHint={returnBreaks ? 'enter' : agent ? 'send' : 'go'}
      autoCapitalize={agent && !directOn ? undefined : 'off'}
      autoCorrect={agent && !directOn ? undefined : 'off'}
      spellCheck={agent && !directOn ? undefined : false}
      aria-label={directOn ? 'Type directly into the Pane' : agent ? `Reply to ${agent}` : 'Command'}
      placeholder={directHint}
      className={`min-w-0 flex-1 resize-none bg-transparent placeholder:truncate placeholder:text-muted focus:outline-none ${
        desktop
          ? `block w-full py-0 leading-[22px] ${agent ? 'text-[15px]' : 'font-mono text-[14px]'}`
          : `max-h-24 min-h-9 self-center py-2 leading-5 ${agent ? 'text-body' : 'font-mono text-[14px]'}`
      }`}
    />
  );
  // The prompt glyph labels the field from inside it: `›` for an Agent, `$` for a shell.
  // With the keys open on the phone, it becomes the way to close them.
  const glyph = (
    <span
      aria-hidden
      className={`font-mono ${agent ? 'text-accent' : 'text-ok'} ${
        desktop ? `absolute top-3 left-4 leading-[22px] ${agent ? 'text-[15px]' : 'text-[14px]'}` : 'self-center'
      }`}
    >
      {agent ? '›' : '$'}
    </span>
  );

  const progressBar = inFlight.length > 0 && (
    <div
      role="progressbar"
      aria-label="Uploading"
      aria-valuenow={Math.round(progress * 100)}
      className={`h-0.5 overflow-hidden bg-surface ${desktop ? '' : 'rounded-full'}`}
    >
      <div
        className="h-full bg-accent transition-[width] duration-150 ease-out motion-reduce:transition-none"
        style={{ width: `${progress * 100}%` }}
      />
    </div>
  );

  const attachments = uploads.length > 0 && (
    <div className={`flex flex-col gap-1.5 ${desktop ? 'px-4 pt-2.5' : ''}`}>
      <div className="flex flex-wrap gap-1.5">
        {uploads.map((u) => (
          <span
            key={u.id}
            title={u.display ?? u.file.name}
            className={`flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-chip border border-border bg-bg py-0.5 pr-0.5 pl-2.5 text-caption ${
              u.status === 'error' ? 'text-danger' : 'text-fg'
            }`}
          >
            <span className="truncate">{u.file.name}</span>
            <span className="shrink-0 text-muted">{human(u.file.size)}</span>
            <button
              type="button"
              aria-label={`Remove ${u.file.name}`}
              onClick={() => drop(u)}
              className="press flex size-7 shrink-0 items-center justify-center rounded-chip text-muted"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {uploads.some((u) => u.status === 'error') && (
        <div role="status" className="flex flex-col gap-1">
          {uploads
            .filter((u) => u.status === 'error')
            .map((u) => (
              <p key={u.id} className="text-caption text-muted">
                {u.file.name} failed · {u.reason}{' '}
                <button type="button" onClick={() => retry(u)} className="text-accent">
                  Retry
                </button>
              </p>
            ))}
        </div>
      )}
    </div>
  );

  // Read off the Screen, so muted: they report, they are not the work.
  const readout = desktop && agent && (toolbar.model || toolbar.context !== undefined) && (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden px-1.5">
      {toolbar.model && (
        <span title="Model, from the Screen" className="truncate text-[12px] text-muted">
          {toolbar.model}
        </span>
      )}
      {toolbar.context !== undefined && <ContextLeft left={toolbar.context} />}
    </div>
  );

  // The phone: one box, the field on top and the toolbar under it with Send alone at the right
  // end; the trays sit above the box. The toolbar has its own line rather than six controls
  // squeezed beside the field, which left 60 px to type into while ^C showed.
  // Desktop: the box is the whole dock, flush with the column. The open tray is a strip inside
  // it, then the attachments, the field, and one quiet bar: toggles left; the Screen's model
  // and context, attach, mic and Send right.
  const box = (
    <div
      className={`relative flex flex-col ${desktop ? '' : 'rounded-card border border-border bg-bg focus-within:border-accent/60'} ${fileOver ? 'ring-2 ring-accent/60 ring-inset' : ''}`}
      // A file dropped on the box goes up as Attach would send it.
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setFileOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false);
      }}
      onDrop={(e) => {
        setFileOver(false);
        if (!carriesFiles(e)) return;
        e.preventDefault();
        attach(e.dataTransfer.files);
      }}
    >
      {desktop && (showSuggest ? suggestTray : showKeys ? keysTray : null)}
      {desktop && attachments}
      {/* Typing directly, the field only catches keys: out of sight, still focusable, so the
          phone's keyboard still opens for it. The bar below is the whole Composer. */}
      {/* Desktop: the field's padding is the field's too, so a press anywhere across the box's
          width lands in it, and a scrolled draft still clips clean at the text. */}
      <div
        className={directOn ? 'pointer-events-none absolute bottom-0 left-0 h-px w-px overflow-hidden opacity-0' : desktop ? 'relative cursor-text pt-3 pr-4 pb-1 pl-9' : 'flex gap-2 px-3 pt-1'}
        onMouseDown={desktop ? (e) => {
          if (e.target !== input.current && !(e.target as Element).closest('[role="listbox"]')) {
            e.preventDefault();
            input.current?.focus();
          }
        } : undefined}
      >
        {/* The picker pops above the field, over the open strip and the Screen. */}
        {open && token && desktop && (
          <div className="absolute inset-x-3 top-0">
            <Picker id={pickerId} kind={token.kind} items={items} active={active} desktop onActive={setActive} onPick={pick} />
          </div>
        )}
        {glyph}
        {textarea}
      </div>
      <div role="toolbar" aria-label="Composer" className={`flex items-center gap-1 ${desktop ? `px-2.5 pb-2.5 ${directOn ? 'pt-2.5' : 'pt-1'}` : `px-1 pb-1 ${directOn ? 'pt-1' : ''}`}`}>
        {suggestToggle}
        {keysToggle}
        {directToggle}
        {directOn ? typingStatus : desktop ? (
          <>
            {/* The bar's empty middle is the field's too. */}
            <span aria-hidden className="flex-1 self-stretch" onClick={() => input.current?.focus()} />
            {readout}
            {readout && <Divider />}
            {attachButton}
            {micButton}
            {sendButton}
          </>
        ) : (
          <>
            {stopKeys}
            {attachButton}
            {agent && (
              <>
                <button
                  type="button"
                  aria-label="Type /"
                  title="Types / — the Agent shows its commands"
                  onPointerDown={keepFocus}
                  onClick={() => typeAtCaret('/')}
                  className={`press flex h-9 w-8 shrink-0 items-center justify-center rounded-chip font-mono text-[16px] text-muted ${HOVER}`}
                >
                  /
                </button>
                <button
                  type="button"
                  aria-label="Type @"
                  title="Types @ — the Agent offers files"
                  onPointerDown={keepFocus}
                  onClick={() => typeAtCaret('@')}
                  className={`press flex h-9 w-8 shrink-0 items-center justify-center rounded-chip font-mono text-[15px] text-muted ${HOVER}`}
                >
                  @
                </button>
              </>
            )}
            <span className="flex-1" />
            {/* The phone has one slot on the right: the mic while the field is empty (or while it
                listens), Send as soon as there is text. No dictation engine, Send keeps it. */}
            {micButton && (listening || !hasText) ? micButton : sendButton}
          </>
        )}
      </div>
      {desktop && progressBar}
    </div>
  );

  return (
    <div
      className={`flex shrink-0 flex-col ${
        desktop
          ? 'border-t border-border bg-bg transition-colors duration-150 focus-within:border-accent/50'
          : 'gap-2.5 rounded-t-drawer bg-elevated pt-3 pb-[max(var(--safe-b,env(safe-area-inset-bottom)),8px)] shadow-[0_-8px_24px_rgb(0_0_0/0.25)]'
      }`}
    >
      {/* The blocked card takes the replies' place. The live region must exist before the
          card does, or a screen reader announces nothing: it stays mounted at zero height
          while no prompt asks. */}
      <div
        ref={cardRef}
        aria-live="polite"
        className={explain && !hideCard ? (desktop ? 'px-4 pt-3' : 'px-4') : `h-0 overflow-hidden ${desktop ? '' : '-mb-2.5 px-4'}`}
      >
        <div className={`transition-opacity duration-150 ${status === 'blocked' && explain ? 'opacity-100' : 'opacity-0'}`}>
          {explain && !hideCard && (
            <Blocked
              key={explain.promptId ?? 'mock'}
              explain={explain}
              agent={agent}
              stale={stale}
              layout={desktop ? 'row' : 'rows'}
              onSend={onAnswer}
              onReread={onReread}
            />
          )}
        </div>
      </div>

      {!desktop && showSuggest && suggestTray}
      {!desktop && showKeys && keysTray}
      {open && token && !desktop && (
        <Picker id={pickerId} kind={token.kind} items={items} active={active} desktop={false} onActive={setActive} onPick={pick} />
      )}

      {heldMessages.length > 0 && (
        <section aria-label="Held messages" className={`overflow-hidden rounded-composer border border-border bg-bg ${desktop ? 'mx-4 mt-3' : 'mx-4'}`}>
          <div className={`flex min-h-9 items-center gap-3 px-3 ${heldFolded ? '' : 'border-b border-border'}`}>
            <span aria-live="polite" className="min-w-0 flex-1 truncate text-caption text-muted">
              <span className="font-medium text-fg">{heldMessages.length} held</span> · {heldMessages.some((m) => m.reason === 'draft') ? "waiting: the terminal's box has text" : `sends when ${Agent || 'the Agent'} is idle`}
            </span>
            {status !== 'working' && !heldMessages.some((m) => m.reason === 'draft') && (
              <button
                type="button"
                disabled={sendingHeld}
                onPointerDown={keepFocus}
                onClick={() => {
                  haptic();
                  void flushHeld(paneKey);
                }}
                className="press min-h-9 shrink-0 text-caption font-semibold text-accent disabled:text-muted"
              >
                {sendingHeld ? 'Sending…' : 'Send now'}
              </button>
            )}
          </div>
          {!heldFolded && (
            <ul className="max-h-28 overflow-y-auto overscroll-contain">
              {heldMessages.map((message) => (
                <li key={message.id} className="flex min-h-10 items-center gap-2 border-t border-border/60 px-3 first:border-t-0">
                  <span title={message.text} className="min-w-0 flex-1 truncate text-caption text-fg">
                    {message.text}
                  </span>
                  <button
                    type="button"
                    disabled={sendingHeld}
                    aria-label={`Remove held message: ${message.text}`}
                    onPointerDown={keepFocus}
                    onClick={() => dropPending([message.id])}
                    className="press flex size-9 shrink-0 items-center justify-center text-muted disabled:opacity-40"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className={`flex flex-col ${desktop ? '' : 'gap-1.5 px-4'}`}>
        {listening && (
          <div className={desktop ? 'px-4 pt-2.5' : ''}>
            <RecordingPill
              analyser={analyser}
              onCancel={() => stopDictation(false)}
              onDone={() => stopDictation(true)}
            />
          </div>
        )}
        {fileInput}
        {box}
        {!desktop && progressBar}
        {!desktop && attachments}
      </div>
    </div>
  );
}
