import {useCallback, useEffect, useRef, useState} from 'react';
import {Archive, ArrowDownUp, Ban, CheckCircle2, Download, Play, XCircle} from 'lucide-react';
import {applyDelta, DeltaError, parseDeltaPackage, sealDelta, serializeDelta, type DeltaEnvelope} from '../shared/delta';
import {canonicalJson, sha256Hex, shortFingerprint} from '../shared/encode';
import type {SnapshotEnvelope} from '../shared/snapshot';
import type {ContentObject, FormatVersion} from '../shared/types';
import {useGeneration} from './hooks/useGeneration';

type Release = {releaseId: string; name: string; draftObjects: number; latestSequence: number | null};
type SnapshotInfo = {sequence: number; formatVersion: FormatVersion; rootDigest: string; createdAt: string; size: number};
type FaultKind = '' | 'truncate' | 'wrongBaseline' | 'dropSharedSegment' | 'futureVersion';

type DeltaResult = {
  jobId: string;
  pkg: DeltaEnvelope;
  deltaBytes: number;
  fullBytes: number;
  counts: {added: number; replaced: number; deleted: number};
};

type ApplyState =
  | {status: 'idle'}
  | {status: 'ok'; repeated: boolean; rootDigest: string; sequence: number}
  | {status: 'error'; code: string; message: string; baselineKept: boolean};

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

export default function SnapshotPanel() {
  const [releases, setReleases] = useState<Release[]>([]);
  const [releaseId, setReleaseId] = useState('rel-prod');
  const [objects, setObjects] = useState<ContentObject[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [format, setFormat] = useState<FormatVersion>(2);
  const [baselineSeq, setBaselineSeq] = useState(1);
  const [targetSeq, setTargetSeq] = useState(2);
  const [fault, setFault] = useState<FaultKind>('');
  const [simulated, setSimulated] = useState<DeltaResult | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>({status: 'idle'});
  const [notice, setNotice] = useState('');
  const jobIdRef = useRef<string | null>(null);

  const deltaGen = useGeneration<DeltaResult>();

  const refreshReleases = useCallback(async () => {
    const response = await fetch('/api/workbench/releases');
    const body = (await response.json()) as {releases: Release[]};
    setReleases(body.releases);
  }, []);

  useEffect(() => {
    void refreshReleases();
  }, [refreshReleases]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [draft, list] = await Promise.all([
        fetch(`/api/workbench/releases/${releaseId}/draft`).then((r) => r.json()),
        fetch(`/api/workbench/releases/${releaseId}/snapshots`).then((r) => r.json()),
      ]);
      if (cancelled) return;
      setObjects(draft.objects);
      setSnapshots(list.snapshots);
      setSimulated(null);
      setApplyState({status: 'idle'});
    })();
    return () => {
      cancelled = true;
    };
  }, [releaseId]);

  async function persistDraft(next: ContentObject[]) {
    setObjects(next);
    setNotice('Draft saved');
    await fetch(`/api/workbench/releases/${releaseId}/draft`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({objects: next}),
    });
    void refreshReleases();
  }

  function move(index: number, delta: number) {
    const next = [...objects];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void persistDraft(next);
  }

  function removeObject(id: string) {
    void persistDraft(objects.filter((object) => object.id !== id));
  }

  async function exportSnapshot() {
    setNotice('Exporting…');
    const response = await fetch(`/api/workbench/releases/${releaseId}/snapshots`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({formatVersion: format}),
    });
    if (!response.ok) {
      const body = await response.json();
      setNotice(`Export rejected: ${body.message ?? body.error}`);
      return;
    }
    const body = await response.json();
    setNotice(`Exported seq ${body.envelope.sequence} (v${format}) bound to ${releaseId}, root ${shortFingerprint(body.envelope.rootDigest)}`);
    const list = await fetch(`/api/workbench/releases/${releaseId}/snapshots`).then((r) => r.json());
    setSnapshots(list.snapshots);
    void refreshReleases();
  }

  const generateDelta = useCallback(async () => {
    setSimulated(null);
    setApplyState({status: 'idle'});
    setNotice('');
    const result = await deltaGen.run(async () => {
      // client-chosen jobId so it can cancel the server generation
      const jobId = `ui-${releaseId}-${baselineSeq}-${targetSeq}-${Date.now()}`;
      jobIdRef.current = jobId;
      const response = await fetch(`/api/workbench/releases/${releaseId}/delta-jobs`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jobId, fromSequence: baselineSeq, toSequence: targetSeq, delayMs: 1200}),
      });
      if (response.status === 499) throw new Error('server generation was cancelled');
      if (!response.ok) throw new Error((await response.json()).message ?? 'generation failed');
      const body = await response.json();
      const pkg = body.delta as DeltaEnvelope;
      const full = await fetch(`/api/workbench/releases/${releaseId}/snapshots/${pkg.target.sequence}`).then((r) => r.json());
      return {
        jobId,
        pkg,
        deltaBytes: body.size,
        fullBytes: JSON.stringify(full.envelope).length,
        counts: body.counts,
      };
    });
    if (result.status === 'completed') setSimulated(result.value);
    else if (result.status === 'cancelled') setNotice('Generation cancelled');
    else if (result.status === 'superseded') setNotice('Older generation discarded — newer selection wins');
    else if (result.status === 'failed') setNotice(`Generation failed: ${result.error}`);
  }, [baselineSeq, deltaGen, releaseId, targetSeq]);

  async function fetchTargetSnapshot(pkg: DeltaEnvelope): Promise<SnapshotEnvelope> {
    const response = await fetch(`/api/workbench/releases/${releaseId}/snapshots/${pkg.target.sequence}`);
    return (await response.json()).envelope;
  }

  async function cancelGeneration() {
    const jobId = jobIdRef.current;
    deltaGen.cancel();
    if (jobId) await fetch(`/api/workbench/delta-jobs/${jobId}/cancel`, {method: 'POST'}).catch(() => undefined);
  }

  async function simulateApply() {
    if (!simulated) return;
    setApplyState({status: 'idle'});
    // For the wrong-baseline fault, deliberately pick a different exported snapshot.
    const wrongSeq = snapshots.map((s) => s.sequence).find((sequence) => sequence !== baselineSeq) ?? baselineSeq;
    const chosenSeq = fault === 'wrongBaseline' ? wrongSeq : baselineSeq;
    const baseline = await fetch(`/api/workbench/releases/${releaseId}/snapshots/${chosenSeq}`).then((r) => r.json());
    const baselineEnv = baseline.envelope as SnapshotEnvelope;
    const snapshotBefore = JSON.stringify(baselineEnv);
    try {
      let pkg = simulated.pkg;
      if (fault === 'truncate') {
        pkg = parseDeltaPackage(serializeDelta(pkg).slice(0, 200));
      }
      if (fault === 'dropSharedSegment') {
        // sealed valid package whose delta deletes a segment still referenced
        const body = {...pkg.delta, deleted: [...pkg.delta.deleted, 'seg-canary'].sort(), deltaDigest: ''};
        body.deltaDigest = await sha256Hex(
          canonicalJson({
            label: body.label,
            releaseId: body.releaseId,
            formatVersion: body.formatVersion,
            baseline: body.baseline,
            target: body.target,
            added: body.added,
            replaced: body.replaced,
            deleted: body.deleted,
          }),
        );
        pkg = await sealDelta(body);
      }
      if (fault === 'futureVersion') {
        pkg = await sealDelta({...pkg.delta, formatVersion: 99 as FormatVersion});
      }
      const outcome = await applyDelta(baselineEnv, pkg);
      const target = await fetchTargetSnapshot(simulated.pkg);
      const verified = outcome.envelope.rootDigest === target.rootDigest;
      if (!verified) throw new DeltaError('target_mismatch', 'assembled snapshot does not equal the target snapshot');
      setApplyState({
        status: 'ok',
        repeated: outcome.status === 'already_applied',
        rootDigest: outcome.envelope.rootDigest,
        sequence: outcome.envelope.sequence,
      });
    } catch (error) {
      setApplyState({
        status: 'error',
        code: error instanceof DeltaError ? error.code : 'invalid_package',
        message: error instanceof Error ? error.message : String(error),
        baselineKept: JSON.stringify(baselineEnv) === snapshotBefore,
      });
    }
  }

  const running = deltaGen.state.status === 'running';

  return (
    <section className="pane snapshot-pane">
      <h2><Archive size={16}/> Offline snapshot export</h2>

      <div className="form-grid">
        <label>
          Release binding
          <select value={releaseId} onChange={(event) => setReleaseId(event.target.value)}>
            {releases.map((release) => (
              <option key={release.releaseId} value={release.releaseId}>{release.name} ({release.releaseId})</option>
            ))}
          </select>
        </label>
        <label>
          Export format
          <select value={format} onChange={(event) => setFormat(Number(event.target.value) as FormatVersion)}>
            <option value={1}>v1 (legacy)</option>
            <option value={2}>v2 (current)</option>
          </select>
        </label>
      </div>

      <h3>Draft objects ({objects.length})</h3>
      <div className="object-list">
        {objects.map((object, index) => (
          <div className="object-row" key={object.id}>
            <span className={`kind kind-${object.kind}`}>{object.kind}</span>
            <span className="object-id">{object.id}</span>
            <small>rev {object.revision}</small>
            <span className="row-actions">
              <button title="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowDownUp size={13} className="flip"/></button>
              <button title="Move down" disabled={index === objects.length - 1} onClick={() => move(index, 1)}><ArrowDownUp size={13}/></button>
              <button title="Delete" onClick={() => removeObject(object.id)}><XCircle size={13}/></button>
            </span>
          </div>
        ))}
      </div>
      <div className="toolbar">
        <button className="primary" onClick={exportSnapshot}><Download size={15}/>Export snapshot</button>
      </div>

      <h3>Exported snapshots</h3>
      <div className="snapshot-list">
        {snapshots.length === 0 && <small>No exports yet.</small>}
        {snapshots.map((snapshot) => (
          <div className="snapshot-row" key={snapshot.sequence}>
            <span className="pill">seq {snapshot.sequence}</span>
            <span className="pill">v{snapshot.formatVersion}</span>
            <code title={snapshot.rootDigest}>{shortFingerprint(snapshot.rootDigest)}</code>
            <small>{formatBytes(snapshot.size)}</small>
          </div>
        ))}
      </div>

      <h3>Incremental package</h3>
      <div className="form-grid">
        <label>Baseline seq<input type="number" min={1} value={baselineSeq} onChange={(e) => setBaselineSeq(Number(e.target.value))}/></label>
        <label>Target seq<input type="number" min={1} value={targetSeq} onChange={(e) => setTargetSeq(Number(e.target.value))}/></label>
      </div>
      <div className="toolbar">
        <button className="primary" disabled={running} onClick={generateDelta}><Play size={15}/>{running ? 'Generating…' : 'Generate delta'}</button>
        <button disabled={!running} onClick={cancelGeneration}><Ban size={15}/>Cancel</button>
      </div>

      <h3>Fault simulation</h3>
      <select value={fault} onChange={(event) => setFault(event.target.value as FaultKind)}>
        <option value="">no fault — happy path</option>
        <option value="truncate">truncate delta package</option>
        <option value="wrongBaseline">apply on wrong baseline</option>
        <option value="dropSharedSegment">delete still-referenced segment</option>
        <option value="futureVersion">future format version</option>
      </select>

      {simulated && (
        <div className="delta-report">
          <h3>Full vs incremental</h3>
          <div className="size-bars">
            <SizeBar label="Full target snapshot" bytes={simulated.fullBytes} max={simulated.fullBytes}/>
            <SizeBar label="Delta package" bytes={simulated.deltaBytes} max={simulated.fullBytes}/>
          </div>
          <small>
            +{simulated.counts.added} added · ~{simulated.counts.replaced} replaced · −{simulated.counts.deleted} deleted
          </small>
          <div className="toolbar">
            <button className="primary" onClick={simulateApply}><CheckCircle2 size={15}/>Simulate apply</button>
            <button onClick={simulateApply}>Apply again (idempotency)</button>
          </div>
        </div>
      )}

      {applyState.status === 'ok' && (
        <div className="result result-ok">
          <CheckCircle2 size={15}/>
          {applyState.repeated ? 'Already applied — no change (idempotent)' : 'Applied: complete target snapshot verified'}
          <code>seq {applyState.sequence} · {shortFingerprint(applyState.rootDigest)}</code>
        </div>
      )}
      {applyState.status === 'error' && (
        <div className="result result-error">
          <XCircle size={15}/>
          Rejected: <strong>{applyState.code}</strong> — {applyState.message}
          <small>{applyState.baselineKept ? 'Original snapshot left unchanged (atomic).' : 'WARNING: baseline was modified'}</small>
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
    </section>
  );
}

function SizeBar({label, bytes, max}: {label: string; bytes: number; max: number}) {
  const pct = Math.max(4, Math.round((bytes / Math.max(1, max)) * 100));
  return (
    <div className="size-row">
      <span>{label}</span>
      <div className="bar"><i style={{width: `${pct}%`}}/></div>
      <strong>{formatBytes(bytes)}</strong>
    </div>
  );
}
