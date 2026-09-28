/**
 * @file src/db/database.ts
 * PGlite (PostgreSQL WASM) database initialization and schema migration runner.
 * Runs standard PostgreSQL queries with full constraint and trigger enforcement.
 */

import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { mockSendMessageContract, mockSendMessageUnsafeContract } from '../contracts/mockSendMessageContract.ts';

let dbInstance: PGlite | null = null;

export async function getDb(dataDir?: string): Promise<PGlite> {
  if (!dbInstance) {
    dbInstance = new PGlite(dataDir);
  }
  return dbInstance;
}

export async function createFreshDb(): Promise<PGlite> {
  return new PGlite();
}

/**
 * Applies the full Stage 1 SQL schema onto the provided database.
 */
export async function applySchema(db: PGlite): Promise<void> {
  // Read schema.sql
  const schemaPath = path.resolve(process.cwd(), 'src/schema/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  // Execute schema DDL
  await db.exec(sql);
}

/**
 * Seeds the mock capability contracts into the database tables.
 */
export async function seedMockCapabilityContract(db: PGlite): Promise<void> {
  const contracts = [mockSendMessageContract, mockSendMessageUnsafeContract];

  for (const contract of contracts) {
    // Insert or ignore capability
    await db.query(
      `INSERT INTO capabilities (capability_id, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (capability_id) DO NOTHING`,
      [contract.capabilityId, contract.name, contract.description]
    );

    // Insert or ignore capability contract
    await db.query(
      `INSERT INTO capability_contracts (
        capability_id,
        version,
        repeat_mode,
        effect_key_canonicalization_version,
        required_effect_fields,
        provider_dedup_semantics,
        provider_dedup_identity_rule,
        dedup_validity_window_seconds,
        supported_evidence_types,
        evidence_correlation_method,
        reconciliation_characteristics,
        heartbeat_interval_seconds,
        max_unresolved_duration_seconds,
        contract_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (capability_id, version) DO UPDATE SET
        repeat_mode = EXCLUDED.repeat_mode,
        dedup_validity_window_seconds = EXCLUDED.dedup_validity_window_seconds`,
      [
        contract.capabilityId,
        contract.version,
        contract.repeatMode,
        contract.effectKeyCanonicalizationVersion,
        JSON.stringify(contract.requiredEffectFields),
        contract.providerDedup.semantics,
        contract.providerDedup.identityRule,
        contract.providerDedup.validityWindowSeconds,
        JSON.stringify(contract.supportedEvidenceTypes),
        contract.evidenceCorrelationMethod,
        JSON.stringify(contract.reconciliation),
        contract.heartbeatIntervalSeconds,
        contract.reconciliation.maxUnresolvedDurationSeconds,
        'ACTIVE',
      ]
    );
  }
}
