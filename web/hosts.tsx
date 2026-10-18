import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import type { HostConfig, ProbeResult, Settings, State, StateHost, StateMux, StatePane, Status, Tailnet, TailnetPeer } from '../shared/types.ts';
import { api, Link, navigate, opensWith, useDesktop } from './app.tsx';
import { Dot, statusText } from './home.tsx';
import { Back, ChevronRight, HostsTab, Install, Plus } from './icons.tsx';
import { TopBar } from './header.tsx';
import { ErrorLine, ModalSheet, useWrite } from './sheets.tsx';
import { Button, IconButton, LinkButton, StatusDot, SwitchToggle, usePal } from './halaska-kit';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// ---- shared Settings parts ----

/** A Settings section heading: small caps on the phone, a sentence-case title at `lg`. */
export function SectionTitle({ id, children, action }: { id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-5 pb-2 lg:px-0 lg:pb-3">
      <h2
        id={id}
        className="flex-1 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase lg:text-[15px] lg:tracking-normal lg:text-fg lg:normal-case"
      >
        {children}
      </h2>
      {action}
    </div>
  );
}

/** A grouped card of rows: filled on the phone, outlined at `lg`. */
export const GROUP = 'mx-4 overflow-hidden rounded-card bg-surface lg:mx-0 lg:border lg:border-border lg:bg-transparent';

/** `/api/settings` as the Hub holds it: `hosts.json`, the herdr versions, and the rest. */
export function useHubSettings() {
  const [prefs, setPrefs] = useState<Settings>({ hosts: [], suggest: { enabled: false } });
  const read = () => api<Settings>('/api/settings', undefined, 'GET').then(setPrefs).catch(() => {});
  useEffect(() => void read(), []);
  // Every write sends the whole array back. The reply carries no versions, so they are kept.
  const writeHosts = async (next: HostConfig[]) => {
    const saved = await api<Settings>('/api/settings', { hosts: next }, 'PUT');
    setPrefs((p) => ({ ...p, hosts: saved.hosts ?? next }));
  };
  return { prefs, setPrefs, read, writeHosts };
}

// ---- Host data, derived from the state stream ----

/** The `hosts.json` entry a Host came from. Only those may be edited. */
const configOf = (host: StateHost, hosts: HostConfig[]) =>
  host.source === 'config' ? (hosts.find((c) => c.id === host.id) ?? { id: host.id, target: host.target ?? '' }) : undefined;

/** `herdr 0.9.2` or `tmux 3.4`, or the kind alone until the Hub learns a version.
 *  The state stream carries it; the settings reply covers the moment before the first tree. */
const muxName = (mux: StateMux, prefs: Settings) => {
  const version = mux.version ?? prefs.version?.herdr.find((h) => h.muxKey === mux.key)?.version;
  return version && version !== 'unknown' ? `${mux.kind} ${version}` : mux.kind;
};

const RANK: Status[] = ['blocked', 'working', 'done', 'idle', 'unknown'];
/** One Status for a group of Panes: the most urgent. */
const topStatus = (panes: StatePane[]): Status => RANK.find((s) => panes.some((p) => p.status === s)) ?? 'unknown';

/** What a Workspace's Panes do, as `[Status, words]` parts. tmux reports no Status, so it says so. */
function statusParts(panes: StatePane[], kind: StateMux['kind']): [Status, string][] {
  const parts = (['blocked', 'working', 'done'] as const)
    .map((s) => [s, panes.filter((p) => p.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]): [Status, string] => [s, `${n} ${s}`]);
  if (parts.length) return parts;
  if (kind === 'tmux') return [['unknown', 'not reported']];
  return [panes.some((p) => p.agent) ? ['idle', 'idle'] : ['unknown', 'no Agent']];
}

function workspacesOf(state: State, mux: StateMux) {
  return state.workspaces
    .filter((w) => w.muxKey === mux.key)
    .map((w) => {
      const panes = state.panes.filter((p) => p.muxKey === mux.key && p.workspaceId === w.id);
      const tabs = state.tabs.filter((t) => t.muxKey === mux.key && t.workspaceId === w.id).length;
      const status = topStatus(panes);
      // A Workspace opens on the Pane that needs the most attention.
      const open = panes.find((p) => p.status === status) ?? panes[0];
      return { w, panes, tabs, status, to: open ? `#/pane/${encodeURIComponent(open.key)}` : undefined };
    });
}

const hostLink = (id: string) => `#/hosts/${encodeURIComponent(id)}`;

/** When a down Host is dialled next: `retry in 12s`, `retrying…` once that time has passed,
 *  or undefined for a Host that is up or has no retry scheduled. The 1 s tick runs only then. */
function useRetryIn(host: StateHost | undefined): string | undefined {
  const retryAt = host && !host.online ? host.retryAt : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now()); // a new retryAt counts from now, not from the last tick
    if (retryAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [retryAt]);
  if (retryAt === undefined) return undefined;
  const seconds = Math.ceil((retryAt - now) / 1_000);
  return seconds > 0 ? `retry in ${seconds}s` : 'retrying…';
}

/** Keep both ends of a long socket path visible; the full path rides the title attribute. */
const middle = (text: string, max = 44) =>
  text.length <= max ? text : `${text.slice(0, Math.ceil(max / 2) - 1)}…${text.slice(-Math.floor(max / 2))}`;

/** Re-dial a Host. The SSE `state` event is the receipt, so the reply is ignored. */
function useRetry(id: string) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void api<StateHost>(`/api/hosts/${encodeURIComponent(id)}/retry`)
      .catch(() => {})
      .finally(() => setRetrying(false));
  };
  return [retrying, retry] as const;
}

/** `herdr 0.9.2` in accent, `tmux` in grey: the Mux kind as a mono chip. */
function MuxChip({ mux, prefs }: { mux: StateMux; prefs: Settings }) {
  return (
    <span
      className={`shrink-0 rounded-[5px] px-1.5 py-0.5 font-mono text-[11px] ${
        mux.kind === 'herdr' ? 'bg-accent/12 text-accent' : 'bg-surface text-muted lg:bg-elevated'
      }`}
    >
      {muxName(mux, prefs)}
    </span>
  );
}

/** The Status of a Workspace: its dot, then each count in its own Status colour.
 *  `short` keeps the most urgent count only, for a phone row. */
function WorkspaceStatus({
  panes,
  status,
  kind,
  short,
}: {
  panes: StatePane[];
  status: Status;
  kind: StateMux['kind'];
  short?: boolean;
}) {
  const parts = statusParts(panes, kind);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Dot status={status} seen={status === 'idle' || status === 'unknown'} />
      {(short ? parts.slice(0, 1) : parts).map(([s, words], i) => (
        <span key={s} className={statusText[s]}>
          {i > 0 && '· '}
          {words}
        </span>
      ))}
    </span>
  );
}

// ---- Hosts ----

/** One phone row: the Host, its Mux kinds and versions, and its Workspace count. */
function HostRow({ host, state, prefs }: { host: StateHost; state: State; prefs: Settings }) {
  const muxes = state.muxes.filter((m) => m.hostId === host.id);
  const kinds = [...new Set(muxes.map((m) => muxName(m, prefs)))];
  const workspaces = state.workspaces.filter((w) => muxes.some((m) => m.key === w.muxKey)).length;
  const retryIn = useRetryIn(host);
  return (
    <li>
      <Link to={hostLink(host.id)} className="flex min-h-15 items-center gap-3 px-3.5 py-2.5 active:bg-elevated">
        <span
          aria-hidden
          className={`flex size-8 shrink-0 items-center justify-center rounded-chip ${
            host.online ? 'bg-ok/12 text-ok' : 'bg-danger/12 text-danger'
          }`}
        >
          <HostsTab size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body">
            {host.label}
            {!host.target && <span className="text-caption text-muted"> · this machine</span>}
          </span>
          {host.online ? (
            <span className="block truncate text-caption text-muted">
              {[...kinds, count(workspaces, 'Workspace')].join(' · ')}
            </span>
          ) : (
            <>
              {/* The retry time sits on the short first line, so a long error can never cut it off. */}
              <span className="block text-caption whitespace-nowrap text-danger">
                unreachable{retryIn && ` · ${retryIn}`}
              </span>
              {host.error && (
                <span title={host.error} className="line-clamp-2 text-caption break-words text-danger/80">
                  {host.error}
                </span>
              )}
            </>
          )}
        </span>
        <ChevronRight size={16} className="shrink-0 text-muted" />
      </Link>
    </li>
  );
}

/** One desktop card: the Host header, then every Mux × Workspace in one table. */
function HostCard({
  host,
  state,
  prefs,
  config,
  onEdit,
  onRemove,
}: {
  host: StateHost;
  state: State;
  prefs: Settings;
  /** The `hosts.json` entry this Host came from, when it came from one. */
  config?: HostConfig;
  onEdit: (entry: HostConfig) => void;
  onRemove: (entry: HostConfig) => void;
}) {
  const [retrying, retry] = useRetry(host.id);
  const pal = usePal();
  const muxes = state.muxes.filter((m) => m.hostId === host.id);
  const retryIn = useRetryIn(host);

  return (
    <section
      aria-label={host.label}
      className={`overflow-hidden rounded-[14px] border ${host.online ? 'border-border' : 'border-danger/40'}`}
    >
      <div className={`flex flex-wrap items-center gap-3 px-4.5 py-3.5 ${host.online ? 'bg-surface' : 'bg-danger/6'}`}>
        <StatusDot status={host.online ? 'online' : 'error'} />
        <Link to={hostLink(host.id)} className="text-[15px] font-semibold text-fg hover:underline">
          {host.label}
        </Link>
        <span
          className={`min-w-0 truncate text-caption ${host.online ? 'text-muted' : 'text-danger'} ${
            host.online && host.target ? 'font-mono' : ''
          }`}
        >
          {host.online
            ? (host.target ?? 'this machine')
            : `unreachable${host.error ? ` — ${host.error}` : ''}${retryIn ? ` · ${retryIn}` : ''}`}
        </span>
        <span className="flex-1" />
        {!host.online && (
          <Button variant="secondary" size="sm" onClick={retry} loading={retrying}>
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
        )}
        {config ? (
          <>
            <Button variant="outline" size="sm" onClick={() => onEdit(config)}>
              Edit
            </Button>
            <LinkButton size="sm" onClick={() => onRemove(config)} style={{ color: pal.danger }}>
              Remove
            </LinkButton>
          </>
        ) : (
          <span className="text-caption text-muted">
            {host.source === 'machines' ? 'from herdr machine list' : 'not editable'}
          </span>
        )}
      </div>

      {host.online && muxes.length > 0 && (
        // Narrow windows scroll the table sideways rather than squeezing its columns.
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[620px] border-collapse text-[13px]">
            <thead>
              <tr className="text-caption text-muted">
                <th className="px-4.5 py-2.5 text-left font-medium">Mux</th>
                <th className="px-3 py-2.5 text-left font-medium">Workspace</th>
                <th className="px-3 py-2.5 text-left font-medium">Tabs</th>
                <th className="px-3 py-2.5 text-left font-medium">Panes</th>
                <th className="px-4.5 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {muxes.flatMap((m) => {
                const rows = workspacesOf(state, m);
                const head = (
                  <td rowSpan={Math.max(1, rows.length)} className="px-4.5 py-2.5 align-top">
                    <span className="flex items-center gap-2">
                      <MuxChip mux={m} prefs={prefs} />
                      <span className="text-fg">{m.label}</span>
                      {!m.online && <span className="text-danger">offline</span>}
                    </span>
                  </td>
                );
                if (!rows.length)
                  return [
                    <tr key={m.key} className="border-t border-border">
                      {head}
                      <td colSpan={4} className="px-3 py-2.5 text-muted">
                        no Workspaces
                      </td>
                    </tr>,
                  ];
                return rows.map(({ w, panes, tabs, status, to }, i) => (
                  <tr key={w.key} className="border-t border-border">
                    {i === 0 && head}
                    <td className="px-3 py-2.5 text-fg">
                      {to ? (
                        <Link to={to} className="hover:underline">
                          {w.label}
                        </Link>
                      ) : (
                        w.label
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">{tabs}</td>
                    <td className="px-3 py-2.5 tabular-nums">{panes.length}</td>
                    <td className="px-4.5 py-2.5">
                      <WorkspaceStatus panes={panes} status={status} kind={m.kind} />
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * The Hosts screen, `#/hosts`. The phone lists one row per Host that opens Host detail; at
 * `lg` each Host is a card with its Mux × Workspace table.
 */
export function Hosts({ state }: { state: State | null }) {
  const desktop = useDesktop();
  const { prefs, writeHosts } = useHubSettings();
  const [edit, setEdit] = useState<HostConfig | null>(null);
  const [add, setAdd] = useState(() => opensWith('add-host') || opensWith('addhost'));
  const [note, setNote] = useState('');
  const hosts = prefs.hosts ?? [];
  useEffect(() => { scrollTo(0, 0); }, []);

  const remove = (entry: HostConfig) => {
    setNote('');
    writeHosts(hosts.filter((c) => c.id !== entry.id)).catch((e: unknown) =>
      setNote(e instanceof Error ? e.message : 'network'),
    );
  };
  const counts = state && count(state.hosts.length, 'Host');

  return (
    <div className="mx-auto max-w-2xl pb-28 lg:max-w-[880px] lg:px-6 lg:pt-8 lg:pb-10">
      {desktop ? (
        <div className="flex flex-wrap items-center gap-3 pb-5">
          <span className="flex flex-1 flex-col gap-1">
            <h1 className="text-[20px] font-semibold">Hosts</h1>
            <span className="text-[13px] text-muted">Each Host runs one or more Muxes. Each Mux holds Workspaces.</span>
          </span>
          <Button variant="primary" size="md" onClick={() => setAdd(true)}>
            + Add Host
          </Button>
        </div>
      ) : (
        <TopBar
          title="Hosts"
          right={
            <>
              {counts && <span className="mr-1.5 text-caption tabular-nums text-muted">{counts}</span>}
              <IconButton size={40} label="Add Host" onClick={() => setAdd(true)} icon={<Plus size={20} />} style={{ color: 'var(--accent)' }} />
            </>
          }
        />
      )}

      {!state ? (
        <p className="px-5 py-3 text-caption text-muted lg:px-0">Reading Hosts…</p>
      ) : state.hosts.length === 0 ? (
        <p className="px-5 py-3 text-body text-muted lg:px-0">No Hosts yet. Add one to see its Muxes here.</p>
      ) : desktop ? (
        <div className="flex flex-col gap-4">
          {state.hosts.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              state={state}
              prefs={prefs}
              config={configOf(h, hosts)}
              onEdit={setEdit}
              onRemove={remove}
            />
          ))}
        </div>
      ) : (
        <ul className={`${GROUP} mt-2 divide-y divide-border`}>
          {state.hosts.map((h) => (
            <HostRow key={h.id} host={h} state={state} prefs={prefs} />
          ))}
        </ul>
      )}

      {note && (
        <p role="alert" className="px-5 pt-2 text-[13px] text-danger lg:px-0">
          Could not save the Host list · {note}
        </p>
      )}

      <AddHostSheet
        open={add || edit !== null}
        editing={edit ?? undefined}
        onClose={() => {
          setAdd(false);
          setEdit(null);
        }}
        onSubmit={(entry) => writeHosts([...hosts.filter((c) => c.id !== entry.id), entry])}
      />
    </div>
  );
}

// ---- Host detail: #/hosts/<id> ----

/** One label and value row in Host detail's Connection group. */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-h-11 items-center gap-3 px-3.5 py-2 text-[14px]">
      <span className="shrink-0">{label}</span>
      <span className={`ml-auto min-w-0 truncate text-muted ${mono ? 'font-mono text-caption' : 'text-[13px]'}`}>{value}</span>
    </div>
  );
}

/** Each Mux on one Host, with its Workspaces, their Tab and Pane counts, and their Status. */
export function HostDetail({ hostId, state }: { hostId: string; state: State | null }) {
  const { prefs, writeHosts } = useHubSettings();
  const [retrying, retry] = useRetry(hostId);
  // The entry is kept as clicked: a fresh object each state event would reset the open sheet.
  const [editing, setEditing] = useState<HostConfig | null>(null);
  const [note, setNote] = useState('');
  const pal = usePal();
  useEffect(() => { scrollTo(0, 0); }, [hostId]);

  const host = state?.hosts.find((h) => h.id === hostId);
  const retryIn = useRetryIn(host);
  const hosts = prefs.hosts ?? [];
  const config = host && configOf(host, hosts);
  const muxes = state?.muxes.filter((m) => m.hostId === hostId) ?? [];

  const remove = (entry: HostConfig) => {
    setNote('');
    writeHosts(hosts.filter((c) => c.id !== entry.id)).then(
      () => navigate('#/hosts'),
      (e: unknown) => setNote(e instanceof Error ? e.message : 'network'),
    );
  };

  return (
    <div className="mx-auto max-w-2xl pb-28 lg:pb-10">
      <header className="sticky top-0 z-30 bg-bg/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="flex h-14 items-center gap-1 pr-4 pl-1">
          <Link to="#/hosts" aria-label="Hosts" className="flex size-11 shrink-0 items-center justify-center text-accent">
            <Back />
          </Link>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-[16px] font-semibold tracking-tight">{host?.label ?? hostId}</h1>
            {host && (
              <p className={`flex items-center gap-1.5 truncate text-caption ${host.online ? 'text-ok' : 'text-danger'}`}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
                {/* The error itself is in the card below. */}
                {host.online ? `connected · ${host.target ?? 'this machine'}` : 'unreachable'}
              </p>
            )}
          </div>
          {config && (
            <LinkButton size="sm" onClick={() => setEditing(config)}>
              Edit
            </LinkButton>
          )}
        </div>
      </header>

      {/* An unknown id never gets here: App falls back to the Hosts list once state arrives. */}
      {!state || !host ? (
        <p className="px-5 pt-4 text-caption text-muted">Reading Hosts…</p>
      ) : !host.online ? (
        <div className="mx-4 mt-2 flex flex-col items-start gap-3 rounded-card border border-danger/40 bg-danger/6 p-3.5">
          <p className="text-[13px] break-words text-danger">
            {host.error ?? 'The Hub cannot reach this Host.'}
            {retryIn && ` · ${retryIn}`}
          </p>
          <Button variant="secondary" size="sm" onClick={retry} loading={retrying}>
            {retrying ? 'Retrying…' : 'Retry now'}
          </Button>
        </div>
      ) : muxes.length === 0 ? (
        <p className="px-5 pt-4 text-body text-muted">No Muxes on this Host.</p>
      ) : (
        muxes.map((m) => {
          const rows = workspacesOf(state, m);
          return (
            <section key={m.key} aria-label={`${m.kind} ${m.label}`} className="flex flex-col gap-2 pt-4">
              <div className="flex items-center gap-2 px-5 lg:px-1">
                <MuxChip mux={m} prefs={prefs} />
                <span className="truncate text-[13px] font-semibold">{m.label}</span>
                <span className={`ml-auto shrink-0 text-[11px] ${m.online ? 'text-muted' : 'text-danger'}`}>
                  {!m.online ? 'offline' : m.kind === 'tmux' ? 'Status not reported' : count(rows.length, 'Workspace')}
                </span>
              </div>
              {m.socket && (
                <p className="px-5 font-mono text-caption text-muted lg:px-1" title={m.socket}>
                  {middle(m.socket)}
                </p>
              )}
              <ul className={`${GROUP} divide-y divide-border`}>
                {rows.length === 0 && <li className="px-3.5 py-3 text-[14px] text-muted">No Workspaces</li>}
                {rows.map(({ w, panes, tabs, status, to }) => {
                  const body = (
                    <>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body">{w.label}</span>
                        <span className="block truncate text-caption text-muted">
                          {[count(tabs, 'Tab'), count(panes.length, 'Pane'), w.cwd].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <span className="text-caption">
                        <WorkspaceStatus panes={panes} status={status} kind={m.kind} short />
                      </span>
                    </>
                  );
                  const row = 'flex min-h-13 items-center gap-3 px-3.5 py-2';
                  return (
                    <li key={w.key}>
                      {to ? (
                        <Link to={to} className={`${row} active:bg-elevated`}>
                          {body}
                        </Link>
                      ) : (
                        <div className={row}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      {host && (
        <section aria-labelledby="host-connection" className="pt-6">
          <SectionTitle id="host-connection">Connection</SectionTitle>
          <div className={`${GROUP} divide-y divide-border`}>
            <Fact label="Target" value={host.target ?? 'this machine'} mono={Boolean(host.target)} />
            <Fact
              label="Source"
              value={host.source === 'config' ? 'hosts.json' : host.source === 'machines' ? 'herdr machine list' : 'this machine'}
            />
            {config && <Fact label="herdr Mux" value={config.session ?? 'discover all'} mono={Boolean(config.session)} />}
          </div>
          {config && (
            <div className="px-4 pt-3 lg:px-0">
              <LinkButton size="sm" onClick={() => remove(config)} style={{ color: pal.danger }}>
                Remove Host
              </LinkButton>
            </div>
          )}
          {note && (
            <p role="alert" className="px-5 pt-2 text-[13px] text-danger lg:px-0">
              Could not save the Host list · {note}
            </p>
          )}
        </section>
      )}

      <AddHostSheet
        open={editing !== null}
        editing={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSubmit={(entry) => writeHosts([...hosts.filter((c) => c.id !== entry.id), entry])}
      />
    </div>
  );
}

/** `Label` wins; otherwise the first part of the target's host, so `dev@vps.ts.net` is `vps`. */
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hostId = (label: string | undefined, target: string) =>
  slug(label ?? '') || slug(target.split('@').pop()!.split(':')[0]!.split('.')[0]!) || 'host';

/** `dev@vps` → `['dev', 'vps']`, `vps` → `['', 'vps']`. ssh splits at the last `@` too. */
const splitTarget = (target: string): [string, string] => {
  const at = target.lastIndexOf('@');
  return at > 0 ? [target.slice(0, at), target.slice(at + 1)] : ['', target];
};

/** The Hub's tailnet, read each time the sheet opens. The last answer stays while the next
 *  one loads, so a reopened sheet does not jump; a failed read hides the list. */
function useTailnet(open: boolean) {
  const [net, setNet] = useState<Tailnet | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<Tailnet>('/api/tailnet', undefined, 'GET').then(
      (n) => live && setNet(n),
      () => live && setNet(null),
    );
    return () => {
      live = false;
    };
  }, [open]);
  return net;
}

/** Phones and tablets run Tailscale but not herdr; herdr runs on macOS and Linux. */
const MOBILE = new Set(['android', 'iOS', 'iPadOS']);
const OS_NAME: Record<string, string> = { linux: 'Linux', windows: 'Windows', android: 'Android', freebsd: 'FreeBSD', openbsd: 'OpenBSD' };
/** The OS, and what it means for herdr where that is not plain. */
const osNote = (p: TailnetPeer) => {
  const os = OS_NAME[p.os] ?? p.os;
  return MOBILE.has(p.os) ? `${os} · no herdr` : p.os === 'windows' ? `${os} · needs WSL` : os;
};

/**
 * Every other machine on the Hub's tailnet, one row each: online first, phones and tablets
 * last. A tap picks it; a machine a Host already names is not a choice. Long lists scroll
 * inside the card, so the form under it stays in reach.
 */
function TailnetPicker({ peers, picked, onPick }: { peers: TailnetPeer[]; picked: string; onPick: (p: TailnetPeer) => void }) {
  const id = useId();
  const sorted = [...peers.filter((p) => !MOBILE.has(p.os)), ...peers.filter((p) => MOBILE.has(p.os))];
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="px-4 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted uppercase">
        On your tailnet
      </h3>
      {/* 5½ rows, so a cut row says there is more. */}
      <ul className="max-h-[242px] divide-y divide-border overflow-y-auto overscroll-contain rounded-card bg-elevated">
        {sorted.map((p) => {
          const on = picked === p.name;
          const quiet = !p.online || MOBILE.has(p.os);
          return (
            <li key={p.dnsName}>
              <button
                type="button"
                disabled={Boolean(p.added)}
                aria-pressed={p.added ? undefined : on}
                aria-label={[p.name, osNote(p), p.online ? 'online' : 'offline', p.ssh && 'Tailscale SSH', p.added && 'added'].filter(Boolean).join(', ')}
                title={p.dnsName}
                onClick={() => onPick(p)}
                className={`flex min-h-11 w-full items-center gap-2.5 px-4 py-2 text-left outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)] enabled:active:bg-surface disabled:cursor-default ${
                  on ? 'bg-accent/8 shadow-[inset_2px_0_0_var(--accent)]' : ''
                }`}
              >
                <span aria-hidden className={`flex min-w-0 flex-1 items-center gap-2.5 ${quiet || p.added ? 'opacity-55' : ''}`}>
                  <StatusDot status={p.online ? 'online' : 'offline'} />
                  <span className={`min-w-0 truncate text-body ${MOBILE.has(p.os) ? 'text-muted' : 'text-fg'} ${on ? 'font-semibold' : ''}`}>
                    {p.name}
                  </span>
                  <span className="ml-auto shrink-0 text-caption text-muted">{osNote(p)}</span>
                </span>
                {p.added ? (
                  <span aria-hidden className="shrink-0 text-caption font-medium text-muted">
                    Added
                  </span>
                ) : (
                  p.ssh && (
                    <span aria-hidden className={`shrink-0 rounded-[5px] bg-accent/12 px-1.5 py-px text-[11px] font-medium text-accent ${quiet ? 'opacity-55' : ''}`}>
                      Tailscale SSH
                    </span>
                  )
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A grouped card of form rows, iOS Settings style: lighter than the sheet behind it. */
const CARD = 'overflow-hidden rounded-card bg-elevated divide-y divide-border';
/** A caption under a card, inset to the rows' text. */
const NOTE = 'px-4 pt-1.5 text-caption text-muted';

/** One form row: the label on the left, the field filling the rest. A tap anywhere focuses it. */
function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex min-h-11 cursor-text items-center gap-3 px-4 focus-within:shadow-[inset_2px_0_0_var(--accent)]">
      <span className="w-[5.5rem] shrink-0 text-body text-fg">{label}</span>
      <input
        type="text"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        {...input}
        className="min-w-0 flex-1 bg-transparent py-2.5 text-body text-fg outline-none placeholder:text-muted"
      />
    </label>
  );
}

/**
 * Add or edit one `hosts.json` entry, in the shape of Termius's New Host: the address and
 * user, the label, the herdr Mux, then a connection test. The stored target stays one string,
 * `user@address`. Testing is optional: it dials the target once and saves nothing, so a Host
 * can be added before its machine is up.
 */
export function AddHostSheet({
  open,
  editing,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** The entry being changed; its `id` is kept, so the Host keeps its Panes' keys. */
  editing?: HostConfig;
  onClose: () => void;
  onSubmit: (entry: HostConfig) => Promise<void>;
}) {
  const { busy, error, submit, retry } = useWrite(open, onSubmit, onClose);
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [username, setUsername] = useState('');
  const [session, setSession] = useState('');
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeShown | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const testRef = useRef<HTMLElement>(null);
  /** The latest probe: an answer to an earlier one, for a machine picked before, is dropped. */
  const probeSeq = useRef(0);
  /** A pick's probe keeps the Test row in view until it answers: below the fold on a phone. */
  const follow = useRef(false);
  const net = useTailnet(open && !editing);

  // A reopened sheet starts clean, the same rule the write hook follows.
  useEffect(() => {
    if (open) {
      const [user, addr] = splitTarget(editing?.target ?? '');
      setLabel(editing?.label ?? '');
      setUsername(user);
      setAddress(addr);
      setSession(editing?.session ?? '');
      setProbing(false);
      setResult(null);
      probeSeq.current++;
      follow.current = false;
    }
  }, [open, editing]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  useEffect(() => {
    if (!follow.current) return;
    testRef.current?.scrollIntoView({ block: 'nearest' });
    if (result) follow.current = false;
  }, [probing, result]);

  const addr = address.trim();
  const user = username.trim();
  // A `user@host` typed into Address is the whole target: its user wins over the field.
  const target = user && !addr.includes('@') ? `${user}@${addr}` : addr;
  const save = () =>
    submit({ id: editing?.id ?? hostId(label.trim() || undefined, target), label: label.trim() || undefined, target, session: session.trim() || undefined });

  const probe = (to = target) => {
    const n = ++probeSeq.current;
    setProbing(true);
    setResult(null);
    api<ProbeResult>('/api/hosts/probe', { target: to, session: session.trim() || undefined })
      .then((r) => n === probeSeq.current && setResult({ ...r, target: to }))
      .catch((e: unknown) => n === probeSeq.current && setResult({ online: false, code: (e instanceof Error && e.message) || 'network', target: to }))
      .finally(() => n === probeSeq.current && setProbing(false));
  };

  // A picked machine fills Address and Label, keeps a typed Username, and is tested at once.
  const pick = (p: TailnetPeer) => {
    setAddress(p.name);
    setLabel(p.name);
    follow.current = true;
    probe(user ? `${user}@${p.name}` : p.name);
  };

  // Enter moves to the next field; in the last one it saves.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const fields = [...e.currentTarget.querySelectorAll('input')];
    const next = fields[fields.indexOf(e.target) + 1];
    if (next) next.focus();
    else if (addr && !busy) save();
  };

  return (
    <ModalSheet
      open={open}
      title={editing ? 'Edit Host' : 'New Host'}
      onClose={onClose}
      save={{ label: busy ? 'Saving…' : 'Save', onSave: save, disabled: !addr, busy }}
    >
      {error && (
        <div ref={errorRef} className="rounded-card bg-danger/8 py-1 pr-1 pl-4">
          <ErrorLine error={error} busy={busy} onRetry={retry} />
        </div>
      )}
      {/* Edit keeps its machine: the list is for adding one. */}
      {!editing && net?.state === 'running' && net.peers.length > 0 && <TailnetPicker peers={net.peers} picked={addr} onPick={pick} />}
      {!editing && net?.state === 'needs-login' && (
        <p className="px-4 text-caption text-muted">
          Tailscale is logged out on this Hub · run <Code>tailscale login</Code>
        </p>
      )}
      <div className="contents" onKeyDown={onKeyDown}>
        <section>
          <div className={CARD}>
            <Field
              label="Address"
              data-autofocus
              inputMode="url"
              enterKeyHint="next"
              placeholder="Hostname, IP or alias"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              // A pasted `user@host` lands in both fields.
              onBlur={() => {
                const [u, a] = splitTarget(addr);
                if (u) {
                  setUsername(u);
                  setAddress(a);
                }
              }}
            />
            <Field label="Username" enterKeyHint="next" placeholder="Optional" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <p className={NOTE}>The Hub runs ssh with this address, so an ~/.ssh/config alias works. Set a custom port there.</p>
        </section>
        <section className={CARD}>
          <Field
            label="Label"
            autoCapitalize="words"
            enterKeyHint="next"
            placeholder="Taken from the address"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </section>
        <section>
          <div className={CARD}>
            <Field label="herdr Mux" enterKeyHint="done" placeholder="Discover all" value={session} onChange={(e) => setSession(e.target.value)} />
          </div>
          <p className={NOTE}>Leave it empty to show every herdr Mux on the Host.</p>
        </section>
      </div>
      <section ref={testRef} className={`${CARD} scroll-mb-5`}>
        <button
          type="button"
          onClick={() => {
            if (!probing) probe();
          }}
          disabled={!addr}
          aria-busy={probing || undefined}
          className="flex min-h-11 w-full items-center justify-center px-4 text-body text-accent outline-none focus-visible:shadow-[inset_2px_0_0_var(--accent)] active:bg-surface disabled:text-muted"
        >
          {probing ? 'Testing…' : 'Test connection'}
        </button>
        {result && (
          <div className="px-4 py-2.5">
            <ProbeLine result={result} />
          </div>
        )}
      </section>
    </ModalSheet>
  );
}

/** A probe's answer, with the target it dialled, so the words name the machine. */
type ProbeShown = ProbeResult & { code?: string; target: string };

/** A command or file name inside a sentence. */
const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-chip bg-bg px-1 py-px font-mono text-[0.86em] [overflow-wrap:anywhere]">{children}</code>
);

/** What one probe found: reachable plus the herdr Muxes it saw, or why it did not connect. */
function ProbeLine({ result }: { result: ProbeShown }) {
  const muxes = result.sessions?.length ? ` · herdr: ${result.sessions.join(', ')}` : '';
  return (
    <p role="status" className="flex items-start gap-2 text-[13px]">
      <span
        aria-hidden
        className={`mt-1.5 size-2 shrink-0 rounded-full ${result.online ? 'bg-ok' : 'bg-danger'}`}
      />
      <span title={result.error} className={`min-w-0 break-words ${result.online ? 'text-fg' : 'text-danger'}`}>
        {result.online ? `reachable${muxes}` : result.error ? failure(result.error, result.target) : why(result.code ?? 'network')}
      </span>
    </p>
  );
}

/**
 * The probe's ssh failures a tailnet user meets first, in words. The Hub passes ssh's last
 * stderr line through: OpenSSH's `user@host: Permission denied (publickey,…).`, and the
 * shell's answer when neither `herdr` nor `~/.local/bin/herdr` exists (bash `No such file or
 * directory`, zsh `no such file or directory:`, dash `not found`, fish `Unknown command`).
 * Any other line shows as ssh wrote it.
 */
function failure(error: string, target: string): ReactNode {
  const name = target.slice(target.lastIndexOf('@') + 1);
  if (/Permission denied \(/.test(error))
    return (
      <>
        SSH refused the login. Turn on Tailscale SSH on {name} (<Code>tailscale set --ssh</Code>) or add this Hub's key to its{' '}
        <Code>authorized_keys</Code>.
      </>
    );
  if (/herdr/.test(error) && /not found|no such file|unknown command/i.test(error))
    return (
      <>
        herdr is not on {name}. Install it there, or run <Code>herdr machine add {target}</Code> on this Hub.
      </>
    );
  if (/Host key verification failed/.test(error))
    return (
      <>
        This Hub has not seen {name}'s host key yet. Run <Code>ssh {target}</Code> on this Hub once to accept it.
      </>
    );
  return error;
}

/** The probe's own failures, in words. A bad target is the one the Hub answers with a 400. */
const why = (code: string) =>
  code === 'target' ? 'Enter an address with no spaces, like dev@vps' : code === 'network' ? 'No connection to the Hub' : code;

/** One setting row: label and hint on the left, the kit SwitchToggle on the right. */
export function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  /** Nothing to switch on yet — the hint says what is missing. */
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className={`flex min-h-12 items-center gap-3 px-4 py-2 ${disabled ? 'pointer-events-none opacity-55' : ''}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-body">{label}</span>
        {hint && <span className="mt-px block text-caption text-muted">{hint}</span>}
      </span>
      <SwitchToggle checked={checked} onChange={disabled ? undefined : onChange} />
    </div>
  );
}

/** iOS only, and only outside the installed app: push needs Add to Home Screen there. */
export function InstallHint() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || location.search.includes('mock');
  const installed =
    matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!ios || installed) return null;

  return (
    <p className="mx-4 mt-2 flex gap-2.5 rounded-card bg-elevated lg:mx-0 px-3 py-2.5 text-caption leading-relaxed text-muted">
      <Install className="mt-px shrink-0" />
      On iPhone, add tautan to the Home Screen from the Share menu to receive notifications.
    </p>
  );
}
