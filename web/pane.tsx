import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { findAffordances } from '../shared/affordances.ts';
import { parseAnsi } from '../shared/ansi.ts';
import type {
  Explain, InputBody, NewTabBody, NewTabResult, RenameBody, ScreenEvent, SeenBody, Span, State, StatePane, Status,
} from '../shared/types.ts';
import { AffordanceLayer, hintPills, useCell, useMouseForward } from './affordances.tsx';
import { api, haptic, navigate, opensWith, post } from './app.tsx';
import { Blocked } from './blocked.tsx';
import { mouseAllowed, profileFor, setMouseOverride } from './profiles.ts';
import { commonAgent, Dot, markSeen, statusText } from './home.tsx';
import { Attach, Back, ChevronDown, Down, Keyboard, Mic, More, Plus, Send, Speaker } from './icons.tsx';
import { ConfirmCloseSheet, MenuSheet, NewTabSheet, RenameSheet } from './sheets.tsx';
import { ThemePicker } from './settings.tsx';
import { SwitchDrawer } from './switch.tsx';
import { AGENT_KEYS, SHELL_KEYS } from './keys.ts';
import { quickReplies } from './replies.ts';

// ---- themed terminal colours ----
// A 256-colour or truecolour span carries the palette the agent picked, which is nobody's
// theme. Snapped on, every such colour becomes the nearest of the theme's own 16, so one
// Pane reads as one picture. Indices 0–15 already resolve through `--ansi-*` and are left be.
let themed = localStorage.getItem('tautan.themedColors') !== 'off';
export const themedColors = () => themed;
export function setThemedColors(on: boolean) {
  themed = on;
  localStorage.setItem('tautan.themedColors', on ? 'on' : 'off');
}

const EXTRA_TOKENS = ['--warn', '--ok', '--danger', '--accent'] as const;
let paletteTheme: string | null = null;
let palette: [number, number, number][] = [];
/** One answer per distinct colour string: a screen repeats the same few thousands of times. */
const snapped = new Map<string, string>();

function parseColor(css: string): [number, number, number] | null {
  const s = css.trim();
  if (s.startsWith('#')) {
    const hex = s.length === 4 ? [...s.slice(1)].map((c) => c + c).join('') : s.slice(1);
    if (hex.length < 6) return null;
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  }
  const n = s.match(/\d+/g);
  return n && n.length >= 3 ? [+n[0]!, +n[1]!, +n[2]!] : null;
}

/** The nearest `--ansi-*` by squared RGB distance. The palette is read once per theme. */
function nearestAnsi(css: string): string {
  const theme = document.documentElement.dataset.theme ?? '';
  if (theme !== paletteTheme) {
    const style = getComputedStyle(document.documentElement);
    // The sixteen ANSI slots plus the theme's semantic tokens: Catppuccin has no orange among
    // its sixteen, so without --warn a peach permission frame would snap to pink.
    palette = [
      ...Array.from({ length: 16 }, (_, i) => `--ansi-${i}`),
      ...EXTRA_TOKENS,
    ].map((v) => parseColor(style.getPropertyValue(v)) ?? [0, 0, 0]);
    paletteTheme = theme;
    snapped.clear();
  }
  const hit = snapped.get(css);
  if (hit) return hit;
  const want = parseColor(css);
  let best = css;
  if (want) {
    let bestAt = 0;
    let bestBy = Infinity;
    palette.forEach((p, i) => {
      const d = (p[0] - want[0]) ** 2 + (p[1] - want[1]) ** 2 + (p[2] - want[2]) ** 2;
      if (d < bestBy) {
        bestBy = d;
        bestAt = i;
      }
    });
    best = `var(${bestAt < 16 ? `--ansi-${bestAt}` : EXTRA_TOKENS[bestAt - 16]})`;
  }
  snapped.set(css, best);
  return best;
}

const color = (c: number | string | undefined) =>
  typeof c === 'number' ? `var(--ansi-${c})` : c && themed ? nearestAnsi(c) : c;

/** The one ANSI-span style function. blocked.tsx renders the detection with it too. */
export function spanStyle(s: Span): CSSProperties {
  let fg = color(s.fg);
  let bg = color(s.bg);
  if (s.inverse) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--fg)'];
  const lines = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ');
  return {
    color: fg,
    background: bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.6 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: lines || undefined,
  };
}

/** Styled ANSI text. Shared by the grid and the blocked card's detection excerpt. */
export function Ansi({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((spans, i) => (
        <Fragment key={i}>
          {spans.map((s, j) => (
            <span key={j} style={spanStyle(s)}>
              {s.text}
            </span>
          ))}
          {'\n'}
        </Fragment>
      ))}
    </>
  );
}

/** Every key cap label the presets spell out, for the key bar an App profile asks for. */
const KEY_LABEL = new Map([...AGENT_KEYS, ...SHELL_KEYS]);

const ROLL: Status[] = ['blocked', 'working', 'done', 'idle', 'unknown'];
const rollUp = (panes: StatePane[]): Status => ROLL.find((s) => panes.some((p) => p.status === s)) ?? 'unknown';

/** The Pane a Tab reopens to, so switching back lands where you left. */
const lastPane = new Map<string, string>();

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** "Wider than the viewport" is a fade, not a scrollbar. The Diff screen reuses it. */
export const FADE = 'linear-gradient(to right,#000 calc(100% - 24px),transparent)';

/** The last block the agent printed, for read-aloud. */
function lastBlock(text?: string): string {
  if (!text) return '';
  const blocks = plain(text)
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.at(-1) ?? '';
}

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

export function PaneScreen({ paneKey, state, screen }: { paneKey: string; state: State | null; screen: ScreenEvent | null }) {
  const pane = state?.panes.find((p) => p.key === paneKey);
  const ws = state?.workspaces.find((w) => w.muxKey === pane?.muxKey && w.id === pane?.workspaceId);
  const mux = state?.muxes.find((m) => m.key === pane?.muxKey);
  const host = state?.hosts.find((h) => h.id === mux?.hostId);
  /** Only herdr writes. tmux answers 501, so New Tab, Rename and Close are not offered. */
  const writable = mux?.kind === 'herdr';
  const lines = useMemo(() => (screen ? parseAnsi(screen.text) : []), [screen]);

  // Wrap is the default reading mode for an agent and never for a shell, where the columns
  // are the layout (htop, logs). Remembered per kind, not per Pane.
  const kind = pane?.agent ? 'agent' : 'shell';
  const [wraps, setWraps] = useState(() => ({
    agent: localStorage.getItem('tautan.wrap.agent') === 'on',
    shell: localStorage.getItem('tautan.wrap.shell') === 'on',
  }));
  const wrap = wraps[kind];
  const setWrap = (v: boolean) => {
    localStorage.setItem(`tautan.wrap.${kind}`, v ? 'on' : 'off');
    setWraps((w) => ({ ...w, [kind]: v }));
  };
  // Fit is off until the user asks for it: the column grows to the grid's own width on a
  // desktop, so scaling is a phone answer, not the default. The scale is min(1, …), so a
  // grid that already fits is left alone even then.
  const [fit, setFitState] = useState(() => localStorage.getItem('tautan.fit') === 'on');
  const setFit = (v: boolean) => { localStorage.setItem('tautan.fit', v ? 'on' : 'off'); setFitState(v); };
  // The key bar is one row of the dock, behind its own trigger: an agent Pane types, so it
  // starts collapsed and the composer is nearest the keyboard; a shell Pane only has keys.
  const [keyBars, setKeyBars] = useState(() => ({
    agent: localStorage.getItem('tautan.keys.agent') === 'on',
    shell: localStorage.getItem('tautan.keys.shell') !== 'off',
  }));
  const showKeys = keyBars[kind];
  const setShowKeys = (v: boolean) => {
    localStorage.setItem(`tautan.keys.${kind}`, v ? 'on' : 'off');
    setKeyBars((k) => ({ ...k, [kind]: v }));
  };
  const [scale, setScale] = useState(1);
  /** The grid's own width, measured from the `<pre>`. It sizes the whole column. */
  const [natural, setNatural] = useState(0);
  const [fade, setFade] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [explain, setExplain] = useState<Explain | null>(null);
  const [showSwitch, setShowSwitch] = useState(() => opensWith('switch'));
  const [showMore, setShowMore] = useState(() => opensWith('more'));
  const [showNewTab, setShowNewTab] = useState(() => opensWith('newtab'));
  // Off means the agent's own 256-colour and truecolour values render as sent.
  const [themedOn, setThemedOn] = useState(themedColors);
  const [rename, setRename] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  // Keep the view pinned to the bottom unless the user scrolled up.
  const box = useRef<HTMLDivElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  const measure = () => {
    const el = box.current;
    if (!el) return;
    setFade(el.scrollWidth > el.clientWidth + 1 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    else if (lines.length) setFresh(true);
    measure();
  }, [lines]);

  // Window width feeds the Fit scale, so a rotation or a desktop resize re-fits the grid.
  const [viewportW, setViewportW] = useState(() => innerWidth);
  // The mono subset swaps in after first paint and changes every column's width with it, so
  // the grid is measured again once the fonts are settled.
  const [fonts, setFonts] = useState(false);
  useEffect(() => {
    void document.fonts?.ready.then(() => {
      setNatural(0);
      setFonts(true);
    });
  }, []);
  useEffect(() => {
    const onResize = () => { setViewportW(innerWidth); measure(); };
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  // ---- interactive screen (ADR 0003) ----
  // The App profile is the gate: it says which Hints to look for, which keys the dock
  // carries, and whether this program reads a mouse report at all.
  const profile = useMemo(() => profileFor(pane), [pane?.agent, pane?.command]);
  const affordances = useMemo(() => findAffordances(lines, profile), [lines, profile]);
  const cell = useCell(pre, scale, fonts);
  /** Bumped by the ⋯ switch, so the per-Pane override is re-read without a second store. */
  const [override, setOverride] = useState(0);
  const mouseOn = useMemo(() => mouseAllowed(paneKey, pane), [paneKey, pane?.agent, pane?.command, override]);
  // Cell coordinates need the grid, so both mechanisms stop at Wrap.
  const forwarding = mouseOn && !wrap;
  /** The row window the overlay draws, in tens of rows, so scrolling repaints it rarely. */
  const [band, setBand] = useState(0);
  const mouse = useMouseForward({
    paneKey,
    on: forwarding,
    pre,
    cell,
    scale,
    cols: pane?.cols ?? 80,
    rows: pane?.rows ?? lines.length,
  });

  useEffect(() => {
    const el = pre.current;
    if (!el || !el.parentElement) return setScale(1);
    // The scroller carries the grid's padding, so the room the `<pre>` actually has is
    // narrower than the scroller. Measuring against `clientWidth` alone left Fit on and the
    // last column still cut off.
    const pad = getComputedStyle(el.parentElement);
    const room = el.parentElement.clientWidth - parseFloat(pad.paddingLeft || '0') - parseFloat(pad.paddingRight || '0');
    setScale(fit ? Math.min(1, room / el.scrollWidth) : 1);
    // Wrapped text is sized by the column it sits in, so measuring it would feed the column
    // its own width back. The fallback column is the right width for reflowed prose anyway.
    // The widest line wins and keeps winning: a column that resized on every frame of agent
    // output would move the header, the Tabs and the dock with it.
    if (!wrap) setNatural((n) => Math.max(n, el.scrollWidth));
    measure();
  }, [fit, wrap, lines, viewportW, fonts]);

  // Mark Seen once the screen settles: Seen is tautan's own flag, never written to the Mux.
  useEffect(() => {
    if (!screen) return;
    markSeen(paneKey, screen.revision);
    const t = setTimeout(() => void post(paneKey, 'seen', { revision: screen.revision } satisfies SeenBody), 1000);
    return () => clearTimeout(t);
  }, [paneKey, screen?.revision]);

  useEffect(() => {
    if (pane) lastPane.set(`${pane.muxKey}/${pane.tabId}`, pane.key);
  }, [pane?.key]);

  /** A new Pane measures its own grid rather than inheriting the last one's column. */
  useEffect(() => setNatural(0), [paneKey]);

  // Smart replies are the phone's own switch; Settings writes it and tells the Hub too.
  const [smart] = useState(() => localStorage.getItem('tautan.smart') === 'on');

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

  // The blocked card outlives the status by 150 ms, so it fades instead of vanishing.
  useEffect(() => {
    if (pane?.status === 'blocked') {
      fetch(`/api/panes/${encodeURIComponent(paneKey)}/explain`)
        .then((r) => r.json() as Promise<Explain | null>)
        .then(setExplain)
        .catch(() => {});
      return;
    }
    if (!explain) return;
    const t = setTimeout(() => setExplain(null), 150);
    return () => clearTimeout(t);
  }, [paneKey, pane?.status, pane?.revision]);

  const tabs = useMemo(() => {
    if (!state || !pane) return [];
    const mine = state.panes.filter((p) => p.muxKey === pane.muxKey && p.workspaceId === pane.workspaceId);
    const listed = state.tabs.filter((t) => t.muxKey === pane.muxKey && t.workspaceId === pane.workspaceId);
    const ids = listed.length ? listed.map((t) => [t.id, t.label] as const) : [...new Set(mine.map((p) => p.tabId))].map((id) => [id, ''] as const);
    return ids.map(([id, label]) => {
      const panes = mine.filter((p) => p.tabId === id);
      return { id, label: label || panes[0]?.title || id, panes, status: rollUp(panes) };
    });
  }, [state, pane?.muxKey, pane?.workspaceId]);

  // One underline that slides, rather than a border that jumps: measured from the selected
  // tab, so a relabelled or newly created Tab moves it without a second source of truth.
  const strip = useRef<HTMLDivElement>(null);
  const [underline, setUnderline] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const on = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    setUnderline(on ? { x: on.offsetLeft, w: on.offsetWidth } : { x: 0, w: 0 });
  }, [tabs, pane?.tabId, viewportW]);

  const openTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    const next = lastPane.get(`${pane?.muxKey}/${id}`) ?? tab?.panes[0]?.key;
    if (!next || next === paneKey) return;
    haptic();
    navigate(`#/pane/${encodeURIComponent(next)}`);
  };

  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // 4 rows at line-height 20 plus padding
  }, [text]);

  const send = () => {
    if (!text.trim()) return;
    haptic();
    void post(paneKey, 'input', { text, keys: ['enter'] } satisfies InputBody);
    setText('');
    // The paths went with the text. A chip still uploading keeps its place.
    setUploads((list) => list.filter((u) => u.status === 'uploading'));
    input.current?.focus();
  };

  const keys = (names: string[]) => {
    haptic();
    void post(paneKey, 'input', { keys: names } satisfies InputBody);
  };

  /** A text pill is a draft, not an answer: it lands in the composer for review. */
  const fill = (reply: string) => {
    haptic();
    setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${reply}`);
    input.current?.focus();
  };

  // ---- attachments ----
  // `post()` is JSON only. An upload wants progress and an abort, so it goes out on XHR:
  // the browser sets Origin either way, which is what the Hub checks.
  const [uploads, setUploads] = useState<Upload[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const running = useRef(new Map<number, XMLHttpRequest>());

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

  const speak = () => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    if (synth.speaking) return synth.cancel();
    synth.speak(new SpeechSynthesisUtterance(lastBlock(screen?.text)));
  };

  // Touch, not pointer: the moment a horizontal drag starts, Chromium hands the gesture to
  // the nearest scroller and fires `pointercancel`, so `pointerup` never arrives on a phone.
  // `touchend` always does. The strip's own scroll position guards the ambiguous case —
  // with more Tabs than fit, dragging scrolls the strip and must not also switch Tab.
  const swipe = useRef({ x: 0, scroll: 0 });
  const rec = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const dictate = () => {
    if (rec.current) {
      rec.current.stop();
      return;
    }
    const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Ctor) return;
    const r = new Ctor();
    r.continuous = false;
    r.interimResults = false;
    // Dictation lands in the field for review; it never sends. See docs/DECISIONS.md.
    r.onresult = (e) => setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${e.results[0]?.[0]?.transcript ?? ''}`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    setListening(true);
    r.start();
  };

  if (state && !pane) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-start gap-3 px-4 pt-[calc(env(safe-area-inset-top)+4rem)] lg:max-w-4xl">
        <p className="text-body">Pane closed</p>
        <a href="#/" className="text-body text-accent">
          ‹ All panes
        </a>
      </div>
    );
  }

  const agent = pane?.agent;
  const status = pane?.status ?? 'unknown';
  // No engine, no button: Send stays in place, disabled, rather than a mic that does nothing.
  const canDictate = 'webkitSpeechRecognition' in window;
  const active = tabs.find((t) => t.id === pane?.tabId);
  const grid = pane?.cols && pane.rows ? `${pane.cols}×${pane.rows}` : 'fit';
  // The App profile decides for every Pane running that program; the switch decides for
  // this one. Wrap wins over both, so the row says so rather than lying about the state.
  const mouseSource =
    mouseOn && wrap
      ? 'off while Wrap is on'
      : localStorage.getItem(`tautan.mouse.${paneKey}`)
        ? 'overridden'
        : `from ${pane?.command ?? pane?.agent ?? 'the generic'} profile`;
  const replies = agent ? quickReplies({ agent, explain, suggestions: pane?.suggestions, smart }) : [];
  // The keys the blocked prompt offers stay first, because answering it is why the Pane is
  // open; then the Hints the Screen itself printed, then the quick replies. Deduped, so a
  // Hint that repeats the prompt's own `esc to cancel` is listed once.
  const pills = [
    ...replies.filter((p) => p.kind === 'key'),
    ...hintPills(affordances, replies),
    ...replies.filter((p) => p.kind === 'text'),
  ];
  // The App profile owns the key bar now: htop and less carry the function keys their own
  // footer advertises, an agent carries the agent set. The cap's label is the key bar's own
  // spelling, so a name the base sets do not carry prints as `F1`.
  const preset = profile.keys.all.map((name) => [name, KEY_LABEL.get(name) ?? name.toUpperCase()] as [string, string]);
  const inlineKeys = preset.filter(([name]) => profile.keys.inline.includes(name));
  // One column for the whole screen, the grid's own width plus the scroller's padding, so a
  // desktop centres a content-sized Pane instead of stretching every bar to the window. A
  // phone is simply the window. See DESIGN.md "Terminal width on a phone".
  // 32 px is the scroller's own padding; the 2 px on top absorbs the fraction `scrollWidth`
  // rounds away, so the grid never overflows by a hair and raises the fade for nothing.
  const column = viewportW >= 1024 ? `clamp(420px, ${(natural || 640) + 34}px, 100vw)` : undefined;

  return (
    <div className="mx-auto flex h-dvh w-full flex-col pt-[env(safe-area-inset-top)]" style={{ maxWidth: column }}>
      {/* One 44 px row, everything centred on it: back · title · status, which is also the
          Switch trigger · actions. The title never shrinks below its own text until it would
          take more than 60 % of the row, so what gives way on a phone is the status text. */}
      <header className="flex h-11 shrink-0 items-center px-1">
        <a href="#/" aria-label="All panes" className="flex size-11 shrink-0 items-center justify-center text-accent">
          <Back />
        </a>
        <h1 className="max-w-[60%] shrink-0 truncate text-title tracking-tight">{pane?.title ?? '…'}</h1>
        {/* Status and the ⌄ are one trigger: one drawer, one name, one hit area. */}
        <button
          type="button"
          aria-label="Switch Pane"
          onClick={() => setShowSwitch(true)}
          className="press flex h-11 min-w-0 items-center gap-1.5 pl-2 text-caption text-muted"
        >
          <Dot status={status} />
          <span aria-live="polite" className={`shrink-0 ${statusText[status]}`}>
            {status}
          </span>
          <span className="truncate">
            · {agent ?? 'shell'} · {ws?.label}
          </span>
          <span aria-hidden className="flex shrink-0 items-center">
            <ChevronDown />
          </span>
        </button>
        {/* What is left after the Tab strip took + and the ⋯ sheet took Fit. */}
        <div className="ml-auto flex items-center gap-0.5 pl-1">
          {agent && (
            <button
              type="button"
              aria-label="Read aloud"
              onClick={speak}
              className="press flex h-11 w-10 items-center justify-center text-muted"
            >
              <Speaker />
            </button>
          )}
          <button
            type="button"
            aria-label="More"
            onClick={() => setShowMore(true)}
            className="press flex h-11 w-10 items-center justify-center text-muted"
          >
            <More />
          </button>
        </div>
      </header>

      {/* The strip is one section of two rows: the Workspace's Tabs, and the open Tab's
          Panes under them. Swipe here, never on the grid. */}
      <div
        className="shrink-0 px-3 pt-0.5 pb-1.5"
        onTouchStart={(e) => {
          swipe.current = { x: e.touches[0]?.clientX ?? 0, scroll: strip.current?.scrollLeft ?? 0 };
        }}
        onTouchEnd={(e) => {
          const dx = (e.changedTouches[0]?.clientX ?? 0) - swipe.current.x;
          const scrolled = Math.abs((strip.current?.scrollLeft ?? 0) - swipe.current.scroll) > 4;
          if (scrolled || Math.abs(dx) < 40 || !active) return;
          const i = tabs.indexOf(active) + (dx < 0 ? 1 : -1);
          if (tabs[i]) openTab(tabs[i].id);
        }}
      >
        <div className="flex items-stretch border-b border-border">
          {writable && (
            <button
              type="button"
              aria-label="New Tab"
              onClick={() => setShowNewTab(true)}
              className="press mr-1 flex w-9 shrink-0 items-center justify-center self-end pb-2 text-accent"
            >
              <Plus />
            </button>
          )}
          <div ref={strip} role="tablist" aria-label="Tabs" className="hscroll relative flex min-w-0 flex-1 items-end gap-0.5">
            {tabs.map((t) => {
              const on = t.id === pane?.tabId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => openTab(t.id)}
                  className={`press flex shrink-0 items-center gap-1.5 px-2.5 pt-2 pb-3 text-[13px] whitespace-nowrap ${
                    on ? 'font-semibold text-fg' : 'font-medium text-muted'
                  }`}
                >
                  <Dot status={t.status} seen={t.status === 'idle' || t.status === 'unknown'} size={6} />
                  {t.label}
                  {t.panes.length > 1 && <span className="ml-0.5 font-mono text-[10px] text-muted">{t.panes.length}</span>}
                </button>
              );
            })}
            <span
              aria-hidden
              data-testid="tab-underline"
              className="absolute bottom-[-1px] left-0 h-0.5 bg-accent transition-[transform,width] duration-200 ease-out motion-reduce:transition-none"
              style={{ width: underline.w, transform: `translateX(${underline.x}px)` }}
            />
          </div>
          {/* Taps on the grid are going to the program, not to tautan. */}
          {forwarding && (
            <span className="mb-2 ml-1.5 shrink-0 self-end rounded-chip border border-border px-1.5 py-0.5 font-mono text-[10px] text-accent">
              mouse
            </span>
          )}
        </div>

        {/* Row two: the Panes of the Tab the underline points at. It carries the section's
            hairline on its own top edge — pulled up by the pixel the row above draws, so the
            two rows share one line — and starts where the Tab labels do, not under the +. */}
        {active && active.panes.length > 1 && (
          <div
            role="group"
            aria-label="Panes in this Tab"
            className={`hscroll -mt-px flex gap-1.5 border-t border-border pt-1.5 ${writable ? 'pl-10' : ''}`}
          >
            {active.panes.map((p) => (
              <button
                key={p.key}
                type="button"
                aria-current={p.key === paneKey ? 'true' : undefined}
                onClick={() => {
                  haptic();
                  navigate(`#/pane/${encodeURIComponent(p.key)}`);
                }}
                className={`press flex shrink-0 items-center gap-1.5 rounded-chip px-2.5 py-1 text-[12px] whitespace-nowrap ${
                  p.key === paneKey ? 'bg-surface font-medium text-fg' : 'text-muted'
                }`}
              >
                <Dot status={p.status} size={6} seen={p.key !== paneKey} />
                {p.agent ?? 'shell'}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={box}
          {...mouse}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (pinned.current) setFresh(false);
            setBand(Math.floor(el.scrollTop / Math.max(1, cell.rh * scale) / 10));
            measure();
          }}
          className="h-full overflow-auto pt-1 pb-2 pl-4 lg:pr-4"
          style={{
            ...(fade ? { maskImage: FADE, WebkitMaskImage: FADE } : null),
            // A vertical drag is the app's wheel while forwarding; sideways stays the
            // scroller's, so a 120-column grid can still be read across.
            ...(forwarding ? { touchAction: 'pan-x' as const } : null),
          }}
        >
          <pre
            ref={pre}
            className={`relative font-mono text-caption lg:mx-auto ${
              // Wrapped text takes the column; unwrapped text keeps the grid's own width.
              // `w-max` would be max-content, which never wraps, so Wrap needs `w-full`.
              wrap ? 'w-full break-words whitespace-pre-wrap' : 'w-max min-w-full whitespace-pre lg:min-w-0'
            }`}
            style={{
              // Never reflow wider than the Pane itself: the agent wrote for `cols` columns.
              maxWidth: wrap && pane?.cols ? `${pane.cols}ch` : undefined,
              ...(scale < 1 ? { transform: `scale(${scale})`, transformOrigin: 'top left' } : null),
            }}
          >
            {lines.map((spans, i) => (
              <Fragment key={i}>
                {spans.map((sp, j) => (
                  <span key={j} style={spanStyle(sp)}>
                    {sp.text}
                  </span>
                ))}
                {'\n'}
              </Fragment>
            ))}
            {/* Inside the `<pre>`, so the Fit transform scales the boxes with the text. */}
            {!wrap && affordances.length > 0 && (
              <AffordanceLayer
                paneKey={paneKey}
                list={affordances}
                cell={cell}
                scale={scale}
                from={band * 10 - 10}
                to={band * 10 + 60}
              />
            )}
          </pre>
        </div>
        {fresh && (
          <button
            type="button"
            onClick={() => {
              const el = box.current;
              if (el) el.scrollTop = el.scrollHeight;
              pinned.current = true;
              setFresh(false);
            }}
            className="absolute inset-x-0 bottom-2 mx-auto flex w-max items-center gap-1.5 rounded-chip bg-elevated px-3 py-1.5 text-caption font-medium text-fg shadow-elevated"
          >
            <Down />
            New output
          </button>
        )}
      </div>

      {explain && (
        <div className={`transition-opacity duration-150 ${status === 'blocked' ? 'opacity-100' : 'opacity-0'}`}>
          <Blocked explain={explain} />
        </div>
      )}

      <div className="flex shrink-0 flex-col gap-2.5 rounded-t-drawer bg-elevated pt-3 pb-[max(env(safe-area-inset-bottom),12px)] shadow-[0_-8px_24px_rgb(0_0_0/0.25)]">
        {/* One bar: the keys a hand reaches for on the left, the replies you tap on the right. */}
        <div className="flex items-center gap-2 pl-4">
          <div className="flex shrink-0 items-center gap-1">
            {/* The toggle opens the rest of the preset, so it leads the row it belongs to.
                Filled, not a ghost: a control among the caps, and accent while it is open. */}
            <button
              type="button"
              aria-label="Keys"
              aria-expanded={showKeys}
              aria-controls="pane-keys"
              onClick={() => {
                haptic();
                setShowKeys(!showKeys);
              }}
              className={`press flex size-9 items-center justify-center rounded-chip border ${
                showKeys ? 'border-accent bg-accent text-bg' : 'border-border bg-surface text-fg'
              }`}
            >
              <Keyboard />
            </button>
            {inlineKeys.map(([name, label]) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                onClick={() => keys([name])}
                className="press flex h-9 min-w-9 items-center justify-center rounded-chip border border-border bg-bg px-2 font-mono text-[11px] text-fg active:bg-surface"
              >
                {label}
              </button>
            ))}
          </div>
          {pills.length > 0 && (
            <div
              role="group"
              aria-label="Quick replies"
              className="hscroll flex min-w-0 flex-1 gap-2 border-l border-border py-0.5 pr-4 pl-2"
              style={{ maskImage: FADE, WebkitMaskImage: FADE }}
            >
              {pills.map((p, i) =>
                p.kind === 'key' ? (
                  <button
                    key={`${p.label}-${i}`}
                    type="button"
                    aria-label={p.aria}
                    onClick={() => keys(p.keys!)}
                    className={`press flex shrink-0 items-center gap-1.5 rounded-chip px-3 py-[7px] text-[13px] whitespace-nowrap ${
                      i === 0
                        ? 'bg-accent font-semibold text-bg'
                        : 'border border-border bg-bg font-medium text-fg active:bg-surface'
                    }`}
                  >
                    {p.label}
                    {p.glyph && (
                      <span className={`font-mono text-[11px] ${i === 0 ? 'opacity-70' : 'text-muted'}`}>{p.glyph}</span>
                    )}
                  </button>
                ) : (
                  <button
                    key={`${p.label}-${i}`}
                    type="button"
                    aria-label={p.aria}
                    onClick={() => fill(p.label)}
                    className={`press flex shrink-0 items-center gap-1.5 rounded-chip border border-border bg-bg px-3 py-[7px] text-[13px] whitespace-nowrap active:bg-surface ${
                      p.generated ? 'text-fg' : 'text-muted'
                    }`}
                  >
                    {p.generated && <span aria-hidden className="text-accent">✦</span>}
                    {p.label}
                  </button>
                ),
              )}
            </div>
          )}
        </div>

        {showKeys && (
          <div id="pane-keys" role="group" aria-label="Keys" className="rise hscroll flex gap-2 px-4">
            {preset.map(([name, label]) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                onClick={() => keys([name])}
                className={`press flex h-9 shrink-0 items-center justify-center rounded-chip border border-border bg-bg px-3 font-mono text-caption active:bg-surface ${
                  name === 'ctrl+c' ? 'text-danger' : 'text-fg'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {agent && (
          <div className="flex flex-col gap-1.5 px-4">
            <div className="flex items-end gap-2 rounded-composer border border-border bg-bg py-1 pr-1.5 pl-3">
              {/* The agent's glyph labels the field from inside it, where the prompt is. */}
              <span aria-hidden className="self-center text-accent">
                ✻
              </span>
              <textarea
                ref={input}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
                enterKeyHint="send"
                aria-label={`Reply to ${agent}`}
                placeholder={`Reply to ${agent[0]!.toUpperCase()}${agent.slice(1)}…`}
                className="max-h-24 min-h-9 flex-1 resize-none self-center bg-transparent py-2 text-body leading-5 placeholder:text-muted focus:outline-none"
              />
              {text.trim() || !canDictate ? (
                <button
                  type="button"
                  onClick={send}
                  disabled={!text.trim()}
                  aria-label="Send"
                  className={`press flex size-9 shrink-0 items-center justify-center rounded-chip ${
                    text.trim() ? 'bg-accent text-bg' : 'bg-surface text-muted'
                  }`}
                >
                  <Send />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={dictate}
                  aria-label="Dictate"
                  aria-pressed={listening}
                  className={`press flex size-9 shrink-0 items-center justify-center ${listening ? 'text-accent' : 'text-muted'}`}
                >
                  <Mic />
                </button>
              )}
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
              <button
                type="button"
                aria-label="Attach"
                onClick={() => picker.current?.click()}
                className="flex size-9 shrink-0 items-center justify-center text-muted"
              >
                <Attach />
              </button>
            </div>

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
          </div>
        )}
      </div>

      <SwitchDrawer open={showSwitch} onClose={() => setShowSwitch(false)} state={state} currentKey={paneKey} onPick={haptic} />
      <MenuSheet
        open={showMore}
        title={pane?.title ?? 'Pane'}
        onClose={() => setShowMore(false)}
        head={<ThemePicker />}
        items={[
          { label: wrap ? 'Wrap: on' : 'Wrap: off', onClick: () => setWrap(!wrap) },
          { label: fit ? 'Fit to width: on' : 'Fit to width: off', hint: grid, onClick: () => setFit(!fit) },
          {
            label: themedOn ? 'Theme colors: on' : 'Theme colors: off',
            onClick: () => {
              setThemedColors(!themedOn);
              setThemedOn(!themedOn);
            },
          },
          {
            label: mouseOn ? 'Mouse taps: on' : 'Mouse taps: off',
            sub: mouseSource,
            onClick: () => {
              setMouseOverride(paneKey, mouseOn ? 'off' : 'on');
              setOverride((n) => n + 1);
            },
          },
          ...(ws ? [{ label: 'Diff', onClick: () => navigate(`#/diff/${encodeURIComponent(ws.key)}`) }] : []),
          ...(writable
            ? [
                { label: 'Rename', onClick: () => setRename(true) },
                { label: 'Close Pane', danger: true, onClick: () => setConfirmClose(true) },
              ]
            : []),
          { label: 'Resize to phone', hint: 'v2', disabled: true },
        ]}
      />
      <NewTabSheet
        open={showNewTab}
        onClose={() => setShowNewTab(false)}
        cwd={ws?.cwd}
        agent={commonAgent(state?.panes.filter((p) => p.muxKey === pane?.muxKey && p.workspaceId === pane?.workspaceId) ?? [])}
        where={
          <>
            in <span className="text-fg">{ws?.label}</span> · {host?.label}
          </>
        }
        onSubmit={async (o) => {
          const { paneKey: created } = await api<NewTabResult>(
            `/api/muxes/${encodeURIComponent(pane!.muxKey)}/tabs`,
            { workspaceId: pane!.workspaceId, ...o } satisfies NewTabBody,
          );
          navigate(`#/pane/${encodeURIComponent(created)}`);
        }}
      />
      <RenameSheet
        open={rename}
        kind="Pane"
        current={pane?.title ?? ''}
        onClose={() => setRename(false)}
        onSubmit={(label) =>
          api<void>('/api/rename', { muxKey: pane!.muxKey, paneId: pane!.id, label } satisfies RenameBody)
        }
      />
      <ConfirmCloseSheet
        open={confirmClose}
        title={pane?.title ?? ''}
        onClose={() => setConfirmClose(false)}
        onConfirm={async () => {
          await api<void>(`/api/panes/${encodeURIComponent(paneKey)}/close`);
          navigate('#/');
        }}
      />
    </div>
  );
}
