import https from 'node:https';
import { createHmac } from 'node:crypto';
import { Fault } from '@ptm/contracts';
import { resolveDestination } from './probe.js';
import type { Store } from './db.js';
import type { Vault } from './security.js';

export async function validateWebhook(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443')
  )
    throw new Fault(
      'WEBHOOK_DESTINATION',
      'Webhook destination must use HTTPS on port 443 without URL credentials or fragments',
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pinned = await Promise.race([
      resolveDestination(url.hostname, []),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Fault('DNS_TIMEOUT', 'Webhook DNS resolution timed out')), 5000);
      }),
    ]);
    return { url, pinned };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function deliverOutbox(store: Store, vault: Vault, demo: boolean) {
  if (demo) return;
  const configured = store.get<{ url: string; encryptedSecret: string } | null>('webhook', null);
  if (!configured) return;
  const next = store.one(
    'SELECT * FROM notification_outbox WHERE status=? AND nextAttemptAt<=? ORDER BY nextAttemptAt LIMIT 1',
    'pending',
    Date.now(),
  );
  if (!next) return;
  const body = String(next.payload);
  const timestamp = Date.now().toString();
  try {
    if (body.length > 8192 || next.destination !== configured.url)
      throw new Fault(
        'NOTIFICATION_CONFIGURATION',
        'Notification destination changed or payload exceeds the limit',
      );
    const { url, pinned: pin } = await validateWebhook(configured.url);
    const secret = vault.decrypt<string>(configured.encryptedSecret, 'webhook');
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: pin.address,
          family: pin.family,
          servername: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: 'POST',
          agent: false,
          headers: {
            Host: url.hostname,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-ptm-timestamp': timestamp,
            'x-ptm-signature': `sha256=${signature}`,
            'x-ptm-event-id': String(next.id),
          },
        },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Fault('WEBHOOK_HTTP_ERROR', 'Webhook delivery failed'));
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('timeout')), 5000);
      req.once('close', () => clearTimeout(timer));
      req.once('error', reject);
      req.end(body);
    });
    store.run('UPDATE notification_outbox SET status=? WHERE id=?', 'delivered', next.id);
  } catch {
    const attempts = Number(next.attempts) + 1;
    store.run(
      'UPDATE notification_outbox SET attempts=?,nextAttemptAt=?,status=? WHERE id=?',
      attempts,
      Date.now() + Math.min(3600000, 5000 * 2 ** attempts),
      attempts >= 8 ? 'failed' : 'pending',
      next.id,
    );
  }
}
