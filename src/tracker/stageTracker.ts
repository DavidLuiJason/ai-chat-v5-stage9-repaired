/**
 * @file src/tracker/stageTracker.ts
 * Authoritative Persistent Stage Status Tracker Engine.
 *
 * Implements:
 *  1. Authoritative persistence surviving application reloads (browser localStorage + Node JSON store).
 *  2. Database synchronization with project_stage_status table.
 *  3. Idempotent initialization: Stage 1–6 = COMPLETE, Stage 7–10 = NOT_STARTED.
 *  4. Single authoritative store of truth (never recreated only in React memory).
 */

import { PGlite } from '@electric-sql/pglite';
import { StageRecord, StageStatus, StageTrackerSummary } from './types.ts';

export const STAGE_TRACKER_STORAGE_KEY = 'orchestration_stage_tracker_v1';

export const CANONICAL_INITIAL_STAGES: ReadonlyArray<Omit<StageRecord, 'updated_at'>> = [
  {
    stage_number: 1,
    stage_name: 'Schema + Mock Capability Contract',
    status: 'COMPLETE',
    completed_at: '2026-09-27T10:00:00.000Z',
    notes: 'PostgreSQL schema constraints, UNIQUE(execution_identity), distinct correlation IDs, append-only triggers.',
  },
  {
    stage_number: 2,
    stage_name: 'Atomic Authorization Transaction',
    status: 'COMPLETE',
    completed_at: '2026-09-27T10:30:00.000Z',
    notes: 'Single-transaction atomic authorization, hard internal budget reservation, compare-and-commit fencing.',
  },
  {
    stage_number: 3,
    stage_name: 'Effect Ledger & Factual Gating',
    status: 'COMPLETE',
    completed_at: '2026-09-27T11:00:00.000Z',
    notes: 'Effect ledger (INTENT ≠ EFFECT ≠ ATTEMPT ≠ DISPATCH), repeat mode gating, dedup validity window.',
  },
  {
    stage_number: 4,
    stage_name: 'Atomic Dispatch Claim & Provider Boundary',
    status: 'COMPLETE',
    completed_at: '2026-09-27T11:30:00.000Z',
    notes: 'Atomic dispatch claim + attempt state transition (RESERVED → DISPATCHED_UNRESOLVED) under row serialization.',
  },
  {
    stage_number: 5,
    stage_name: 'Immutable Evidence Ingestion & Claim Correlation',
    status: 'COMPLETE',
    completed_at: '2026-09-27T12:00:00.000Z',
    notes: 'Append-only evidence_records, claim-specific semantics, contract correlation, contradiction preservation.',
  },
  {
    stage_number: 6,
    stage_name: 'Canonical Execution & Terminal-State Derivation',
    status: 'COMPLETE',
    completed_at: '2026-09-27T18:18:00.000Z',
    notes: 'Single authoritative derivation path, monotonic executed_fact, complete terminal closure, crash idempotency.',
  },
  {
    stage_number: 7,
    stage_name: 'Recovery, Heartbeat Deadlines & Reconciliation',
    status: 'COMPLETE',
    completed_at: '2026-09-27T18:52:00.000Z',
    notes: 'Restart-safe recovery, durable heartbeat deadlines, compare-and-commit fencing, control-plane reconciliation tasks.',
  },
  {
    stage_number: 8,
    stage_name: 'Adjudication & Contradiction Blocking',
    status: 'COMPLETE',
    completed_at: '2026-09-27T19:20:00.000Z',
    notes: 'Control-plane adjudication records, atomic contradiction blocking in authorization, zero evidence fabrication, monotonic executed_fact.',
  },
  {
    stage_number: 9,
    stage_name: 'Property Tests & Fault Injection',
    status: 'COMPLETE',
    completed_at: '2026-09-28T12:00:00.000Z',
    notes: 'Binding differential testing, real RECOVER/RECONCILE/DISPATCH/ADJUDICATE randomized actions, crash-window post-restart validation, exactly-one concurrency uniqueness, sequence minimizer connected, negative controls proving assertions catch violations.',
  },
  {
    stage_number: 10,
    stage_name: 'Final Hardening & Integration Audit',
    status: 'NOT_STARTED',
    completed_at: null,
    notes: 'Planned final stage. Preserved as NOT_STARTED.',
  },
];

// Fallback in-memory cache
let memoryCache: StageRecord[] | null = null;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readFromPersistentStorage(): StageRecord[] | null {
  if (isBrowser()) {
    try {
      const data = window.localStorage.getItem(STAGE_TRACKER_STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Could not read from window.localStorage:', e);
    }
    return memoryCache;
  }

  // Node environment file storage
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      // Dynamic require in node environment only
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('node:path');
      const filePath = path.resolve(process.cwd(), '.stage_tracker_store.json');
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Ignore in non-node or browser
    }
  }

  return memoryCache;
}

function writeToPersistentStorage(records: StageRecord[]): void {
  memoryCache = records;

  if (isBrowser()) {
    try {
      window.localStorage.setItem(STAGE_TRACKER_STORAGE_KEY, JSON.stringify(records));
    } catch (e) {
      console.warn('Could not write to window.localStorage:', e);
    }
    return;
  }

  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const path = require('node:path');
      const filePath = path.resolve(process.cwd(), '.stage_tracker_store.json');
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    } catch {
      // Ignore in browser
    }
  }
}

/**
 * Initializes the stage tracker idempotently.
 * Preserves any existing stored records; creates initial canonical records if missing.
 */
export function initializeStageTracker(forceReset = false): StageRecord[] {
  if (!forceReset) {
    const existing = readFromPersistentStorage();
    if (existing && existing.length >= 10) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const initialRecords: StageRecord[] = CANONICAL_INITIAL_STAGES.map((s) => ({
    ...s,
    updated_at: now,
  }));

  writeToPersistentStorage(initialRecords);
  return initialRecords;
}

/**
 * Loads all stage records from persistent storage.
 * Idempotently initializes them on first call.
 */
export function loadStageRecords(): StageRecord[] {
  const stored = readFromPersistentStorage();
  if (stored && stored.length >= 10) {
    // Return sorted by stage_number ASC
    return [...stored].sort((a, b) => a.stage_number - b.stage_number);
  }
  return initializeStageTracker();
}

/**
 * Updates a specific stage status and persists it.
 */
export function updateStageStatus(
  stageNumber: number,
  status: StageStatus,
  notes?: string
): StageRecord {
  const current = loadStageRecords();
  const idx = current.findIndex((s) => s.stage_number === stageNumber);

  if (idx === -1) {
    throw new Error(`Stage number ${stageNumber} not found.`);
  }

  const updated: StageRecord = {
    ...current[idx],
    status,
    notes: notes !== undefined ? notes : current[idx].notes,
    completed_at: status === 'COMPLETE' ? (current[idx].completed_at || new Date().toISOString()) : null,
    updated_at: new Date().toISOString(),
  };

  current[idx] = updated;
  writeToPersistentStorage(current);
  return updated;
}

/**
 * Returns a high-level summary of stage progress.
 */
export function getStageTrackerSummary(): StageTrackerSummary {
  const stages = loadStageRecords();
  const completedStages = stages.filter((s) => s.status === 'COMPLETE');
  const nextPending = stages.find((s) => s.status !== 'COMPLETE');

  return {
    stages,
    completedCount: completedStages.length,
    totalStages: stages.length,
    currentProgressStage: completedStages.length > 0 ? Math.max(...completedStages.map((s) => s.stage_number)) : 0,
    nextPendingStage: nextPending ? nextPending.stage_number : 9,
    nextPendingStageName: nextPending ? nextPending.stage_name : 'Property Tests & Fault Injection',
    isStorageSynchronized: true,
    lastLoadedAt: new Date().toISOString(),
  };
}

/**
 * Seeds and synchronizes the project_stage_status table in the PostgreSQL database.
 */
export async function seedStageTrackerInDatabase(db: PGlite): Promise<void> {
  const stages = loadStageRecords();

  for (const s of stages) {
    await db.query(
      `INSERT INTO project_stage_status (stage_number, stage_name, status, completed_at, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stage_number) DO UPDATE SET
         stage_name = EXCLUDED.stage_name,
         status = EXCLUDED.status,
         completed_at = EXCLUDED.completed_at,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at;`,
      [
        s.stage_number,
        s.stage_name,
        s.status,
        s.completed_at,
        s.notes,
        s.updated_at,
      ]
    );
  }
}
