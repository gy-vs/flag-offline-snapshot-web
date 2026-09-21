import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {applyDelta,SNAPSHOT_FORMAT_VERSION,type DeltaOp,type DeltaPackage,type Snapshot} from '../src/shared/snapshot';

type App=ReturnType<typeof createApp>;

async function waitTask(app:App,id:string){
  for(let i=0;i<100;i++){
    const res=await request(app).get('/api/tasks/'+id).expect(200);
    if(['done','failed','cancelled'].includes(res.body.status))return res.body;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('task did not finish: '+id);
}
async function exportSnapshot(app:App,releaseId='rel-2026.09'):Promise<Snapshot>{
  const started=await request(app).post(`/api/releases/${releaseId}/exports`).expect(202);
  const view=await waitTask(app,started.body.taskId);
  expect(view.status).toBe('done');
  const artifact=await request(app).get(`/api/tasks/${started.body.taskId}/artifact`).expect(200);
  return artifact.body.snapshot as Snapshot;
}

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/flags/alpha').expect(200);
    await request(app).put('/api/flags/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/flags/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('snapshot export',()=>{
  it('exports a snapshot bound to a release with content digests',async()=>{
    const app=createApp();
    const snapshot=await exportSnapshot(app);
    expect(snapshot.releaseId).toBe('rel-2026.09');
    expect(snapshot.formatVersion).toBe(SNAPSHOT_FORMAT_VERSION);
    expect(snapshot.rootDigest).toMatch(/^[0-9a-f]{64}$/);
    const ids=Object.keys(snapshot.objects);
    expect(ids).toContain('spec:global');
    expect(ids).toContain('topology:deps');
    expect(ids).toContain('cohort:beta-testers');
    expect(ids).toContain('flag:alpha');
    for(const object of Object.values(snapshot.objects))expect(object.digest).toMatch(/^[0-9a-f]{64}$/);
    const list=await request(app).get('/api/releases/rel-2026.09/snapshots').expect(200);
    expect(list.body.map((row:{snapshotId:string})=>row.snapshotId)).toContain(snapshot.snapshotId);
  });
  it('rejects exports for unknown releases',async()=>{
    const app=createApp();
    await request(app).post('/api/releases/nope/exports').expect(404);
  });
});

describe('delta generation and client application',()=>{
  it('generates add/replace/remove ops and the client reaches the target root digest',async()=>{
    const app=createApp();
    const base=await exportSnapshot(app);
    const alpha=await request(app).get('/api/flags/alpha').expect(200);
    await request(app).put('/api/flags/alpha').send({content:'evaluation rules: alpha v2\nstate: active',revision:alpha.body.revision}).expect(200);
    const target=await exportSnapshot(app);
    const started=await request(app)
      .post('/api/releases/rel-2026.09/deltas')
      .send({baseSnapshotId:base.snapshotId,targetSnapshotId:target.snapshotId})
      .expect(202);
    const view=await waitTask(app,started.body.taskId);
    expect(view.status).toBe('done');
    const artifact=await request(app).get(`/api/tasks/${started.body.taskId}/artifact`).expect(200);
    const delta=artifact.body.delta as DeltaPackage;
    expect(delta.base.snapshotId).toBe(base.snapshotId);
    expect(delta.target.snapshotId).toBe(target.snapshotId);
    const replaced=delta.ops.filter((op):op is Extract<DeltaOp,{op:'replace'}>=>op.op==='replace').map(op=>op.id);
    expect(replaced).toContain('flag:alpha');
    expect(artifact.body.deltaBytes).toBeLessThan(artifact.body.fullBytes);
    // client-side: verify baseline identity + integrity, apply, check target root digest
    const result=applyDelta(base,delta);
    expect(result.ok).toBe(true);
    if(result.ok)expect(result.snapshot.rootDigest).toBe(target.rootDigest);
  });
  it('rejects delta requests for unknown snapshots',async()=>{
    const app=createApp();
    await request(app).post('/api/releases/rel-2026.09/deltas').send({baseSnapshotId:'a',targetSnapshotId:'b'}).expect(404);
  });
});

describe('cohort references',()=>{
  it('refuses to delete a cohort that is still referenced, allows it after unreferencing',async()=>{
    const app=createApp();
    const blocked=await request(app).delete('/api/cohorts/beta-testers').expect(409);
    expect(blocked.body.error).toBe('cohort_in_use');
    expect(blocked.body.usedBy.sort()).toEqual(['alpha','beta']);
    for(const id of ['alpha','beta']){
      const row=await request(app).get('/api/flags/'+id).expect(200);
      await request(app).put('/api/flags/'+id).send({content:row.body.content,revision:row.body.revision,cohortIds:[]}).expect(200);
    }
    await request(app).delete('/api/cohorts/beta-testers').expect(200);
    const snapshot=await exportSnapshot(app);
    expect(Object.keys(snapshot.objects)).not.toContain('cohort:beta-testers');
  });
});

describe('generation cancellation',()=>{
  it('cancels a pending task and keeps its artifact unavailable',async()=>{
    const app=createApp({taskDelayMs:200});
    const started=await request(app).post('/api/releases/rel-2026.09/exports').expect(202);
    const cancelled=await request(app).post(`/api/tasks/${started.body.taskId}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    const view=await waitTask(app,started.body.taskId);
    expect(view.status).toBe('cancelled');
    const artifact=await request(app).get(`/api/tasks/${started.body.taskId}/artifact`).expect(409);
    expect(artifact.body.error).toBe('artifact_unavailable');
  });
  it('refuses to cancel a finished task',async()=>{
    const app=createApp({taskDelayMs:5});
    const started=await request(app).post('/api/releases/rel-2026.09/exports').expect(202);
    const view=await waitTask(app,started.body.taskId);
    expect(view.status).toBe('done');
    await request(app).post(`/api/tasks/${started.body.taskId}/cancel`).expect(409);
  });
});
