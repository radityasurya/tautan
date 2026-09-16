import { TopBar } from './header.tsx';
import { useEffect, useState } from 'react';
import { api, getTheme, setTheme, THEMES } from './app.tsx';
import { Select } from './halaska-kit';
import type { Theme } from './app.tsx';
import { InstallHint, Toggle } from './hosts.tsx';
import { disablePush, enablePush, pushOn } from './push.ts';

import type { ReactNode } from 'react';
import type { Settings as HubSettings, SuggestSettingBody } from '../shared/types.ts';

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

export function Settings() {
  const [prefs, setPrefs] = useState<HubSettings>({ hosts: [], suggest: { enabled: false } });
  const [access, setAccess] = useState('');
  const [haptics, setHaptics] = useState(() => localStorage.getItem('tautan.haptics') !== 'off');
  // Push state is the browser's, not the Hub's: the intent in localStorage plus a live
  // permission. `/api/settings` has no push field to read.
  const [push, setPush] = useState(pushOn);
  const [pushNote, setPushNote] = useState('');
  // Smart replies live in two places: the Hub decides whether to draft at all, this phone
  // decides whether to show the drafts. On means both, and the switch writes both.
  const [smart, setSmart] = useState(() => localStorage.getItem('tautan.smart') === 'on');

  const read = () => api<HubSettings>('/api/settings', undefined, 'GET').then(setPrefs).catch(() => {});
  useEffect(() => void read(), []);

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
    <div className="mx-auto max-w-2xl pb-28">
      <TopBar title="Settings" />

      <h2 className="label-caps px-4 pt-3.5 pb-2">Theme</h2>
      <div className="pb-1">
        <ThemePicker />
      </div>

      <h2 className="label-caps px-4 pt-6 pb-1">Notifications</h2>
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
      <InstallHint />
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

      <h2 className="label-caps px-4 pt-6 pb-1">Replies</h2>
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
        <p className="px-4 pb-2 text-caption leading-relaxed text-muted">
          When an agent blocks, the last lines of its Screen go to the provider, which drafts three replies.
          The key stays on the Hub.
        </p>
      )}

      <h2 className="label-caps px-4 pt-6 pb-1">Access</h2>
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
        <span className={`mt-px block truncate text-caption text-muted ${value ? 'font-mono' : ''}`}>
          {value || empty}
        </span>
      </span>
      {action}
    </div>
  );
}
