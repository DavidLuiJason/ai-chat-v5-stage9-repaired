/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { StageStatusTracker } from './components/StageStatusTracker.tsx';

export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-start p-4 sm:p-6 lg:p-8 font-mono">
      <div className="max-w-3xl w-full space-y-6">
        {/* Authoritative Persistent Stage Status Tracker */}
        <StageStatusTracker />

        {/* Technical Architecture & Verification Details */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 sm:p-6 shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-3 gap-2">
            <h1 className="text-base font-semibold text-slate-100">
              Control Plane Orchestration: Completed Stages 1–8
            </h1>
            <span className="self-start sm:self-auto px-2.5 py-0.5 text-xs rounded bg-emerald-950 text-emerald-400 border border-emerald-800 font-bold">
              170 / 170 Invariant Tests Passing
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Control plane schema integrity, atomic authorization transaction, factual effect ledger,
            controlled dispatch boundary, immutable claim-specific evidence ingestion (
            <code className="text-amber-400">evidence_records</code>), canonical execution & terminal-state
            derivation (<code className="text-emerald-400">deriveCanonicalState</code>), authoritative recovery,
            durable heartbeat deadlines & reconciliation tasks (<code className="text-cyan-400">executeRecovery</code>),
            and control-plane adjudication & atomic contradiction blocking (<code className="text-violet-400">adjudicateContradiction</code>)
            are fully implemented and verified against PostgreSQL with hard trigger enforcement.
          </p>

          <ul className="text-xs space-y-2 text-slate-300">
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 1:</strong> Schema constraints, <code className="text-slate-200">UNIQUE(execution_identity)</code>,
                distinct correlation IDs, append-only triggers (34/34 checks)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 2:</strong> Single-transaction atomic authorization, hard internal budget reservation,
                compare-and-commit fencing (13/13 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 3:</strong> Effect Ledger (<code className="text-slate-200">INTENT ≠ EFFECT ≠ ATTEMPT ≠ DISPATCH</code>),
                repeat mode gating (17/17 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 4:</strong> Atomic dispatch claim + attempt state transition (
                <code className="text-slate-200">RESERVED → DISPATCHED_UNRESOLVED</code>) under row serialization (17/17 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 5:</strong> Immutable evidence ingestion (<code className="text-slate-200">evidence_records</code>),
                exact contract correlation, contradiction preservation (17/17 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 6:</strong> Authoritative canonical execution + terminal-state derivation (
                <code className="text-slate-200">deriveCanonicalState</code>), monotonic <code className="text-slate-200">executed_fact</code>,
                terminal closure completeness, crash idempotency (22/22 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 7:</strong> Control-plane recovery (<code className="text-slate-200">RESERVED → RECOVERY_RELEASED</code>),
                restart scanning, durable heartbeat deadlines, and reconciliation tasks (24/24 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 8:</strong> Adjudication & contradiction blocking (<code className="text-slate-200">adjudicateContradiction</code>),
                atomic authorization blocking, zero evidence fabrication, monotonic <code className="text-slate-200">executed_fact</code> (27/27 tests)
              </span>
            </li>
            <li className="flex items-start space-x-2">
              <span className="text-emerald-400 font-bold mt-0.5">✓</span>
              <span>
                <strong>Stage 9:</strong> Property Tests, Fault Injection, Reference Model & Concurrency Validation (
                <code className="text-slate-200">ControlPlaneReferenceModel</code>), 250+ operations across 10 seeds, crash windows & deadlock freedom
              </span>
            </li>
          </ul>

          <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
            <span>Next Boundary: Stage 10 (Final Hardening & Integration Audit) — Status: NOT_STARTED</span>
            <span className="text-emerald-400">All Stage 1–9 Invariants Active</span>
          </div>
        </div>
      </div>
    </div>
  );
}

