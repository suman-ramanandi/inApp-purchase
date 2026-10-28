import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_STATUSES,
  accessEndsAt,
  isEntitled,
  reconcile,
  type SubscriptionState,
  type SubscriptionStatus,
  type TransitionCause,
  type VerifiedSnapshot,
} from './lifecycle.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (days: number) => new Date(T0 + days * DAY);

/** Valid lifecycle fields for a status: 30-day period, 6-day grace, refund-type revocation. */
function fieldsFor(status: SubscriptionStatus) {
  return {
    status,
    autoRenew: true,
    periodStart: at(0),
    expiresAt: at(30),
    graceExpiresAt: status === 'grace_period' ? at(36) : null,
    revocation: status === 'revoked' ? { at: at(10), reason: 'refund' as const } : null,
  };
}

function state(status: SubscriptionStatus, overrides: Partial<SubscriptionState> = {}) {
  return { ...fieldsFor(status), lastObservedAt: at(1), ...overrides };
}

function snapshot(status: SubscriptionStatus, overrides: Partial<VerifiedSnapshot> = {}) {
  return { ...fieldsFor(status), observedAt: at(2), ...overrides };
}

/** Expected outcome of every status pair with otherwise unchanged fields. */
const EXPECTED: Record<SubscriptionStatus, Record<SubscriptionStatus, TransitionCause | null>> = {
  active: {
    active: null,
    grace_period: 'billing_failed',
    billing_retry: 'billing_failed',
    paused: 'paused',
    expired: 'expired',
    revoked: 'refunded',
  },
  grace_period: {
    active: 'recovered',
    grace_period: null,
    billing_retry: 'grace_period_expired',
    paused: null,
    expired: 'expired',
    revoked: 'refunded',
  },
  billing_retry: {
    active: 'recovered',
    grace_period: null,
    billing_retry: null,
    paused: null,
    expired: 'expired',
    revoked: 'refunded',
  },
  paused: {
    active: 'resumed',
    grace_period: null,
    billing_retry: null,
    paused: null,
    expired: 'expired',
    revoked: 'refunded',
  },
  expired: {
    active: 'resubscribed',
    grace_period: null,
    billing_retry: null,
    paused: null,
    expired: null,
    revoked: 'refunded',
  },
  revoked: {
    active: 'refund_reversed',
    grace_period: null,
    billing_retry: null,
    paused: null,
    expired: 'refund_reversed',
    revoked: null,
  },
};

const pairs = SUBSCRIPTION_STATUSES.flatMap((from) =>
  SUBSCRIPTION_STATUSES.map((to) => ({ from, to, cause: EXPECTED[from][to] })),
);

describe('reconcile: status transition matrix', () => {
  it.each(pairs.filter((p) => p.from === p.to))('$from -> $to is unchanged', ({ from, to }) => {
    expect(reconcile(state(from), snapshot(to)).kind).toBe('unchanged');
  });

  it.each(pairs.filter((p) => p.from !== p.to && p.cause !== null))(
    '$from -> $to is allowed and records $cause',
    ({ from, to, cause }) => {
      const result = reconcile(state(from), snapshot(to));
      expect(result).toMatchObject({ kind: 'updated', causes: [cause] });
    },
  );

  it.each(pairs.filter((p) => p.from !== p.to && p.cause === null))(
    '$from -> $to is rejected',
    ({ from, to }) => {
      expect(reconcile(state(from), snapshot(to))).toEqual({
        kind: 'rejected',
        reason: 'transition_not_allowed',
        detail: `${from} -> ${to}`,
      });
    },
  );
});

describe('reconcile: lifecycle scenarios', () => {
  it('creates state from the first verified snapshot', () => {
    const snap = snapshot('active');
    expect(reconcile(null, snap)).toEqual({
      kind: 'created',
      causes: ['created'],
      next: { ...fieldsFor('active'), lastObservedAt: snap.observedAt },
    });
  });

  it('accepts an already-expired subscription on first sight', () => {
    expect(reconcile(null, snapshot('expired')).kind).toBe('created');
  });

  it('renews: a later period while active records renewed', () => {
    const result = reconcile(
      state('active'),
      snapshot('active', { periodStart: at(30), expiresAt: at(60), observedAt: at(30) }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['renewed'] });
    if (result.kind === 'updated') {
      expect(result.next.expiresAt).toEqual(at(60));
    }
  });

  it('enters the grace period when renewal fails and the store grants grace', () => {
    const result = reconcile(state('active'), snapshot('grace_period', { observedAt: at(30) }));
    expect(result).toMatchObject({ kind: 'updated', causes: ['billing_failed'] });
  });

  it('moves to billing retry when the grace period ends without payment', () => {
    const result = reconcile(
      state('grace_period'),
      snapshot('billing_retry', { observedAt: at(36) }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['grace_period_expired'] });
  });

  it.each(['grace_period', 'billing_retry'] as const)(
    'recovers from %s into a new period without a separate renewed cause',
    (from) => {
      const result = reconcile(
        state(from),
        snapshot('active', { periodStart: at(32), expiresAt: at(62), observedAt: at(32) }),
      );
      expect(result).toMatchObject({ kind: 'updated', causes: ['recovered'] });
    },
  );

  it('records a missed renewal followed by a billing failure as two causes', () => {
    const result = reconcile(
      state('active'),
      snapshot('grace_period', {
        periodStart: at(30),
        expiresAt: at(60),
        graceExpiresAt: at(66),
        observedAt: at(60),
      }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['renewed', 'billing_failed'] });
  });

  it('cancels: turning auto-renew off keeps access until the period ends', () => {
    const result = reconcile(state('active'), snapshot('active', { autoRenew: false }));
    expect(result).toMatchObject({ kind: 'updated', causes: ['auto_renew_disabled'] });
    if (result.kind === 'updated') {
      expect(isEntitled(result.next, at(29))).toBe(true);
      expect(isEntitled(result.next, at(30))).toBe(false);
    }
  });

  it('records auto-renew being turned back on', () => {
    const result = reconcile(state('active', { autoRenew: false }), snapshot('active'));
    expect(result).toMatchObject({ kind: 'updated', causes: ['auto_renew_enabled'] });
  });

  it('expires a cancelled subscription and records only the status change', () => {
    const result = reconcile(
      state('active', { autoRenew: true }),
      snapshot('expired', { autoRenew: false, observedAt: at(30) }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['expired'] });
  });

  it('refunds: revokes access immediately, before the period ends', () => {
    const result = reconcile(
      state('active'),
      snapshot('revoked', { revocation: { at: at(5), reason: 'refund' }, observedAt: at(5) }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['refunded'] });
    if (result.kind === 'updated') {
      expect(isEntitled(result.next, at(6))).toBe(false);
    }
  });

  it('revokes for a non-refund reason', () => {
    const result = reconcile(
      state('active'),
      snapshot('revoked', { revocation: { at: at(5), reason: 'revoked' } }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['revoked'] });
  });

  it('records a refund of an already-expired subscription', () => {
    const result = reconcile(state('expired'), snapshot('revoked'));
    expect(result).toMatchObject({ kind: 'updated', causes: ['refunded'] });
  });

  it('reverses a refund back to active', () => {
    const result = reconcile(state('revoked'), snapshot('active'));
    expect(result).toMatchObject({ kind: 'updated', causes: ['refund_reversed'] });
  });

  it('rejects reversing a non-refund revocation', () => {
    const current = state('revoked', { revocation: { at: at(10), reason: 'revoked' } });
    expect(reconcile(current, snapshot('active'))).toMatchObject({
      kind: 'rejected',
      reason: 'transition_not_allowed',
    });
  });

  it('resubscribes an expired subscription into a new period', () => {
    const result = reconcile(
      state('expired'),
      snapshot('active', { periodStart: at(40), expiresAt: at(70), observedAt: at(40) }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['resubscribed'] });
  });

  it('pauses and resumes', () => {
    const paused = reconcile(state('active'), snapshot('paused', { observedAt: at(30) }));
    expect(paused).toMatchObject({ kind: 'updated', causes: ['paused'] });

    const resumed = reconcile(
      state('paused', { lastObservedAt: at(30) }),
      snapshot('active', { periodStart: at(45), expiresAt: at(75), observedAt: at(45) }),
    );
    expect(resumed).toMatchObject({ kind: 'updated', causes: ['resumed'] });
  });

  it('records other field changes within the same status as details_changed', () => {
    const result = reconcile(
      state('grace_period'),
      snapshot('grace_period', { graceExpiresAt: at(46) }),
    );
    expect(result).toMatchObject({ kind: 'updated', causes: ['details_changed'] });
  });
});

describe('reconcile: ordering and idempotency', () => {
  it('ignores a snapshot older than the persisted state', () => {
    const current = state('expired', { lastObservedAt: at(31) });
    expect(reconcile(current, snapshot('active', { observedAt: at(20) }))).toEqual({
      kind: 'stale',
    });
  });

  it('applies a snapshot observed at the same instant as the persisted state', () => {
    const current = state('active', { lastObservedAt: at(2) });
    expect(reconcile(current, snapshot('active', { autoRenew: false })).kind).toBe('updated');
  });

  it('is idempotent: re-applying the resulting state changes nothing', () => {
    const snap = snapshot('active', { periodStart: at(30), expiresAt: at(60), observedAt: at(30) });
    const first = reconcile(state('active'), snap);
    expect(first.kind).toBe('updated');
    if (first.kind !== 'updated') return;

    const second = reconcile(first.next, snap);
    expect(second).toEqual({ kind: 'unchanged', next: first.next });
  });

  it('advances lastObservedAt when nothing else changed', () => {
    const result = reconcile(state('active'), snapshot('active', { observedAt: at(9) }));
    expect(result).toMatchObject({ kind: 'unchanged', next: { lastObservedAt: at(9) } });
  });

  it('rejects a snapshot whose period ends earlier than the persisted one', () => {
    const result = reconcile(
      state('active', { expiresAt: at(60) }),
      snapshot('active', { expiresAt: at(30) }),
    );
    expect(result).toMatchObject({ kind: 'rejected', reason: 'period_regressed' });
  });

  it('does not mutate its inputs', () => {
    const current = Object.freeze(state('active'));
    const snap = Object.freeze(snapshot('grace_period'));
    expect(() => reconcile(current, snap)).not.toThrow();
    expect(current).toEqual(state('active'));
  });
});

describe('reconcile: invalid snapshots', () => {
  const cases: [string, VerifiedSnapshot, string][] = [
    [
      'period ends before it starts',
      snapshot('active', { expiresAt: at(0) }),
      'expiresAt must be after periodStart',
    ],
    [
      'grace period without an end',
      snapshot('grace_period', { graceExpiresAt: null }),
      'graceExpiresAt must be set exactly when status is grace_period',
    ],
    [
      'grace end outside the grace period',
      snapshot('active', { graceExpiresAt: at(36) }),
      'graceExpiresAt must be set exactly when status is grace_period',
    ],
    [
      'grace ending before the period does',
      snapshot('grace_period', { graceExpiresAt: at(30) }),
      'graceExpiresAt must be after expiresAt',
    ],
    [
      'revoked without a revocation',
      snapshot('revoked', { revocation: null }),
      'revocation must be set exactly when status is revoked',
    ],
    [
      'revocation on an active subscription',
      snapshot('active', { revocation: { at: at(3), reason: 'refund' } }),
      'revocation must be set exactly when status is revoked',
    ],
    [
      'an invalid date',
      snapshot('active', { observedAt: new Date('not a date') }),
      'snapshot contains an invalid date',
    ],
  ];

  it.each(cases)('rejects %s', (_name, snap, detail) => {
    expect(reconcile(state('active'), snap)).toEqual({
      kind: 'rejected',
      reason: 'invalid_snapshot',
      detail,
    });
    expect(reconcile(null, snap)).toMatchObject({ kind: 'rejected', reason: 'invalid_snapshot' });
  });
});

describe('entitlement', () => {
  it('grants access while active, until the period ends (exclusive)', () => {
    const s = state('active');
    expect(isEntitled(s, new Date(at(30).getTime() - 1))).toBe(true);
    expect(isEntitled(s, at(30))).toBe(false);
  });

  it('keeps access during the grace period, until the grace period ends', () => {
    const s = state('grace_period');
    expect(accessEndsAt(s)).toEqual(at(36));
    expect(isEntitled(s, at(35))).toBe(true);
    expect(isEntitled(s, at(36))).toBe(false);
  });

  it.each(['billing_retry', 'paused', 'expired', 'revoked'] as const)(
    'grants no access while %s, even inside the paid period',
    (status) => {
      const s = state(status);
      expect(accessEndsAt(s)).toBeNull();
      expect(isEntitled(s, at(5))).toBe(false);
    },
  );
});
