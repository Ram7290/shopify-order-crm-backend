export const IN_FLIGHT_WINDOW_MS = 30_000;

export type CreateRequestStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type CreateAction = 'return-existing' | 'in-flight' | 'reconcile' | 'create';

export function decideCreateAction(
  existing: { status: CreateRequestStatus; updatedAt: Date } | null,
  now: Date,
): CreateAction {
  if (!existing) return 'create';
  if (existing.status === 'SUCCEEDED') return 'return-existing';
  if (existing.status === 'FAILED') return 'create';
  return now.getTime() - existing.updatedAt.getTime() < IN_FLIGHT_WINDOW_MS ? 'in-flight' : 'reconcile';
}

export function requestTag(requestKey: string): string {
  return `crm-request:${requestKey}`;
}
