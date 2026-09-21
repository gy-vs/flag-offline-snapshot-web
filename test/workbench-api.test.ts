import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {applyDelta, parseDeltaPackage} from '../src/shared/delta';
import type {ContentObject} from '../src/shared/types';

async function exportSnapshot(app: ReturnType<typeof createApp>, releaseId: string, formatVersion = 2) {
  const response = await request(app).post(`/api/workbench/releases/${releaseId}/snapshots`).send({formatVersion}).expect(201);
  return response.body as {envelope: any; size: number};
}

describe('workbench snapshot API', () => {
  it('binds exports to a release and lists sealed snapshots', async () => {
    const app = createApp();
    const releases = await request(app).get('/api/workbench/releases').expect(200);
    expect(releases.body.releases[0]).toMatchObject({releaseId: 'rel-prod', latestSequence: null});

    const first = await exportSnapshot(app, 'rel-prod');
    expect(first.envelope.releaseId).toBe('rel-prod');
    expect(first.envelope.sequence).toBe(1);
    expect(first.envelope.rootDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.envelope.snapshot.topology.length).toBeGreaterThan(0);

    const second = await exportSnapshot(app, 'rel-prod');
    expect(second.envelope.sequence).toBe(2);
    const list = await request(app).get('/api/workbench/releases/rel-prod/snapshots').expect(200);
    expect(list.body.snapshots.map((entry: any) => entry.sequence)).toEqual([1, 2]);
    expect(list.body.snapshots[0]).toHaveProperty('size');
  });

  it('exports v1 and v2 format snapshots for the same draft', async () => {
    const app = createApp();
    const v1 = await exportSnapshot(app, 'rel-prod', 1);
    const v2 = await exportSnapshot(app, 'rel-prod', 2);
    expect(v1.envelope.formatVersion).toBe(1);
    expect(v2.envelope.formatVersion).toBe(2);
    expect(v1.envelope.rootDigest).not.toBe(v2.envelope.rootDigest);
  });

  it('round-trips a delta through the client applier, including reordering', async () => {
    const app = createApp();
    const first = await exportSnapshot(app, 'rel-prod');

    // object reordering in the draft: segment moved after a flag
    const draft = await request(app).get('/api/workbench/releases/rel-prod/draft').expect(200);
    const objects = draft.body.objects as ContentObject[];
    const reordered = [...objects.slice(1), objects[0]];
    await request(app).put('/api/workbench/releases/rel-prod/draft').send({objects: reordered}).expect(200);
    const second = await exportSnapshot(app, 'rel-prod');

    const deltaResponse = await request(app)
      .post('/api/workbench/releases/rel-prod/delta-jobs')
      .send({fromSequence: 1, toSequence: 2})
      .expect(201);
    expect(deltaResponse.body.counts).toEqual({added: 0, replaced: 0, deleted: 0});
    // an empty delta package should be smaller than the full snapshot
    expect(deltaResponse.body.size).toBeLessThan(JSON.stringify(second.envelope).length);

    const pkg = parseDeltaPackage(JSON.stringify(deltaResponse.body.delta));
    const applied = await applyDelta(first.envelope, pkg);
    expect(applied.status).toBe('applied');
    if (applied.status === 'applied') expect(applied.envelope.rootDigest).toBe(second.envelope.rootDigest);
  });

  it('reports added/replaced/deleted counts for a shared-segment edit and deletion', async () => {
    const app = createApp();
    await exportSnapshot(app, 'rel-prod');
    const draft = await request(app).get('/api/workbench/releases/rel-prod/draft').expect(200);
    const objects = draft.body.objects as ContentObject[];
    const shared = objects.find((object) => object.id === 'seg-canary')!;
    const updated = objects.map((object) => (object.id === 'seg-canary' ? {...shared, revision: shared.revision + 1} : object));
    await request(app).put('/api/workbench/releases/rel-prod/draft').send({objects: updated}).expect(200);
    await exportSnapshot(app, 'rel-prod');

    const deltaResponse = await request(app)
      .post('/api/workbench/releases/rel-prod/delta-jobs')
      .send({fromSequence: 1, toSequence: 2})
      .expect(201);
    expect(deltaResponse.body.counts.replaced).toBe(1);
    expect(deltaResponse.body.delta.delta.replaced[0].id).toBe('seg-canary');

    // now delete the shared segment without removing its referencing flags
    const withoutSegment = updated.filter((object) => object.id !== 'seg-canary');
    await request(app).put('/api/workbench/releases/rel-prod/draft').send({objects: withoutSegment}).expect(200);
    const blocked = await request(app).post('/api/workbench/releases/rel-prod/snapshots').send({}).expect(409);
    expect(blocked.body.error).toBe('reference_broken');
  });

  it('rejects a baseline mismatch: delta built from seq 2 cannot apply to seq 1', async () => {
    const app = createApp();
    const first = await exportSnapshot(app, 'rel-prod');
    void first;
    const draftResponse = await request(app).get('/api/workbench/releases/rel-prod/draft').expect(200);
    const objects = draftResponse.body.objects as ContentObject[];
    const changed = objects.map((object) => (object.kind === 'flag' ? {...object, revision: object.revision + 1} : object));
    await request(app).put('/api/workbench/releases/rel-prod/draft').send({objects: changed}).expect(200);
    await exportSnapshot(app, 'rel-prod');
    const changedAgain = changed.map((object) => (object.kind === 'flag' ? {...object, revision: object.revision + 1} : object));
    await request(app).put('/api/workbench/releases/rel-prod/draft').send({objects: changedAgain}).expect(200);
    await exportSnapshot(app, 'rel-prod');

    const deltaResponse = await request(app)
      .post('/api/workbench/releases/rel-prod/delta-jobs')
      .send({fromSequence: 2, toSequence: 3})
      .expect(201);

    const seq1 = (await request(app).get('/api/workbench/releases/rel-prod/snapshots/1').expect(200)).body.envelope;
    await expect(applyDelta(seq1, parseDeltaPackage(JSON.stringify(deltaResponse.body.delta)))).rejects.toMatchObject({
      code: 'baseline_mismatch',
    });
  });

  it('cancels a slow delta generation server side', async () => {
    const app = createApp();
    await exportSnapshot(app, 'rel-prod');
    await exportSnapshot(app, 'rel-prod');

    // supertest serialises requests on one agent, so use a real server and
    // independent fetch clients to exercise concurrent job + cancel requests.
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as {port: number}).port;
    const base = `http://127.0.0.1:${port}/api/workbench`;
    try {
      const jobId = `cancel-test-${Date.now()}`;
      const job = fetch(`${base}/releases/rel-prod/delta-jobs`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jobId, fromSequence: 1, toSequence: 2, delayMs: 2000}),
      });
      await new Promise((resolve) => setTimeout(resolve, 200));

      const cancel = await fetch(`${base}/delta-jobs/${jobId}/cancel`, {method: 'POST'});
      expect(cancel.status).toBe(200);
      expect(await cancel.json()).toEqual({cancelled: true, jobId});

      const response = await job;
      expect(response.status).toBe(499);
      expect(await response.json()).toMatchObject({error: 'cancelled'});

      const cancelAgain = await fetch(`${base}/delta-jobs/${jobId}/cancel`, {method: 'POST'});
      expect(cancelAgain.status).toBe(404);
    } finally {
      server.close();
    }
  }, 10000);

  it('validates draft payloads', async () => {
    const app = createApp();
    const bad = await request(app)
      .put('/api/workbench/releases/rel-prod/draft')
      .send({objects: [{id: 'x'}]})
      .expect(400);
    expect(bad.body.error).toBe('invalid_draft');
    await request(app).put('/api/workbench/releases/unknown/draft').send({objects: []}).expect(404);
  });
});
