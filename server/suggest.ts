import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export const SUGGEST_SYSTEM = "You draft replies a developer would send to a coding agent from their phone. Given the agent's latest terminal output, answer with exactly three short replies (≤ 6 words each) as a JSON array of strings and nothing else.";

export interface SuggestAdapter {
  provider: 'zai' | 'anthropic';
  model: string;
  /** Draft replies for a Screen's tail. `null` means the call failed: the caller caches
   *  nothing and may ask again; `[]` means the model answered with nothing usable. */
  suggest(text: string): Promise<string[] | null>;
}

const warned = new Set<string>();

export function parseSuggestions(text: string): string[] {
  for (let start = text.indexOf('['); start >= 0; start = text.indexOf('[', start + 1)) {
    for (let end = text.indexOf(']', start + 1); end >= 0; end = text.indexOf(']', end + 1)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (!Array.isArray(value)) continue;
        return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).slice(0, 3);
      } catch {}
    }
  }
  return [];
}

export function configureSuggest(env: Record<string, string | undefined> = process.env, opts: { timeoutMs?: number } = {}): SuggestAdapter | null {
  const provider = env.TAUTAN_SUGGEST ?? 'off';
  if (provider !== 'zai' && provider !== 'anthropic') return null;
  let fileKey: string | undefined;
  if (provider === 'zai' && !env.TAUTAN_SUGGEST_KEY && !env.ZAI_API_KEY) {
    try { fileKey = readFileSync(join(os.homedir(), '.config/zai/api-key'), 'utf8').trim(); } catch {}
  }
  const key = env.TAUTAN_SUGGEST_KEY || (provider === 'zai' ? env.ZAI_API_KEY || fileKey : env.ANTHROPIC_API_KEY);
  const model = env.TAUTAN_SUGGEST_MODEL || (provider === 'zai' ? 'glm-5.3' : 'claude-haiku-5-5');
  const base = env.TAUTAN_SUGGEST_BASE || (provider === 'zai' ? 'https://api.z.ai/api/anthropic' : 'https://api.anthropic.com');
  if (!key) return null;
  return {
    provider, model,
    async suggest(text: string): Promise<string[] | null> {
      try {
        const response = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          // glm-5.3 spends its budget on a thinking block before the text one; 120 tokens died
          // inside thinking, answered no text block, and read as "nothing usable".
          body: JSON.stringify({ model, max_tokens: 300, system: SUGGEST_SYSTEM, messages: [{ role: 'user', content: text }] }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { content?: { type?: string; text?: string }[] };
        const block = body.content?.find(item => item.type === 'text');
        return block?.text ? parseSuggestions(block.text) : [];
      } catch (error) {
        if (!warned.has(provider)) {
          warned.add(provider);
          const detail = error instanceof Error ? error.name === 'Error' ? error.message : error.name : 'Error';
          console.warn(`tautan: suggest failed (${provider}): ${detail}`);
        }
        return null;
      }
    },
  };
}
