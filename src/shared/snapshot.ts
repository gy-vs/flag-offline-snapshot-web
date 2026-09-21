import {checkReferences, computeRootDigest, digestObject, deriveTopology} from './digest';
import type {ContentObject, FormatVersion, TopologyEdge} from './types';
import {CURRENT_FORMAT} from './types';

export const SNAPSHOT_LABEL = 'feature-eval-snapshot';

export type StoredObject = {
  kind: ContentObject['kind'];
  id: string;
  digest: string;
  data: ContentObject;
};

export type Snapshot = {
  label: typeof SNAPSHOT_LABEL;
  releaseId: string;
  sequence: number;
  formatVersion: FormatVersion;
  objects: StoredObject[];
  topology: TopologyEdge[];
  rootDigest: string;
};

/** Transport envelope. `createdAt` is deliberately outside the digest. */
export type SnapshotEnvelope = {
  releaseId: string;
  sequence: number;
  formatVersion: FormatVersion;
  rootDigest: string;
  createdAt: string;
  snapshot: Snapshot;
};

export function objectMap(snapshot: {objects: Iterable<StoredObject>}): Map<string, ContentObject> {
  return new Map([...snapshot.objects].map((entry) => [entry.id, entry.data]));
}

/** v1 content -> v2 content: old flags gain the default variant, old segments the matcher. */
export function migrateObject(object: ContentObject, to: FormatVersion): ContentObject {
  if (to < CURRENT_FORMAT) return object;
  if (object.kind === 'flag') {
    return {...object, defaultVariant: object.defaultVariant ?? 'off'};
  }
  return {...object, match: object.match ?? 'all'};
}

/**
 * Migrate a sealed snapshot forward and reseal it. Per-object digests and the
 * root digest are recomputed, so the result is a valid snapshot at `to`.
 */
export async function migrateSnapshot(snapshot: Snapshot, to: FormatVersion): Promise<Snapshot> {
  if (snapshot.formatVersion >= to) return snapshot;
  const objects: StoredObject[] = [];
  for (const entry of snapshot.objects) {
    const data = migrateObject(entry.data, to);
    objects.push({kind: data.kind, id: data.id, data, digest: await digestObject(data, to)});
  }
  objects.sort((a, b) => a.id.localeCompare(b.id));
  const rootDigest = await computeRootDigest({
    label: snapshot.label,
    releaseId: snapshot.releaseId,
    sequence: snapshot.sequence,
    formatVersion: to,
    objects: objects.map((entry) => ({id: entry.id, digest: entry.digest})),
    topology: snapshot.topology,
  });
  return {...snapshot, formatVersion: to, objects, rootDigest};
}

export type BuildInput = {
  releaseId: string;
  sequence: number;
  formatVersion: FormatVersion;
  objects: readonly ContentObject[];
  createdAt?: string;
};

/**
 * Build and seal a snapshot: validates references, upgrades authored content
 * when a newer format is requested, computes per-object digests and the
 * topology, then binds them with a root digest.
 */
export async function buildSnapshot(input: BuildInput): Promise<SnapshotEnvelope> {
  const map = new Map<string, ContentObject>();
  for (const object of input.objects) {
    if (map.has(object.id)) throw new Error(`duplicate object id '${object.id}'`);
    if (object.id !== object.id.trim() || !object.id.trim()) throw new Error('invalid object id');
    map.set(object.id, object);
  }
  const topology = deriveTopology(map);
  checkReferences(map, topology);

  // Content is authored at the oldest baseline; newer exports add computed fields.
  const authored = [...map.values()].map((object) => migrateObject(object, input.formatVersion));
  const objects: StoredObject[] = [];
  for (const data of authored) {
    objects.push({kind: data.kind, id: data.id, data, digest: await digestObject(data, input.formatVersion)});
  }
  objects.sort((a, b) => a.id.localeCompare(b.id));

  const snapshot: Snapshot = {
    label: SNAPSHOT_LABEL,
    releaseId: input.releaseId,
    sequence: input.sequence,
    formatVersion: input.formatVersion,
    objects,
    topology,
    rootDigest: '',
  };
  snapshot.rootDigest = await computeRootDigest({
    label: snapshot.label,
    releaseId: snapshot.releaseId,
    sequence: snapshot.sequence,
    formatVersion: snapshot.formatVersion,
    objects: snapshot.objects.map((entry) => ({id: entry.id, digest: entry.digest})),
    topology: snapshot.topology,
  });
  return {
    releaseId: input.releaseId,
    sequence: input.sequence,
    formatVersion: snapshot.formatVersion,
    rootDigest: snapshot.rootDigest,
    createdAt: input.createdAt ?? new Date().toISOString(),
    snapshot,
  };
}

/** Recompute every digest of a received/exported snapshot and compare. */
export async function verifySnapshot(snapshot: Snapshot): Promise<void> {
  if (snapshot.label !== SNAPSHOT_LABEL) throw new Error('snapshot label mismatch');
  const map = objectMap(snapshot);
  for (const entry of snapshot.objects) {
    if (entry.data.id !== entry.id || entry.data.kind !== entry.kind) {
      throw new Error(`object identity mismatch for '${entry.id}'`);
    }
    const digest = await digestObject(entry.data, snapshot.formatVersion);
    if (digest !== entry.digest) throw new Error(`integrity check failed for object '${entry.id}'`);
  }
  const topology = deriveTopology(map);
  if (JSON.stringify(topology) !== JSON.stringify(snapshot.topology)) {
    throw new Error('topology does not match object references');
  }
  checkReferences(map, topology);
  const root = await computeRootDigest({
    label: snapshot.label,
    releaseId: snapshot.releaseId,
    sequence: snapshot.sequence,
    formatVersion: snapshot.formatVersion,
    objects: snapshot.objects.map((entry) => ({id: entry.id, digest: entry.digest})),
    topology: snapshot.topology,
  });
  if (root !== snapshot.rootDigest) throw new Error('root digest mismatch');
}
