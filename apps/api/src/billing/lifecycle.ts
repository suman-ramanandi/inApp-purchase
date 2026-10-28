/**
 * Subscription lifecycle rules.
 *
 * Pure and deterministic: no I/O and no clock reads. Callers pass the persisted state and a
 * snapshot of the subscription that a store provider has already verified (signature checked,
 * fetched from the store's API). Prices and dates supplied by a client app must never reach this
 * module unverified.
 *
 * See docs/subscription-lifecycle.md for the transition table and its rationale.
 */

export const SUBSCRIPTION_STATUSES = [
  'active',
  'grace_period',
  'billing_retry',
  'paused',
  'expired',
  'revoked',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type RevocationReason = 'refund' | 'revoked';

export interface Revocation {
  at: Date;
  reason: RevocationReason;
}

interface LifecycleFields {
  status: SubscriptionStatus;
  autoRenew: boolean;
  periodStart: Date;
  /** End of the current paid period. */
  expiresAt: Date;
  /** Set exactly when status is `grace_period`. */
  graceExpiresAt: Date | null;
  /** Set exactly when status is `revoked`. */
  revocation: Revocation | null;
}

/** Subscription state reported by a store after the provider has verified it. */
export interface VerifiedSnapshot extends LifecycleFields {
  /** Store-signed time at which this state was produced. Orders snapshots; never the local clock. */
  observedAt: Date;
}

/** Lifecycle fields of a persisted subscription. */
export interface SubscriptionState extends LifecycleFields {
  lastObservedAt: Date;
}

export const TRANSITION_CAUSES = [
  'created',
  'renewed',
  'billing_failed',
  'grace_period_expired',
  'recovered',
  'paused',
  'resumed',
  'expired',
  'resubscribed',
  'refunded',
  'revoked',
  'refund_reversed',
  'auto_renew_disabled',
  'auto_renew_enabled',
  'details_changed',
] as const;
export type TransitionCause = (typeof TRANSITION_CAUSES)[number];

export type RejectionReason = 'invalid_snapshot' | 'transition_not_allowed' | 'period_regressed';

export type ReconcileResult =
  | { kind: 'created'; next: SubscriptionState; causes: ['created'] }
  | { kind: 'updated'; next: SubscriptionState; causes: TransitionCause[] }
  /** Nothing changed except `lastObservedAt`. Safe to persist or to skip. */
  | { kind: 'unchanged'; next: SubscriptionState }
  /** The snapshot is older than the persisted state and must be ignored. */
  | { kind: 'stale' }
  /** The snapshot contradicts the rules; it must not be applied and needs investigation. */
  | { kind: 'rejected'; reason: RejectionReason; detail: string };

/**
 * Allowed status changes and the cause each one records. Changes into `revoked` are handled
 * separately because their cause depends on the revocation reason. A pair that is absent here is
 * rejected.
 */
const STATUS_TRANSITIONS: Record<
  SubscriptionStatus,
  Partial<Record<SubscriptionStatus, TransitionCause>>
> = {
  active: {
    grace_period: 'billing_failed',
    billing_retry: 'billing_failed',
    paused: 'paused',
    expired: 'expired',
  },
  grace_period: { active: 'recovered', billing_retry: 'grace_period_expired', expired: 'expired' },
  billing_retry: { active: 'recovered', expired: 'expired' },
  // Google Play: a failed payment when resuming goes straight to account hold, never to grace.
  paused: { active: 'resumed', billing_retry: 'billing_failed', expired: 'expired' },
  expired: { active: 'resubscribed' },
  // Only a refund can be reversed; see transitionCause().
  revoked: { active: 'refund_reversed', expired: 'refund_reversed' },
};

/** Causes that already imply a new paid period, so a period advance needs no extra `renewed`. */
const PERIOD_STARTING_CAUSES: ReadonlySet<TransitionCause> = new Set([
  'recovered',
  'resumed',
  'resubscribed',
  'refund_reversed',
]);

export function reconcile(
  current: SubscriptionState | null,
  snapshot: VerifiedSnapshot,
): ReconcileResult {
  const problem = validateSnapshot(snapshot);
  if (problem !== null) {
    return { kind: 'rejected', reason: 'invalid_snapshot', detail: problem };
  }

  const next: SubscriptionState = {
    status: snapshot.status,
    autoRenew: snapshot.autoRenew,
    periodStart: snapshot.periodStart,
    expiresAt: snapshot.expiresAt,
    graceExpiresAt: snapshot.graceExpiresAt,
    revocation: snapshot.revocation,
    lastObservedAt: snapshot.observedAt,
  };

  if (current === null) {
    return { kind: 'created', next, causes: ['created'] };
  }

  if (snapshot.observedAt.getTime() < current.lastObservedAt.getTime()) {
    return { kind: 'stale' };
  }

  // An earlier period end is contradictory only while the snapshot still grants access. A snapshot
  // that grants none (a refund, revocation or expiry) is accepted even if its period end moved
  // back; rejecting it would leave the persisted state granting access.
  if (
    accessEndsAt(snapshot) !== null &&
    snapshot.expiresAt.getTime() < current.expiresAt.getTime()
  ) {
    return {
      kind: 'rejected',
      reason: 'period_regressed',
      detail: `expiresAt moved back from ${current.expiresAt.toISOString()} to ${snapshot.expiresAt.toISOString()}`,
    };
  }

  const periodAdvanced = snapshot.expiresAt.getTime() > current.expiresAt.getTime();
  const causes: TransitionCause[] = [];

  if (snapshot.status !== current.status) {
    const cause = transitionCause(current, snapshot);
    if (cause === null) {
      return {
        kind: 'rejected',
        reason: 'transition_not_allowed',
        detail: `${current.status} -> ${snapshot.status}`,
      };
    }
    // A missed renewal followed by another change (for example renewed, then failed to renew
    // again) arrives as one snapshot; record both.
    if (periodAdvanced && !PERIOD_STARTING_CAUSES.has(cause)) {
      causes.push('renewed');
    }
    causes.push(cause);
  } else {
    if (periodAdvanced) {
      causes.push('renewed');
    }
    if (snapshot.autoRenew !== current.autoRenew) {
      causes.push(snapshot.autoRenew ? 'auto_renew_enabled' : 'auto_renew_disabled');
    }
    if (causes.length === 0 && !sameLifecycleFields(current, next)) {
      causes.push('details_changed');
    }
  }

  return causes.length === 0 ? { kind: 'unchanged', next } : { kind: 'updated', next, causes };
}

/** When access granted by this subscription ends, or null if it grants no access in this state. */
export function accessEndsAt(state: LifecycleFields): Date | null {
  switch (state.status) {
    case 'active':
      return state.expiresAt;
    case 'grace_period':
      return state.graceExpiresAt;
    case 'billing_retry':
    case 'paused':
    case 'expired':
    case 'revoked':
      return null;
  }
}

/**
 * Whether the subscription grants access at `now`. Time-based on purpose: access lapses at the end
 * of the period or grace period even if the store's expiry notification never arrives.
 */
export function isEntitled(state: LifecycleFields, now: Date): boolean {
  const endsAt = accessEndsAt(state);
  return endsAt !== null && now.getTime() < endsAt.getTime();
}

function transitionCause(
  current: SubscriptionState,
  snapshot: VerifiedSnapshot,
): TransitionCause | null {
  if (snapshot.revocation !== null) {
    return snapshot.revocation.reason === 'refund' ? 'refunded' : 'revoked';
  }
  if (current.status === 'revoked' && current.revocation?.reason !== 'refund') {
    return null;
  }
  return STATUS_TRANSITIONS[current.status][snapshot.status] ?? null;
}

function validateSnapshot(s: VerifiedSnapshot): string | null {
  const dates = [s.observedAt, s.periodStart, s.expiresAt, s.graceExpiresAt, s.revocation?.at];
  if (dates.some((d) => d !== null && d !== undefined && Number.isNaN(d.getTime()))) {
    return 'snapshot contains an invalid date';
  }
  if (s.expiresAt.getTime() <= s.periodStart.getTime()) {
    return 'expiresAt must be after periodStart';
  }
  if ((s.status === 'grace_period') !== (s.graceExpiresAt !== null)) {
    return 'graceExpiresAt must be set exactly when status is grace_period';
  }
  if (s.graceExpiresAt !== null && s.graceExpiresAt.getTime() <= s.expiresAt.getTime()) {
    return 'graceExpiresAt must be after expiresAt';
  }
  if ((s.status === 'revoked') !== (s.revocation !== null)) {
    return 'revocation must be set exactly when status is revoked';
  }
  return null;
}

function sameLifecycleFields(a: LifecycleFields, b: LifecycleFields): boolean {
  return (
    a.status === b.status &&
    a.autoRenew === b.autoRenew &&
    a.periodStart.getTime() === b.periodStart.getTime() &&
    a.expiresAt.getTime() === b.expiresAt.getTime() &&
    a.graceExpiresAt?.getTime() === b.graceExpiresAt?.getTime() &&
    a.revocation?.reason === b.revocation?.reason &&
    a.revocation?.at.getTime() === b.revocation?.at.getTime()
  );
}
