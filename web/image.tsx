// Images in Chat turns. The transcript is untrusted, so a source is checked before it reaches
// an <img>: https only, the Hub's own file route, or a pasted data URL of a raster type.
// SVG is never inlined; the file route serves it as text, so it never renders here at all.
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Plus } from './icons.tsx';

const DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** A transcript URL the page may load as an image, or undefined. */
export function safeImage(src: string): string | undefined {
  if (DATA.test(src)) return src;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

/** The Hub file route for a path the Agent read; the Hub keeps it inside the Pane cwd. */
export const fileImage = (paneKey: string, path: string) => `/api/panes/${encodeURIComponent(paneKey)}/file?path=${encodeURIComponent(path)}`;
/** The image a Read returned, as the Hub keeps it from the transcript: any path, even outside the cwd.
 *  `agent` reads it from that subagent's transcript. */
export const chatImage = (paneKey: string, imageId: number, agent?: string) =>
  `/api/panes/${encodeURIComponent(paneKey)}/chat/image/${imageId}${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`;
/** The full-screen file viewer for the same path. */
export const fileView = (paneKey: string, path: string) => `#/file/${encodeURIComponent(paneKey)}?path=${encodeURIComponent(path)}`;

const host = (src: string) => {
  if (src.startsWith('data:')) return 'pasted';
  try { return new URL(src, location.href).host; } catch { return ''; }
};

const IMG = { referrerPolicy: 'no-referrer', loading: 'lazy', decoding: 'async' } as const;

/** A small square for a collapsed tool row. Decorative: the open row carries the alt text. */
export function Thumb({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img {...IMG} src={src} alt="" aria-hidden onError={() => setFailed(true)} className="size-10 shrink-0 rounded-chip border border-border bg-bg object-cover lg:size-7" />;
}

export function Unavailable({ src, why = 'Image unavailable' }: { src?: string; why?: string }) {
  const from = src ? host(src) : '';
  return (
    <span className="inline-flex max-w-full items-center rounded-chip border border-dashed border-border bg-bg px-2 py-1 text-caption text-muted">
      <span className="truncate">{why}{from && ` · ${from}`}</span>
    </span>
  );
}

export interface Shot { src: string; alt: string }

const OVERLAY = 'flex size-11 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md';

/**
 * A native <dialog> over the page: Esc or any tap closes it. With more than one image, the
 * arrows, the ← → keys and a horizontal swipe step through them (wrapping at the ends).
 * Portalled: a <dialog> may not sit in a <p>, and the body keeps it clear of the row.
 */
export function Lightbox({ images, start = 0, onClose }: { images: Shot[]; start?: number; onClose: () => void }) {
  const [at, setAt] = useState(start);
  const touchX = useRef(0);
  const many = images.length > 1;
  const image = images[at] ?? images[0]!;
  const step = (by: number) => setAt((i) => (i + by + images.length) % images.length);
  const arrow = (by: 1 | -1) => (
    <button
      type="button"
      aria-label={by < 0 ? 'Previous image' : 'Next image'}
      onClick={(event) => { event.stopPropagation(); step(by); }}
      className={`${OVERLAY} fixed top-1/2 -translate-y-1/2 ${by < 0 ? 'left-[max(env(safe-area-inset-left),12px)]' : 'right-[max(env(safe-area-inset-right),12px)]'}`}
    >
      <ChevronRight size={20} className={by < 0 ? 'rotate-180' : ''} />
    </button>
  );
  return createPortal(
    <dialog
      ref={(el) => { if (el && !el.open) el.showModal(); }}
      aria-label={image.alt}
      onClick={(event) => event.currentTarget.close()}
      onClose={onClose}
      onKeyDown={(event) => {
        if (!many || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }}
      // Swipes are read on touchend: Chromium cancels a horizontal pointer drag (see CLAUDE.md).
      onTouchStart={(event) => { touchX.current = event.touches[0]!.clientX; }}
      onTouchEnd={(event) => {
        const dx = event.changedTouches[0]!.clientX - touchX.current;
        if (!many || Math.abs(dx) < 48) return;
        event.preventDefault(); // no synthetic click, so the swipe does not close the dialog
        step(dx < 0 ? 1 : -1);
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 backdrop:bg-[rgb(0_0_0/0.88)]"
    >
      {/* First, so showModal() focuses Close rather than an arrow. Any tap closes, this one too. */}
      <button type="button" aria-label="Close image" className={`${OVERLAY} fixed right-[max(env(safe-area-inset-right),12px)] top-[max(env(safe-area-inset-top),12px)]`}>
        <Plus className="rotate-45" />
      </button>
      <span className={`flex h-full w-full items-center justify-center pt-[max(env(safe-area-inset-top),64px)] pb-[max(env(safe-area-inset-bottom),12px)] lg:p-12 ${many ? 'px-16 lg:px-24' : 'px-3'}`}>
        <img key={image.src} src={image.src} alt={image.alt} referrerPolicy="no-referrer" decoding="async" className="max-h-full max-w-full rounded-card object-contain" />
      </span>
      {many && (
        <>
          <span aria-live="polite" className="fixed left-[max(env(safe-area-inset-left),16px)] top-[max(env(safe-area-inset-top),12px)] flex h-11 items-center font-mono text-caption tabular-nums text-white/80">
            {at + 1} of {images.length}
          </span>
          {arrow(-1)}
          {arrow(1)}
        </>
      )}
    </dialog>,
    document.body,
  );
}

/**
 * An image block: fits the bubble, caps its height, opens full size on tap. A Hub file opens
 * the file viewer (`href`); anything else opens the Lightbox.
 * Inline elements only, so it may sit inside a Markdown paragraph.
 */
export function Picture({ src, alt, href }: { src: string; alt: string; href?: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [open, setOpen] = useState(false);
  if (state === 'failed') return <Unavailable src={src} />;
  const frame = `block w-fit max-w-full overflow-hidden rounded-card border border-border bg-bg ${state === 'loading' ? 'min-h-24 min-w-40' : ''}`;
  const img = (
    <img
      {...IMG}
      src={src}
      alt={alt}
      onLoad={() => setState('ready')}
      onError={() => setState('failed')}
      className="block h-auto max-h-80 w-auto max-w-full object-contain lg:max-h-[420px]"
    />
  );
  if (href) return <a href={href} aria-label={`Open ${alt}`} className={frame}>{img}</a>;
  return (
    <>
      <button type="button" aria-label={`Open ${alt}`} aria-haspopup="dialog" onClick={() => setOpen(true)} className={`${frame} cursor-zoom-in p-0`}>
        {img}
      </button>
      {open && <Lightbox images={[{ src, alt }]} onClose={() => setOpen(false)} />}
    </>
  );
}

const TILES = 4;

/**
 * Images pasted into one turn. One shows as a Picture; two or more make a 2-column grid of
 * square tiles, at most four, the fourth carrying "+N" for the rest. Every tile opens the
 * Lightbox on the turn's images, so the hidden ones are a swipe away.
 * `src` undefined = over the Hub's cap: a tile that says so, skipped by the Lightbox.
 */
export function Gallery({ images }: { images: { src?: string; alt: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shots = images.filter((image): image is Shot => Boolean(image.src));
  if (images.length === 1) return shots[0] ? <Picture {...shots[0]} /> : <Unavailable why="Image too large to show here" />;
  const more = images.length - TILES;
  return (
    <span className="grid w-fit grid-cols-[repeat(2,8.5rem)] gap-1.5 lg:grid-cols-[repeat(2,10rem)]">
      {images.slice(0, TILES).map((image, n) => {
        const rest = n === TILES - 1 && more > 0 ? more : 0;
        const tile = 'relative block aspect-square overflow-hidden rounded-card border border-border bg-bg';
        if (!image.src) return <span key={n} className={`${tile} flex items-center justify-center border-dashed p-2 text-center text-caption text-muted`}>Image too large to show here</span>;
        return (
          <button
            key={n}
            type="button"
            aria-haspopup="dialog"
            aria-label={rest ? `Open ${image.alt}, and ${rest} more` : `Open ${image.alt}`}
            onClick={() => setOpen(shots.indexOf(image as Shot))}
            className={`${tile} cursor-zoom-in p-0`}
          >
            <Tile src={image.src} />
            {rest > 0 && <span aria-hidden className="absolute inset-0 flex items-center justify-center bg-[rgb(0_0_0/0.55)] text-title text-white">+{rest}</span>}
          </button>
        );
      })}
      {open !== null && <Lightbox images={shots} start={open} onClose={() => setOpen(null)} />}
    </span>
  );
}

function Tile({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="flex size-full items-center justify-center p-2 text-caption text-muted">Image unavailable</span>;
  return <img {...IMG} src={src} alt="" onError={() => setFailed(true)} className="size-full object-cover" />;
}
