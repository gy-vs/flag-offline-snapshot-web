import express from 'express';
import {fileURLToPath} from 'node:url';
import {ReferenceError_} from '../shared/digest';
import {StoreError, WorkbenchStore} from './workbench';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary evaluation rules',revision:3,content:'evaluation rules: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary evaluation rules',revision:5,content:'evaluation rules: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

// Server-side generation registry: lets a client cancel an in-flight delta build.
const deltaJobs = new Map<string, AbortController>();

export function createApp(){
  const app=express();
  const workbench = new WorkbenchStore();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"feature-eval",count:rows.length}));
  app.get('/api/flags',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/flags/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/flags/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/flags/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  const wb = express.Router();
  wb.get('/releases', (_req, res) => res.json({releases: workbench.listReleases()}));
  wb.get('/releases/:releaseId/draft', (req, res) => res.json(workbench.getDraft(req.params.releaseId)));
  wb.put('/releases/:releaseId/draft', (req, res) => {
    workbench.setDraft(req.params.releaseId, req.body.objects ?? []);
    res.json(workbench.getDraft(req.params.releaseId));
  });
  wb.post('/releases/:releaseId/snapshots', async (req, res, next) => {
    try {
      const formatVersion = req.body.formatVersion === 1 ? 1 : 2;
      const envelope = await workbench.exportSnapshot(req.params.releaseId, formatVersion);
      res.status(201).json({envelope, size: Buffer.byteLength(JSON.stringify(envelope))});
    } catch (error) { next(error); }
  });
  wb.get('/releases/:releaseId/snapshots', (req, res) => res.json({snapshots: workbench.listSnapshots(req.params.releaseId)}));
  wb.get('/releases/:releaseId/snapshots/:sequence', (req, res, next) => {
    try {
      const envelope = workbench.getSnapshot(req.params.releaseId, Number(req.params.sequence));
      res.json({envelope, size: Buffer.byteLength(JSON.stringify(envelope))});
    } catch (error) { next(error); }
  });
  // Start a (optionally slow) delta generation job.
  wb.post('/releases/:releaseId/delta-jobs', async (req, res, next) => {
    try {
      const releaseId = req.params.releaseId;
      const from = Number(req.body.fromSequence);
      const to = Number(req.body.toSequence);
      const delayMs = Number(req.body.delayMs ?? 0);
      const jobId = String(req.body.jobId ?? `${releaseId}:${from}->${to}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`);
      if (deltaJobs.has(jobId)) return res.status(409).json({error: 'job_exists', jobId});
      const controller = new AbortController();
      deltaJobs.set(jobId, controller);
      const result = await workbench.generateDelta(releaseId, from, to, controller.signal, delayMs);
      if (!deltaJobs.has(jobId)) return res.status(499).json({error: 'cancelled', jobId});
      deltaJobs.delete(jobId);
      res.status(201).json({jobId, delta: result.envelope, size: result.size, counts: result.counts});
    } catch (error) { next(error); }
  });
  wb.post('/delta-jobs/:jobId/cancel', (req, res) => {
    const controller = deltaJobs.get(req.params.jobId);
    if (!controller) return res.status(404).json({error: 'job_not_found'});
    controller.abort();
    deltaJobs.delete(req.params.jobId);
    res.json({cancelled: true, jobId: req.params.jobId});
  });
  app.use('/api/workbench', wb);

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof StoreError) return res.status(error.status).json({error: error.code, message: error.message});
    if (error instanceof ReferenceError_) return res.status(409).json({error: 'reference_broken', message: error.message});
    const message = error instanceof Error ? error.message : String(error);
    if (/generation cancelled/.test(message)) return res.status(499).json({error: 'cancelled', message});
    res.status(500).json({error: 'internal_error', message});
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
