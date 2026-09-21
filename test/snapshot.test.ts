import {describe,expect,it} from 'vitest';
import {
  SNAPSHOT_FORMAT_VERSION,
  applyDelta,
  applyOps,
  buildDeltaPackage,
  computeDeltaDigest,
  computeRootDigest,
  createSnapshot,
  objectsFromDomain,
  parseDeltaPackage,
  serializeSnapshot,
  sha256hex,
  type DeltaOp,
  type DeltaPackage,
  type DomainState,
  type Snapshot,
} from '../src/shared/snapshot';

function domain():DomainState{
  return {
    spec:{revision:2,content:'spec: evaluation-v2'},
    cohorts:[
      {id:'c-shared',revision:4,definition:'user.group == "beta"'},
      {id:'c-solo',revision:1,definition:'user.country == "cn"'},
    ],
    flags:[
      {id:'f1',revision:3,content:'rules f1',cohortIds:['c-shared'],dependsOn:[]},
      {id:'f2',revision:5,content:'rules f2',cohortIds:['c-shared'],dependsOn:['f1']},
      {id:'f3',revision:1,content:'rules f3',cohortIds:['c-solo'],dependsOn:['f1']},
    ],
  };
}
function snap(state:DomainState,id:string):Snapshot{
  return createSnapshot({releaseId:'rel-1',snapshotId:id,createdAt:'2026-09-21T00:00:00.000Z',objects:objectsFromDomain(state)});
}
function clone<T>(value:T):T{
  return structuredClone(value);
}

describe('sha256hex',()=>{
  it('matches known vectors',()=>{
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('object reordering',()=>{
  it('produces identical root digest, identical export bytes and an empty delta',()=>{
    const a=domain();
    const b=domain();
    b.flags.reverse();
    b.cohorts.reverse();
    const s1=snap(a,'rel-1:s1');
    const s1Reordered=snap(b,'rel-1:s1');
    expect(s1Reordered.rootDigest).toBe(s1.rootDigest);
    expect(serializeSnapshot(s1Reordered)).toBe(serializeSnapshot(s1));
    const s2=snap(b,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    expect(pkg.ops).toHaveLength(0);
    const result=applyDelta(s1,pkg);
    expect(result.ok).toBe(true);
    if(result.ok)expect(result.snapshot.snapshotId).toBe('rel-1:s2');
  });
});

describe('shared cohorts',()=>{
  it('keeps a shared cohort when only one of its consumers is removed',()=>{
    const v1=domain();
    const v2=domain();
    v2.flags=v2.flags.filter(flag=>flag.id!=='f2'); // f1 and f3 still use/reference c-shared
    const s1=snap(v1,'rel-1:s1');
    const s2=snap(v2,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    const removed=pkg.ops.filter(op=>op.op==='remove').map(op=>op.id);
    expect(removed).toEqual(['flag:f2']);
    expect(removed).not.toContain('cohort:c-shared');
    const result=applyDelta(s1,pkg);
    expect(result.ok).toBe(true);
    if(!result.ok)return;
    expect(result.snapshot.rootDigest).toBe(s2.rootDigest);
    expect(result.snapshot.objects['cohort:c-shared']).toBeDefined();
    expect(result.snapshot.objects['flag:f2']).toBeUndefined();
  });
});

describe('deleting a still-referenced object',()=>{
  it('rejects a delta that removes a cohort the topology still references',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const before=clone(s1);
    const ops:DeltaOp[]=[{op:'remove',id:'cohort:c-shared',expect:s1.objects['cohort:c-shared'].digest}];
    // honestly compute the target digest over the (invalid) result, so only the
    // referential-integrity guard can catch this delta
    const nextObjects=applyOps(s1.objects,ops);
    const body={
      formatVersion:SNAPSHOT_FORMAT_VERSION,
      releaseId:'rel-1',
      base:{snapshotId:s1.snapshotId,rootDigest:s1.rootDigest},
      target:{snapshotId:'rel-1:s9',rootDigest:computeRootDigest(nextObjects),createdAt:s1.createdAt},
      ops,
    };
    const pkg:DeltaPackage={...body,digest:computeDeltaDigest(body)};
    const result=applyDelta(s1,pkg);
    expect(result.ok).toBe(false);
    if(result.ok)return;
    expect(result.error.code).toBe('dangling_reference');
    expect(s1).toEqual(before); // original snapshot untouched
  });
});

describe('baseline mismatch',()=>{
  it('refuses to apply a delta onto a different baseline',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const changed=domain();
    changed.flags[0].content='rules f1 v2';
    changed.flags[0].revision=4;
    const s2=snap(changed,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    const other=snap(domain(),'rel-1:other'); // same content, different identity
    const before=clone(other);
    const result=applyDelta(other,pkg);
    expect(result.ok).toBe(false);
    if(result.ok)return;
    expect(result.error.code).toBe('baseline_mismatch');
    expect(other).toEqual(before);
  });
  it('refuses a delta issued for a different release',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const s2=snap(domain(),'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    const foreign=createSnapshot({releaseId:'rel-2',snapshotId:'rel-2:s1',createdAt:s1.createdAt,objects:objectsFromDomain(domain())});
    const result=applyDelta(foreign,pkg);
    expect(result.ok).toBe(false);
    if(!result.ok)expect(result.error.code).toBe('baseline_mismatch');
  });
});

describe('delta truncation',()=>{
  it('rejects truncated bytes and tampered packages, leaving the base unchanged',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const changed=domain();
    changed.flags=changed.flags.filter(flag=>flag.id!=='f3');
    changed.flags[0].content='rules f1 v2';
    changed.flags[0].revision=4;
    const s2=snap(changed,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    expect(pkg.ops.length).toBeGreaterThan(1);
    const raw=JSON.stringify(pkg);
    const truncated=parseDeltaPackage(raw.slice(0,raw.length/2));
    expect(truncated.ok).toBe(false);
    if(!truncated.ok)expect(truncated.error.code).toBe('delta_corrupt');
    const before=clone(s1);
    const tampered:DeltaPackage={...pkg,ops:pkg.ops.slice(1)}; // drop an op, keep stale digest
    const result=applyDelta(s1,tampered);
    expect(result.ok).toBe(false);
    if(result.ok)return;
    expect(result.error.code).toBe('delta_corrupt');
    expect(s1).toEqual(before);
  });
});

describe('duplicate application',()=>{
  it('applies once and rejects the second attempt without changing the result',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const changed=domain();
    changed.cohorts[0].definition='user.group == "beta" && user.active';
    changed.cohorts[0].revision=5;
    const s2=snap(changed,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    const first=applyDelta(s1,pkg);
    expect(first.ok).toBe(true);
    if(!first.ok)return;
    expect(first.snapshot.rootDigest).toBe(s2.rootDigest);
    const afterFirst=clone(first.snapshot);
    const second=applyDelta(first.snapshot,pkg);
    expect(second.ok).toBe(false);
    if(!second.ok)expect(second.error.code).toBe('baseline_mismatch');
    expect(first.snapshot).toEqual(afterFirst); // failed re-apply leaves the snapshot as-is
  });
});

describe('version upgrade',()=>{
  it('rejects a delta from a newer format version even when its digest is valid',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const changed=domain();
    changed.flags[0].content='rules f1 v2';
    changed.flags[0].revision=4;
    const s2=snap(changed,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    const {digest:_ignored,...unsigned}=pkg;
    const upgraded:DeltaPackage={...unsigned,formatVersion:SNAPSHOT_FORMAT_VERSION+1,digest:''};
    upgraded.digest=computeDeltaDigest({...unsigned,formatVersion:SNAPSHOT_FORMAT_VERSION+1});
    const before=clone(s1);
    const result=applyDelta(s1,upgraded);
    expect(result.ok).toBe(false);
    if(result.ok)return;
    expect(result.error.code).toBe('unsupported_version');
    expect(s1).toEqual(before);
  });
});

describe('atomicity',()=>{
  it('failed application never mutates the base snapshot',()=>{
    const s1=snap(domain(),'rel-1:s1');
    const changed=domain();
    changed.flags[0].content='rules f1 v2';
    changed.flags[0].revision=4;
    const s2=snap(changed,'rel-1:s2');
    const pkg=buildDeltaPackage(s1,s2);
    const before=clone(s1);
    const corrupt:DeltaPackage={...pkg,digest:'0'.repeat(64)};
    expect(applyDelta(s1,corrupt).ok).toBe(false);
    expect(applyDelta(s1,{...pkg,base:{snapshotId:'nope',rootDigest:'nope'}}).ok).toBe(false);
    expect(s1).toEqual(before);
  });
});
