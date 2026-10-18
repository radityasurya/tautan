import type { StatePane } from '../shared/types.ts';
import type { MenuItem } from './sheets.tsx';
import { paneKind, statusWord } from './pane-label.ts';

/**
 * The Tab and Pane menus, one list per target. The desktop draws it at the pointer
 * (MenuPopover) and the phone as a bottom sheet (MenuSheet). An action the Mux cannot do
 * is not listed: tmux writes layout but has no New, Duplicate, Rename or Close.
 */

export interface TabMenuActions {
  openPane: (key: string) => void;
  newTab: () => void;
  duplicate: () => void;
  rename: () => void;
  move: (by: -1 | 1) => void;
  close: () => void;
  closeOthers: () => void;
}

export function tabMenuItems(
  tab: { panes: StatePane[]; index: number; count: number },
  can: { write: boolean; busy: boolean; newTabHint?: string },
  act: TabMenuActions,
): MenuItem[] {
  return [
    // A split Tab lists its Panes first, so one gesture opens any of them.
    ...(tab.panes.length > 1
      ? tab.panes.map((p) => ({ label: p.title, sub: [paneKind(p), statusWord(p)].filter(Boolean).join(' · '), group: 'Panes', onClick: () => act.openPane(p.key) }))
      : []),
    ...(can.write
      ? [
          { label: 'New Tab', hint: can.newTabHint, onClick: act.newTab },
          { label: 'Duplicate Tab', disabled: can.busy, onClick: act.duplicate },
          { label: 'Rename Tab…', onClick: act.rename },
        ]
      : []),
    // Both Muxes move Tabs (ADR 0009).
    ...(tab.count > 1
      ? [
          { label: 'Move left', disabled: can.busy || tab.index === 0, onClick: () => act.move(-1) },
          { label: 'Move right', disabled: can.busy || tab.index === tab.count - 1, onClick: () => act.move(1) },
        ]
      : []),
    ...(can.write
      ? [
          { label: 'Close Tab', danger: true, onClick: act.close },
          ...(tab.count > 1 ? [{ label: 'Close other Tabs', danger: true, onClick: act.closeOthers }] : []),
        ]
      : []),
  ];
}

export interface PaneMenuActions {
  split: (direction: 'right' | 'down') => void;
  duplicate: () => void;
  zoom: (on: boolean) => void;
  rename: () => void;
  renameAgent: () => void;
  copyPath: () => void;
  close: () => void;
}

export function paneMenuItems(
  pane: StatePane,
  can: {
    write: boolean;
    /** a layout write is out, or a zoom is */
    busy: boolean;
    /** the Tab holds other Panes, so Zoom means something */
    split: boolean;
    /** the Tab is zoomed: layout edits would be invisible (ADR 0008), so only Unzoom shows */
    zoomed: boolean;
  },
  act: PaneMenuActions,
): MenuItem[] {
  return [
    ...(can.zoomed
      ? []
      : [
          { label: 'Split right', disabled: can.busy, onClick: () => act.split('right') },
          { label: 'Split down', disabled: can.busy, onClick: () => act.split('down') },
          // tmux splits but cannot start an Agent, so an Agent Pane there has no duplicate.
          ...(can.write || !pane.agent ? [{ label: 'Duplicate Pane', disabled: can.busy, onClick: act.duplicate }] : []),
        ]),
    ...(can.split ? [{ label: can.zoomed ? 'Unzoom' : 'Zoom Pane', disabled: can.busy, onClick: () => act.zoom(!can.zoomed) }] : []),
    ...(can.write ? [{ label: 'Rename Pane…', onClick: act.rename }] : []),
    ...(can.write && pane.agent ? [{ label: 'Rename Agent…', sub: pane.agentName, onClick: act.renameAgent }] : []),
    ...(pane.cwd ? [{ label: 'Copy path', onClick: act.copyPath }] : []),
    ...(can.write ? [{ label: 'Close Pane', danger: true, onClick: act.close }] : []),
  ];
}

/** A duplicate keeps a label the user gave its Tab. herdr numbers an unlabelled Tab by its
 *  place, and the snapshot falls back to the Tab id: neither is a name to copy. */
export const duplicateLabel = (tab: { id: string; label: string }) =>
  /^\d+$/.test(tab.label) || tab.label === tab.id ? undefined : tab.label;
