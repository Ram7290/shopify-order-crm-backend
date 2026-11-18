import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.util.js';

const KEY = randomBytes(32).toString('hex');

describe('token encryption', () => {
  it('round-trips a token', () => {
    const encrypted = encrypt('shpat_secret_token', KEY);
    expect(encrypted).not.toContain('shpat_secret_token');
    expect(decrypt(encrypted, KEY)).toBe('shpat_secret_token');
  });

  it('produces different ciphertext each time', () => {
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('fails when the ciphertext is tampered with', () => {
    const [iv, tag, data] = encrypt('token', KEY).split('.');
    const tampered = [iv, tag, Buffer.from('ff', 'hex').toString('base64') + data.slice(2)].join('.');
    expect(() => decrypt(tampered, KEY)).toThrow();
  });
});
