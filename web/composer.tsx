import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Affordance, InputBody, Span, StatePane } from '../shared/types.ts';
import { hintPills } from './affordances.tsx';
import { api, haptic, post, reducedMotion } from './app.tsx';
import { Blocked, type ExplainResponse } from './blocked.tsx';
import { Attach, Keyboard, Mic, Send } from './icons.tsx';
import { AGENT_KEYS, SHELL_KEYS } from './keys.ts';
import { CYCLE_MODE_KEYS, toolbarFromScreen, type Profile } from './profiles.ts';
import { quickReplies, type Pill } from './replies.ts';

/** "Wider than the viewport" is a fade, not a scrollbar. The grid and the Diff screen reuse it. */
export const FADE = 'linear-gradient(to right,#000 calc(100% - 24px),transparent)';

/** localStorage that never throws: a full or blocked store must not break a send. */
const store = {
  get: (key: string): string | null => {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set: (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch {}
  },
};

/** Every key cap label the presets spell out, for the key bar an App profile asks for. */
const KEY_LABEL = new Map([...AGENT_KEYS, ...SHELL_KEYS]);

interface HeldMessage { id: number; text: string }
// ponytail: a module counter, only a React key and a remove handle; it never leaves the tab.
let heldMessageId = 0;

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

/** A desktop shortcut cap, the header's `kbd` look. */
const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded-[4px] border border-border px-[5px] font-mono text-[10.5px] text-muted">{children}</kbd>
);

/**
 * The dock under the Screen, at both widths. Phone: the keys toggle, the inline keys, the
 * quick replies, then the input. Desktop (`lg`): suggestion chips above a bordered box whose
 * toolbar reads mode, model and context off the Screen. A blocked prompt puts its card where
 * the replies were; a Pane with no Agent gets a `$` prompt and its recent commands.
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
}) {
  const agent = pane?.agent;
  const status = pane?.status ?? 'unknown';
  const kind = agent ? 'agent' : 'shell';

  // The open key preset is one state per kind. Both start closed: the resting row already
  // carries the keys a hand reaches for, and opening the grid hides the replies.
  const [keyBars, setKeyBars] = useState(() => ({
    agent: store.get('tautan.keys.agent') === 'on',
    shell: store.get('tautan.keys.shell') === 'on',
  }));
  const showKeys = keyBars[kind];
  const setShowKeys = (v: boolean) => {
    haptic();
    store.set(`tautan.keys.${kind}`, v ? 'on' : 'off');
    setKeyBars((k) => ({ ...k, [kind]: v }));
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

  const [text, setText] = useState('');
  const [heldMessages, setHeldMessages] = useState<HeldMessage[]>([]);
  const [sendingHeld, setSendingHeld] = useState(false);
  const heldGeneration = useRef(0);
  const flushingHeld = useRef(false);
  useEffect(() => {
    heldGeneration.current += 1;
    flushingHeld.current = false;
    setHeldMessages([]);
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

  // ---- attachments ----
  // `post()` is JSON only. An upload wants progress and an abort, so it goes out on XHR:
  // the browser sets Origin either way, which is what the Hub checks.
  const [uploads, setUploads] = useState<Upload[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const running = useRef(new Map<number, XMLHttpRequest>());

  const send = () => {
    const sent = text.trim();
    if (!sent) return;
    haptic();
    if (status === 'working') {
      const message = { id: (heldMessageId += 1), text };
      setHeldMessages((list) => [...list, message]);
    } else {
      void post(paneKey, 'input', { text, keys: ['enter'] } satisfies InputBody);
    }
    if (!agent && mayRemember(screenText)) setHistory(remember(sent));
    setText('');
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
      try {
        await api<void>(`/api/panes/${encodeURIComponent(paneKey)}/input`, {
          text: message.text,
          keys: ['enter'],
        } satisfies InputBody);
      } catch {
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

  const [ctrlArmed, setCtrlArmed] = useState(false);
  useEffect(() => setCtrlArmed(false), [paneKey, kind]);
  const keys = (names: string[]) => {
    haptic();
    if (names.length === 1 && names[0] === 'ctrl') {
      setCtrlArmed((armed) => !armed);
      return;
    }
    if (ctrlArmed) {
      setCtrlArmed(false);
      if (names.length === 1 && names[0] === 'esc') return;
      if (names.length === 1 && !names[0]!.includes('+')) names = [`ctrl+${names[0]}`];
    }
    void post(paneKey, 'input', { keys: names } satisfies InputBody);
  };

  /** A text pill is a draft, not an answer: it lands in the composer for review. */
  const fill = (reply: string) => {
    haptic();
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${reply}`);
    input.current?.focus();
  };

  /** `/` and `@` type their character at the caret and send nothing: the Agent's own TUI
   *  draws its menu once the text reaches it. */
  const typeAtCaret = (ch: string) => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setRangeText(ch, el.selectionStart, el.selectionEnd, 'end');
    setText(el.value);
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
  const pills: Pill[] = [
    ...replies.filter((p) => p.kind === 'key'),
    ...hintPills(affordances, replies).filter((p) => !(modeInToolbar && p.keys?.join() === CYCLE_MODE_KEYS.join())),
    ...replies.filter((p) => p.kind === 'text'),
  ];
  const commands = agent ? [] : history;
  // The App profile owns the key bar: htop and less carry the function keys their own footer
  // advertises, an agent carries the agent set. A name the base sets do not carry prints as
  // `F1`.
  const preset = profile.keys.all.map((name) => [name, KEY_LABEL.get(name) ?? name.toUpperCase()] as [string, string]);
  const inlineKeys = preset.filter(([name]) => profile.keys.inline.includes(name));
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

  const keysToggle = (
    // Filled, not a ghost: a control among the caps, and accent while it is open.
    <button
      type="button"
      aria-label={showKeys ? 'Close keys' : 'Keys'}
      aria-expanded={showKeys}
      aria-controls="pane-keys"
      onClick={() => setShowKeys(!showKeys)}
      className={`press flex shrink-0 items-center justify-center rounded-chip border ${desktop ? 'size-8' : 'size-9'} ${
        showKeys ? 'border-accent bg-accent text-bg' : 'border-border bg-surface text-fg'
      }`}
    >
      <Keyboard size={desktop ? 16 : 17} />
    </button>
  );

  const capClass = (name: string) => (name === 'ctrl+c' ? 'text-danger' : 'text-fg');
  const inlineCaps = inlineKeys.map(([name, label]) => (
    <button
      key={name}
      type="button"
      aria-label={name}
      onClick={() => keys([name])}
      className={`press flex shrink-0 items-center justify-center border border-border font-mono text-[11px] active:bg-surface ${
        desktop ? 'h-7 min-w-8 rounded-[6px] px-2' : 'h-9 min-w-10 rounded-chip px-2'
      } ${capClass(name)}`}
    >
      {label}
    </button>
  ));

  // The open preset: a fixed six-column grid, every cap the App profile carries.
  const grid = (
    <div
      id="pane-keys"
      role="group"
      aria-label="Keys"
      className={`rise grid grid-cols-6 gap-1.5 ${gutter} ${desktop ? 'max-w-md' : ''}`}
    >
      {preset.map(([name, label]) => (
        <button
          key={name}
          type="button"
          aria-label={name === 'ctrl' ? `${ctrlArmed ? 'Disarm' : 'Arm'} Control` : name}
          aria-pressed={name === 'ctrl' ? ctrlArmed : undefined}
          onClick={() => keys([name])}
          className={`press flex min-w-0 items-center justify-center truncate rounded-chip font-mono text-[12px] ${
            desktop ? 'h-8' : 'h-10'
          } ${name === 'ctrl' && ctrlArmed ? 'bg-accent/12 text-accent' : `bg-surface active:bg-border ${capClass(name)}`}`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const divider = <span aria-hidden className="mx-0.5 my-1 w-px shrink-0 self-stretch bg-border" />;

  /** The row the replies live in: keys first, then the pills and recent commands. The phone
   *  scrolls it; the desktop wraps it. */
  const quickRow = (withKeys: boolean) => {
    const rest = [...pillButtons, ...commandButtons];
    if (!withKeys && !rest.length) return null;
    return (
      <div className={`flex items-stretch gap-1.5 ${desktop ? '' : 'pl-4'}`}>
        {withKeys && (
          <>
            {keysToggle}
            {inlineCaps}
          </>
        )}
        {withKeys && rest.length > 0 && divider}
        {rest.length > 0 && (
          <div
            role="group"
            aria-label={agent ? 'Quick replies' : 'Recent commands'}
            className={desktop ? 'flex min-w-0 flex-1 flex-wrap gap-2' : 'hscroll flex min-w-0 flex-1 gap-1.5 pr-4'}
            style={desktop ? undefined : { maskImage: FADE, WebkitMaskImage: FADE }}
          >
            {rest}
          </div>
        )}
      </div>
    );
  };

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
      className={`press flex shrink-0 items-center justify-center rounded-chip text-muted hover:text-fg ${desktop ? 'size-8' : 'size-9'}`}
    >
      <Attach size={desktop ? 17 : 18} />
    </button>
  );
  const sendButton = (
    <button
      type="button"
      onClick={send}
      disabled={!hasText}
      aria-label={agent ? 'Send' : 'Run'}
      className={`press flex shrink-0 items-center justify-center rounded-chip ${desktop ? 'size-8' : 'size-9'} ${
        hasText ? 'bg-accent text-bg' : 'bg-surface text-muted'
      }`}
    >
      <Send size={desktop ? 17 : 18} />
    </button>
  );
  const micButton = canDictate && (
    <button
      type="button"
      onClick={dictate}
      aria-label={listening ? 'Done dictating' : 'Dictate'}
      aria-pressed={listening}
      className={`press flex shrink-0 items-center justify-center rounded-chip ${
        desktop ? `size-8 ${listening ? 'text-accent' : 'text-muted hover:text-fg'}` : 'size-9 bg-accent text-bg'
      }`}
    >
      <Mic size={desktop ? 17 : 18} />
    </button>
  );

  const placeholder = agent
    ? explain
      ? desktop ? `Or tell ${agent} what to do instead` : 'Or type an answer'
      : desktop ? `Reply to ${Agent} — / for commands, @ for files` : `Reply to ${Agent}…`
    : 'Type a command';
  const textarea = (
    <textarea
      ref={input}
      rows={desktop && agent ? 2 : 1}
      value={text}
      onChange={(e) => setText(e.target.value)}
      // Enter sends and Shift+Enter breaks the line; every other key, Ctrl included, is the
      // field's own.
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          send();
        }
      }}
      enterKeyHint={agent ? 'send' : 'go'}
      autoCapitalize={agent ? undefined : 'off'}
      autoCorrect={agent ? undefined : 'off'}
      spellCheck={agent ? undefined : false}
      aria-label={agent ? `Reply to ${agent}` : 'Command'}
      placeholder={placeholder}
      className={`flex-1 resize-none self-center bg-transparent placeholder:text-muted focus:outline-none ${
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

  const box = desktop && agent ? (
    <div className="flex flex-col rounded-card border border-border bg-bg focus-within:border-accent/60">
      <div className="flex gap-2.5 px-4 pt-3.5 pb-1.5">
        {glyph}
        {textarea}
      </div>
      <div role="toolbar" aria-label="Composer" className="flex flex-wrap items-center gap-1.5 pt-1.5 pr-2 pb-2 pl-2.5">
        {keysToggle}
        {attachButton}
        <button
          type="button"
          aria-label="Type /"
          title="Types / — the Agent shows its commands"
          onClick={() => typeAtCaret('/')}
          className="press flex size-8 shrink-0 items-center justify-center rounded-chip font-mono text-[15px] text-muted hover:text-fg"
        >
          /
        </button>
        <button
          type="button"
          aria-label="Type @"
          title="Types @ — the Agent offers files"
          onClick={() => typeAtCaret('@')}
          className="press flex size-8 shrink-0 items-center justify-center rounded-chip font-mono text-[14px] text-muted hover:text-fg"
        >
          @
        </button>
        <span aria-hidden className="mx-1 h-[18px] w-px shrink-0 bg-border" />
        {toolbar.mode && (
          // The chip follows the Screen: the tap only sends the key, the next Screen says
          // which mode the Agent landed in.
          <button
            type="button"
            aria-label={`Mode: ${toolbar.mode}. Send shift+tab to cycle`}
            onClick={() => keys(CYCLE_MODE_KEYS)}
            className="press flex h-7 shrink-0 items-center gap-1.5 rounded-chip bg-accent/12 px-2.5 text-[12px] font-medium text-accent"
          >
            ⏵⏵ {toolbar.mode}
            <kbd className="rounded-[4px] border border-accent/35 px-[5px] font-mono text-[10.5px] font-normal">⇧⇥</kbd>
          </button>
        )}
        {inlineCaps}
        <span className="flex-1" />
        {toolbar.context !== undefined && <ContextLeft left={toolbar.context} />}
        {toolbar.model && (
          <span title="Model, from the Screen" className="shrink-0 px-1.5 text-[12px] text-muted">
            {toolbar.model}
          </span>
        )}
        {micButton}
        {sendButton}
      </div>
    </div>
  ) : (
    <div className="flex items-end gap-1.5 rounded-card border border-border bg-bg py-1 pr-1 pl-3 focus-within:border-accent/60">
      {!desktop && showKeys ? (
        <button
          type="button"
          aria-label="Close keys"
          aria-expanded
          aria-controls="pane-keys"
          onClick={() => setShowKeys(false)}
          className="press flex h-9 w-7 shrink-0 items-center justify-center text-accent"
        >
          <Keyboard size={17} />
        </button>
      ) : (
        glyph
      )}
      {textarea}
      {attachButton}
      {desktop ? (
        <button
          type="button"
          onClick={send}
          disabled={!hasText}
          className={`press flex h-8 shrink-0 items-center gap-1.5 self-center rounded-chip px-3 text-[12px] ${
            hasText ? 'bg-accent font-medium text-bg' : 'bg-surface text-muted'
          }`}
        >
          Run <kbd className="font-mono text-[10.5px] opacity-70">↵</kbd>
        </button>
      ) : hasText || !micButton ? (
        sendButton
      ) : (
        micButton
      )}
    </div>
  );

  // What sits above the box: the card while a prompt asks, else the open keys, else the
  // resting row. The desktop agent keeps its keys in the toolbar, so its row is replies only.
  const above = explain
    ? null
    : showKeys
      ? grid
      : quickRow(!(desktop && agent));

  return (
    <div
      className={`flex shrink-0 flex-col ${
        desktop
          ? 'border-t border-border bg-elevated px-6 pt-4 pb-5'
          : 'rounded-t-drawer bg-elevated pt-3 pb-[max(env(safe-area-inset-bottom),12px)] shadow-[0_-8px_24px_rgb(0_0_0/0.25)]'
      }`}
    >
      <div className={`flex flex-col gap-2.5 ${desktop ? 'mx-auto w-full max-w-4xl' : ''}`}>
        {/* The blocked card takes the replies' place. The live region must exist before the
            card does, or a screen reader announces nothing: it stays mounted at zero height
            while no prompt asks. */}
        <div ref={cardRef} aria-live="polite" className={explain ? gutter : `-mb-2.5 h-0 overflow-hidden ${gutter}`}>
          <div className={`transition-opacity duration-150 ${status === 'blocked' && explain ? 'opacity-100' : 'opacity-0'}`}>
            {explain && (
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

        {above}

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
                      onClick={() => setHeldMessages((list) => list.filter((item) => item.id !== message.id))}
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

          {desktop && (
            <p className="flex items-center gap-1.5 text-[12px] text-muted">
              <Kbd>↵</Kbd> {agent ? 'send' : 'run'} · <Kbd>⇧↵</Kbd> newline
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
