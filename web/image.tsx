// Images in Chat turns. The transcript is untrusted, so a source is checked before it reaches
// an <img>: https only, the Hub's own file route, or a pasted data URL of a raster type.
// SVG is never inlined; the file route serves it as text, so it never renders here at all.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from './icons.tsx';

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

/**
 * An image block: fits the bubble, caps its height, opens full size on tap. A Hub file opens
 * the file viewer (`href`); anything else opens a native <dialog>, which Esc closes.
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
      {/* Portalled: a <dialog> may not sit in a <p>, and the body keeps it clear of the row. Any tap closes. */}
      {open && createPortal(
        <dialog
          ref={(el) => { if (el && !el.open) el.showModal(); }}
          aria-label={alt}
          onClick={(event) => event.currentTarget.close()}
          onClose={() => setOpen(false)}
          className="m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 backdrop:bg-[rgb(0_0_0/0.88)]"
        >
          <span className="flex h-full w-full items-center justify-center px-3 pt-[max(env(safe-area-inset-top),64px)] pb-[max(env(safe-area-inset-bottom),12px)] lg:p-12">
            <img src={src} alt={alt} referrerPolicy="no-referrer" decoding="async" className="max-h-full max-w-full rounded-card object-contain" />
          </span>
          <button
            type="button"
            aria-label="Close image"
            className="fixed right-[max(env(safe-area-inset-right),12px)] top-[max(env(safe-area-inset-top),12px)] flex size-11 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md"
          >
            <Plus className="rotate-45" />
          </button>
        </dialog>,
        document.body,
      )}
    </>
  );
}
