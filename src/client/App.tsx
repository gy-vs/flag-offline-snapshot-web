import {useEffect,useRef,useState} from 'react';
import {FileDown,FlaskConical,GitCompareArrows,Play,Save,ShieldCheck,XCircle} from 'lucide-react';
import {applyDelta,type DeltaPackage,type Snapshot} from '../shared/snapshot';
import {createTaskGate} from './generation';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type Release={id:string;name:string};
type SnapshotSummary={snapshotId:string;releaseId:string;createdAt:string;rootDigest:string;objectCount:number;sizeBytes:number};
type TaskView={id:string;kind:'export'|'delta';status:string;error?:string};
type ExportArtifact={kind:'export';snapshot:Snapshot;sizeBytes:number};
type DeltaArtifact={kind:'delta';delta:DeltaPackage;deltaBytes:number;fullBytes:number};

function formatBytes(bytes:number){
  return bytes<1024?`${bytes} B`:`${(bytes/1024).toFixed(1)} KB`;
}

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [analysis,setAnalysis]=useState<unknown>(null);
  const [status,setStatus]=useState('Ready');
  const [releases,setReleases]=useState<Release[]>([]);
  const [releaseId,setReleaseId]=useState('');
  const [snapshots,setSnapshots]=useState<SnapshotSummary[]>([]);
  const [baseId,setBaseId]=useState('');
  const [targetId,setTargetId]=useState('');
  const [task,setTask]=useState<TaskView|null>(null);
  const [exportInfo,setExportInfo]=useState<ExportArtifact|null>(null);
  const [deltaInfo,setDeltaInfo]=useState<DeltaArtifact|null>(null);
  const [sim,setSim]=useState<{ok:boolean;text:string}|null>(null);
  const gate=useRef(createTaskGate());

  useEffect(()=>{fetch('/api/flags').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{fetch('/api/releases').then(r=>r.json()).then((list:Release[])=>{setReleases(list);if(list.length)setReleaseId(current=>current||list[0].id)})},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/flags/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  useEffect(()=>{
    if(!releaseId)return;
    let stale=false;
    gate.current.invalidate();
    setTask(null);setExportInfo(null);setDeltaInfo(null);setSim(null);
    fetch('/api/releases/'+encodeURIComponent(releaseId)+'/snapshots').then(r=>r.json()).then((list:SnapshotSummary[])=>{
      if(stale)return;
      setSnapshots(list);
      setBaseId(list.length>1?list[list.length-2].snapshotId:(list[0]?.snapshotId??''));
      setTargetId(list.length?list[list.length-1].snapshotId:'');
    });
    return ()=>{stale=true};
  },[releaseId]);

  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/flags/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/flags/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}

  async function trackTask(taskId:string,kind:'export'|'delta'){
    const token=gate.current.begin();
    for(;;){
      await new Promise(resolve=>setTimeout(resolve,150));
      if(!gate.current.isCurrent(token))return; // a newer selection superseded this task
      const view:TaskView=await (await fetch('/api/tasks/'+taskId)).json();
      if(!gate.current.isCurrent(token))return;
      setTask(view);
      if(view.status==='done'){
        const artifact=await (await fetch('/api/tasks/'+taskId+'/artifact')).json();
        if(!gate.current.isCurrent(token))return;
        if(kind==='export'){
          setExportInfo(artifact);
          const list:SnapshotSummary[]=await (await fetch('/api/releases/'+encodeURIComponent(releaseId)+'/snapshots')).json();
          if(!gate.current.isCurrent(token))return;
          setSnapshots(list);
          setBaseId(list.length>1?list[list.length-2].snapshotId:(list[0]?.snapshotId??''));
          setTargetId(list.length?list[list.length-1].snapshotId:'');
        }else{
          setDeltaInfo(artifact);
          setSim(null);
        }
        return;
      }
      if(view.status==='failed'||view.status==='cancelled')return;
    }
  }
  async function exportSnapshot(){
    if(!releaseId)return;
    setDeltaInfo(null);setSim(null);
    const response=await fetch('/api/releases/'+encodeURIComponent(releaseId)+'/exports',{method:'POST'});
    if(!response.ok)return;
    const {taskId}=await response.json();
    setTask({id:taskId,kind:'export',status:'pending'});
    await trackTask(taskId,'export');
  }
  async function generateDelta(){
    if(!releaseId||!baseId||!targetId)return;
    setSim(null);
    const response=await fetch('/api/releases/'+encodeURIComponent(releaseId)+'/deltas',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseSnapshotId:baseId,targetSnapshotId:targetId})});
    if(!response.ok)return;
    const {taskId}=await response.json();
    setTask({id:taskId,kind:'delta',status:'pending'});
    await trackTask(taskId,'delta');
  }
  async function cancelTask(){
    gate.current.invalidate(); // in-flight completions become stale immediately
    if(task)await fetch('/api/tasks/'+task.id+'/cancel',{method:'POST'});
    setTask(null);
  }
  async function simulate(){
    if(!deltaInfo||!baseId)return;
    const response=await fetch('/api/snapshots/'+encodeURIComponent(baseId));
    if(!response.ok){setSim({ok:false,text:'基线快照不存在，无法模拟'});return}
    const base:Snapshot=await response.json();
    const result=applyDelta(base,deltaInfo.delta);
    setSim(result.ok
      ?{ok:true,text:`校验通过：基线身份匹配，应用后根摘要 ${result.snapshot.rootDigest.slice(0,16)}… 与目标一致`}
      :{ok:false,text:`应用失败（${result.error.code}）：${result.error.message}，原快照保持不变`});
  }
  function changeBase(id:string){gate.current.invalidate();setBaseId(id);setDeltaInfo(null);setSim(null)}
  function changeTarget(id:string){gate.current.invalidate();setTargetId(id);setDeltaInfo(null);setSim(null)}

  const savings=deltaInfo?Math.max(0,Math.round((1-deltaInfo.deltaBytes/Math.max(1,deltaInfo.fullBytes))*100)):0;
  const deltaPct=deltaInfo?Math.max(3,Math.round(deltaInfo.deltaBytes/Math.max(1,deltaInfo.fullBytes)*100)):0;

  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Feature Evaluation Lab</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section>
  <section className="export">
    <div className="card"><h2>Release 导出</h2>
      <div className="list">{releases.map(release=><button key={release.id} className={release.id===releaseId?'active':''} onClick={()=>setReleaseId(release.id)}>{release.name}<br/><small>{release.id}</small></button>)}</div>
      <div className="toolbar"><button className="primary" onClick={exportSnapshot} disabled={!releaseId}><FileDown size={15}/>导出快照</button></div>
      {task&&<p className="task">任务 {task.id} · {task.status}{task.error?` · ${task.error}`:''}{(task.status==='pending'||task.status==='running')&&<button className="link" onClick={cancelTask}><XCircle size={14}/>取消</button>}</p>}
      {exportInfo&&<p className="ok">已导出 {exportInfo.snapshot.snapshotId}<br/><small>根摘要 {exportInfo.snapshot.rootDigest.slice(0,16)}… · {Object.keys(exportInfo.snapshot.objects).length} 个对象 · {formatBytes(exportInfo.sizeBytes)}</small></p>}
    </div>
    <div className="card"><h2>快照基线 / 目标</h2>
      {snapshots.length===0&&<p className="dim">该 release 还没有快照，请先导出。</p>}
      <label>基线<select value={baseId} onChange={event=>changeBase(event.target.value)}>{snapshots.map(s=><option key={s.snapshotId} value={s.snapshotId}>{s.snapshotId} · {s.rootDigest.slice(0,8)}</option>)}</select></label>
      <label>目标<select value={targetId} onChange={event=>changeTarget(event.target.value)}>{snapshots.map(s=><option key={s.snapshotId} value={s.snapshotId}>{s.snapshotId} · {s.rootDigest.slice(0,8)}</option>)}</select></label>
      <div className="toolbar"><button className="primary" onClick={generateDelta} disabled={!baseId||!targetId}><GitCompareArrows size={15}/>生成增量</button></div>
    </div>
    <div className="card"><h2>全量 vs 增量</h2>
      {!deltaInfo&&<p className="dim">生成增量后在此比较体积。</p>}
      {deltaInfo&&<>
        <div className="sizebar" title="delta / full"><span style={{width:deltaPct+'%'}}/></div>
        <p>全量 {formatBytes(deltaInfo.fullBytes)} → 增量 {formatBytes(deltaInfo.deltaBytes)}（节省 {savings}%）</p>
        <p><small>{deltaInfo.delta.ops.length} 个操作 · 基线 {deltaInfo.delta.base.snapshotId} → 目标 {deltaInfo.delta.target.snapshotId}</small></p>
      </>}
    </div>
    <div className="card"><h2>模拟应用</h2>
      <p className="dim">在本地验证基线身份与完整性，应用后校验目标根摘要；失败时原快照保持不变。</p>
      <div className="toolbar"><button onClick={simulate} disabled={!deltaInfo||!baseId}><ShieldCheck size={15}/>模拟应用</button></div>
      {sim&&<p className={sim.ok?'ok':'err'}>{sim.text}</p>}
    </div>
  </section></main>;
}
