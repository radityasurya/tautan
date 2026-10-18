/**
 * Desktop drag and drop (ADR 0008/0009). A Pane, a Workspace and a Tab each travel under their
 * own type, so a target answers only the drag it can take. Nothing the browser would paste
 * rides along — no `text/plain`, no link URL — so a drop on the Composer types nothing into
 * the Pane. A Pane drags from a split cell's title row, a Pane row or an Agent row; it drops
 * on a split cell, a Tab, the strip's + or a Space row. The decision is pure, so a test runs it
 * without a DOM; the phone keeps the menus (a touch drag fights scrolling, ADR 0008).
 */
import type { Dispatch, DragEvent, HTMLAttributes, SetStateAction } from 'react';
import type { MoveBody, StatePane, StateTab, StateWorkspace } from '../shared/types.ts';

export const PANE_TYPE = 'application/x-tautan-pane';
export const TAB_TYPE = 'application/x-tautan-tab';
export const WORKSPACE_TYPE = 'application/x-tautan-workspace';

/** Where a Pane can be dropped. A Space takes the Pane into its first Tab: the tree carries no active one. */
export type PaneTarget =
  | { kind: 'cell'; pane: StatePane; tab?: StateTab }
  | { kind: 'tab'; tab: StateTab }
  | { kind: 'newTab'; muxKey: string; workspaceId: string }
  | { kind: 'space'; space: StateWorkspace; tab?: StateTab };

export type PaneDrop = { verb: 'Swap'; label: string; target: string } | { verb: 'Move'; label: string; to: MoveBody };

const inTab = (p: StatePane, muxKey: string, workspaceId: string, tabId: string) =>
  p.muxKey === muxKey && p.workspaceId === workspaceId && p.tabId === tabId;
/** A drop lands beside what is there; a desktop is wider than tall. */
const into = (tab: StateTab): PaneDrop => ({ verb: 'Move', label: 'Move here', to: { tab: tab.key, split: 'right' } });

/**
 * What dropping Pane `src` on `at` does, or null when the drop would change nothing or cannot
 * happen: another Mux (a Pane never leaves its Mux), its own cell, Tab or Space, or a new Tab
 * for a Pane that is alone in its Tab already. `panes` is the state's, to count `src`'s Tab.
 */
export function paneDrop(src: StatePane, at: PaneTarget, panes: StatePane[]): PaneDrop | null {
  switch (at.kind) {
    case 'cell':
      if (at.pane.key === src.key || at.pane.muxKey !== src.muxKey) return null;
      // Two cells of one Tab trade places; a Pane from elsewhere joins the cell's Tab.
      if (inTab(src, at.pane.muxKey, at.pane.workspaceId, at.pane.tabId)) return { verb: 'Swap', label: 'Swap', target: at.pane.key };
      return at.tab ? into(at.tab) : null;
    case 'tab':
      return at.tab.muxKey === src.muxKey && !inTab(src, at.tab.muxKey, at.tab.workspaceId, at.tab.id) ? into(at.tab) : null;
    case 'newTab':
      // The Mux opens the new Tab in the Pane's own Workspace, so only that Workspace's + takes it.
      return at.muxKey === src.muxKey && at.workspaceId === src.workspaceId &&
        panes.some((p) => p.key !== src.key && inTab(p, src.muxKey, src.workspaceId, src.tabId))
        ? { verb: 'Move', label: 'New Tab', to: { newTab: true } }
        : null;
    case 'space':
      return at.tab && at.space.muxKey === src.muxKey && at.space.id !== src.workspaceId ? into(at.tab) : null;
  }
}

// ---- the DOM side ----

// ponytail: one drag per document. `dataTransfer` hides its data until the drop, so a target
// reads the Pane in hand here while it decides; the type check keeps a stale one out when a
// moved source unmounts before its `dragend`.
let held: StatePane | null = null;
/** The element the last press landed on: a drag that starts on ⋯, × or Zoom is a click instead. */
let pressed: Element | null = null;
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { pressed = e.target as Element; }, true);

/** Did the drag start on a control inside the draggable element (`data-nodrag`)? Cancels it. */
export const fromControl = (e: DragEvent) => {
  if (!pressed?.closest('[data-nodrag]')) return false;
  e.preventDefault();
  return true;
};

/** Start a drag of `type` carrying `value`, and nothing else the browser could paste. */
export function carry(e: DragEvent, type: string, value: string) {
  e.dataTransfer.clearData();
  e.dataTransfer.setData(type, value);
  e.dataTransfer.effectAllowed = 'move';
}

/** The props that make an element a Pane drag source. */
export const paneSource = (p: StatePane): HTMLAttributes<HTMLElement> => ({
  draggable: true,
  onDragStart: (e) => {
    if (fromControl(e)) return;
    carry(e, PANE_TYPE, p.key);
    held = p;
  },
  onDragEnd: () => { held = null; },
});

const inHand = (e: DragEvent) => (e.dataTransfer.types.includes(PANE_TYPE) ? held : null);

/** The Pane target under the pointer, and the action a drop there takes. */
export type DropOver = { id: string; label: string } | null;

/**
 * The props that make an element a Pane drop target. `decide` says what a drop does, or null
 * to refuse it (the browser then shows no-drop). `rest` are the element's own handlers for
 * every other drag — a Tab or Workspace reorder — and keep working untouched.
 */
export function paneTarget(o: {
  id: string;
  decide: (src: StatePane) => PaneDrop | null;
  setOver: Dispatch<SetStateAction<DropOver>>;
  onDrop: (src: StatePane, drop: PaneDrop) => void;
  rest?: HTMLAttributes<HTMLElement>;
}): HTMLAttributes<HTMLElement> {
  const over = (e: DragEvent<HTMLElement>) => {
    const src = inHand(e);
    if (!src) return (e.type === 'dragenter' ? o.rest?.onDragEnter : o.rest?.onDragOver)?.(e);
    const drop = o.decide(src);
    if (!drop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    o.setOver((now) => (now?.id === o.id ? now : { id: o.id, label: drop.label }));
  };
  return {
    ...o.rest,
    onDragEnter: over,
    onDragOver: over,
    onDragLeave: (e) => {
      if (!inHand(e)) return o.rest?.onDragLeave?.(e);
      // A move onto a child fires a leave too; only leaving the element ends the hover. A
      // missing relatedTarget clears it, and the next dragover sets it again if still inside.
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) o.setOver((now) => (now?.id === o.id ? null : now));
    },
    onDrop: (e) => {
      const src = inHand(e);
      if (!src) return o.rest?.onDrop?.(e);
      e.preventDefault();
      o.setOver(null);
      held = null;
      const drop = o.decide(src);
      if (drop) o.onDrop(src, drop);
    },
  };
}
