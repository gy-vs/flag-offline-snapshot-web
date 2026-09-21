import {canonicalJson, sha256Hex} from './encode';
import {checkReferences, computeRootDigest, deriveTopology, digestObject} from './digest';
import {
  migrateSnapshot,
  objectMap,
  verifySnapshot,
  type Snapshot,
  type SnapshotEnvelope,
  type StoredObject,
} from './snapshot';
import type {FormatVersion} from './types';
import {CURRENT_FORMAT} from './types';

export const DELTA_LABEL = 'feature-eval-delta';
export const DELTA_PACKAGE_VERSION = 1;

export class DeltaError extends Error {
  constructor(
    public code:
      | 'invalid_package'
      | 'integrity_failed'
      | 'unsupported_version'
      | 'release_mismatch'
      | 'baseline_mismatch'
      | 'target_mismatch'
      | 'reference_broken',
    message: string,
  ) {
    super(message);
    this.name = 'DeltaError';
  }
}

export type DeltaObject = {
  kind: StoredObject['kind'];
  id: string;
  digest: string;
  data: StoredObject['data'];
};

export type Delta = {
  label: typeof DELTA_LABEL;
  releaseId: string;
  formatVersion: FormatVersion;
  baseline: {sequence: number; rootDigest: string};
  target: {sequence: number; rootDigest: string};
  added: DeltaObject[];
  replaced: DeltaObject[];
  deleted: string[];
  deltaDigest: string;
};

export type DeltaEnvelope = {
  packageVersion: typeof DELTA_PACKAGE_VERSION;
  formatVersion: FormatVersion;
  releaseId: string;
  baseline: Delta['baseline'];
  target: Delta['target'];
  deltaDigest: string;
  /** Package digest seals the serialised delta; catches truncation/tampering. */
  packageDigest: string;
  delta: Delta;
};

async function digestDelta(
  releaseId: string,
  formatVersion: FormatVersion,
  baseline: Delta['baseline'],
  target: Delta['target'],
  added: DeltaObject[],
  replaced: DeltaObject[],
  deleted: string[],
): Promise<string> {
  const canon = canonicalJson({
    label: DELTA_LABEL,
    releaseId,
    formatVersion,
    baseline,
    target,
    added: [...added].sort((a, b) => a.id.localeCompare(b.id)),
    replaced: [...replaced].sort((a, b) => a.id.localeCompare(b.id)),
    deleted: [...deleted].sort(),
  });
  return sha256Hex(canon);
}

/**
 * Build the delta between two sealed snapshots.
 *
 * The baseline is migrated forward to the target format before diffing, so a
 * version upgrade delta carries the upgraded objects. Objects are compared by
 * content digest: pure reordering yields an empty delta (the root digest still
 * pins the target).
 */
export async function buildDelta(baseline: Snapshot, target: Snapshot): Promise<DeltaEnvelope> {
  if (baseline.releaseId !== target.releaseId) {
    throw new DeltaError('release_mismatch', `delta cannot cross releases ('${baseline.releaseId}' -> '${target.releaseId}')`);
  }
  if (target.formatVersion < baseline.formatVersion) {
    throw new DeltaError('unsupported_version', 'delta target format is older than baseline');
  }
  // Membership/content layout is compared against the migrated baseline so a
  // v1 client can upgrade to v2; digest comparison uses the *original* baseline
  // digests, which makes every carried-over object an explicit replacement on
  // a format upgrade (its format-bound digest changes).
  const migrated = baseline.formatVersion === target.formatVersion ? baseline : await migrateSnapshot(baseline, target.formatVersion);
  const before = objectMap(migrated);
  const after = objectMap(target);
  const originalDigests = new Map(baseline.objects.map((entry) => [entry.id, entry.digest]));

  const added: DeltaObject[] = [];
  const replaced: DeltaObject[] = [];
  const deleted: string[] = [];

  for (const entry of target.objects) {
    if (!before.has(entry.id)) added.push(storedToDelta(entry));
    else if (originalDigests.get(entry.id) !== entry.digest) replaced.push(storedToDelta(entry));
  }
  for (const id of before.keys()) if (!after.has(id)) deleted.push(id);

  added.sort((a, b) => a.id.localeCompare(b.id));
  replaced.sort((a, b) => a.id.localeCompare(b.id));
  deleted.sort();

  const baselineRef = {sequence: baseline.sequence, rootDigest: baseline.rootDigest};
  const targetRef = {sequence: target.sequence, rootDigest: target.rootDigest};
  const deltaDigest = await digestDelta(target.releaseId, target.formatVersion, baselineRef, targetRef, added, replaced, deleted);
  const delta: Delta = {
    label: DELTA_LABEL,
    releaseId: target.releaseId,
    formatVersion: target.formatVersion,
    baseline: baselineRef,
    target: targetRef,
    added,
    replaced,
    deleted,
    deltaDigest,
  };
  return sealDelta(delta);
}

function storedToDelta(entry: StoredObject): DeltaObject {
  return {kind: entry.kind, id: entry.id, digest: entry.digest, data: entry.data};
}

export function serializeDelta(envelope: DeltaEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Parse a delta package. A truncated body fails JSON parsing or the package
 * integrity check, so callers can never operate on a partial delta.
 */
export function parseDeltaPackage(text: string): DeltaEnvelope {
  let envelope: DeltaEnvelope;
  try {
    envelope = JSON.parse(text) as DeltaEnvelope;
  } catch {
    throw new DeltaError('invalid_package', 'delta package is not valid JSON (possibly truncated)');
  }
  if (!envelope || envelope.packageVersion !== DELTA_PACKAGE_VERSION || !envelope.delta || envelope.delta.label !== DELTA_LABEL) {
    throw new DeltaError('invalid_package', 'delta package is malformed');
  }
  return envelope;
}

/** Verify only the outer package seal. Catches truncated/corrupt bodies. */
export async function verifyPackageSeal(envelope: DeltaEnvelope): Promise<void> {
  const {packageDigest, delta} = envelope;
  const expectedPackage = await sha256Hex(
    canonicalJson({
      packageVersion: envelope.packageVersion,
      formatVersion: envelope.formatVersion,
      releaseId: envelope.releaseId,
      baseline: envelope.baseline,
      target: envelope.target,
      deltaDigest: envelope.deltaDigest,
      delta,
    }),
  );
  if (expectedPackage !== packageDigest) throw new DeltaError('integrity_failed', 'delta package digest mismatch (corrupt or truncated)');
}

/** Verify package seal and the inner delta digest. Async because hashing is async. */
export async function verifyDeltaPackage(envelope: DeltaEnvelope): Promise<void> {
  await verifyPackageSeal(envelope);
  const delta = envelope.delta;
  const expectedDelta = await digestDelta(
    delta.releaseId,
    delta.formatVersion,
    delta.baseline,
    delta.target,
    delta.added,
    delta.replaced,
    delta.deleted,
  );
  if (expectedDelta !== delta.deltaDigest) throw new DeltaError('integrity_failed', 'delta digest mismatch');
}

export type ApplyOutcome =
  | {status: 'applied'; envelope: SnapshotEnvelope}
  | {status: 'already_applied'; envelope: SnapshotEnvelope};

/**
 * Apply a delta to a baseline snapshot envelope.
 *
 * The contract is all-or-nothing: either the result verifies against the
 * delta's target root digest, or the caller's snapshot is left untouched.
 * Verification runs before any mutation of the baseline (build a candidate
 * first), and applying the same delta twice is an idempotent no-op.
 */
export async function applyDelta(baseline: SnapshotEnvelope, pkg: DeltaEnvelope): Promise<ApplyOutcome> {
  // 1. outer package seal: truncated/corrupt bytes are rejected before touching anything
  await verifyPackageSeal(pkg);
  const delta = pkg.delta;

  if (
    pkg.releaseId !== delta.releaseId ||
    pkg.formatVersion !== delta.formatVersion ||
    JSON.stringify(pkg.baseline) !== JSON.stringify(delta.baseline) ||
    JSON.stringify(pkg.target) !== JSON.stringify(delta.target) ||
    pkg.deltaDigest !== delta.deltaDigest
  ) {
    throw new DeltaError('integrity_failed', 'delta envelope header does not match the sealed delta body');
  }

  // 2. capability gate: a newer-format delta must be refused before any local work
  if (delta.formatVersion > CURRENT_FORMAT) {
    throw new DeltaError('unsupported_version', `delta format v${delta.formatVersion} is newer than this client (v${CURRENT_FORMAT})`);
  }

  // 3. inner content digest
  await verifyDeltaPackage(pkg);

  if (delta.releaseId !== baseline.releaseId) {
    throw new DeltaError('release_mismatch', `delta belongs to release '${delta.releaseId}', snapshot belongs to '${baseline.releaseId}'`);
  }

  // Baseline identity + integrity. A corrupt local snapshot is rejected, never "upgraded away".
  await verifySnapshot(baseline.snapshot);

  // Idempotency: the same delta on an already-updated snapshot is a no-op.
  if (baseline.snapshot.rootDigest === delta.target.rootDigest && baseline.sequence === delta.target.sequence) {
    return {status: 'already_applied', envelope: baseline};
  }

  if (baseline.snapshot.rootDigest !== delta.baseline.rootDigest || baseline.sequence !== delta.baseline.sequence) {
    throw new DeltaError(
      'baseline_mismatch',
      `baseline mismatch: delta expects seq ${delta.baseline.sequence} ${delta.baseline.rootDigest.slice(0, 12)}, ` +
        `snapshot is seq ${baseline.sequence} ${baseline.snapshot.rootDigest.slice(0, 12)}`,
    );
  }

  // Work on a migrated copy; the caller's envelope is not touched until the end.
  const working: Snapshot =
    baseline.snapshot.formatVersion === delta.formatVersion
      ? structuredClone(baseline.snapshot)
      : await migrateSnapshot(baseline.snapshot, delta.formatVersion);

  const objects = objectMap(working);

  const claim = (entry: DeltaObject, bucket: 'added' | 'replaced'): void => {
    const exists = objects.has(entry.id);
    if ((bucket === 'added') === exists) {
      throw new DeltaError('invalid_package', `delta ${bucket} entry '${entry.id}' ${exists ? 'already exists' : 'does not exist'}`);
    }
    if (entry.data.id !== entry.id || entry.data.kind !== entry.kind) {
      throw new DeltaError('integrity_failed', `object identity mismatch for '${entry.id}'`);
    }
  };

  for (const entry of delta.added) {
    claim(entry, 'added');
    if ((await digestObject(entry.data, delta.formatVersion)) !== entry.digest) {
      throw new DeltaError('integrity_failed', `integrity check failed for added object '${entry.id}'`);
    }
    objects.set(entry.id, structuredClone(entry.data));
  }
  for (const entry of delta.replaced) {
    claim(entry, 'replaced');
    if ((await digestObject(entry.data, delta.formatVersion)) !== entry.digest) {
      throw new DeltaError('integrity_failed', `integrity check failed for replaced object '${entry.id}'`);
    }
    objects.set(entry.id, structuredClone(entry.data));
  }
  for (const id of delta.deleted) {
    if (!objects.delete(id)) throw new DeltaError('invalid_package', `delta deletes missing object '${id}'`);
  }

  // A delta must never leave dangling references (e.g. deleting a shared segment).
  const entries: StoredObject[] = [];
  for (const data of objects.values()) {
    entries.push({kind: data.kind, id: data.id, data, digest: await digestObject(data, delta.formatVersion)});
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const candidate: Snapshot = {
    label: working.label,
    releaseId: working.releaseId,
    sequence: delta.target.sequence,
    formatVersion: delta.formatVersion,
    objects: entries,
    topology: [],
    rootDigest: '',
  };
  try {
    candidate.topology = deriveTopology(objectMap(candidate));
    checkReferences(objectMap(candidate), candidate.topology);
  } catch (error) {
    if (error instanceof DeltaError) throw error;
    throw new DeltaError('reference_broken', (error as Error).message);
  }

  // Seal check: build the expected root digest from the candidate and compare
  // against the delta's declared target.
  const rootDigest = await computeRootDigest({
    label: candidate.label,
    releaseId: candidate.releaseId,
    sequence: candidate.sequence,
    formatVersion: candidate.formatVersion,
    objects: candidate.objects.map((entry) => ({id: entry.id, digest: entry.digest})),
    topology: candidate.topology,
  });
  if (rootDigest !== delta.target.rootDigest) {
    throw new DeltaError('target_mismatch', 'assembled snapshot does not match the declared target root digest');
  }
  candidate.rootDigest = rootDigest;
  await verifySnapshot(candidate);

  return {
    status: 'applied',
    envelope: {
      releaseId: candidate.releaseId,
      sequence: candidate.sequence,
      formatVersion: candidate.formatVersion,
      rootDigest: candidate.rootDigest,
      createdAt: new Date().toISOString(),
      snapshot: candidate,
    },
  };
}

export async function sealDelta(delta: Delta): Promise<DeltaEnvelope> {
  const packageDigest = await sha256Hex(
    canonicalJson({
      packageVersion: DELTA_PACKAGE_VERSION,
      formatVersion: delta.formatVersion,
      releaseId: delta.releaseId,
      baseline: delta.baseline,
      target: delta.target,
      deltaDigest: delta.deltaDigest,
      delta,
    }),
  );
  return {
    packageVersion: DELTA_PACKAGE_VERSION,
    formatVersion: delta.formatVersion,
    releaseId: delta.releaseId,
    baseline: delta.baseline,
    target: delta.target,
    deltaDigest: delta.deltaDigest,
    packageDigest,
    delta,
  };
}
