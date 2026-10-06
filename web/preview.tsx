// HTML the Agent wrote, shown in a sandboxed iframe: no allow tokens, so no scripts, no
// forms, no popups, and an opaque origin. The Hub serves it under a CSP `sandbox` header
// too, so the page stays inert even if it is opened outside this frame.
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from './icons.tsx';

/** The virtual page the preview lays out at: a laptop viewport, 16:10. */
export const PREVIEW_W = 1280;
export const PREVIEW_H = 800;

/** The scale that fits the virtual page into `width`, and the height it then takes. Never enlarges. */
export function fitPreview(width: number): { scale: number; height: number } {
  const scale = width > 0 ? Math.min(1, width / PREVIEW_W) : 0;
  return { scale, height: Math.round(PREVIEW_H * scale) };
}

/** The Hub route for a preview, from the subagent's transcript when `agent` is set. */
export const previewSrc = (paneKey: string, id: number, agent?: string) =>
  `/api/panes/${encodeURIComponent(paneKey)}/chat/preview/${id}${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`;

/** A link card's title: the one the tool gave, else the URL's last path segment, else its host. */
export function linkLabel(link: { url: string; title?: string }): { title: string; host: string } {
  try {
    const url = new URL(link.url);
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
    return { title: link.title?.trim() || last || url.host, host: url.host };
  } catch {
    return { title: link.title?.trim() || link.url, host: '' };
  }
}

/** Only an https link may open; anything else stays text. */
export function safeLink(url: string): string | undefined {
  try { return new URL(url).protocol === 'https:' ? url : undefined; } catch { return undefined; }
}

const FRAME = { sandbox: '', referrerPolicy: 'no-referrer', loading: 'lazy' } as const;

/**
 * A live thumbnail of the page at 1280×800, scaled down to the row's width. It takes no
 * input, so a drag over it scrolls the Chat, not the page; a tap opens it full screen.
 */
export function Preview({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { scale } = fitPreview(width);
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      {/* 16:10 like the virtual page, so the height is right before the frame has a width. */}
      <div ref={box} className="relative aspect-[16/10] w-full overflow-hidden rounded-chip border border-border bg-white">
        {scale > 0 && (
          <iframe
            {...FRAME}
            src={src}
            title={`Preview of ${title}`}
            tabIndex={-1}
            aria-hidden
            width={PREVIEW_W}
            height={PREVIEW_H}
            style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}
            className="pointer-events-none absolute top-0 left-0 max-w-none border-0"
          />
        )}
        {/* A sibling, not a parent: an iframe may not sit inside a button. */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`Open the preview of ${title} full screen`}
          onClick={() => setFull(true)}
          className="absolute inset-0 cursor-zoom-in"
        />
      </div>
      <figcaption className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted">Preview of the source · images and scripts off</span>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setFull(true)}
          className="press -my-1 ml-auto inline-flex min-h-8 shrink-0 items-center rounded-chip border border-border bg-bg px-2.5 text-caption text-fg"
        >
          Full screen
        </button>
      </figcaption>
      {full && <FullPreview src={src} title={title} onClose={() => setFull(false)} />}
    </figure>
  );
}

/** The same page at the viewport's size, in a native <dialog>: Esc or Close ends it. */
function FullPreview({ src, title, onClose }: { src: string; title: string; onClose: () => void }) {
  return createPortal(
    <dialog
      ref={(el) => { if (el && !el.open) el.showModal(); }}
      aria-label={`Preview of ${title}`}
      onClose={onClose}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-bg p-0 text-fg backdrop:bg-[rgb(0_0_0/0.88)]"
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 pt-[max(env(safe-area-inset-top),8px)] pb-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium">{title}</span>
            <span className="block truncate text-[11px] text-muted">Preview of the source · images and scripts off</span>
          </span>
          {/* First in the dialog, so showModal() puts focus here. */}
          <button
            type="button"
            aria-label="Close preview"
            autoFocus
            onClick={(event) => event.currentTarget.closest('dialog')?.close()}
            className="press flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-fg"
          >
            <Plus className="rotate-45" />
          </button>
        </header>
        <iframe {...FRAME} src={src} title={`Preview of ${title}`} className="min-h-0 w-full flex-1 border-0 bg-white pb-[env(safe-area-inset-bottom)]" />
      </div>
    </dialog>,
    document.body,
  );
}
