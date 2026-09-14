import { useEffect, useState, type ReactNode } from 'react';

/**
 * Sticky top bar, shared by the root screens and the Pane. One 56 px row + safe area, 16 px
 * sides, 44 px icon targets. `large` is the root screens' title: 26 px at rest, and once the
 * document scrolls past a few pixels it shrinks to the 44 px bar and gains a hairline.
 * `compact` is the Pane's: the 17 px title from the start and no scroll listener, because
 * the Pane's grid scrolls in its own box. `leading` sits before the title (the back chevron).
 */
export function TopBar({
  title,
  leading,
  right,
  below,
  size = 'large',
}: {
  title: string;
  leading?: ReactNode;
  right?: ReactNode;
  below?: ReactNode;
  size?: 'large' | 'compact';
}) {
  const shrinks = size === 'large';
  const [scrolled, setScrolled] = useState(() => shrinks && scrollY > 24);
  useEffect(() => {
    if (!shrinks) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setScrolled(scrollY > 24));
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => { removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, [shrinks]);
  return (
    <header
      className={`sticky top-0 z-30 shrink-0 bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur-md transition-[box-shadow] duration-200 ${
        scrolled ? 'shadow-[0_1px_0_0_var(--border)]' : ''
      }`}
    >
      {/* `@container`, so a caller can cap an item at a share of the row (`45cqw`). */}
      <div
        className={`@container flex items-center justify-between px-4 transition-[height] duration-200 motion-reduce:transition-none ${
          scrolled ? 'h-11' : 'h-14'
        }`}
      >
        {leading}
        <h1
          className={`min-w-0 flex-1 origin-left truncate font-semibold tracking-tight transition-[font-size] duration-200 motion-reduce:transition-none ${
            shrinks && !scrolled ? 'text-[26px]' : 'text-[17px]'
          }`}
        >
          {title}
        </h1>
        {right && <div className="flex shrink-0 items-center gap-1">{right}</div>}
      </div>
      {below}
    </header>
  );
}
