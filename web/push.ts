/**
 * Web Push and the app badge (phase 3).
 *
 * The intent ("the user asked for notifications") lives in `localStorage` under
 * `tautan.push`; the subscription itself lives on the Hub in `state.json`. The Hub has no
 * `PUT /api/settings`, so nothing here rides on the settings endpoint.
 */

const INTENT = 'tautan.push';
import { store } from './store.tsx';

export type PushResult = { ok: true } | { ok: false; reason: 'denied' | 'unsupported' | 'error'; message: string };

export const MESSAGES = {
  denied:
    'Notifications are blocked for this site. Allow them in your browser settings, then turn this on again.',
  unsupported: 'This browser does not support push notifications.',
};

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const pushIntent = () => store.get(INTENT) === '1';

/** True only when the user asked for push and the browser still agrees. */
export const pushOn = () => pushIntent() && pushSupported() && Notification.permission === 'granted';

/** The active registration, registering `/sw.js` first if the page never did. */
export async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing?.active) return existing;
  if (!existing) await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/**
 * Registers the worker and re-subscribes a user who already said yes. Dev keeps Vite's
 * HMR untouched unless the URL carries `?sw`.
 */
export function startPush(): void {
  if (!pushSupported()) return;
  if (!import.meta.env.PROD && !new URLSearchParams(location.search).has('sw')) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    // The worker asks for the route when it cannot navigate the window itself (iOS).
    const data = event.data as { type?: string; url?: string } | null;
    if (data?.type === 'navigate' && data.url) location.hash = new URL(data.url, location.href).hash || '#/';
  });

  void navigator.serviceWorker
    .register('/sw.js')
    .then(async (reg) => {
      // A worker update drops the subscription, so take it again in silence.
      if (!pushOn() || (await reg.pushManager.getSubscription())) return;
      await subscribe(await getRegistration());
    })
    .catch(() => {});
}

export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported', message: MESSAGES.unsupported };
  try {
    if ((await Notification.requestPermission()) !== 'granted') {
      return { ok: false, reason: 'denied', message: MESSAGES.denied };
    }
    await subscribe(await getRegistration());
    store.set(INTENT, '1');
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'error', message: `Could not turn on notifications: ${detail}` };
  }
}

export async function disablePush(): Promise<void> {
  store.set(INTENT, '0');
  if (!pushSupported()) return;
  const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** Unseen `blocked` + `done`, on the installed app's icon. Chrome and Safari only. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => {});
  } catch { /* older Safari throws instead of missing the method */ }
}

async function subscribe(reg: ServiceWorkerRegistration): Promise<void> {
  const { publicKey } = (await (await fetch('/api/push/vapid')).json()) as { publicKey: string };
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) throw new Error(`the Hub answered ${res.status}`);
}

/** base64url VAPID key → the bytes `pushManager.subscribe` wants. */
function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(key.length + ((4 - (key.length % 4)) % 4), '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
