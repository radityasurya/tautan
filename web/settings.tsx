import { TopBar } from './header.tsx';
import { useEffect, useState } from 'react';
import { api, getTheme, setTheme, THEMES, useDesktop } from './app.tsx';
import { SegmentedControl, Select } from './halaska-kit';
import { getPaneList, setPaneList, usePref, type PaneList } from './spaces.ts';
import type { Theme } from './app.tsx';
import { GROUP, InstallHint, SectionTitle, Toggle, useHubSettings } from './hosts.tsx';
import { UsageMeters } from './usage.tsx';
import { PALETTES } from './palettes.ts';
import { disablePush, enablePush, pushOn } from './push.ts';

import type { ReactNode } from 'react';
import type { Settings as HubSettings, SuggestSettingBody } from '../shared/types.ts';

const LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  ...Object.fromEntries(Object.entries(PALETTES).map(([id, p]) => [id, p.label])),
};

/** The chosen palette's own colours as a strip: surface, text, accent, then the three Status colours. */
function Swatch({ id }: { id: string }) {
  const p = PALETTES[id];
  const colours = p
    ? [p.bg, p.fg, p.accent, p.ok, p.warn, p.danger]
    : id === 'light' ? ['#ffffff'] : id === 'dark' ? ['#0e0e11'] : null;
  if (!colours) return null;
  return (
    <span aria-hidden className="flex shrink-0 overflow-hidden rounded-chip border border-border">
      {colours.map((c, i) => (
        <span key={i} className="size-5" style={{ background: c }} />
      ))}
    </span>
  );
}

const android = /Android/.test(navigator.userAgent);

/**
 * The theme picker: the kit Select, applied on pick. Settings owns the screen version and
 * the Pane's ⋯ sheet reuses it. The kit palette is light/dark; the grid's ANSI colours
 * follow the resolved theme through `data-theme`.
 */
export function ThemePicker() {
  const [theme, choose] = useState(getTheme);
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0" style={{ width: 220 }}>
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
      <Swatch id={theme} />
    </div>
  );
}

const PANE_LISTS: Record<PaneList, string> = {
  tautan: 'Grouped by Workspace, with Needs you and Running on top',
  herdr: 'Spaces above, Agents below, most urgent first, like herdr',
};

/** How the Pane list is drawn: tautan's Workspace groups, or herdr's Spaces and Agents. */
function PaneListChoice() {
  const list = usePref(getPaneList);
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 lg:px-0">
      <span className="min-w-0 flex-1 basis-48">
        <span id="pane-list-label" className="block text-body">Pane list</span>
        <span className="mt-px block text-caption text-muted">{PANE_LISTS[list]}</span>
      </span>
      <div role="group" aria-labelledby="pane-list-label" className="w-48 shrink-0">
        <SegmentedControl
          options={['tautan', 'herdr']}
          value={list}
          onChange={(v: string) => setPaneList(v as PaneList)}
        />
      </div>
    </div>
  );
}

export function Settings({ section }: { section?: string }) {
  const desktop = useDesktop();
  const { prefs, setPrefs, read } = useHubSettings();
  const [access, setAccess] = useState('');
  const [haptics, setHaptics] = useState(() => localStorage.getItem('tautan.haptics') !== 'off');
  // Push state is the browser's, not the Hub's: the intent in localStorage plus a live
  // permission. `/api/settings` has no push field to read.
  const [push, setPush] = useState(pushOn);
  const [pushNote, setPushNote] = useState('');
  // Smart replies live in two places: the Hub decides whether to draft at all, this phone
  // decides whether to show the drafts. On means both, and the switch writes both.
  const [smart, setSmart] = useState(() => localStorage.getItem('tautan.smart') === 'on');

  // `#/settings/<section>` lands on that section; plain `#/settings` on the top.
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

      <Section id="appearance" title="Appearance">
        <div className="px-4 lg:px-0">
          <ThemePicker />
        </div>
        <PaneListChoice />
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
          <UsageMeters />
        </div>
      </Section>
    </div>
  );
}

/** One Settings section: an anchor the section nav scrolls to, its title, then its rows. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-16 pt-6 lg:pt-10 lg:first:pt-0">
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
