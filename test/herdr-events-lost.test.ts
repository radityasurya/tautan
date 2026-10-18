import { createServer, type Server } from 'node:net';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { HerdrMux } from '../server/herdr.ts';

// herdr 0.9.2+ ends a subscription that fell behind with an `events_lost` error. That is not a
// refusal of the subscription set: the Hub must subscribe again with the same events (it used
// to drop an optional one, `layout.updated` first) and re-read everything once.
const socketPath = join(tmpdir(), `tautan-events-lost-${process.pid}.sock`);
const subscribes: string[][] = [];
let server: Server;

beforeAll(async () => {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return;
  server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (request.method !== 'events.subscribe') return void socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      subscribes.push(request.params.subscriptions.map((s: { type: string }) => s.type));
      socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
      // The first subscription falls behind at once.
      if (subscribes.length === 1) setTimeout(() => socket.end(`${JSON.stringify({ id: request.id, error: { code: 'events_lost', message: 'events_lost: subscriber fell behind' } })}\n`), 50);
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
});
afterAll(() => { server?.close(); try { unlinkSync(socketPath); } catch {} });

const until = async (ok: () => boolean) => { while (!ok()) await new Promise(resolve => setTimeout(resolve, 25)); };

test.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('events_lost resubscribes with every event and resyncs', async () => {
  const mux = new HerdrMux('test', socketPath);
  const calls: (string[] | 'all')[] = [];
  mux.onChange(ids => calls.push(ids));
  await until(() => subscribes.length >= 2);
  expect(subscribes[0]).toContain('layout.updated');
  expect(subscribes[1]).toEqual(subscribes[0]);
  await until(() => calls.includes('all'));
  mux.close();
}, 10_000);
