import {buildDelta, serializeDelta, type DeltaEnvelope} from '../shared/delta';
import {buildSnapshot, type SnapshotEnvelope} from '../shared/snapshot';
import type {ContentObject} from '../shared/types';
import {CURRENT_FORMAT, type FormatVersion} from '../shared/types';

export type ReleaseState = {
  releaseId: string;
  name: string;
  draft: ContentObject[];
  /** Generated snapshots keyed by sequence, newest last. */
  history: SnapshotEnvelope[];
};

export type GeneratedDelta = {
  envelope: DeltaEnvelope;
  body: string;
  size: number;
  counts: {added: number; replaced: number; deleted: number};
};

export class WorkbenchStore {
  readonly releases = new Map<string, ReleaseState>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.releases.clear();
    this.releases.set('rel-prod', {
      releaseId: 'rel-prod',
      name: 'Production rollout',
      draft: seedObjects(),
      history: [],
    });
  }

  getRelease(releaseId: string): ReleaseState {
    const release = this.releases.get(releaseId);
    if (!release) throw new StoreError('not_found', `unknown release '${releaseId}'`, 404);
    return release;
  }

  listReleases(): Array<{releaseId: string; name: string; draftObjects: number; latestSequence: number | null}> {
    return [...this.releases.values()].map((release) => ({
      releaseId: release.releaseId,
      name: release.name,
      draftObjects: release.draft.length,
      latestSequence: release.history.length ? release.history[release.history.length - 1].sequence : null,
    }));
  }

  getDraft(releaseId: string): {releaseId: string; name: string; objects: ContentObject[]} {
    const release = this.getRelease(releaseId);
    return {releaseId: release.releaseId, name: release.name, objects: release.draft.map((object) => structuredClone(object))};
  }

  /** Replace the whole draft (reordering is a normal replacement). */
  setDraft(releaseId: string, objects: ContentObject[]): void {
    validateObjects(objects);
    this.getRelease(releaseId).draft = objects.map((object) => structuredClone(object));
  }

  /** Export the draft as the next snapshot, bound to the release. */
  async exportSnapshot(releaseId: string, formatVersion: FormatVersion = CURRENT_FORMAT): Promise<SnapshotEnvelope> {
    const release = this.getRelease(releaseId);
    const sequence = release.history.length ? release.history[release.history.length - 1].sequence + 1 : 1;
    const envelope = await buildSnapshot({releaseId, sequence, formatVersion, objects: release.draft});
    release.history.push(envelope);
    return structuredClone(envelope);
  }

  getSnapshot(releaseId: string, sequence: number): SnapshotEnvelope {
    const release = this.getRelease(releaseId);
    const envelope = release.history.find((entry) => entry.sequence === sequence);
    if (!envelope) throw new StoreError('not_found', `no snapshot seq ${sequence} for release '${releaseId}'`, 404);
    return structuredClone(envelope);
  }

  listSnapshots(releaseId: string): Array<{sequence: number; formatVersion: FormatVersion; rootDigest: string; createdAt: string; size: number}> {
    const release = this.getRelease(releaseId);
    return release.history.map((envelope) => ({
      sequence: envelope.sequence,
      formatVersion: envelope.formatVersion,
      rootDigest: envelope.rootDigest,
      createdAt: envelope.createdAt,
      size: Buffer.byteLength(JSON.stringify(envelope)),
    }));
  }

  /**
   * Generate the delta between two previously exported snapshots.
   * `signal` lets a slow generation be cancelled cooperatively.
   */
  async generateDelta(releaseId: string, fromSequence: number, toSequence: number, signal?: AbortSignal, delayMs = 0): Promise<GeneratedDelta> {
    const release = this.getRelease(releaseId);
    const from = release.history.find((entry) => entry.sequence === fromSequence);
    const to = release.history.find((entry) => entry.sequence === toSequence);
    if (!from || !to) throw new StoreError('not_found', 'both snapshots must be exported before generating a delta', 404);
    if (delayMs > 0) await interruptibleSleep(delayMs, signal);
    const envelope = await buildDelta(from.snapshot, to.snapshot);
    const body = serializeDelta(envelope);
    return {
      envelope: structuredClone(envelope),
      body,
      size: Buffer.byteLength(body),
      counts: {added: envelope.delta.added.length, replaced: envelope.delta.replaced.length, deleted: envelope.delta.deleted.length},
    };
  }
}

export class StoreError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('generation cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('generation cancelled'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
}

function validateObjects(objects: ContentObject[]): void {
  if (!Array.isArray(objects)) throw new StoreError('invalid_draft', 'draft must be an object array', 400);
  const ids = new Set<string>();
  for (const object of objects) {
    if (!object || (object.kind !== 'flag' && object.kind !== 'segment')) {
      throw new StoreError('invalid_draft', 'every object needs kind "flag" or "segment"', 400);
    }
    if (!object.id || ids.has(object.id)) throw new StoreError('invalid_draft', `duplicate or missing id '${object?.id}'`, 400);
    ids.add(object.id);
    if (object.kind === 'flag' && !Array.isArray(object.rules)) throw new StoreError('invalid_draft', `flag '${object.id}' needs rules`, 400);
  }
}

export function seedObjects(): ContentObject[] {
  return [
    {
      kind: 'segment',
      id: 'seg-canary',
      name: 'Canary audience',
      revision: 2,
      match: 'tier="canary"',
    },
    {
      kind: 'segment',
      id: 'seg-beta',
      name: 'Beta testers',
      revision: 1,
      match: 'beta=true',
    },
    {
      kind: 'flag',
      id: 'flag-checkout',
      name: 'New checkout',
      revision: 4,
      rules: [
        {id: 'r1', segmentId: 'seg-canary', enabled: true, value: 'new'},
        {id: 'r2', enabled: true, value: 'old'},
      ],
      defaultVariant: 'old',
    },
    {
      kind: 'flag',
      id: 'flag-search',
      name: 'Ranked search',
      revision: 2,
      rules: [
        {id: 'r1', segmentId: 'seg-beta', enabled: true, value: 'ranked'},
        {id: 'r2', segmentId: 'seg-canary', enabled: false, value: 'control'},
      ],
      defaultVariant: 'off',
    },
  ];
}
