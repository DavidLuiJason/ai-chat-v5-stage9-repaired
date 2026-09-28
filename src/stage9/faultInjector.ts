/**
 * @file src/stage9/faultInjector.ts
 * Test-Only Fault Injection Harness for Stage 9 Crash-Window & Rollback Validation.
 *
 * Wraps PGlite queries and transactions to inject deterministic, reproducible
 * crash failures at critical transaction boundaries WITHOUT modifying production logic.
 */

import { PGlite } from '@electric-sql/pglite';

export type FaultInjectionPoint =
  | 'NONE'
  | 'AFTER_AUTH_VALIDATION'
  | 'AFTER_BUDGET_RESERVATION'
  | 'BEFORE_INTENT_PERSIST'
  | 'AFTER_INTENT_PERSIST'
  | 'BEFORE_AUTH_PERSIST'
  | 'AFTER_AUTH_PERSIST'
  | 'BEFORE_ATTEMPT_PERSIST'
  | 'AFTER_ATTEMPT_PERSIST'
  | 'BEFORE_DISPATCH_CLAIM_PERSIST'
  | 'AFTER_DISPATCH_CLAIM_PERSIST'
  | 'BEFORE_STATE_TRANSITION'
  | 'AFTER_STATE_TRANSITION'
  | 'DURING_EVIDENCE_INGESTION'
  | 'DURING_CANONICAL_DERIVATION'
  | 'DURING_RECOVERY'
  | 'DURING_ADJUDICATION'
  | 'BEFORE_COMMIT'
  | 'AFTER_COMMIT';

export class FaultInjectionError extends Error {
  constructor(public readonly point: FaultInjectionPoint, message?: string) {
    super(message ?? `[FAULT_INJECTION] Synthetic crash injected at boundary: ${point}`);
    this.name = 'FaultInjectionError';
  }
}

export class FaultInjectingDatabase {
  public activePoint: FaultInjectionPoint = 'NONE';
  public hasInjected = false;
  public injectionCount = 0;

  constructor(public readonly underlyingDb: PGlite) {}

  public setFaultPoint(point: FaultInjectionPoint): void {
    this.activePoint = point;
    this.hasInjected = false;
  }

  public clear(): void {
    this.activePoint = 'NONE';
    this.hasInjected = false;
  }

  private checkInjection(sql: string, timing: 'BEFORE' | 'AFTER'): void {
    if (this.activePoint === 'NONE' || this.hasInjected) return;

    const normalizedSql = sql.trim().toUpperCase();

    if (timing === 'BEFORE') {
      if (this.activePoint === 'BEFORE_COMMIT' && normalizedSql === 'COMMIT') {
        this.trigger();
      } else if (this.activePoint === 'BEFORE_INTENT_PERSIST' && normalizedSql.includes('INSERT INTO INTENTS')) {
        this.trigger();
      } else if (this.activePoint === 'BEFORE_AUTH_PERSIST' && normalizedSql.includes('INSERT INTO AUTHORIZATIONS')) {
        this.trigger();
      } else if (this.activePoint === 'BEFORE_ATTEMPT_PERSIST' && normalizedSql.includes('INSERT INTO ATTEMPTS')) {
        this.trigger();
      } else if (this.activePoint === 'BEFORE_DISPATCH_CLAIM_PERSIST' && normalizedSql.includes('INSERT INTO DISPATCH_CLAIMS')) {
        this.trigger();
      } else if (this.activePoint === 'BEFORE_STATE_TRANSITION' && normalizedSql.includes('UPDATE ATTEMPTS SET') && normalizedSql.includes('DISPATCHED_UNRESOLVED')) {
        this.trigger();
      } else if (this.activePoint === 'DURING_EVIDENCE_INGESTION' && normalizedSql.includes('INSERT INTO EVIDENCE_RECORDS')) {
        this.trigger();
      } else if (this.activePoint === 'DURING_ADJUDICATION' && normalizedSql.includes('INSERT INTO ADJUDICATION_RECORDS')) {
        this.trigger();
      }
    } else if (timing === 'AFTER') {
      if (this.activePoint === 'AFTER_AUTH_VALIDATION' && normalizedSql.includes('FROM PRINCIPALS') && normalizedSql.includes('FOR SHARE')) {
        this.trigger();
      } else if (this.activePoint === 'AFTER_BUDGET_RESERVATION' && normalizedSql.includes('UPDATE PRINCIPAL_BUDGETS')) {
        this.trigger();
      } else if (this.activePoint === 'AFTER_INTENT_PERSIST' && normalizedSql.includes('INSERT INTO INTENTS')) {
        this.trigger();
      } else if (this.activePoint === 'AFTER_AUTH_PERSIST' && normalizedSql.includes('INSERT INTO AUTHORIZATIONS')) {
        this.trigger();
      } else if (this.activePoint === 'AFTER_ATTEMPT_PERSIST' && normalizedSql.includes('INSERT INTO ATTEMPTS')) {
        this.trigger();
      } else if (this.activePoint === 'AFTER_DISPATCH_CLAIM_PERSIST' && normalizedSql.includes('INSERT INTO DISPATCH_CLAIMS')) {
        this.trigger();
      } else if (this.activePoint === 'AFTER_STATE_TRANSITION' && normalizedSql.includes('UPDATE ATTEMPTS SET') && normalizedSql.includes('DISPATCHED_UNRESOLVED')) {
        this.trigger();
      } else if (this.activePoint === 'DURING_CANONICAL_DERIVATION' && normalizedSql.includes('FROM EVIDENCE_RECORDS')) {
        this.trigger();
      } else if (this.activePoint === 'DURING_RECOVERY' && normalizedSql.includes('UPDATE ATTEMPTS') && normalizedSql.includes('RECOVERY_RELEASED')) {
        this.trigger();
      }
    }
  }

  private trigger(): void {
    this.hasInjected = true;
    this.injectionCount++;
    throw new FaultInjectionError(this.activePoint);
  }

  /**
   * Proxies query calls to the underlying PGlite database, applying injection checks.
   */
  public async query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> {
    this.checkInjection(sql, 'BEFORE');
    const result = await this.underlyingDb.query<T>(sql, params);
    this.checkInjection(sql, 'AFTER');
    return result as { rows: T[] };
  }

  public async exec(sql: string): Promise<any> {
    this.checkInjection(sql, 'BEFORE');
    const result = await this.underlyingDb.exec(sql);
    this.checkInjection(sql, 'AFTER');
    return result;
  }

  /**
   * Proxies database transactions.
   */
  public async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    return this.underlyingDb.transaction(async (rawTx) => {
      const wrappedTx = {
        query: async <R = any>(sql: string, params?: any[]): Promise<{ rows: R[] }> => {
          this.checkInjection(sql, 'BEFORE');
          const res = await rawTx.query<R>(sql, params);
          this.checkInjection(sql, 'AFTER');
          return res as { rows: R[] };
        },
        exec: async (sql: string): Promise<any> => {
          this.checkInjection(sql, 'BEFORE');
          const res = await rawTx.exec(sql);
          this.checkInjection(sql, 'AFTER');
          return res;
        },
        rollback: async (): Promise<void> => {
          return rawTx.rollback();
        },
      };

      const result = await callback(wrappedTx);
      this.checkInjection('COMMIT', 'BEFORE');
      return result;
    });
  }
}
