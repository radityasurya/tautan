import { TopBar } from './header.tsx';
import { useEffect, useState } from 'react';
import type { HostConfig, ProbeResult, Settings, State, StateHost } from '../shared/types.ts';
import { api, opensWith } from './app.tsx';
import { Install, Plus } from './icons.tsx';
import { ErrorLine, Sheet, useWrite } from './sheets.tsx';
import { Button, Card, Caption, IconButton, LinkButton, StatusDot, SwitchToggle, TextInput, usePal } from './halaska-kit';

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function HostCard({
  host,
  state,
  config,
  onEdit,
  onRemove,
}: {
  host: StateHost;
  state: State;
  /** The `hosts.json` entry this Host came from, when it came from one. */
  config?: HostConfig;
  onEdit: (entry: HostConfig) => void;
  onRemove: (entry: HostConfig) => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const pal = usePal();
  const muxes = state.muxes.filter((m) => m.hostId === host.id);
  const panes = state.panes.filter((p) => muxes.some((m) => m.key === p.muxKey));

  const retry = () => {
    setRetrying(true);
    // The Hub re-dials the Host; the SSE `state` event is the receipt.
    void api<StateHost>(`/api/hosts/${encodeURIComponent(host.id)}/retry`)
      .catch(() => {})
      .finally(() => setRetrying(false));
  };

  return (
    <li>
      <Card>
        <div className="flex items-center gap-2.5">
          <StatusDot status={host.online ? 'online' : 'error'} />
          <span className="shrink-0 font-semibold">{host.label}</span>
          <span className={`min-w-0 truncate text-caption text-muted ${host.target ? 'font-mono' : ''}`}>
            {host.target ?? 'this machine'}
          </span>
          {host.online && muxes.length > 1 && (
            <span className="ml-auto shrink-0 text-caption tabular-nums text-muted">{count(panes.length, 'pane')}</span>
          )}
        </div>

        {host.online ? (
          <ul className="flex flex-col gap-1.5">
            {muxes.map((m) => {
              const mine = panes.filter((p) => p.muxKey === m.key);
              const blocked = mine.filter((p) => p.status === 'blocked').length;
              return (
                <li key={m.key} className="flex items-center gap-2.5 text-[13px] text-muted">
                  <span className="font-mono text-fg">{m.kind}</span>
                  {m.label !== m.kind && <span className="min-w-0 truncate">{m.label}</span>}
                  <span className="ml-auto shrink-0 tabular-nums">
                    {count(mine.length, 'pane')}
                    {blocked > 0 && ` · ${blocked} blocked`}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] break-words text-danger">{host.error ?? 'unreachable'}</p>
        )}

        {/* The bottom row is always there, so a Host without actions says why: this machine
            or the machine list owns it, and tautan may not edit those entries. */}
        <div className="flex items-center gap-1">
          {!host.online && (
            <Button variant="outline" size="sm" onClick={retry} loading={retrying}>
              {retrying ? 'Retrying…' : 'Retry now'}
            </Button>
          )}
          {config && (
            <>
              <LinkButton size="sm" onClick={() => onEdit(config)}>
                Edit
              </LinkButton>
              <LinkButton size="sm" onClick={() => onRemove(config)} style={{ color: pal.danger }}>
                Remove
              </LinkButton>
            </>
          )}
          {!config && (
            <span className="ml-auto pl-2 text-right text-caption text-muted">
              {host.source === 'machines' ? 'from herdr machine list' : 'this machine · not editable'}
            </span>
          )}
        </div>
      </Card>
    </li>
  );
}

export function Hosts({ state }: { state: State | null }) {
  // `hosts.json` as the Hub holds it. State says what a Host is doing; this says what tautan
  // may edit, and every write sends the whole array back.
  const [hosts, setHosts] = useState<HostConfig[]>([]);
  const [edit, setEdit] = useState<HostConfig | null>(null);
  const [add, setAdd] = useState(() => opensWith('add-host') || opensWith('addhost'));
  const [note, setNote] = useState('');

  const read = () =>
    api<Settings>('/api/settings', undefined, 'GET')
      .then((s) => setHosts(s.hosts ?? []))
      .catch(() => {});
  useEffect(() => void read(), []);

  const write = async (next: HostConfig[]) => {
    const saved = await api<Settings>('/api/settings', { hosts: next }, 'PUT');
    setHosts(saved.hosts ?? next);
  };

  const open = add || edit !== null;
  const counts =
    state &&
    `${count(state.hosts.length, 'host')} · ${count(state.panes.length, 'pane')}`;

  return (
    <div className="mx-auto max-w-2xl pb-28 lg:pb-10">
      <TopBar
        title="Hosts"
        right={
          <>
            <span className="mr-1.5 text-caption tabular-nums text-muted">{counts}</span>
            <IconButton size={40} label="Add Host" onClick={() => setAdd(true)} icon={<Plus size={20} />} style={{ color: 'var(--accent)' }} />
          </>
        }
      />

      <ul className="flex flex-col gap-3 px-4 pt-2">
        {state?.hosts.map((h) => (
          <HostCard
            key={h.id}
            host={h}
            state={state}
            config={h.source === 'config' ? (hosts.find((c) => c.id === h.id) ?? { id: h.id, target: h.target ?? '' }) : undefined}
            onEdit={setEdit}
            onRemove={(entry) => {
              setNote('');
              write(hosts.filter((c) => c.id !== entry.id)).catch((e: unknown) =>
                setNote(e instanceof Error ? e.message : 'network'),
              );
            }}
          />
        ))}
      </ul>

      {note && (
        <p role="alert" className="px-4 pt-2 text-[13px] text-danger">
          Could not save the Host list · {note}
        </p>
      )}

      <AddHostSheet
        open={open}
        editing={edit ?? undefined}
        onClose={() => {
          setAdd(false);
          setEdit(null);
        }}
        onSubmit={(entry) => write([...hosts.filter((c) => c.id !== entry.id), entry])}
      />
    </div>
  );
}

/** `Label` wins; otherwise the first part of the target's host, so `dev@vps.ts.net` is `vps`. */
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hostId = (label: string | undefined, target: string) =>
  slug(label ?? '') || slug(target.split('@').pop()!.split(':')[0]!.split('.')[0]!) || 'host';

/**
 * Add or edit one `hosts.json` entry. Probe is optional: it dials the target once and
 * saves nothing, so a Host can be added before its machine is up.
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
  const [target, setTarget] = useState('');
  const [session, setSession] = useState('');
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<(ProbeResult & { code?: string }) | null>(null);

  // A reopened sheet starts clean, the same rule the write hook follows.
  useEffect(() => {
    if (open) {
      setLabel(editing?.label ?? '');
      setTarget(editing?.target ?? '');
      setSession(editing?.session ?? '');
      setProbing(false);
      setResult(null);
    }
  }, [open, editing]);

  const probe = () => {
    setProbing(true);
    setResult(null);
    api<ProbeResult>('/api/hosts/probe', { target: target.trim(), session: session.trim() || undefined })
      .then(setResult)
      .catch((e: unknown) => setResult({ online: false, code: (e instanceof Error && e.message) || 'network' }))
      .finally(() => setProbing(false));
  };

  return (
    <Sheet open={open} title={editing ? 'Edit Host' : 'Add Host'} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <TextInput value={label} onChange={setLabel} label="Label" placeholder="Optional · taken from the target" />
        <TextInput value={target} onChange={setTarget} label="SSH target" placeholder="user@host" />
        <TextInput value={session} onChange={setSession} label="herdr Mux" placeholder="default · leave empty to discover" />

        <Button variant="secondary" size="lg" fullWidth loading={probing} onClick={probe}>
          {probing ? 'Probing…' : 'Probe'}
        </Button>
        {result && <ProbeLine result={result} />}

        {error && <ErrorLine error={error} busy={busy} onRetry={retry} />}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          loading={busy}
          disabled={!target.trim()}
          onClick={() =>
            submit({ id: editing?.id ?? hostId(label.trim() || undefined, target.trim()), label: label.trim() || undefined, target: target.trim(), session: session.trim() || undefined })
          }
        >
          {busy ? 'Saving…' : editing ? 'Save Host' : 'Add Host'}
        </Button>
      </div>
    </Sheet>
  );
}

/** What one probe found: reachable plus the herdr Muxes it saw, or why it did not connect. */
function ProbeLine({ result }: { result: ProbeResult & { code?: string } }) {
  const muxes = result.sessions?.length ? ` · herdr: ${result.sessions.join(', ')}` : '';
  return (
    <p role="status" className="flex items-start gap-2 text-[13px]">
      <span
        aria-hidden
        className={`mt-1.5 size-2 shrink-0 rounded-full ${result.online ? 'bg-ok' : 'bg-danger'}`}
      />
      <span className={`min-w-0 break-words ${result.online ? 'text-fg' : 'text-danger'}`}>
        {result.online ? `reachable${muxes}` : (result.error ?? why(result.code ?? 'network'))}
      </span>
    </p>
  );
}

/** The probe's own failures, in words. A bad target is the one the Hub answers with a 400. */
const why = (code: string) =>
  code === 'target' ? 'Enter a target like user@host' : code === 'network' ? 'No connection to the Hub' : code;

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
    <p className="mx-4 mt-2 flex gap-2.5 rounded-card bg-elevated px-3 py-2.5 text-caption leading-relaxed text-muted">
      <Install className="mt-px shrink-0" />
      On iPhone, add tautan to the Home Screen from the Share menu to receive notifications.
    </p>
  );
}
