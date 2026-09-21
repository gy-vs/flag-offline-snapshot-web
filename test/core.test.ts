import {describe, expect, it} from 'vitest';
import {applyDelta, buildDelta, DeltaError, parseDeltaPackage, sealDelta, serializeDelta, type DeltaEnvelope} from '../src/shared/delta';
import {GenerationCancelledError, GenerationGate, throwIfAborted} from '../src/shared/generation';
import {buildSnapshot, migrateSnapshot, objectMap, verifySnapshot, type SnapshotEnvelope} from '../src/shared/snapshot';
import type {ContentObject, FlagContent, SegmentContent} from '../src/shared/types';

const segCanary: SegmentContent = {kind: 'segment', id: 'seg-canary', name: 'Canary', revision: 1};
const segBeta: SegmentContent = {kind: 'segment', id: 'seg-beta', name: 'Beta', revision: 1};
const flagCheckout: FlagContent = {
  kind: 'flag',
  id: 'flag-checkout',
  name: 'Checkout',
  revision: 1,
  rules: [
    {id: 'r1', segmentId: 'seg-canary', enabled: true, value: 'new'},
    {id: 'r2', enabled: true, value: 'old'},
  ],
};
const flagSearch: FlagContent = {
  kind: 'flag',
  id: 'flag-search',
  name: 'Search',
  revision: 1,
  rules: [{id: 'r1', segmentId: 'seg-canary', enabled: true, value: 'ranked'}],
};

async function snapshot(releaseId: string, sequence: number, objects: ContentObject[], formatVersion: 1 | 2 = 2): Promise<SnapshotEnvelope> {
  return buildSnapshot({releaseId, sequence, formatVersion, objects, createdAt: `2026-01-0${sequence}T00:00:00.000Z`});
}

function freezeEnvelope(envelope: SnapshotEnvelope): SnapshotEnvelope {
  return structuredClone(envelope);
}

describe('snapshot digests', () => {
  it('seals object digests, topology and a root digest', async () => {
    const env = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    expect(env.snapshot.objects).toHaveLength(2);
    expect(env.snapshot.topology).toEqual([{from: 'flag-checkout', to: 'seg-canary'}]);
    await expect(verifySnapshot(env.snapshot)).resolves.toBeUndefined();
  });

  it('detects tampering with a stored object', async () => {
    const env = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const tampered = freezeEnvelope(env);
    tampered.snapshot.objects[0].data.name = 'Renamed';
    await expect(verifySnapshot(tampered.snapshot)).rejects.toThrow(/integrity/);
  });
});

describe('scenario: object reordering', () => {
  it('produces an empty delta and identical root digest when only object order changes', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, segBeta, flagCheckout, flagSearch]);
    const v2 = await snapshot('rel-prod', 2, [flagSearch, flagCheckout, segBeta, segCanary]);

    expect(v2.rootDigest).not.toBe(v1.rootDigest); // sequence binds the export identity
    const delta = await buildDelta(v1.snapshot, v2.snapshot);
    expect(delta.delta.added).toHaveLength(0);
    expect(delta.delta.replaced).toHaveLength(0);
    expect(delta.delta.deleted).toHaveLength(0);

    const applied = await applyDelta(freezeEnvelope(v1), delta);
    expect(applied.status).toBe('applied');
    if (applied.status === 'applied') {
      expect(applied.envelope.rootDigest).toBe(v2.rootDigest);
      expect(objectMap(applied.envelope.snapshot).get('flag-search')?.name).toBe('Search');
    }
  });
});

describe('scenario: shared segments', () => {
  it('keeps one segment shared by several flags and carries exactly one replacement', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout, flagSearch]);
    const updated: ContentObject = {...segCanary, name: 'Canary audience (broadened)', revision: 2};
    const v2 = await snapshot('rel-prod', 2, [updated, flagSearch, flagCheckout]); // also reordered

    const delta = await buildDelta(v1.snapshot, v2.snapshot);
    expect(delta.delta.replaced.map((entry) => entry.id)).toEqual(['seg-canary']);
    expect(delta.delta.added).toHaveLength(0);
    expect(delta.delta.deleted).toHaveLength(0);

    const result = await applyDelta(freezeEnvelope(v1), delta);
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.envelope.rootDigest).toBe(v2.rootDigest);
      // both flags still reference the single shared segment through the topology
      expect(result.envelope.snapshot.topology).toEqual([
        {from: 'flag-checkout', to: 'seg-canary'},
        {from: 'flag-search', to: 'seg-canary'},
      ]);
    }
  });
});

describe('scenario: deleting an object that is still referenced', () => {
  it('refuses to export a snapshot with a dangling segment reference', async () => {
    await expect(snapshot('rel-prod', 1, [flagCheckout])).rejects.toThrow(/references missing/);
  });

  it('rejects a crafted delta that deletes a referenced segment, leaving the baseline untouched', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const target = await snapshot('rel-prod', 2, [segCanary, flagCheckout]); // same content, new seq
    const delta = await buildDelta(v1.snapshot, target.snapshot);
    // A well-sealed package whose only change is "delete the shared segment".
    // The inner digest and package digest are recomputed, so sealing is intact;
    // referential validation is what must reject it.
    const forgedBody = {...structuredClone(delta.delta), deleted: ['seg-canary']};
    const {canonicalJson, sha256Hex} = await import('../src/shared/encode');
    forgedBody.deltaDigest = await sha256Hex(
      canonicalJson({
        label: forgedBody.label,
        releaseId: forgedBody.releaseId,
        formatVersion: forgedBody.formatVersion,
        baseline: forgedBody.baseline,
        target: forgedBody.target,
        added: forgedBody.added,
        replaced: forgedBody.replaced,
        deleted: forgedBody.deleted,
      }),
    );
    const forged = await sealDelta(forgedBody);
    const baselineCopy = freezeEnvelope(v1);

    await expect(applyDelta(baselineCopy, forged)).rejects.toBeInstanceOf(DeltaError);
    await expect(applyDelta(baselineCopy, forged)).rejects.toMatchObject({code: 'reference_broken'});
    // original snapshot remains intact and usable
    await expect(verifySnapshot(baselineCopy.snapshot)).resolves.toBeUndefined();
    expect(baselineCopy.rootDigest).toBe(v1.rootDigest);
  });

  it('allows deleting a segment together with the flags that reference it', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, segBeta, flagCheckout, flagSearch]);
    const v2 = await snapshot('rel-prod', 2, [segBeta]);
    const delta = await buildDelta(v1.snapshot, v2.snapshot);
    expect(delta.delta.deleted.sort()).toEqual(['flag-checkout', 'flag-search', 'seg-canary']);
    const result = await applyDelta(freezeEnvelope(v1), delta);
    expect(result.status).toBe('applied');
    if (result.status === 'applied') expect(result.envelope.rootDigest).toBe(v2.rootDigest);
  });
});

describe('scenario: baseline mismatch', () => {
  it('refuses a delta whose baseline identity does not match the local snapshot', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const intermediate = await snapshot('rel-prod', 2, [segCanary, {...flagCheckout, revision: 2}]);
    const v3 = await snapshot('rel-prod', 3, [segCanary, {...flagCheckout, revision: 3}]);
    const delta2to3 = await buildDelta(intermediate.snapshot, v3.snapshot);

    const local = freezeEnvelope(v1);
    const before = JSON.stringify(local);
    await expect(applyDelta(local, delta2to3)).rejects.toMatchObject({code: 'baseline_mismatch'});
    expect(JSON.stringify(local)).toBe(before); // untouched
  });

  it('refuses a delta produced for another release', async () => {
    const a1 = await snapshot('rel-a', 1, [segCanary, flagCheckout]);
    const b1 = await snapshot('rel-b', 1, [segCanary, flagCheckout]);
    const b2 = await snapshot('rel-b', 2, [segCanary, {...flagCheckout, revision: 9}]);
    await expect(buildDelta(a1.snapshot, b2.snapshot)).rejects.toMatchObject({code: 'release_mismatch'});
    // even a forged cross-release delta is rejected at apply time
    const forged = structuredClone(await buildDelta(b1.snapshot, b2.snapshot));
    forged.delta.releaseId = 'rel-a';
    await expect(applyDelta(freezeEnvelope(a1), forged)).rejects.toMatchObject({code: 'integrity_failed'});
  });
});

describe('scenario: truncated / corrupt delta', () => {
  it('rejects a cut-off package body as invalid package', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const v2 = await snapshot('rel-prod', 2, [segCanary, {...flagCheckout, revision: 2}]);
    const body = serializeDelta(await buildDelta(v1.snapshot, v2.snapshot));
    let thrown: unknown;
    try {
      parseDeltaPackage(body.slice(0, 100));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeltaError);
    expect((thrown as DeltaError).code).toBe('invalid_package');
  });

  it('rejects a package with a truncated object payload via the package seal', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const v2 = await snapshot('rel-prod', 2, [segCanary, {...flagCheckout, revision: 2, name: 'Checkout rewritten with longer content'}]);
    const delta = structuredClone(await buildDelta(v1.snapshot, v2.snapshot));
    delta.delta.replaced[0].data.name = 'tampered'; // object truncation/tampering
    const local = freezeEnvelope(v1);
    await expect(applyDelta(local, delta)).rejects.toMatchObject({code: 'integrity_failed'});
    await expect(verifySnapshot(local.snapshot)).resolves.toBeUndefined();
  });

  it('rejects a delta whose declared target was tampered with', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const v2 = await snapshot('rel-prod', 2, [segCanary, {...flagCheckout, revision: 2}]);
    const delta: DeltaEnvelope = structuredClone(await buildDelta(v1.snapshot, v2.snapshot));
    delta.delta.target.rootDigest = 'deadbeef';
    delta.packageDigest = 'deadbeef';
    await expect(applyDelta(freezeEnvelope(v1), delta)).rejects.toMatchObject({code: 'integrity_failed'});
  });
});

describe('scenario: repeated application', () => {
  it('is idempotent: a second apply reports already_applied and changes nothing', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout]);
    const v2 = await snapshot('rel-prod', 2, [segCanary, {...flagCheckout, revision: 2}]);
    const delta = await buildDelta(v1.snapshot, v2.snapshot);

    const local = freezeEnvelope(v1);
    const first = await applyDelta(local, delta);
    expect(first.status).toBe('applied');
    if (first.status !== 'applied') throw new Error('expected applied');
    expect(first.envelope.rootDigest).toBe(v2.rootDigest);

    const snapshotAfterFirst = JSON.stringify(first.envelope);
    const second = await applyDelta(first.envelope, delta);
    expect(second.status).toBe('already_applied');
    expect(JSON.stringify(second.envelope)).toBe(snapshotAfterFirst);
  });
});

describe('scenario: version upgrade', () => {
  it('upgrades v1 snapshots to v2 through the delta and reaches the v2 target', async () => {
    // content authored without v2 fields
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout], 1);
    expect(v1.formatVersion).toBe(1);
    expect(objectMap(v1.snapshot).get('seg-canary')).not.toHaveProperty('match');

    // same authored content, exported at v2: migration alone fills the new fields
    const v2target = await snapshot('rel-prod', 2, [segCanary, flagCheckout], 2);
    expect(objectMap(v2target.snapshot).get('seg-canary')).toMatchObject({match: 'all'});
    expect(objectMap(v2target.snapshot).get('flag-checkout')).toMatchObject({defaultVariant: 'off'});

    const delta = await buildDelta(v1.snapshot, v2target.snapshot);
    expect(delta.formatVersion).toBe(2);
    // every v1 object is replaced by its migrated v2 representation, nothing added/deleted
    expect(delta.delta.replaced.map((entry) => entry.id).sort()).toEqual(['flag-checkout', 'seg-canary']);
    expect(delta.delta.added).toHaveLength(0);
    expect(delta.delta.deleted).toHaveLength(0);

    const result = await applyDelta(freezeEnvelope(v1), delta);
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.envelope.formatVersion).toBe(2);
      expect(result.envelope.rootDigest).toBe(v2target.rootDigest);
    }
  });

  it('refuses a delta from a newer format than the client supports', async () => {
    const v2 = await snapshot('rel-prod', 1, [segCanary, flagCheckout], 2);
    const delta = await buildDelta(v2.snapshot, v2.snapshot);
    // a future client sends a properly sealed v3 package; sealing is valid,
    // the version gate must reject it
    const future = await sealDelta({...structuredClone(delta.delta), formatVersion: 3 as 1 | 2});
    const local = freezeEnvelope(v2);
    await expect(applyDelta(local, future)).rejects.toMatchObject({code: 'unsupported_version'});
    await expect(verifySnapshot(local.snapshot)).resolves.toBeUndefined();
  });

  it('re-seals a migrated snapshot with a verifiable root digest', async () => {
    const v1 = await snapshot('rel-prod', 1, [segCanary, flagCheckout], 1);
    const upgraded = await migrateSnapshot(v1.snapshot, 2);
    await expect(verifySnapshot(upgraded)).resolves.toBeUndefined();
  });
});

describe('scenario: generation cancellation and stale results', () => {
  it('cancels a running generation cooperatively', async () => {
    const gate = new GenerationGate();
    const {generation, signal} = gate.begin();
    const outcome = gate.run(generation, signal, async (sig) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throwIfAborted(sig);
      return 'old';
    });
    expect(gate.cancel()).toBe(true);
    expect(await outcome).toEqual({status: 'cancelled'});
    expect(gate.cancel()).toBe(false);
  });

  it('marks a settled-but-superseded generation so an old result cannot overwrite the new selection', async () => {
    const gate = new GenerationGate();
    const first = gate.begin();
    let oldProducerFinished = false;
    const oldResult = gate.run(
      first.generation,
      first.signal,
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            oldProducerFinished = true;
            resolve('old-selection-result');
          }, 20),
        ),
    );
    // user changes the selection before the old generation completes
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = gate.begin();
    const newResult = gate.run(
      second.generation,
      second.signal,
      async (sig) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throwIfAborted(sig);
        return 'new-selection-result';
      },
    );

    expect(await oldResult).toEqual({status: 'superseded'});
    expect(oldProducerFinished).toBe(true); // the work ran, but its result is dropped
    expect(await newResult).toEqual({status: 'completed', value: 'new-selection-result'});
  });

  it('surfaces producer cancellation errors as cancellation', async () => {
    const gate = new GenerationGate();
    const {generation, signal} = gate.begin();
    const result = gate.run(generation, signal, async () => {
      throw new GenerationCancelledError();
    });
    expect(await result).toEqual({status: 'cancelled'});
  });
});
