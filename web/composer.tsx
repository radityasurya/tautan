import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import type { Affordance, InputBody, Span, StatePane } from '../shared/types.ts';
import { hintPills } from './affordances.tsx';
import { haptic, post, reducedMotion } from './app.tsx';
import { Blocked, type ExplainResponse } from './blocked.tsx';
import { Attach, Keyboard, Mic, Send } from './icons.tsx';
import { applyKeyPrefs, capInput, editableCaps, modified, MODIFIERS, moveRow, parseKeyPrefs, toKeyPrefs, trayGroups, type Cap, type KeyPrefs, type Modifier } from './keys.ts';
import { applyPick, Picker, tokenAt, useComplete, type Item } from './complete.tsx';
import { CYCLE_MODE_KEYS, toolbarFromScreen, type Profile } from './profiles.ts';
import { quickReplies, type Pill } from './replies.ts';
import { deliver, dropPending, holdPending, trackPending } from './pending.ts';
import { showingSubagent, subscribeShowing } from './subagents.ts';
import { store } from './store.tsx';

/** "Wider than the viewport" is a fade, not a scrollbar. The grid and the Diff screen reuse it. */
export const FADE = 'linear-gradient(to right,#000 calc(100% - 24px),transparent)';

/**
 * The two trays above the input, remembered per kind. An Agent opens on its suggestions; a
 * shell opens on its keys, and its recent commands live in the suggestions tray.
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

/** The key bar the user chose, per kind. */
const keysKey = (kind: 'agent' | 'shell') => `tautan.keys.${kind}`;
const readKeyPrefs = (kind: 'agent' | 'shell'): KeyPrefs | null => parseKeyPrefs(store.get(keysKey(kind)));

/** `id` is the pending entry's (web/pending.ts), so the Chat view shows it held as well. */
interface HeldMessage { id: number; text: string }

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

/** A desktop shortcut cap, the header's `kbd` look, one step smaller for the legend. */
const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded-[3px] border border-border px-1 font-mono text-[10px] leading-[14px]">{children}</kbd>
);

/** Every composer control: a surface fill and `fg` ink on hover (Tailwind's `hover:` only
 *  matches a pointer that hovers, so a phone never sticks on it), and a visible focus ring. */
const RING =
  'outline-none transition-[transform,background-color,color,border-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';
const HOVER = `${RING} hover:bg-surface hover:text-fg`;

/** The hairline between toolbar groups. */
const Divider = () => <span aria-hidden className="mx-1 h-[18px] w-px shrink-0 bg-border" />;

/**
 * The dock under the Screen, at both widths. Two toggles, Suggestions and Keys, each open
 * their own tray above the input; both open stack them, both closed leave the input alone.
 * Send (Run for a shell) is always the right-most control and stands alone; everything else
 * sits to its left, in the toolbar under the field: the toggles, ^C while working, attach,
 * mic. Desktop (`lg`) adds `/`, `@`, and mode, model and context read off the Screen. A blocked prompt keeps its
 * card on top and opens Suggestions; a Pane with no Agent gets a `$` prompt, and its recent
 * commands are its suggestions.
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
  onAnswer: (keys: string[], promptId?: string) => Promise<'sent' | 'changed'>;
  onReread: () => void;
  /** The card's live region, so the header's Review can bring it into view. */
  cardRef: RefObject<HTMLDivElement | null>;
  /** The Chat view shows the prompt in the transcript: the card stays out, the text box stays. */
  hideCard?: boolean;
}) {
  const agent = pane?.agent;
  const status = pane?.status ?? 'unknown';
  const kind = agent ? 'agent' : 'shell';
  const subagentOpen = useSyncExternalStore(subscribeShowing, () => showingSubagent(paneKey)) !== undefined;

  const [trays, setTrays] = useState(() => ({
    agent: { suggest: readTray('agent', 'suggest'), keys: readTray('agent', 'keys') },
    shell: { suggest: readTray('shell', 'suggest'), keys: readTray('shell', 'keys') },
  }));
  // A blocked prompt opens the suggestions for as long as it asks, without touching the
  // remembered choice. Closing them then dismisses only this prompt's opening.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [paneKey, status]);
  const forced = status === 'blocked' && !dismissed;
  const showSuggest = trays[kind].suggest || forced;
  const showKeys = trays[kind].keys;
  const keep = (tray: Tray, v: boolean) => {
    store.set(`tautan.tray.${tray}.${kind}`, v ? 'on' : 'off');
    setTrays((t) => ({ ...t, [kind]: { ...t[kind], [tray]: v } }));
  };
  const toggleTray = (tray: Tray) => {
    haptic();
    if (tray === 'keys') return keep('keys', !showKeys);
    if (!showSuggest) return keep('suggest', true);
    if (trays[kind].suggest) keep('suggest', false);
    if (status === 'blocked') setDismissed(true);
  };

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
  const [heldMessages, setHeldMessages] = useState<HeldMessage[]>([]);
  const [sendingHeld, setSendingHeld] = useState(false);
  const heldGeneration = useRef(0);
  const flushingHeld = useRef(false);
  useEffect(() => {
    heldGeneration.current += 1;
    flushingHeld.current = false;
    setHeldMessages((list) => { dropPending(list.map((m) => m.id)); return []; });
    setSendingHeld(false);
  }, [paneKey]);
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
    if (token.kind === 'model') return send(`/model ${item.value}`);
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
  const picker = useRef<HTMLInputElement>(null);
  const running = useRef(new Map<number, XMLHttpRequest>());

  const send = (override?: string) => {
    const body = override ?? text;
    const sent = body.trim();
    if (!sent) return;
    // A bare `/model` opens the card first; the same text with a space sends it as typed.
    if (override === undefined && agent && body === '/model') return setText('/model ');
    haptic();
    // An Agent's reply also goes to the Chat view as a pending turn; a shell has no transcript.
    if (status === 'working') {
      setHeldMessages((list) => [...list, { id: trackPending(paneKey, body, true), text: body }]);
    } else if (agent) {
      void deliver(trackPending(paneKey, body));
    } else {
      void post(paneKey, 'input', { text: body, keys: ['enter'] } satisfies InputBody);
    }
    if (!agent && mayRemember(screenText)) setHistory(remember(sent));
    setText('');
    writeDraft(paneKey, '');
    // The paths went with the text. A chip still uploading keeps its place.
    setUploads((list) => list.filter((u) => u.status === 'uploading'));
    input.current?.focus();
  };

  const flushHeld = async () => {
    if (flushingHeld.current || status === 'working') return;
    const generation = heldGeneration.current;
    const batch = heldMessages;
    flushingHeld.current = true;
    setSendingHeld(true);
    haptic();
    for (const message of batch) {
      if (!(await deliver(message.id))) {
        holdPending(message.id);
        break;
      }
      if (heldGeneration.current === generation) {
        setHeldMessages((list) => list.filter((item) => item.id !== message.id));
      }
    }
    if (heldGeneration.current === generation) {
      flushingHeld.current = false;
      setSendingHeld(false);
    }
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

  /** A text pill is a draft, not an answer: it lands in the composer for review. */
  const fill = (reply: string) => {
    haptic();
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${reply}`);
    input.current?.focus();
    setCaret(Infinity); // the reply lands at the end
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

  const attach = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const u: Upload = { id: (uploadId += 1), file, progress: 0, status: 'uploading' };
      setUploads((list) => [...list, u]);
      upload(u);
    }
  };

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
  const replies = agent ? quickReplies({ agent, explain, suggestions: pane?.suggestions, smart }) : [];
  // The keys the blocked prompt offers stay first, because answering it is why the Pane is
  // open; then the Hints the Screen itself printed, then the quick replies. Deduped, so a
  // Hint that repeats the prompt's own `esc to cancel` is listed once.
  // On desktop the mode chip already sends the cycle key, so its Hint pill would say it twice.
  const modeInToolbar = desktop && !!agent && !!toolbar.mode;
  // While the card is up it carries the prompt's own keys, so the tray does not repeat them.
  const pills: Pill[] = [
    ...replies.filter((p) => p.kind === 'key' && !explain),
    ...hintPills(affordances, replies).filter((p) => !(modeInToolbar && p.keys?.join() === CYCLE_MODE_KEYS.join())),
    ...replies.filter((p) => p.kind === 'text'),
  ];
  const commands = agent ? [] : history;
  // Control, the App profile's own keys, Navigate, Edit; the Modifiers are drawn here.
  const defaults = useMemo(
    () => trayGroups({ shell: !agent, claude: !!agent?.toLowerCase().includes('claude'), profileKeys: profile.keys.all }),
    [agent, profile],
  );
  // The user's own bar, per kind; null is the defaults.
  const [keyPrefs, setKeyPrefs] = useState(() => ({ agent: readKeyPrefs('agent'), shell: readKeyPrefs('shell') }));
  const [editing, setEditing] = useState(false);
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
  const gutter = desktop ? '' : 'px-4';

  // ---- parts ----
  const chip = desktop
    ? 'press flex h-[30px] shrink-0 items-center gap-1.5 px-3 text-[13px] whitespace-nowrap'
    : 'press flex h-9 shrink-0 items-center gap-1.5 px-3 text-[13px] whitespace-nowrap';
  // Replies are round on desktop (the Claude Code box); keys and commands stay 8 px caps.
  const pill = `${chip} ${desktop ? 'rounded-full' : 'rounded-chip'}`;

  const pillButtons = pills.map((p, i) =>
    p.kind === 'key' ? (
      <button
        key={`${p.label}-${i}`}
        type="button"
        aria-label={p.aria}
        onClick={() => keys(p.keys!)}
        className={`${pill} ${
          i === 0 ? 'bg-accent font-semibold text-bg' : 'border border-border bg-bg font-medium text-fg active:bg-surface'
        }`}
      >
        {p.label}
        {p.glyph && <span className={`font-mono text-[11px] ${i === 0 ? 'opacity-70' : 'text-muted'}`}>{p.glyph}</span>}
      </button>
    ) : (
      <button
        key={`${p.label}-${i}`}
        type="button"
        aria-label={p.aria}
        onClick={() => fill(p.label)}
        className={`${pill} border border-border bg-bg active:bg-surface ${p.generated ? 'text-fg' : 'text-muted'}`}
      >
        {p.generated && <span aria-hidden className="text-accent">✦</span>}
        {p.label}
      </button>
    ),
  );

  // A recent command replaces the field rather than adding to it: it is a whole line.
  const commandButtons = commands.map((c) => (
    <button
      key={c}
      type="button"
      aria-label={`${c}, fills the command line`}
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

  // The two toggles: accent tint while open, a plain outline while closed.
  const toggle = (on: boolean) =>
    `press flex shrink-0 items-center justify-center gap-1.5 rounded-composer border font-medium ${
      desktop ? 'h-8 px-2.5 text-[12px]' : 'h-9 min-w-10 px-2.5 text-[13px]'
    } ${on ? `${RING} border-accent/45 bg-accent/12 text-accent hover:bg-accent/20` : `${HOVER} border-border bg-bg text-fg`}`;
  const suggestToggle = (
    <button
      type="button"
      aria-label={`Suggestions, ${waiting} waiting`}
      aria-pressed={showSuggest}
      aria-controls="pane-suggestions"
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
      onClick={() => toggleTray('keys')}
      className={toggle(showKeys)}
    >
      <Keyboard size={desktop ? 15 : 17} />
      {desktop && 'Keys'}
    </button>
  );

  const groupLabel = 'text-[10px] font-semibold uppercase tracking-[0.06em] text-muted';
  const capClass = `press flex min-w-0 items-center justify-center rounded-chip border font-mono whitespace-nowrap ${
    desktop ? 'h-7 min-w-8 px-2' : 'h-9 px-1'
  }`;
  // A lone glyph (⌫, ␣, ▲) needs a size step to read like the word caps beside it; a long
  // label (`⇧⇥ mode`) takes two of the phone's six columns.
  const capSize = (label: string) =>
    `${[...label].length === 1 ? (desktop ? 'text-[13px]' : 'text-[15px]') : desktop ? 'text-[11px]' : 'text-[12px]'} ${
      !desktop && label.length > 4 ? 'col-span-2' : ''
    }`;
  const capRow = desktop ? 'flex flex-wrap gap-1.5' : 'grid grid-cols-6 gap-1.5';
  const capButton = (cap: Cap) => (
    <button
      key={cap.label}
      type="button"
      aria-label={cap.name}
      onClick={() => press(cap)}
      className={`${capClass} ${capSize(cap.label)} border-border bg-surface active:bg-border ${cap.danger ? 'text-danger' : 'text-fg'}`}
    >
      {cap.label}
    </button>
  );

  // Edit keys: every cap in a list, a switch for whether it shows and two buttons to move
  // it. Each change saves at once; Reset puts the defaults back.
  const smallBtn = `press flex size-9 shrink-0 items-center justify-center rounded-chip border border-border text-fg ${RING} disabled:opacity-40`;
  const keysEditor = (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className={`${groupLabel} flex-1`}>Edit keys</span>
        <button type="button" onClick={() => { haptic(); resetKeys(); }} disabled={!prefs} className="press min-h-8 px-1 text-caption font-medium text-muted disabled:opacity-40">
          Reset
        </button>
        <button type="button" onClick={() => { haptic(); setEditing(false); }} className="press min-h-8 px-1 text-caption font-semibold text-accent">
          Done
        </button>
      </div>
      <ul className="flex flex-col">
        {rows.map((row, i) => (
          <li key={row.cap.label} className="flex min-h-10 items-center gap-2 border-t border-border/60 first:border-t-0">
            <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5">
              <input
                type="checkbox"
                checked={row.on}
                onChange={() => saveRows(rows.map((r, j) => (j === i ? { ...r, on: !r.on } : r)))}
                className="size-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="shrink-0 font-mono text-[13px] text-fg">{row.cap.label}</span>
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
  );

  // Groups with a tiny label each: one wrapping row on desktop, a six-column grid per group
  // on the phone, which scrolls inside the tray past 38% of the screen.
  const keysTray = (
    <div
      id="pane-keys"
      role="group"
      aria-label="Keys"
      className={`rise ${
        desktop
          ? 'flex flex-wrap gap-x-4 gap-y-2 rounded-composer border border-border bg-bg p-2'
          : 'flex max-h-[38vh] flex-col gap-2 overflow-y-auto overscroll-contain px-4'
      }`}
    >
      {editing ? keysEditor : <>
      {groups.map((group) => (
        <div key={group.label} role="group" aria-label={group.label} className="flex min-w-0 flex-col gap-1">
          <span aria-hidden className={groupLabel}>{group.label}</span>
          <div className={capRow}>{group.caps.map(capButton)}</div>
        </div>
      ))}
      <div role="group" aria-label="Modifiers" className="flex min-w-0 flex-col gap-1">
        <span aria-hidden className={groupLabel}>Modifiers</span>
        <div className={capRow}>
          {MODIFIERS.map((mod) => (
            <button
              key={mod}
              type="button"
              aria-label={`${armed === mod ? 'Disarm' : 'Arm'} ${mod === 'ctrl' ? 'Control' : 'Alt'}`}
              aria-pressed={armed === mod}
              onClick={() => arm(mod)}
              className={`${capClass} ${capSize(mod)} ${armed === mod ? 'border-accent/45 bg-accent/12 text-accent' : 'border-border bg-surface text-fg active:bg-border'}`}
            >
              {mod}
            </button>
          ))}
        </div>
      </div>
      <button type="button" onClick={() => { haptic(); setEditing(true); }} className={`press self-start text-caption font-medium text-muted ${HOVER} min-h-8 px-1`}>
        Edit keys
      </button>
      </>}
    </div>
  );

  /** The replies (or a shell's recent commands): wrapped on desktop, one scrolling row on the phone. */
  const suggestTray = (
    <div id="pane-suggestions" role="group" aria-label={agent ? 'Suggestions' : 'Recent commands'} className="rise">
      {waiting === 0 ? (
        <p className={`text-caption text-muted ${gutter}`}>{agent ? 'No suggestions yet' : 'Commands you run show up here'}</p>
      ) : desktop ? (
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden className={`${groupLabel} mr-1`}>{agent ? 'Suggested' : 'Recent'}</span>
          {pillButtons}
          {commandButtons}
        </div>
      ) : (
        <div className="hscroll flex gap-1.5 px-4" style={{ maskImage: FADE, WebkitMaskImage: FADE }}>
          {pillButtons}
          {commandButtons}
        </div>
      )}
    </div>
  );

  // While the Agent works, ^C stays one tap away beside the toggles, whatever the trays
  // show — never beside Send, where a slip would interrupt instead of reply.
  const stopButton = status === 'working' && (
    <button
      type="button"
      aria-label="Interrupt, control C"
      title="Sends ^C"
      onClick={() => keys(['ctrl+c'])}
      className={`press flex shrink-0 items-center justify-center border border-danger/40 font-mono text-danger ${RING} hover:border-danger/60 hover:bg-danger/10 ${
        desktop ? 'h-8 rounded-composer px-2.5 text-[11px]' : 'h-9 rounded-composer px-2.5 text-[12px]'
      }`}
    >
      ^C
    </button>
  );

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
      : desktop ? `Reply to ${Agent} — / for commands, @ for files` : `Reply to ${Agent}…`
    : 'Type a command';
  const textarea = (
    <textarea
      ref={input}
      rows={desktop && agent ? 2 : 1}
      value={text}
      onChange={(e) => {
        const el = e.target;
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
      // Enter sends and Shift+Enter breaks the line; every other key, Ctrl included, is the
      // field's own.
      onKeyDown={(e) => {
        if (open && !e.nativeEvent.isComposing) {
          const item = items[active]!;
          const typed = token?.kind === 'slash' && item.value === text.trim(); // already typed in full: Enter sends it
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
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          send();
        }
      }}
      role={open ? 'combobox' : undefined}
      aria-expanded={open ? true : undefined}
      aria-controls={open ? pickerId : undefined}
      aria-activedescendant={open ? `${pickerId}-${active}` : undefined}
      aria-autocomplete={open ? 'list' : undefined}
      enterKeyHint={agent ? 'send' : 'go'}
      autoCapitalize={agent ? undefined : 'off'}
      autoCorrect={agent ? undefined : 'off'}
      spellCheck={agent ? undefined : false}
      aria-label={agent ? `Reply to ${agent}` : 'Command'}
      placeholder={placeholder}
      className={`min-w-0 flex-1 resize-none self-center bg-transparent placeholder:truncate placeholder:text-muted focus:outline-none ${
        desktop && agent
          ? 'min-h-11 py-0 text-[15px] leading-[22px]'
          : `max-h-24 min-h-9 py-2 leading-5 ${agent ? 'text-body' : 'font-mono text-[14px]'}`
      }`}
    />
  );
  // The prompt glyph labels the field from inside it: `›` for an Agent, `$` for a shell.
  // With the keys open on the phone, it becomes the way to close them.
  const glyph = (
    <span aria-hidden className={`font-mono ${agent ? 'text-accent' : 'text-ok'} ${desktop && agent ? 'text-[15px] leading-[22px]' : 'self-center'}`}>
      {agent ? '›' : '$'}
    </span>
  );

  // One box at both widths: the field on top, the toolbar under it with Send alone at the
  // right end. The phone gives the toolbar its own line rather than squeezing six controls
  // beside the field, which left 60 px to type into while ^C showed.
  const box = (
    <div className="relative flex flex-col rounded-card border border-border bg-bg focus-within:border-accent/60">
      {open && token && desktop && (
        <Picker id={pickerId} kind={token.kind} items={items} active={active} desktop onActive={setActive} onPick={pick} />
      )}
      <div className={`flex ${desktop ? 'gap-2.5 px-3 pt-3 pb-1.5' : 'gap-2 px-3 pt-1'}`}>
        {glyph}
        {textarea}
      </div>
      <div role="toolbar" aria-label="Composer" className={`flex items-center gap-1 ${desktop ? 'flex-wrap px-2 pt-1 pb-2' : 'px-1 pb-1'}`}>
        {suggestToggle}
        {keysToggle}
        {stopButton}
        <Divider />
        {attachButton}
        {agent && desktop && (
          <>
            <button
              type="button"
              aria-label="Type /"
              title="Types / — the Agent shows its commands"
              onClick={() => typeAtCaret('/')}
              className={`press flex size-8 shrink-0 items-center justify-center rounded-chip font-mono text-[15px] text-muted ${HOVER}`}
            >
              /
            </button>
            <button
              type="button"
              aria-label="Type @"
              title="Types @ — the Agent offers files"
              onClick={() => typeAtCaret('@')}
              className={`press flex size-8 shrink-0 items-center justify-center rounded-chip font-mono text-[14px] text-muted ${HOVER}`}
            >
              @
            </button>
          </>
        )}
        {micButton && (
          <>
            <Divider />
            {micButton}
          </>
        )}
        {desktop && agent && (toolbar.mode || toolbar.model || toolbar.context !== undefined) && (
          <>
            <Divider />
            {/* Read off the Screen, so muted: they report, they are not the work. */}
            <div className="flex min-w-0 items-center gap-1">
              {toolbar.mode && (
                // The chip follows the Screen: the tap only sends the key, the next Screen
                // says which mode the Agent landed in.
                <button
                  type="button"
                  aria-label={`Mode: ${toolbar.mode}. Send shift+tab to cycle`}
                  onClick={() => keys(CYCLE_MODE_KEYS)}
                  className={`press flex h-8 shrink-0 items-center gap-1.5 rounded-chip px-2 text-[12px] text-muted ${HOVER}`}
                >
                  ⏵⏵ {toolbar.mode}
                  <kbd className="rounded-[4px] border border-border px-[5px] font-mono text-[10.5px] font-normal">⇧⇥</kbd>
                </button>
              )}
              {toolbar.model && (
                <span title="Model, from the Screen" className="shrink-0 px-1.5 text-[12px] text-muted">
                  {toolbar.model}
                </span>
              )}
              {toolbar.context !== undefined && <ContextLeft left={toolbar.context} />}
            </div>
          </>
        )}
        <span className="flex-1" />
        {sendButton}
      </div>
    </div>
  );

  return (
    <div
      className={`flex shrink-0 flex-col ${
        desktop
          ? 'border-t border-border bg-elevated px-4 pt-3 pb-2'
          : 'rounded-t-drawer bg-elevated pt-3 pb-[max(env(safe-area-inset-bottom),8px)] shadow-[0_-8px_24px_rgb(0_0_0/0.25)]'
      }`}
    >
      <div className={`flex flex-col gap-2.5 ${desktop ? 'mx-auto w-full max-w-5xl' : ''}`}>
        {/* The blocked card takes the replies' place. The live region must exist before the
            card does, or a screen reader announces nothing: it stays mounted at zero height
            while no prompt asks. */}
        <div ref={cardRef} aria-live="polite" className={explain && !hideCard ? gutter : `-mb-2.5 h-0 overflow-hidden ${gutter}`}>
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

        {showSuggest && suggestTray}
        {showKeys && keysTray}
        {open && token && !desktop && (
          <Picker id={pickerId} kind={token.kind} items={items} active={active} desktop={false} onActive={setActive} onPick={pick} />
        )}

        {heldMessages.length > 0 && (
          <section aria-label="Held messages" className={`overflow-hidden rounded-composer border border-border bg-bg ${desktop ? '' : 'mx-4'}`}>
            <div className={`flex min-h-9 items-center gap-3 px-3 ${heldFolded ? '' : 'border-b border-border'}`}>
              <span aria-live="polite" className="flex-1 text-caption font-medium text-muted">
                {heldMessages.length} held
              </span>
              {status !== 'working' && (
                <button
                  type="button"
                  disabled={sendingHeld}
                  onClick={() => void flushHeld()}
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
                      onClick={() => {
                        dropPending([message.id]);
                        setHeldMessages((list) => list.filter((item) => item.id !== message.id));
                      }}
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

        <div className={`flex flex-col gap-1.5 ${gutter}`}>
          {listening && (
            <RecordingPill
              analyser={analyser}
              onCancel={() => stopDictation(false)}
              onDone={() => stopDictation(true)}
            />
          )}
          {fileInput}
          {box}

          {inFlight.length > 0 && (
            <div
              role="progressbar"
              aria-label="Uploading"
              aria-valuenow={Math.round(progress * 100)}
              className="h-0.5 overflow-hidden rounded-full bg-surface"
            >
              <div
                className="h-full bg-accent transition-[width] duration-150 ease-out motion-reduce:transition-none"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}

          {uploads.length > 0 && (
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
          )}

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

          {/* The legend for Send, under it on the right. */}
          {desktop && (
            <p className="-mt-0.5 flex items-center justify-end gap-1 pr-1 text-[10.5px] leading-[14px] text-muted/80">
              <Kbd>↵</Kbd> {agent ? 'send' : 'run'} · <Kbd>⇧↵</Kbd> newline
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
