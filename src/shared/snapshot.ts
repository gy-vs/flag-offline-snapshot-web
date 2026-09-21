// Shared snapshot/delta model used by the server (export + delta generation)
// and by offline clients (baseline verification + atomic delta application).

export const SNAPSHOT_FORMAT_VERSION = 2;

export type ObjectKind = 'spec' | 'cohort' | 'flag' | 'topology';

export type SnapshotObject = {
  id: string; // object identity, e.g. "flag:alpha", "cohort:beta-testers"
  kind: ObjectKind;
  revision: number;
  content: string;
  digest: string; // sha256 over canonical({content,id,kind,revision})
};
export type ObjectDraft = Omit<SnapshotObject, 'digest'>;

export type Snapshot = {
  formatVersion: number;
  releaseId: string;
  snapshotId: string;
  createdAt: string;
  rootDigest: string; // sha256 over sorted [objectId, objectDigest] pairs
  objects: Record<string, SnapshotObject>;
};

export type DeltaOp =
  | {op: 'add'; object: SnapshotObject}
  | {op: 'replace'; id: string; expect: string; object: SnapshotObject}
  | {op: 'remove'; id: string; expect: string};

export type DeltaPackage = {
  formatVersion: number;
  releaseId: string;
  base: {snapshotId: string; rootDigest: string};
  target: {snapshotId: string; rootDigest: string; createdAt: string};
  ops: DeltaOp[];
  digest: string; // integrity digest over the whole package body
};

export type ApplyErrorCode =
  | 'unsupported_version'
  | 'delta_corrupt'
  | 'baseline_mismatch'
  | 'baseline_corrupt'
  | 'delta_conflict'
  | 'dangling_reference'
  | 'target_mismatch';

export type ApplyError = {code: ApplyErrorCode; message: string};
export type ApplyResult = {ok: true; snapshot: Snapshot} | {ok: false; error: ApplyError};

// ---------------------------------------------------------------------------
// sha256 (synchronous, dependency-free; verified against known vectors)

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256hex(message: string): string {
  const data = new TextEncoder().encode(message);
  const bitLength = data.length * 8;
  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// canonical serialization (stable key order → reorder-invariant digests)

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ---------------------------------------------------------------------------
// digests

export function digestObject(draft: ObjectDraft): string {
  return sha256hex(canonical({content: draft.content, id: draft.id, kind: draft.kind, revision: draft.revision}));
}

export function computeRootDigest(objects: Record<string, SnapshotObject>): string {
  const ids = Object.keys(objects).sort();
  return sha256hex(canonical(ids.map(id => [id, objects[id].digest])));
}

export function computeDeltaDigest(body: Omit<DeltaPackage, 'digest'>): string {
  return sha256hex(canonical(body));
}

export function verifySnapshotIntegrity(snapshot: Snapshot): boolean {
  for (const object of Object.values(snapshot.objects)) {
    if (digestObject(object) !== object.digest) return false;
  }
  return computeRootDigest(snapshot.objects) === snapshot.rootDigest;
}

// ---------------------------------------------------------------------------
// domain → snapshot objects (spec config, cohorts, flags, dependency topology)

export type DomainState = {
  spec: {revision: number; content: string};
  cohorts: {id: string; revision: number; definition: string}[];
  flags: {id: string; revision: number; content: string; cohortIds: string[]; dependsOn: string[]}[];
};

function byId<T extends {id: string}>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function topologyContent(flags: DomainState['flags']): string {
  const edges = flags.slice().sort(byId).map(flag => ({
    flag: flag.id,
    dependsOn: flag.dependsOn.slice().sort(),
    cohorts: flag.cohortIds.slice().sort(),
  }));
  return canonical({edges});
}

export function objectsFromDomain(state: DomainState): ObjectDraft[] {
  const drafts: ObjectDraft[] = [
    {kind: 'spec', id: 'spec:global', revision: state.spec.revision, content: state.spec.content},
  ];
  for (const cohort of state.cohorts.slice().sort(byId)) {
    drafts.push({kind: 'cohort', id: `cohort:${cohort.id}`, revision: cohort.revision, content: cohort.definition});
  }
  for (const flag of state.flags.slice().sort(byId)) {
    drafts.push({kind: 'flag', id: `flag:${flag.id}`, revision: flag.revision, content: flag.content});
  }
  drafts.push({kind: 'topology', id: 'topology:deps', revision: 1, content: topologyContent(state.flags)});
  return drafts;
}

// ---------------------------------------------------------------------------
// referential integrity (topology edges → flag/cohort objects)

export function collectReferences(objects: Record<string, SnapshotObject>): {from: string; to: string}[] {
  const refs: {from: string; to: string}[] = [];
  for (const object of Object.values(objects)) {
    if (object.kind !== 'topology') continue;
    let parsed: {edges?: {flag: string; dependsOn?: string[]; cohorts?: string[]}[]};
    try {
      parsed = JSON.parse(object.content);
    } catch {
      continue;
    }
    for (const edge of parsed.edges ?? []) {
      refs.push({from: object.id, to: `flag:${edge.flag}`});
      for (const dep of edge.dependsOn ?? []) refs.push({from: object.id, to: `flag:${dep}`});
      for (const cohort of edge.cohorts ?? []) refs.push({from: object.id, to: `cohort:${cohort}`});
    }
  }
  return refs;
}

export function findDanglingReferences(objects: Record<string, SnapshotObject>): string[] {
  return collectReferences(objects).filter(ref => !objects[ref.to]).map(ref => `${ref.from} -> ${ref.to}`);
}

// ---------------------------------------------------------------------------
// snapshot construction

export function createSnapshot(input: {
  releaseId: string;
  snapshotId: string;
  createdAt?: string;
  objects: ObjectDraft[];
}): Snapshot {
  const objects: Record<string, SnapshotObject> = {};
  for (const draft of input.objects) {
    if (objects[draft.id]) throw new Error(`duplicate object identity: ${draft.id}`);
    objects[draft.id] = {...draft, digest: digestObject(draft)};
  }
  const dangling = findDanglingReferences(objects);
  if (dangling.length) throw new Error(`dangling references: ${dangling.join(', ')}`);
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    releaseId: input.releaseId,
    snapshotId: input.snapshotId,
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    rootDigest: computeRootDigest(objects),
    objects,
  };
}

export function serializeSnapshot(snapshot: Snapshot): string {
  return canonical(snapshot);
}

// ---------------------------------------------------------------------------
// diff: additions / replacements / removals by object identity

export function diffObjects(
  base: Record<string, SnapshotObject>,
  target: Record<string, SnapshotObject>,
): DeltaOp[] {
  const ops: DeltaOp[] = [];
  for (const id of Object.keys(target).sort()) {
    const before = base[id];
    const after = target[id];
    if (!before) ops.push({op: 'add', object: after});
    else if (before.digest !== after.digest) ops.push({op: 'replace', id, expect: before.digest, object: after});
  }
  for (const id of Object.keys(base).sort()) {
    if (!target[id]) ops.push({op: 'remove', id, expect: base[id].digest});
  }
  return ops;
}

export function buildDeltaPackage(base: Snapshot, target: Snapshot): DeltaPackage {
  if (base.releaseId !== target.releaseId) throw new Error('snapshots belong to different releases');
  const body: Omit<DeltaPackage, 'digest'> = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    releaseId: base.releaseId,
    base: {snapshotId: base.snapshotId, rootDigest: base.rootDigest},
    target: {snapshotId: target.snapshotId, rootDigest: target.rootDigest, createdAt: target.createdAt},
    ops: diffObjects(base.objects, target.objects),
  };
  return {...body, digest: computeDeltaDigest(body)};
}

// ---------------------------------------------------------------------------
// delta application (atomic: returns the full target snapshot or nothing)

class DeltaConflict extends Error {}

export function applyOps(
  objects: Record<string, SnapshotObject>,
  ops: DeltaOp[],
): Record<string, SnapshotObject> {
  const next: Record<string, SnapshotObject> = {...objects};
  for (const op of ops) {
    if (op.op === 'add') {
      if (next[op.object.id]) throw new DeltaConflict(`add conflicts with existing object ${op.object.id}`);
      next[op.object.id] = op.object;
    } else if (op.op === 'replace') {
      const current = next[op.id];
      if (!current) throw new DeltaConflict(`replace targets missing object ${op.id}`);
      if (op.object.id !== op.id) throw new DeltaConflict(`replace identity mismatch on ${op.id}`);
      if (current.digest !== op.expect) throw new DeltaConflict(`replace digest mismatch on ${op.id}`);
      next[op.id] = op.object;
    } else {
      const current = next[op.id];
      if (!current) throw new DeltaConflict(`remove targets missing object ${op.id}`);
      if (current.digest !== op.expect) throw new DeltaConflict(`remove digest mismatch on ${op.id}`);
      delete next[op.id];
    }
  }
  return next;
}

function fail(code: ApplyErrorCode, message: string): ApplyResult {
  return {ok: false, error: {code, message}};
}

export function applyDelta(base: Snapshot, pkg: DeltaPackage): ApplyResult {
  // 1. format version gate (version upgrades must be rejected, not half-applied)
  if (pkg.formatVersion !== SNAPSHOT_FORMAT_VERSION || base.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    return fail('unsupported_version', `format version ${pkg.formatVersion} is not supported (expected ${SNAPSHOT_FORMAT_VERSION})`);
  }
  // 2. package integrity (covers truncation / tampering)
  const {digest, ...body} = pkg;
  if (computeDeltaDigest(body) !== digest) {
    return fail('delta_corrupt', 'delta package digest mismatch');
  }
  // 3. baseline identity
  if (pkg.releaseId !== base.releaseId || pkg.base.snapshotId !== base.snapshotId || pkg.base.rootDigest !== base.rootDigest) {
    return fail('baseline_mismatch', `delta expects baseline ${pkg.base.snapshotId} (${pkg.base.rootDigest.slice(0, 12)}…)`);
  }
  // 4. baseline integrity
  if (!verifySnapshotIntegrity(base)) {
    return fail('baseline_corrupt', 'baseline snapshot failed integrity check');
  }
  // 5. per-object integrity of incoming payloads
  for (const op of pkg.ops) {
    const object = op.op === 'remove' ? null : op.object;
    if (object && digestObject(object) !== object.digest) {
      return fail('delta_corrupt', `object ${object.id} failed integrity check`);
    }
  }
  // 6. apply ops onto a copy — the input snapshot is never mutated
  let next: Record<string, SnapshotObject>;
  try {
    next = applyOps(base.objects, pkg.ops);
  } catch (err) {
    return fail('delta_conflict', err instanceof Error ? err.message : String(err));
  }
  // 7. referential integrity of the result
  const dangling = findDanglingReferences(next);
  if (dangling.length) {
    return fail('dangling_reference', `unresolved references after apply: ${dangling.join(', ')}`);
  }
  // 8. target root digest verification
  const rootDigest = computeRootDigest(next);
  if (rootDigest !== pkg.target.rootDigest) {
    return fail('target_mismatch', `resulting root digest ${rootDigest.slice(0, 12)}… does not match target ${pkg.target.rootDigest.slice(0, 12)}…`);
  }
  return {
    ok: true,
    snapshot: {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      releaseId: base.releaseId,
      snapshotId: pkg.target.snapshotId,
      createdAt: pkg.target.createdAt,
      rootDigest,
      objects: next,
    },
  };
}

export function parseDeltaPackage(raw: string): {ok: true; pkg: DeltaPackage} | {ok: false; error: ApplyError} {
  try {
    const pkg = JSON.parse(raw) as DeltaPackage;
    if (!pkg || typeof pkg !== 'object' || !Array.isArray(pkg.ops) || typeof pkg.digest !== 'string') {
      throw new Error('malformed delta package');
    }
    return {ok: true, pkg};
  } catch (err) {
    return {ok: false, error: {code: 'delta_corrupt', message: `cannot parse delta package: ${err instanceof Error ? err.message : String(err)}`}};
  }
}
