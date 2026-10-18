import type { Status } from '../shared/types.ts';

/** The shells a Pane sits in at its prompt; a login shell's name carries a leading `-`. */
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'pwsh', 'xonsh', 'elvish']);

/** The program a shell Pane runs in front of its prompt (`make`, `nvim`), or nothing at the
 *  prompt. An Agent Pane answers nothing: its Agent says it better. */
export const running = (pane: { agent?: string; command?: string }): string | undefined => {
  const name = pane.command?.replace(/^-/, '');
  return !pane.agent && name && !SHELLS.has(name.toLowerCase()) ? name : undefined;
};

/** What a Pane runs, for its labels: the Agent, else the program, else `shell`. */
export const paneKind = (pane: { agent?: string; command?: string }): string => pane.agent ?? running(pane) ?? 'shell';

/** The Status word a Pane's label shows. herdr reports no Status for a shell, so a shell
 *  Pane reads `running` while a program runs and shows no word at its prompt. */
export const statusWord = (pane: { agent?: string; command?: string; status: Status }): string | undefined =>
  pane.agent ? (pane.status === 'blocked' ? 'needs you' : pane.status) : running(pane) ? 'running' : undefined;
