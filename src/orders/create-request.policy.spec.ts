import { describe, expect, it } from 'vitest';
import { decideCreateAction, IN_FLIGHT_WINDOW_MS, requestTag } from './create-request.policy.js';

const now = new Date('2026-11-19T10:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('decideCreateAction', () => {
  it('creates when the key has never been seen', () => {
    expect(decideCreateAction(null, now)).toBe('create');
  });

  it('returns the existing order when the key already succeeded', () => {
    expect(decideCreateAction({ status: 'SUCCEEDED', updatedAt: ago(1000) }, now)).toBe('return-existing');
  });

  it('creates again after a definite failure', () => {
    expect(decideCreateAction({ status: 'FAILED', updatedAt: ago(1000) }, now)).toBe('create');
  });

  it('rejects a second request while the first is still in flight', () => {
    expect(decideCreateAction({ status: 'PENDING', updatedAt: ago(1000) }, now)).toBe('in-flight');
  });

  it('reconciles with Shopify once a pending attempt is stale', () => {
    expect(decideCreateAction({ status: 'PENDING', updatedAt: ago(IN_FLIGHT_WINDOW_MS + 1) }, now)).toBe('reconcile');
  });

  it('builds the tag used to find an order by request key', () => {
    expect(requestTag('abc-123')).toBe('crm-request:abc-123');
  });
});
