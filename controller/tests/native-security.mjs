import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault, equalSecret, hashToken, randomToken } from '../apps/api/src/security.ts';

test('stored credentials are authenticated ciphertext with unique nonces', () => {
  const vault = new Vault(Buffer.alloc(32, 7));
  const first = vault.encrypt({ token: 'provider-sensitive-value' }, 'provider-one');
  const second = vault.encrypt({ token: 'provider-sensitive-value' }, 'provider-one');
  assert.notEqual(first, second);
  assert.ok(!first.includes('provider-sensitive-value'));
  assert.deepEqual(vault.decrypt(first, 'provider-one'), { token: 'provider-sensitive-value' });
});
test('wrong master key and wrong authenticated context fail closed', () => {
  const vault = new Vault(Buffer.alloc(32, 7));
  const value = vault.encrypt({ token: 'secret' }, 'provider-one');
  assert.throws(() => new Vault(Buffer.alloc(32, 8)).decrypt(value, 'provider-one'), /decrypt/);
  assert.throws(() => vault.decrypt(value, 'provider-two'), /decrypt/);
  assert.throws(() => new Vault(Buffer.alloc(4)), /32 bytes/);
});
test('tampered authentication tag cannot return plaintext', () => {
  const vault = new Vault(Buffer.alloc(32, 7));
  const parts = vault.encrypt({ token: 'secret' }, 'provider-one').split('.');
  parts[2] = Buffer.alloc(16, 0).toString('base64');
  assert.throws(() => vault.decrypt(parts.join('.'), 'provider-one'), /decrypt/);
});
test('session tokens are random and equality checks do not accept prefixes', () => {
  const first = randomToken();
  const second = randomToken();
  assert.notEqual(first, second);
  assert.equal(first.length, 43);
  assert.equal(hashToken(first).length, 64);
  assert.ok(!hashToken(first).includes(first));
  assert.ok(equalSecret(first, first));
  assert.ok(!equalSecret(first, second));
  assert.ok(!equalSecret(first, first.slice(0, -1)));
});
