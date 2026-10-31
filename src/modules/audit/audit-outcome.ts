/**
 * How an audited action went (P3-02). Stored as text in `AuditLog.outcome`, not as a database enum, so that the contract shared with the
 * apps (generated from the enums of the schema) does not change until a screen reads the log.
 *
 *  - STARTED: the row was written and the action was let through; it has not come back (yet), or it never will (a crash);
 *  - SUCCEEDED: the action answered;
 *  - FAILED: the action ended with an error (the status is in the row).
 */
export const AuditOutcome = {
  STARTED: 'STARTED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

export const AUDIT_OUTCOMES: readonly AuditOutcome[] = Object.freeze(Object.values(AuditOutcome));

export function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === 'string' && (AUDIT_OUTCOMES as readonly string[]).includes(value);
}
