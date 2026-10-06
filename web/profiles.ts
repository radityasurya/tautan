import type { AffordanceProfile } from '../shared/affordances.ts';
import { AGENT_KEYS, INLINE_KEYS, SHELL_KEYS } from './keys.ts';

/** Toolbar facts read off a Screen. An absent field means the Screen does not state it — never a guess. */
export interface ToolbarData {
  /** Short mode label ("accept edits", "plan", "bypass permissions"). Undefined when the footer prints no ⏵⏵ line: Claude Code's default mode. */
  mode?: string;
  /** Model name exactly as the footer prints it ("Opus 4.6", "Sonnet"). */
  model?: string;
  /** Percent of context LEFT until auto-compact, 0–100 — not percent used. */
  context?: number;
}

export interface Profile extends AffordanceProfile {
  mouse: boolean;
  keys: { inline: string[]; all: string[] };
  replies: string[];
  /** Reads toolbar facts off the Screen's footer area. Profiles without one state nothing. */
  toolbar?: (lines: string[]) => ToolbarData;
}

/** herdr key names (canonical; the tmux adapter maps them) that cycle Claude Code's mode. */
export const CYCLE_MODE_KEYS = ['shift+tab'];

// ponytail: scan the last 15 lines only, so a ⏵⏵ echo higher in the transcript cannot fool
// the recogniser; raise the window only if real footers grow past it.
const FOOTER_LINES = 15;
const MODE_ON = /⏵⏵ (auto mode|plan mode|accept edits|bypass permissions) on\b/;
// ponytail: three literal footer spellings, not a general model/context parser; add a pattern
// when a real Screen shows a new one.
const MODEL = /\b(Opus|Sonnet|Haiku)(?: \d[\w.]*)?/;
const CONTEXT_LEFT = /Context left until auto-compact: (\d{1,3})%|(\d{1,3})% context/;

function claudeToolbar(lines: string[]): ToolbarData {
  const footer = lines.slice(-FOOTER_LINES).join('\n');
  const context = CONTEXT_LEFT.exec(footer);
  return {
    mode: MODE_ON.exec(footer)?.[1]?.replace(/ mode$/, ''),
    model: MODEL.exec(footer)?.[0],
    context: context ? Number(context[1] ?? context[2]) : undefined,
  };
}

/** Toolbar facts from the Screen's footer area; a profile without a recogniser states nothing. */
export function toolbarFromScreen(profile: Profile, lines: string[]): ToolbarData {
  return profile.toolbar ? profile.toolbar(lines) : {};
}

const agentKeys = { inline: INLINE_KEYS.agent, all: AGENT_KEYS.map(([name]) => name) };
const shellKeys = { inline: INLINE_KEYS.shell, all: SHELL_KEYS.map(([name]) => name) };
const agent = (replies: string[], extra: Partial<Profile> = {}): Profile => ({ mouse: false, keys: agentKeys, replies, ...extra });
const tool = (mouse: boolean, keys = shellKeys): Profile => ({ mouse, keys, replies: ['Continue'] });

// The Herdr contract test proved herdr accepts these key names. htop and less both show a
// function-key footer, so their full key bar offers them too; the inline dock stays the
// short SHELL_KEYS set.
const FUNCTION_KEYS: [name: string, label: string][] = [
  ['f1', 'F1'], ['f2', 'F2'], ['f3', 'F3'], ['f4', 'F4'], ['f5', 'F5'],
  ['f6', 'F6'], ['f7', 'F7'], ['f8', 'F8'], ['f9', 'F9'], ['f10', 'F10'],
];
const functionKeys = { inline: INLINE_KEYS.shell, all: [...shellKeys.all, ...FUNCTION_KEYS.map(([name]) => name)] };

export const PROFILES: Record<string, Profile> = {
  claude: agent(['Continue', 'Run the tests', 'Commit and push', 'Explain the diff', 'Stop here'], { toolbar: claudeToolbar, statusItems: [
    { pattern: /(\[)?\d+ (shells?|local agents?|idle agents?|monitors?)(\])?/g, action: { command: '/tasks' } },
    { pattern: /← \d+ agents?/g, action: { command: '/tasks' } },
    { pattern: /(auto mode on|plan mode on|accept edits on)/g, action: { keys: ['shift+tab'] } },
  ] }),
  pi: agent(['Continue', 'Run the tests', 'Show me the plan']),
  codex: agent(['Continue']),
  k9s: tool(true), htop: tool(true, functionKeys), btop: tool(true), lazygit: tool(true),
  nvim: tool(true), vim: tool(true), less: tool(true, functionKeys), generic: tool(false),
};

export function profileFor(pane: { agent?: string; command?: string } | undefined): Profile {
  const agentName = pane?.agent?.toLowerCase();
  if (agentName) {
    const key = Object.keys(PROFILES).find(name => agentName.includes(name));
    if (key) return PROFILES[key]!;
  }
  const command = pane?.command?.split('/').at(-1)?.toLowerCase();
  return command && PROFILES[command] || PROFILES.generic!;
}

export function mouseAllowed(paneKey: string, pane: { agent?: string; command?: string } | undefined): boolean {
  const override = localStorage.getItem(`tautan.mouse.${paneKey}`);
  return override === 'on' || override !== 'off' && profileFor(pane).mouse;
}

export function setMouseOverride(paneKey: string, value: 'on' | 'off' | null): void {
  const key = `tautan.mouse.${paneKey}`;
  if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
}
