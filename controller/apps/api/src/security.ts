import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Fault } from '../../../packages/contracts/src/fault.ts';

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function equalSecret(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashToken(a)), Buffer.from(hashToken(b)));
}
export class Vault {
  constructor(private key: Buffer) {
    if (key.length !== 32)
      throw new Error('Master key must contain exactly 32 bytes (64 hexadecimal characters).');
  }
  static fromFile(path: string) {
    const text = readFileSync(path, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error('Invalid master key file');
    return new Vault(Buffer.from(text, 'hex'));
  }
  encrypt(value: unknown, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`ptm:v1:${context}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      1,
      nonce.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }
  decrypt<T>(blob: string, context: string): T {
    try {
      const [v, nonce, tag, body] = blob.split('.');
      if (v !== '1') throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
      cipher.setAAD(Buffer.from(`ptm:v1:${context}`));
      cipher.setAuthTag(Buffer.from(tag, 'base64'));
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString('utf8'),
      ) as T;
    } catch {
      throw new Fault(
        'DECRYPTION_FAILED',
        'Credentials could not be decrypted. Restore the matching master key.',
        503,
      );
    }
  }
}
