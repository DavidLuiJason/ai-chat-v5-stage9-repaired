/**
 * @file src/tracker/types.ts
 * Domain model for Persistent Stage Status Tracker.
 *
 * Distinct boundary: The stage tracker is NOT part of the execution control plane.
 * It tracks project development and integration progress durably across application reloads.
 */

export type StageStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE';

export interface StageRecord {
  /** Unique stage identifier (1 to 10) */
  stage_number: number;
  /** Human-readable canonical name of the stage */
  stage_name: string;
  /** Explicit persistent progress status */
  status: StageStatus;
  /** ISO timestamp when the stage completed */
  completed_at: string | null;
  /** Reference notes or validation summary */
  notes: string | null;
  /** Timestamp when the record was last updated */
  updated_at: string;
}

export interface StageTrackerSummary {
  stages: StageRecord[];
  completedCount: number;
  totalStages: number;
  currentProgressStage: number; // 6
  nextPendingStage: number; // 7
  nextPendingStageName: string;
  isStorageSynchronized: boolean;
  lastLoadedAt: string;
}
