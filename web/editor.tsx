// The file editor: CodeMirror 6, and the only module that imports it. file.tsx loads this
// module on the first Edit tap, so neither it nor CodeMirror is in the main bundle (both are
// `lazy-*` chunks, left out of the service worker's precache).
//
// A save is a PUT with the version the file was read at. When the file changed on disk
// since, the Hub answers 412 and nothing is written: the editor offers Copy my text and
// Reload, never an overwrite. The bytes round-trip: the doc splits and joins on the file's
// own line break, and a byte order mark is put back on save.
// ponytail: no drawSelection, so iOS keeps its native caret and selection handles.
import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { AlertDialog } from './halaska-kit';
import { lineBreakOf } from './folders-logic.ts';
import { ON_WARN } from './blocked.tsx';
import { why } from './sheets.tsx';

/** Each language is its own chunk, loaded into a Compartment once the editor is up. */
const LANGUAGES: [RegExp, (path: string) => Promise<Extension>][] = [
  [
    /\.[cm]?[jt]sx?$/i,
    (path) => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: /x$/i.test(path), typescript: /\.[cm]?tsx?$/i.test(path) })),
  ],
  [/\.json[c5]?$/i, () => import('@codemirror/lang-json').then((m) => m.json())],
  [/\.(md|markdown)$/i, () => import('@codemirror/lang-markdown').then((m) => m.markdown())],
  [/\.html?$/i, () => import('@codemirror/lang-html').then((m) => m.html())],
  [/\.(css|scss|less)$/i, () => import('@codemirror/lang-css').then((m) => m.css())],
  [/\.pyi?$/i, () => import('@codemirror/lang-python').then((m) => m.python())],
  [/\.ya?ml$/i, () => import('@codemirror/lang-yaml').then((m) => m.yaml())],
];

/** Syntax colours from the theme's own ANSI palette, so every palette colours code its way. */
const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier, t.definitionKeyword, t.moduleKeyword], color: 'var(--ansi-5)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.monospace], color: 'var(--ansi-2)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--ansi-3)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--ansi-4)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--ansi-6)' },
  { tag: [t.tagName, t.propertyName, t.attributeName], color: 'var(--ansi-1)' },
  { tag: t.heading, color: 'var(--ansi-5)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--ansi-4)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator, t.quote], color: 'var(--muted)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

/** On tautan's CSS variables, so it follows light, dark and the named palettes. 16 px text
 *  keeps iOS from zooming in when the editor takes focus. */
const THEME = EditorView.theme({
  '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'var(--bg)', fontSize: '16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', lineHeight: '1.5', overscrollBehavior: 'contain' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-line': { padding: '0 12px 0 10px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', border: 'none' },
  // 24 px is the 16 px text's line, so a number sits on its line's middle.
  '.cm-lineNumbers .cm-gutterElement': { fontSize: '13px', lineHeight: '24px', padding: '0 8px 0 10px', minWidth: '30px' },
  '.cm-activeLine': { backgroundColor: 'var(--surface)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  '&.cm-focused .cm-nonmatchingBracket': { color: 'var(--danger)' },
});

/** The Hub's save refusals, in words. 412 has its own banner. */
const NOT_SAVED: Record<string, string> = {
  version: 'The Hub needs the version this file was read at',
  'too large': 'The file is too large to save from here',
  'not a file': 'That path is not a file',
  'not text': 'tautan saves text files only',
  escape: 'That file is outside the places tautan may write',
  'read-only': 'The file is read-only',
  origin: 'The Hub refused a write from this page',
  'not found': 'The file is gone from disk',
  remote: 'The Host could not write the file',
  cut: 'The write to the Host was cut short. Reload to see what is on disk.',
};

type Status = 'clean' | 'edited' | 'saving' | 'saved' | 'conflict' | 'failed';
const STATUS: Record<Status, [string, string]> = {
  clean: ['No changes', 'text-muted'],
  edited: ['● Edited', 'text-warn'],
  saving: ['Saving…', 'text-muted'],
  saved: ['Saved', 'text-ok'],
  conflict: ['● Not saved', 'text-danger'],
  failed: ['● Not saved', 'text-danger'],
};

export interface Saved { text: string; version: string; bytes: number }

export default function Editor({
  name,
  path,
  text,
  bom,
  version,
  url,
  onDone,
  onReload,
}: {
  name: string;
  path: string;
  /** The file as read, without its byte order mark. */
  text: string;
  bom: boolean;
  /** The etag the file was read with, sent back as If-Match. */
  version: string;
  /** The Hub's file route for this Pane and path. */
  url: string;
  /** Back to the viewer, with the last saved text when there was a save. */
  onDone: (saved?: Saved) => void;
  /** Leave and read the file again: the way out of a 412. */
  onReload: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const savedDoc = useRef<Text | null>(null);
  const ver = useRef(version);
  const last = useRef<Saved | undefined>(undefined);
  const [status, setStatus] = useState<Status>('clean');
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState<'done' | 'reload' | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedOnce = useRef(false);
  const save = useRef<() => void>(() => {});
  const changed = useRef<() => void>(() => {});

  const dirty = () => Boolean(view.current && savedDoc.current && !view.current.state.doc.eq(savedDoc.current));
  const unsaved = status === 'edited' || status === 'saving' || status === 'failed' || status === 'conflict';

  changed.current = () => {
    copiedOnce.current = false; // an edit after a Copy invalidates it: Reload asks again
    setStatus((s) => (s === 'conflict' || s === 'saving' ? s : dirty() ? 'edited' : last.current ? 'saved' : 'clean'));
  };

  save.current = async () => {
    const v = view.current;
    if (!v || status === 'saving' || status === 'conflict' || !dirty()) return;
    const doc = v.state.doc;
    const sent = doc.sliceString(0, doc.length, v.state.lineBreak);
    const body = (bom ? '﻿' : '') + sent;
    setStatus('saving');
    setError('');
    let response: Response;
    try {
      response = await fetch(url, { method: 'PUT', headers: { 'if-match': ver.current, 'content-type': 'text/plain; charset=utf-8' }, body });
    } catch {
      setError('network');
      setStatus('failed');
      return;
    }
    if (response.status === 412) {
      setStatus('conflict');
      return;
    }
    if (!response.ok) {
      const code = await response
        .json()
        .then((value) => (value as { error?: string }).error)
        .catch(() => undefined);
      setError(code || `http ${response.status}`);
      setStatus('failed');
      return;
    }
    ver.current = response.headers.get('etag') ?? ver.current;
    savedDoc.current = doc;
    last.current = { text: sent, version: ver.current, bytes: new Blob([body]).size };
    // Typing during the save leaves the newer text unsaved.
    setStatus(view.current?.state.doc.eq(doc) ? 'saved' : 'edited');
  };

  useEffect(() => {
    const language = new Compartment();
    const eol = lineBreakOf(text);
    const state = EditorState.create({
      doc: text,
      extensions: [
        EditorState.lineSeparator.of(eol),
        // A paste brings its own line breaks; they become the file's, so a save never mixes them.
        EditorView.clipboardInputFilter.of((input) => input.replace(/\r\n?|\n/g, eol)),
        lineNumbers(),
        history(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (void save.current(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        syntaxHighlighting(HIGHLIGHT),
        language.of([]),
        THEME,
        EditorView.contentAttributes.of({ 'aria-label': `Edit ${name}`, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) changed.current();
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    savedDoc.current = state.doc;
    v.focus();

    let live = true;
    LANGUAGES.find(([match]) => match.test(path))?.[1](path).then(
      (extension) => live && v.dispatch({ effects: language.reconfigure(extension) }),
      () => {}, // a language that fails to load leaves plain text, which still edits
    );

    // The keyboard shrinks the layer from below; keep the caret above it.
    const viewport = window.visualViewport;
    const keep = () => {
      if (v.hasFocus) v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'nearest' }) });
    };
    viewport?.addEventListener('resize', keep);
    return () => {
      live = false;
      viewport?.removeEventListener('resize', keep);
      v.destroy();
      view.current = null;
    };
  }, []);

  // Closing the tab or reloading the page with unsaved edits asks first.
  useEffect(() => {
    if (!unsaved) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', guard);
    return () => removeEventListener('beforeunload', guard);
  }, [unsaved]);

  // While a save is in flight the write may still land: Done does nothing, and the back-swipe
  // guard (which re-pushes its entry before calling this) holds the editor in place.
  const done = () => {
    if (status === 'saving') return;
    unsaved ? setLeaving('done') : onDone(last.current);
  };
  const reload = () => (copiedOnce.current ? onReload() : setLeaving('reload'));

  // A back swipe (iOS) or the Android Back button would drop unsaved edits without a word:
  // Edit is screen state, and `beforeunload` does not fire on a hash change. So while the
  // editor is open it holds one extra history entry at the same URL. Back lands on the entry
  // under it, which the router reads as the same route; that asks the question Done asks and,
  // on Keep editing, puts the entry back. When the editor closes any other way it pops its own.
  const back = useRef(done);
  back.current = done;
  useEffect(() => {
    // `window.history`: CodeMirror's `history` import shadows the global.
    const mark = `editor-${Math.random()}`;
    const href = location.href;
    window.history.pushState({ mark }, '');
    const onPop = () => {
      if (location.href !== href) return; // another route: the router takes it, and this screen goes
      window.history.pushState({ mark }, '');
      back.current();
    };
    addEventListener('popstate', onPop);
    return () => {
      removeEventListener('popstate', onPop);
      if (window.history.state?.mark === mark) window.history.back();
    };
  }, []);

  const selectAll = () => {
    const v = view.current;
    if (!v) return;
    v.focus();
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } });
  };
  const copy = () => {
    const doc = view.current?.state.sliceDoc() ?? '';
    // Over plain http there is no clipboard: select everything, so the system Copy is one tap.
    if (!navigator.clipboard) return selectAll();
    navigator.clipboard.writeText(doc).then(() => {
      copiedOnce.current = true;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, selectAll);
  };

  const [label, tone] = STATUS[status];
  const canSave = status === 'edited' || status === 'failed';

  return (
    // A layer the size of the visual viewport, so Save sits above the keyboard. It is fixed on
    // desktop too: it covers the sidebar, where a click would navigate away and drop unsaved
    // edits with no question. The editor itself stays a centred column, like the viewer.
    <div className="fixed inset-x-0 top-(--vv-top,0px) z-40 flex h-(--vv-h,100dvh) flex-col bg-bg">
      <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-1 pt-[env(safe-area-inset-top)] lg:px-2">
          <div className="flex w-20 shrink-0">
            <button
              type="button"
              onClick={done}
              disabled={status === 'saving'}
              className="flex min-h-11 items-center px-3 text-body text-accent outline-none focus-visible:shadow-[inset_0_-2px_0_var(--accent)] disabled:text-muted"
            >
              Done
            </button>
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-center py-1">
            <h1 className="max-w-full truncate text-body font-semibold">{name}</h1>
            <p aria-live="polite" className={`text-caption ${tone}`}>
              {label}
            </p>
          </div>
          <div className="flex w-20 shrink-0 justify-end pr-2">
            {/* A 44 px target around a 36 px pill. */}
            <button
              type="button"
              disabled={!canSave}
              onClick={() => void save.current()}
              className="group flex min-h-11 items-center outline-none"
            >
              <span className="rounded-chip bg-accent px-4 py-2 text-body leading-none font-semibold text-bg group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-bg group-disabled:bg-surface group-disabled:text-muted">
                Save
              </span>
            </button>
          </div>
        </header>

        {status === 'conflict' && (
          // The blocked card's shape: it asks for a decision the same way.
          <div role="alert" className="mx-3 mt-3 flex shrink-0 flex-col gap-2.5 rounded-card border border-warn/35 bg-warn/8 p-3.5">
            {/* The warn colour pulled toward the text colour, so a 12 px heading keeps its contrast in light themes. */}
            <p className="flex items-center gap-2 text-[12px] font-semibold text-[color-mix(in_srgb,var(--warn)_65%,var(--fg))]">
              <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-warn" />
              Changed on disk after you opened it
            </p>
            <p className="text-[14px] leading-snug">
              Your edits are not saved, so nothing an Agent wrote is lost. Copy your text, then reload to see the new version.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={copy} className="press min-h-[38px] rounded-chip border border-border bg-bg px-3.5 text-[13px] font-medium">
                <span aria-live="polite">{copied ? 'Copied' : 'Copy my text'}</span>
              </button>
              <button
                type="button"
                onClick={reload}
                className="press min-h-[38px] rounded-chip bg-warn px-4 text-[13px] font-semibold"
                style={{ color: ON_WARN }}
              >
                Reload
              </button>
            </div>
          </div>
        )}
        {status === 'failed' && (
          <p role="alert" className="shrink-0 px-4 pt-2 text-caption text-danger">
            Not saved · {NOT_SAVED[error] ?? why(error)}
          </p>
        )}

        <div ref={host} className={`min-h-0 flex-1 ${status === 'conflict' ? 'mt-3 border-t border-border' : ''}`} />
      </div>

      <AlertDialog
        open={leaving !== null}
        onClose={() => setLeaving(null)}
        variant="danger"
        title="Discard your edits?"
        description={`Your changes to ${name} are not saved.`}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => (leaving === 'reload' ? onReload() : onDone(last.current))}
      />
    </div>
  );
}
