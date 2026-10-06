import { TopBar } from './header.tsx';
import { useEffect, useState } from 'react';
import { api, getTheme, setTheme, THEMES, useDesktop } from './app.tsx';
import { Select } from './halaska-kit';
import type { Theme } from './app.tsx';
import { GROUP, HostsSection, InstallHint, SectionTitle, Toggle, useHubSettings } from './hosts.tsx';
import { disablePush, enablePush, pushOn } from './push.ts';

import type { ReactNode } from 'react';
import type { Settings as HubSettings, State, SuggestSettingBody } from '../shared/types.ts';

const LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Each chip carries its theme's own `--bg` as the swatch. System has no colour of its own. */
const SWATCH: Record<Theme, string | null> = {
  system: null,
  light: '#ffffff',
  dark: '#0e0e11',
};

const android = /Android/.test(navigator.userAgent);

type QuotaProvider = {
  provider: string;
  quotaSemantics?: {
    effectiveAvailability?: {
      scope: string;
      effectivePercentRemaining?: number;
      runway?: { status: string; usableRunwaySeconds?: number };
    }[];
  };
};
type QuotaReport = { providers: QuotaProvider[] };

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'GitHub Copilot', grok: 'Grok', kimi: 'Kimi',
  zai: 'Z.AI', agy: 'Antigravity', alibaba: 'Alibaba', 'opencode-go': 'OpenCode Go', commandcode: 'Command Code',
  minimax: 'MiniMax', mimo: 'MiMo', deepseek: 'DeepSeek', openrouter: 'OpenRouter', elevenlabs: 'ElevenLabs',
};

function runway(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function quotaSummary(provider: QuotaProvider): string {
  const scopes = provider.quotaSemantics?.effectiveAvailability ?? [];
  const quota = scopes.find(item => item.scope === 'all_models') ?? scopes[0];
  if (!quota || typeof quota.effectivePercentRemaining !== 'number') return 'not available';
  const percent = `${Math.round(quota.effectivePercentRemaining)}% left`;
  if (quota.runway?.status === 'projected_exhaustion' && typeof quota.runway.usableRunwaySeconds === 'number')
    return `${percent} · ${runway(quota.runway.usableRunwaySeconds)} runway`;
  if (quota.runway?.status === 'through_reset') return `${percent} · through reset`;
  return `${percent} · runway unknown`;
}

/**
 * The theme picker: the kit Select, applied on pick. Settings owns the screen version and
 * the Pane's ⋯ sheet reuses it. The kit palette is light/dark; the grid's ANSI colours
 * follow the resolved theme through `data-theme`.
 */
export function ThemePicker() {
  const [theme, choose] = useState(getTheme);
  return (
    <div style={{ maxWidth: 220 }}>
      <Select
        value={theme}
        onChange={(t: string) => {
          setTheme(t as Theme);
          choose(t as Theme);
        }}
        options={THEMES.map((t) => ({ value: t, label: LABELS[t] }))}
        aria-label="Theme"
      />
    </div>
  );
}

export function Settings({ state, section }: { state: State | null; section?: string }) {
  const desktop = useDesktop();
  const { prefs, setPrefs, read, writeHosts } = useHubSettings();
  const [access, setAccess] = useState('');
  const [quota, setQuota] = useState<QuotaReport | null>();
  const [haptics, setHaptics] = useState(() => localStorage.getItem('tautan.haptics') !== 'off');
  // Push state is the browser's, not the Hub's: the intent in localStorage plus a live
  // permission. `/api/settings` has no push field to read.
  const [push, setPush] = useState(pushOn);
  const [pushNote, setPushNote] = useState('');
  // Smart replies live in two places: the Hub decides whether to draft at all, this phone
  // decides whether to show the drafts. On means both, and the switch writes both.
  const [smart, setSmart] = useState(() => localStorage.getItem('tautan.smart') === 'on');

  useEffect(() => {
    void api<QuotaReport>('/api/settings/quota', undefined, 'GET').then(setQuota, () => setQuota(null));
  }, []);

  // `#/settings/<section>` (and `#/hosts`) lands on that section; plain `#/settings` on the top.
  useEffect(() => {
    const el = section && document.getElementById(`settings-${section}`);
    if (el) el.scrollIntoView({ block: 'start' });
    else scrollTo(0, 0);
  }, [section]);

  // Locking and unlocking are the same write. The row is repainted from a fresh read, not
  // from what was sent: only the Hub knows whether the header it saw matched.
  const lock = (trustedUser: string | null) => {
    setAccess('');
    api<HubSettings>('/api/settings', { trustedUser }, 'PUT').then(read, (e: unknown) =>
      setAccess(
        (e instanceof Error && e.message) === 'login'
          ? 'The Hub did not see that login on this request. Open tautan through tailscale serve and try again.'
          : 'The Hub did not save that. Check the connection and try again.',
      ),
    );
  };

  const suggest = prefs.suggest ?? { enabled: false };
  const provider = suggest.provider && [suggest.provider, suggest.model].filter(Boolean).join(' · ');

  return (
    <div className="mx-auto max-w-2xl pb-28 lg:max-w-[880px] lg:px-6 lg:pt-8 lg:pb-10">
      {/* At `lg` the section nav carries the "Settings" title. */}
      {!desktop && <TopBar title="Settings" />}

      <HostsSection state={state} prefs={prefs} writeHosts={writeHosts} />

      <Section id="appearance" title="Appearance">
        <div className="px-4 lg:px-0">
          <ThemePicker />
        </div>
      </Section>

      <Section id="notifications" title="Notifications">
        <div className={GROUP}>
          <Toggle
            label="Push when an agent is blocked"
            hint="Done shows as a badge only"
            checked={push}
            onChange={async (v) => {
              setPushNote('');
              setPush(v);
              if (!v) return void disablePush();
              const result = await enablePush();
              if (result.ok) return;
              setPush(false);
              setPushNote(result.message);
            }}
          />
          {pushNote && (
            <p role="status" className="px-4 pb-2 text-caption leading-relaxed text-muted">
              {pushNote}
            </p>
          )}
          {android && (
            <>
              <div className="ml-4 border-t border-border/60" />
              <Toggle
                label="Haptics"
                hint="A short tap on send and on answering"
                checked={haptics}
                onChange={(v) => {
                  setHaptics(v);
                  localStorage.setItem('tautan.haptics', v ? 'on' : 'off');
                }}
              />
            </>
          )}
        </div>
        <InstallHint />
      </Section>

      <Section id="replies" title="Replies">
        <div className={GROUP}>
          <Toggle
            label="Smart replies"
            hint={provider || 'not configured · set TAUTAN_SUGGEST on the Hub'}
            checked={Boolean(provider) && suggest.enabled && smart}
            disabled={!provider}
            onChange={(v) => {
              setSmart(v);
              localStorage.setItem('tautan.smart', v ? 'on' : 'off');
              setPrefs({ ...prefs, suggest: { ...suggest, enabled: v } });
              void fetch('/api/settings/suggest', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ enabled: v } satisfies SuggestSettingBody),
              }).catch(() => {});
            }}
          />
          {provider && (
            <p className="px-4 pb-3 text-caption leading-relaxed text-muted">
              When an agent blocks, the last lines of its Screen go to the provider, which drafts three replies.
              The key stays on the Hub.
            </p>
          )}
        </div>
      </Section>

      <Section id="access" title="Access">
        <div className={GROUP}>
          <Row label="Login" value={prefs.login} empty="no identity header · not behind tailscale serve" />
          <div className="ml-4 border-t border-border/60" />
          <Row
            label="Trusted login"
            value={prefs.trustedUser}
            empty="anyone who can reach the Hub"
            action={
              prefs.trustedUser ? (
                <button type="button" onClick={() => lock(null)} className={accessAction}>
                  Unlock
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!prefs.login}
                  onClick={() => lock(prefs.login!)}
                  className={accessAction}
                >
                  Lock to this login
                </button>
              )
            }
          />
          {access && (
            <p role="alert" className="px-4 pb-2 text-caption leading-relaxed text-danger">
              {access}
            </p>
          )}
          <div className="ml-4 border-t border-border/60" />
          <Row label="Served by" value={prefs.servedBy || location.host} />
        </div>
      </Section>

      <Section id="about" title="About">
        <div className={GROUP}>
          <Row label={`tautan ${prefs.version?.tautan ?? 'unknown'}`} />
          {prefs.version?.herdr.map(item => (
            <div key={item.muxKey}>
              <div className="ml-4 border-t border-border/60" />
              <Row label={`herdr ${item.version} · ${item.label}`} />
            </div>
          ))}
          <div className="ml-4 border-t border-border/60" />
          <div aria-live="polite">
            {quota === undefined ? (
              <Row label="Quota" value="checking…" />
            ) : quota === null ? (
              <Row label="Quota" value="not available" />
            ) : quota.providers.some(item => item.quotaSemantics?.effectiveAvailability?.length) ? (
              quota.providers.filter(item => item.quotaSemantics?.effectiveAvailability?.length).map((item, index) => (
                <div key={item.provider}>
                  {index > 0 && <div className="ml-4 border-t border-border/60" />}
                  <Row label={PROVIDER_LABELS[item.provider] ?? item.provider} value={quotaSummary(item)} />
                </div>
              ))
            ) : (
              <Row label="Quota" value="not available" />
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

/** One Settings section: an anchor the section nav scrolls to, its title, then its rows. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-16 pt-6 lg:pt-10">
      <SectionTitle id={`settings-${id}-title`}>{title}</SectionTitle>
      {children}
    </section>
  );
}

const accessAction =
  'flex h-9 shrink-0 items-center rounded-chip px-2 text-[13px] font-medium text-accent active:bg-surface disabled:text-muted disabled:opacity-60';

/**
 * One Access row: the label, the Hub's value in mono under it, and an optional action.
 * The value goes on its own line because a login and a serve address both outrun the row.
 */
function Row({
  label,
  value,
  empty,
  action,
}: {
  label: string;
  value?: string;
  /** What the row says when the Hub has no value: the state, not the word "none". */
  empty?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-body">{label}</span>
        {(value !== undefined || empty !== undefined) && (
          <span className={`mt-px block truncate text-caption text-muted ${value ? 'font-mono' : ''}`}>
            {value || empty}
          </span>
        )}
      </span>
      {action}
    </div>
  );
}
