// An edit row's input as a diff: each span of an Edit or MultiEdit (or a Write's whole file)
// drawn with the Diff view's rows, three lines of context around each change, in the file's
// syntax colours. The words never pass through innerHTML: runs render as spans.
import { Fragment, useMemo } from 'react';
import type { editSpans } from '../shared/chat.ts';
import { diffLines, foldContext, textLines } from '../shared/line-diff.ts';
import { DiffRow } from './diff.tsx';
import type { Run } from './highlight.ts';
import { CopyButton, codeLang, useRuns } from './markdown.tsx';

export type Edit = NonNullable<ReturnType<typeof editSpans>>;

/** Coloured runs cut at their line breaks: entry n holds line n's runs. */
function runLines(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]];
  for (const [text, cls] of runs) {
    text.split('\n').forEach((part, n) => {
      if (n) lines.push([]);
      if (part) lines.at(-1)!.push([part, cls]);
    });
  }
  return lines;
}

/** A band between hunks: how many unchanged lines it stands for, or between two spans, none. */
function Fold({ count }: { count?: number }) {
  return (
    <div className="flex bg-surface py-0.5 font-mono text-[11px] text-muted">
      <span aria-hidden className="ml-1 w-3.5 shrink-0 text-center select-none">⋯</span>
      <span className="pr-4 whitespace-pre">{count ? `${count.toLocaleString()} unchanged line${count === 1 ? '' : 's'}` : ' '}</span>
    </div>
  );
}

function Span({ oldText = '', newText, ext }: { oldText?: string; newText: string; ext: string }) {
  const lines = useMemo(() => foldContext(diffLines(textLines(oldText), textLines(newText))), [oldText, newText]);
  const oldRuns = useRuns(codeLang(ext, oldText), oldText);
  const newRuns = useRuns(codeLang(ext, newText), newText);
  const before = useMemo(() => oldRuns && runLines(oldRuns), [oldRuns]);
  const after = useMemo(() => newRuns && runLines(newRuns), [newRuns]);
  return lines.map((line, n) =>
    line.type === 'skip' ? <Fold key={n} count={line.count} />
      : <DiffRow key={n} line={line} wrap={false} numbers={false} runs={line.type === 'del' ? before?.[line.oldNo! - 1] : after?.[line.newNo! - 1]} />,
  );
}

/**
 * The open edit: the file's path over a box of diff rows that scrolls both ways, as the Diff
 * view does on a phone. `copy` is the raw input for the Copy button; `tall` off fits the
 * approval row, whose choices sit under the box.
 */
export function EditDiff({ edit, copy, tall = true }: { edit: Edit; copy: string; tall?: boolean }) {
  const cut = edit.path.lastIndexOf('/') + 1;
  const ext = edit.path.match(/\.([^./]+)$/)?.[1] ?? '';
  return (
    <>
      <div className="mb-1.5 flex min-h-8 items-center gap-2 pl-1">
        <span title={edit.path} className="flex min-w-0 flex-1 items-baseline font-mono text-[11px]">
          {/* The directory keeps its end, nearest the file: it cuts on the left. The marks keep
              a path's slashes in order inside the right-to-left box. */}
          <span className="min-w-0 truncate text-muted [direction:rtl]">{`‎${edit.path.slice(0, cut)}‎`}</span>
          <span className="shrink-0 text-fg">{edit.path.slice(cut)}</span>
        </span>
        <CopyButton text={copy} className="min-h-8 shrink-0 rounded-chip border border-border bg-bg px-2 text-caption text-muted active:text-fg" />
      </div>
      <div tabIndex={0} aria-label={`Changes to ${edit.path.slice(cut)}`} className={`${tall ? 'max-h-80' : 'max-h-48'} overflow-auto overscroll-contain rounded-[6px] border border-border bg-bg py-1`}>
        <div className="w-max min-w-full">
          {edit.spans.map((span, n) => (
            <Fragment key={n}>
              {n > 0 && <Fold />}
              <Span oldText={span.oldText} newText={span.newText} ext={ext} />
            </Fragment>
          ))}
        </div>
      </div>
      {edit.cut && <p className="mt-1 pl-1 text-[10px] text-muted">Cut at 4,000 characters</p>}
    </>
  );
}
