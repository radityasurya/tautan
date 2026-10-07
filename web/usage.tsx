import { useEffect, useState } from 'react';
import { api } from './app.tsx';

// ---- the quota report ----
// One Hub call, `/api/settings/quota`, which the Hub caches for five minutes. The Settings
// meters and the sidebar strip share one fetch and one timer; polling faster than the Hub's
// TTL would only re-read its cache.
const POLL = 5 * 60 * 1_000;

type QuotaWindow = { id: string; label?: string; resetsAt?: string; percentRemaining?: number; pace?: { status?: string } };
type Scope = {
  scope: string;
  effectivePercentRemaining?: number;
  runway?: { status?: string; projectedExhaustedAt?: string };
};
type Provider = { provider: string; windows?: QuotaWindow[]; quotaSemantics?: { effectiveAvailability?: Scope[] } };
type Report = { providers: Provider[] };

export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude', codex: 'Codex', cursor: 'Cursor', copilot: 'GitHub Copilot', grok: 'Grok', kimi: 'Kimi',
  zai: 'Z.AI', agy: 'Antigravity', alibaba: 'Alibaba', 'opencode-go': 'OpenCode Go', commandcode: 'Command Code',
  minimax: 'MiniMax', mimo: 'MiMo', deepseek: 'DeepSeek', openrouter: 'OpenRouter', elevenlabs: 'ElevenLabs',
};

/** undefined: not asked yet. null: the Hub could not say. Otherwise the providers worth a meter. */
type Meters = { provider: string; windows: Meter[]; runsOutAt?: number }[] | null | undefined;
type Meter = { id: string; label: string; percent: number; resetsAt?: number; pace?: 'ahead' | 'behind' };

// ponytail: one module-level store, so two screens never double the fetch; a state library
// would be the upgrade if a third consumer appears.
let meters: Meters;
let fetchedAt = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<(m: Meters) => void>();

/** Provider windows when it lists them; else its one effective figure, so no provider drops out. */
function toMeters(report: Report): Meters {
  const out = report.providers.flatMap((p) => {
    let windows: Meter[] = (p.windows ?? []).flatMap((w) =>
      typeof w.percentRemaining === 'number'
        ? [{
            id: w.id,
            label: w.id === 'five_hour' ? '5 h' : w.id === 'seven_day' ? 'Week' : (w.label ?? w.id),
            percent: Math.round(w.percentRemaining),
            resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : undefined,
            pace: w.pace?.status === 'ahead' || w.pace?.status === 'behind' ? w.pace.status : undefined,
          }]
        : [],
    );
    if (!windows.length) {
      const scopes = p.quotaSemantics?.effectiveAvailability ?? [];
      const s = scopes.find((x) => x.scope === 'all_models') ?? scopes[0];
      if (typeof s?.effectivePercentRemaining === 'number')
        windows = [{ id: s.scope, label: 'Overall', percent: Math.round(s.effectivePercentRemaining) }];
    }
    const scopes = p.quotaSemantics?.effectiveAvailability ?? [];
    const runway = scopes.find((x) => x.scope === 'all_models')?.runway;
    const runsOutAt = runway?.status === 'projected_exhaustion' && runway.projectedExhaustedAt ? Date.parse(runway.projectedExhaustedAt) : NaN;
    return windows.length ? [{ provider: p.provider, windows, runsOutAt: Number.isNaN(runsOutAt) ? undefined : runsOutAt }] : [];
  });
  return out.length ? out : null;
}

function load() {
  fetchedAt = Date.now();
  void api<Report>('/api/settings/quota', undefined, 'GET').then(
    (r) => publish(toMeters(r)),
    // Unavailable stays quiet: keep what we had, say "not available" only if we never had any.
    () => publish(meters ?? null),
  );
}

function publish(m: Meters) {
  meters = m;
  listeners.forEach((l) => l(m));
}

export function useMeters(): Meters {
  const [value, setValue] = useState(meters);
  useEffect(() => {
    listeners.add(setValue);
    setValue(meters);
    if (Date.now() - fetchedAt >= POLL) load();
    timer ??= setInterval(load, POLL);
    return () => {
      listeners.delete(setValue);
      if (!listeners.size) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return value;
}

// ---- display ----
const AMBER = 30;
const RED = 15;
const tone = (p: number) => (p < RED ? 'danger' : p < AMBER ? 'warn' : 'accent');
const BAR = { danger: 'bg-danger', warn: 'bg-warn', accent: 'bg-accent' } as const;
const NUM = { danger: 'text-danger', warn: 'text-warn', accent: 'text-fg' } as const;

/** `in 25 min`, `in 2 h`, `in 3 d`. */
export function resetIn(at: number, now = Date.now()): string {
  const min = Math.round((at - now) / 60_000);
  if (min < 1) return 'resetting';
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
}

function Bar({ percent, className = 'h-1.5' }: { percent: number; className?: string }) {
  return (
    <span aria-hidden className={`block min-w-0 flex-1 overflow-hidden rounded-full bg-border ${className}`}>
      <span className={`block h-full rounded-full ${BAR[tone(percent)]}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </span>
  );
}

function MeterRow({ m, name, runsOut }: { m: Meter; name: string; runsOut?: number }) {
  const t = tone(m.percent);
  const detail = [
    m.resetsAt ? `resets ${resetIn(m.resetsAt)}` : '',
    // quota-axi: 'ahead' is spending faster than the window refills, the bad case.
    m.pace ? (m.pace === 'ahead' ? 'using quota fast' : 'on pace') : '',
  ].filter(Boolean);
  return (
    <div className="flex min-h-12 flex-col justify-center gap-1 px-4 py-2" role="group" aria-label={`${name} ${m.label}`}>
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-body">
          {name} <span className="text-muted">{m.label}</span>
        </span>
        <span className={`shrink-0 font-mono text-caption ${NUM[t]}`}>
          {m.percent}% left{t === 'danger' ? ' · low' : t === 'warn' ? ' · running low' : ''}
        </span>
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.percent} aria-label={`${name} ${m.label} left`} className="flex">
        <Bar percent={m.percent} />
      </div>
      {(detail.length > 0 || runsOut) && (
        <span className="text-caption text-muted">
          {detail.join(' · ')}
          {runsOut && <span className="text-warn">{detail.length ? ' · ' : ''}runs out {resetIn(runsOut)}</span>}
        </span>
      )}
    </div>
  );
}

/** Every provider and window as a meter. Settings › About. */
export function UsageMeters() {
  const list = useMeters();
  return (
    <div aria-live="polite">
      {list === undefined ? (
        <p className="min-h-12 px-4 py-3 text-caption text-muted">Checking usage…</p>
      ) : list === null ? (
        <p className="min-h-12 px-4 py-3 text-caption text-muted">Usage is not available.</p>
      ) : (
        list.map((p, i) => (
          <div key={p.provider}>
            {i > 0 && <div className="ml-4 border-t border-border/60" />}
            {p.windows.map((m, j) => (
              <MeterRow key={m.id} m={m} name={PROVIDER_LABELS[p.provider] ?? p.provider} runsOut={j === 0 ? p.runsOutAt : undefined} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/**
 * The sidebar footer strip: one line per provider whose lowest window is under 30 % or whose runway projects exhaustion, and
 * nothing at all otherwise or while unavailable. It opens Settings › About.
 */
export function UsageStrip() {
  const list = useMeters();
  const low = (list ?? []).flatMap((p) => {
    const worst = p.windows.reduce((a, b) => (b.percent < a.percent ? b : a));
    return worst.percent < AMBER || p.runsOutAt
      ? [{ name: PROVIDER_LABELS[p.provider] ?? p.provider, worst, runsOutAt: p.runsOutAt }]
      : [];
  });
  if (!low.length) return null;
  return (
    <a
      href="#/settings/about"
      aria-label="Usage is running low. Open Settings."
      className="flex shrink-0 flex-col gap-1.5 border-t border-border px-4 py-2 hover:bg-elevated/60"
    >
      {low.map(({ name, worst, runsOutAt }) => (
        <span key={name} title={runsOutAt ? `Runs out ${resetIn(runsOutAt)}` : undefined} className="flex items-center gap-2 text-caption">
          <span className="w-16 shrink-0 truncate text-muted">{name}</span>
          <Bar percent={worst.percent} className="h-1" />
          <span className={`shrink-0 font-mono ${NUM[tone(worst.percent)]}`}>{worst.percent}%</span>
          {runsOutAt && <span className="shrink-0 text-warn">out {resetIn(runsOutAt).replace('in ', '')}</span>}
        </span>
      ))}
    </a>
  );
}
