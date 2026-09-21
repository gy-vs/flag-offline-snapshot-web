import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  buildDeltaPackage,
  byteLength,
  createSnapshot,
  objectsFromDomain,
  serializeSnapshot,
  type Snapshot,
} from '../shared/snapshot';

type RecordRow = {id:string;name:string;revision:number;content:string;cohortIds:string[];dependsOn:string[];updatedAt:string};
type CohortRow = {id:string;name:string;revision:number;definition:string};
type TaskStatus = 'pending'|'running'|'done'|'cancelled'|'failed';
type Task = {id:string;kind:'export'|'delta';releaseId:string;status:TaskStatus;createdAt:string;error?:string;artifact?:unknown;timer?:ReturnType<typeof setTimeout>};

export function createApp(options:{taskDelayMs?:number}={}){
  const taskDelayMs=options.taskDelayMs??60;
  const spec={revision:2,content:'spec: evaluation-v2\nbucketing: murmur3\nexposure: log'};
  const cohorts:CohortRow[]=[
    {id:'beta-testers',name:'Beta testers',revision:4,definition:'user.group == "beta"'},
    {id:'internal',name:'Internal users',revision:2,definition:'user.email.endsWith("@example.com")'},
  ];
  const rows:RecordRow[]=[
    {id:'alpha',name:'Primary evaluation rules',revision:3,content:'evaluation rules: alpha\nstate: active',cohortIds:['beta-testers'],dependsOn:[],updatedAt:new Date(0).toISOString()},
    {id:'beta',name:'Secondary evaluation rules',revision:5,content:'evaluation rules: beta\nstate: review',cohortIds:['beta-testers'],dependsOn:['alpha'],updatedAt:new Date(1000).toISOString()},
    {id:'gamma',name:'Fallback evaluation rules',revision:1,content:'evaluation rules: gamma\nstate: active',cohortIds:['internal'],dependsOn:['alpha'],updatedAt:new Date(2000).toISOString()},
  ];
  const releases=[{id:'rel-2026.09',name:'2026.09 stable'},{id:'rel-hotfix',name:'Hotfix line'}];
  const snapshots=new Map<string,Snapshot>();
  const sequences=new Map<string,number>();
  const tasks=new Map<string,Task>();
  let taskSeq=0;

  function captureSnapshot(releaseId:string):Snapshot{
    const sequence=(sequences.get(releaseId)??0)+1;
    sequences.set(releaseId,sequence);
    const snapshot=createSnapshot({
      releaseId,
      snapshotId:`${releaseId}:s${sequence}`,
      createdAt:new Date().toISOString(),
      objects:objectsFromDomain({spec,cohorts,flags:rows}),
    });
    snapshots.set(snapshot.snapshotId,snapshot);
    return snapshot;
  }
  function summarize(snapshot:Snapshot){
    return {snapshotId:snapshot.snapshotId,releaseId:snapshot.releaseId,createdAt:snapshot.createdAt,rootDigest:snapshot.rootDigest,objectCount:Object.keys(snapshot.objects).length,sizeBytes:byteLength(serializeSnapshot(snapshot))};
  }
  function startTask(kind:Task['kind'],releaseId:string,work:()=>unknown):Task{
    const task:Task={id:`task-${++taskSeq}`,kind,releaseId,status:'pending',createdAt:new Date().toISOString()};
    tasks.set(task.id,task);
    task.timer=setTimeout(()=>{
      if(task.status==='cancelled')return;
      task.status='running';
      try{task.artifact=work();task.status='done'}
      catch(err){task.status='failed';task.error=err instanceof Error?err.message:String(err)}
    },taskDelayMs);
    return task;
  }
  function taskView(task:Task){
    return {id:task.id,kind:task.kind,releaseId:task.releaseId,status:task.status,createdAt:task.createdAt,...(task.error?{error:task.error}:{})};
  }

  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"feature-eval",count:rows.length}));
  app.get('/api/flags',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/flags/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/flags/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');if(Array.isArray(req.body.cohortIds))row.cohortIds=req.body.cohortIds.map(String);if(Array.isArray(req.body.dependsOn))row.dependsOn=req.body.dependsOn.map(String);row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/flags/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  app.get('/api/cohorts',(_req,res)=>res.json(cohorts));
  app.delete('/api/cohorts/:id',(req,res)=>{
    const index=cohorts.findIndex(cohort=>cohort.id===req.params.id);
    if(index<0)return res.status(404).json({error:'not_found'});
    const usedBy=rows.filter(row=>row.cohortIds.includes(req.params.id)).map(row=>row.id);
    if(usedBy.length)return res.status(409).json({error:'cohort_in_use',usedBy});
    cohorts.splice(index,1);
    res.json({ok:true});
  });

  app.get('/api/releases',(_req,res)=>res.json(releases));
  app.get('/api/releases/:id/snapshots',(req,res)=>{
    if(!releases.some(release=>release.id===req.params.id))return res.status(404).json({error:'not_found'});
    res.json([...snapshots.values()].filter(snapshot=>snapshot.releaseId===req.params.id).map(summarize));
  });
  app.get('/api/snapshots/:id',(req,res)=>{
    const snapshot=snapshots.get(req.params.id);
    if(!snapshot)return res.status(404).json({error:'not_found'});
    res.json(snapshot);
  });

  app.post('/api/releases/:id/exports',(req,res)=>{
    if(!releases.some(release=>release.id===req.params.id))return res.status(404).json({error:'not_found'});
    const releaseId=req.params.id;
    const task=startTask('export',releaseId,()=>{
      const snapshot=captureSnapshot(releaseId);
      return {kind:'export',snapshot,sizeBytes:byteLength(serializeSnapshot(snapshot))};
    });
    res.status(202).json({taskId:task.id});
  });
  app.post('/api/releases/:id/deltas',(req,res)=>{
    if(!releases.some(release=>release.id===req.params.id))return res.status(404).json({error:'not_found'});
    const base=snapshots.get(String(req.body?.baseSnapshotId??''));
    const target=snapshots.get(String(req.body?.targetSnapshotId??''));
    if(!base||!target)return res.status(404).json({error:'snapshot_not_found'});
    if(base.releaseId!==req.params.id||target.releaseId!==req.params.id)return res.status(400).json({error:'release_mismatch'});
    const task=startTask('delta',req.params.id,()=>{
      const delta=buildDeltaPackage(base,target);
      return {kind:'delta',delta,deltaBytes:byteLength(JSON.stringify(delta)),fullBytes:byteLength(serializeSnapshot(target))};
    });
    res.status(202).json({taskId:task.id});
  });

  app.get('/api/tasks/:id',(req,res)=>{
    const task=tasks.get(req.params.id);
    if(!task)return res.status(404).json({error:'not_found'});
    res.json(taskView(task));
  });
  app.post('/api/tasks/:id/cancel',(req,res)=>{
    const task=tasks.get(req.params.id);
    if(!task)return res.status(404).json({error:'not_found'});
    if(task.status==='done'||task.status==='failed')return res.status(409).json({error:'task_not_cancellable',status:task.status});
    if(task.timer)clearTimeout(task.timer);
    task.status='cancelled';
    task.artifact=undefined;
    res.json(taskView(task));
  });
  app.get('/api/tasks/:id/artifact',(req,res)=>{
    const task=tasks.get(req.params.id);
    if(!task)return res.status(404).json({error:'not_found'});
    if(task.status!=='done')return res.status(409).json({error:'artifact_unavailable',status:task.status});
    res.json(task.artifact);
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
