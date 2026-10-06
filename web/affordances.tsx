// Affordances on the grid (CONTEXT.md): the tappable boxes tautan derives from a Screen,
// the Hints it lifts into the dock, and the gestures that forward a tap to the program as
// a mouse report. Where an Affordance comes from is `shared/affordances.ts`; this file only
// places it, sends it, and says what it does.
import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { Action, Affordance, InputBody, MouseBody } from '../shared/types.ts';
import { haptic, navigate, post } from './app.tsx';
import { keyGlyph } from './keys.ts';
import { pillLabel } from './replies.ts';
import type { Pill } from './replies.ts';

/** The grid's cell, in unscaled CSS pixels: one column wide, one row high. */
export interface Cell {
  cw: number;
  rh: number;
}

/**
 * One probe character inside the `<pre>` is one cell. `getBoundingClientRect` reports the
 * scaled box, so Fit's own scale is divided back out; an inline-block is exactly as high as
 * its line. Measured again when the mono subset swaps in, because every column changes with
 * it, and whenever the scale moves.
 */
export function useCell(pre: RefObject<HTMLElement | null>, scale: number, fonts: boolean): Cell {
  const [cell, setCell] = useState<Cell>({ cw: 0, rh: 0 });
  useLayoutEffect(() => {
    const el = pre.current;
    if (!el) return;
    const probe = document.createElement('span');
    probe.textContent = '0';
    probe.style.cssText = 'position:absolute;visibility:hidden;display:inline-block;white-space:pre';
    el.appendChild(probe);
    const box = probe.getBoundingClientRect();
    el.removeChild(probe);
    const next = { cw: box.width / scale, rh: box.height / scale };
    setCell((c) => (Math.abs(c.cw - next.cw) < 0.01 && Math.abs(c.rh - next.rh) < 0.01 ? c : next));
  }, [pre, scale, fonts]);
  return cell;
}

/** An option list's row: the cursor moves with the arrows, so the keys are arrows only. */
const isOption = (a: Action): boolean => 'keys' in a && a.keys.every((k) => k === 'up' || k === 'down');

/** What a tap does, in words, because the box itself shows no text. */
function summary(a: Action): string {
  if ('copy' in a) return 'copies it';
  if ('command' in a) return `runs ${a.command}`;
  if ('text' in a) return `types ${a.text}`;
  if (isOption(a)) return 'moves the cursor here, hold to confirm';
  return a.keys.length ? `sends ${a.keys.join(' ')}` : 'selected';
}

/** Send one Action. `copy` never reaches the Pane: the clipboard and the chip are the tap. */
function sendAction(paneKey: string, a: Action): void {
  if ('copy' in a) return;
  const body: InputBody =
    'keys' in a ? { keys: a.keys } : 'text' in a ? { text: a.text } : { text: a.command, keys: ['enter'] };
  // The cursor is already on this row: nothing to send, and no haptic for a no-op.
  if (!body.text && !body.keys?.length) return;
  haptic();
  void post(paneKey, 'input', body);
}

/** 500 ms, cancelled by 10 px of movement, the same gesture as the Agents screen headers. */
function useHold(fn: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const stop = () => clearTimeout(timer.current);
  return {
    held,
    on: {
      onPointerDown: (e: ReactPointerEvent) => {
        // The grid forwards taps as mouse reports; an Affordance wins the ones it covers.
        e.stopPropagation();
        held.current = false;
        from.current = { x: e.clientX, y: e.clientY };
        timer.current = setTimeout(() => {
          held.current = true;
          fn();
        }, 500);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (Math.hypot(e.clientX - from.current.x, e.clientY - from.current.y) > 10) stop();
      },
      onPointerUp: stop,
      onPointerCancel: stop,
    },
  };
}

const HIT = 44;

function Box({
  a,
  cell,
  scale,
  onTap,
  onHold,
  copied,
}: {
  a: Affordance;
  cell: Cell;
  scale: number;
  onTap: () => void;
  onHold?: () => void;
  copied: boolean;
}) {
  const hold = useHold(() => onHold?.());
  // The 44 px hit area is physical, so under Fit it is drawn larger in the grid's own
  // coordinates; the underline stays exactly under the token, whatever the box grew to.
  const reach = HIT / scale;
  const tw = (a.colEnd - a.colStart) * cell.cw;
  const w = Math.max(tw, reach);
  const h = Math.max(cell.rh, reach);
  const padX = (w - tw) / 2;
  const padY = (h - cell.rh) / 2;
  return (
    <button
      type="button"
      aria-label={`${a.label}, ${summary(a.action)}`}
      {...hold.on}
      onClick={() => {
        if (!hold.held.current) onTap();
      }}
      className="absolute [-webkit-touch-callout:none]"
      style={{
        left: a.colStart * cell.cw - padX,
        top: a.row * cell.rh - padY,
        width: w,
        height: h,
        pointerEvents: 'auto',
        background: 'transparent',
      }}
    >
      <span
        aria-hidden
        className="absolute"
        style={{
          left: padX,
          top: padY + cell.rh - 1.5 / scale,
          width: tw,
          height: 1.5 / scale,
          background: 'color-mix(in srgb, var(--accent) 60%, transparent)',
        }}
      />
      {copied && (
        <span
          aria-hidden
          className="absolute rounded-chip bg-elevated px-1.5 py-0.5 text-[11px] font-medium text-fg shadow-elevated"
          style={{
            left: padX,
            top: padY,
            // Counter-scale, so the chip reads at its own size while the grid is fitted.
            transform: `scale(${1 / scale}) translateY(-100%)`,
            transformOrigin: 'top left',
          }}
        >
          Copied
        </span>
      )}
    </button>
  );
}

/**
 * The overlay, rendered inside the `<pre>` itself, so it sits in the grid's own coordinate
 * space and Fit's transform scales it for free. The wrapper clips, because a hit box wider
 * than the last column would otherwise grow the `<pre>`'s `scrollWidth`, which is what sizes
 * the column and the Fit scale.
 */
export function AffordanceLayer({
  paneKey,
  list,
  cell,
  scale,
  from,
  to,
}: {
  paneKey: string;
  list: Affordance[];
  cell: Cell;
  scale: number;
  /** The row window to draw, so a long Screen does not carry a box per row off-screen. */
  from: number;
  to: number;
}) {
  const [copied, setCopied] = useState(-1);
  if (!cell.cw) return null;
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
      {list.map((a, i) => {
        if (a.row < from || a.row > to) return null;
        const option = 'keys' in a.action && isOption(a.action) ? a.action.keys : null;
        const path = 'copy' in a.action && (a.label.startsWith('/') || a.label.startsWith('~') || a.action.copy.startsWith('/') || a.action.copy.startsWith('~'))
          ? a.action.copy
          : null;
        return (
          <Box
            key={`${a.row}:${a.colStart}:${a.label}`}
            a={a}
            cell={cell}
            scale={scale}
            copied={copied === i}
            onTap={() => {
              if (!('copy' in a.action)) return sendAction(paneKey, a.action);
              haptic();
              void navigator.clipboard?.writeText(a.action.copy);
              setCopied(i);
              // ponytail: one timer per tap, no toast system — the chip is the whole receipt.
              setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1500);
            }}
            // Move and confirm in one send: the Hub plays the keys in order.
            onHold={path
              ? () => navigate(`#/file/${encodeURIComponent(paneKey)}?path=${encodeURIComponent(path)}`)
              : option ? () => sendAction(paneKey, { keys: [...option, 'enter'] }) : undefined}
          />
        );
      })}
    </div>
  );
}

/**
 * Hints as dock pills, ahead of the quick replies. An option row is not a Hint, and a key
 * or a label the dock already offers is dropped, so the blocked preset is never doubled.
 */
export function hintPills(list: Affordance[], taken: Pill[], max = 8): Pill[] {
  const seen = new Set(taken.flatMap((p) => [p.label.trim().toLowerCase(), (p.keys ?? []).join('+')]));
  const pills: Pill[] = [];
  for (const a of list) {
    if (!('keys' in a.action) || !a.action.keys.length || isOption(a.action)) continue;
    const label = a.label.trim();
    const keys = a.action.keys.join('+');
    if (!label || seen.has(label.toLowerCase()) || seen.has(keys)) continue;
    seen.add(label.toLowerCase());
    seen.add(keys);
    pills.push({ kind: 'key', label: pillLabel(label), aria: `${label}, ${a.action.keys.join(' ')}`, keys: a.action.keys, glyph: keyGlyph(keys) });
    if (pills.length === max) break;
  }
  return pills;
}

// ---- mouse forwarding ----

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Taps, holds and drags on the grid, as mouse reports at a cell. The Hub builds the SGR
 * bytes; `allow` is the client's assertion that the App profile or the per-Pane switch says
 * this program reads them. Off while Wrap is on, because a cell needs the grid.
 */
export function useMouseForward(o: {
  paneKey: string;
  on: boolean;
  pre: RefObject<HTMLElement | null>;
  cell: Cell;
  scale: number;
  cols: number;
  rows: number;
}) {
  // `active` is what tells a drag from a hover: a mouse sends pointermove with no button
  // down, and without the flag the first one reads as an 80-row wheel from the last gesture.
  const down = useRef({ x: 0, y: 0, wheel: 0, held: false, moved: false, active: false });
  const last = useRef({ at: 0, col: 0, row: 0 });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cellAt = (e: { clientX: number; clientY: number }) => {
    const box = o.pre.current?.getBoundingClientRect();
    if (!box || !o.cell.cw) return null;
    return {
      col: clamp(Math.floor((e.clientX - box.left) / (o.cell.cw * o.scale)) + 1, 1, o.cols),
      row: clamp(Math.floor((e.clientY - box.top) / (o.cell.rh * o.scale)) + 1, 1, o.rows),
    };
  };

  const send = (kind: MouseBody['kind'], col: number, row: number) => {
    haptic();
    void post(o.paneKey, 'mouse', { kind, col, row, allow: true } satisfies MouseBody);
  };

  if (!o.on) return {};
  return {
    onPointerDown: (e: ReactPointerEvent) => {
      down.current = { x: e.clientX, y: e.clientY, wheel: 0, held: false, moved: false, active: true };
      timer.current = setTimeout(() => {
        const at = cellAt(e);
        if (!at) return;
        down.current.held = true;
        send('right', at.col, at.row);
      }, 500);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (!down.current.active) return;
      const dy = e.clientY - down.current.y;
      if (Math.hypot(e.clientX - down.current.x, dy) > 10) {
        clearTimeout(timer.current);
        down.current.moved = true;
      }
      const at = cellAt(e);
      if (!at || down.current.held) return;
      // One wheel report per row of movement, the way a terminal counts notches. Dragging
      // the screen down looks back up the buffer, which is what a touch scroll means.
      // ponytail: eight per move event is the ceiling; batch them in one POST if a fast
      // swipe ever floods the Hub.
      const want = Math.trunc(dy / o.cell.rh);
      for (let i = 0; i < 8 && down.current.wheel !== want; i += 1) {
        const up = want > down.current.wheel;
        down.current.wheel += up ? 1 : -1;
        send(up ? 'wheelUp' : 'wheelDown', at.col, at.row);
      }
    },
    onPointerUp: (e: ReactPointerEvent) => {
      clearTimeout(timer.current);
      const { held, moved, active } = down.current;
      down.current.active = false;
      if (held || moved || !active) return;
      const at = cellAt(e);
      if (!at) return;
      const now = Date.now();
      const again = now - last.current.at < 300 && last.current.col === at.col && last.current.row === at.row;
      last.current = { at: now, col: at.col, row: at.row };
      send(again ? 'double' : 'click', at.col, at.row);
    },
    onPointerCancel: () => {
      clearTimeout(timer.current);
      down.current.active = false;
    },
  };
}
