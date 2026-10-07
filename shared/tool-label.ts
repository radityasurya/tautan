import type { ChatResponse } from './chat.ts';

export type AgentKind = NonNullable<ChatResponse['agentKind']>;

// Codex names its calls after the harness, not the user's idea of the work; the raw name stays in the tooltip.
const CODEX_LABEL: Record<string, string> = {
  exec: 'shell', exec_command: 'shell', shell: 'shell', local_shell_call: 'shell', write_stdin: 'stdin',
  apply_patch: 'patch', update_plan: 'plan', view_image: 'image', web_search: 'web search', web_search_call: 'web search',
  tool_search: 'tool search', tool_search_call: 'tool search',
};

export const toolLabel = (name: string, kind?: AgentKind) => (kind === 'codex' ? CODEX_LABEL[name] ?? name.replace(/_/g, ' ') : name);
