# Feature Evaluation Lab

Local workbench for evaluation rules, with offline snapshot export and incremental packages for the offline client.

Run `npm install`, then `npm run dev`.

## Offline snapshots

Shared code lives in `src/shared/` and runs on both the server exporter and the client applier:

- `shared/digest.ts` — canonical JSON + SHA-256 content digests. Per-object digests cover the
  object's identity (`id`, `kind`) and its **format version**; the root digest binds the release
  id, sequence, format version, every object digest and the derived dependency topology. Object
  collection order is sorted, so reordering never changes a digest.
- `shared/snapshot.ts` — build, migrate and verify snapshots. References are derived from flag
  rules, so the topology cannot be desynchronised from content.
- `shared/delta.ts` — deltas list `added` / `replaced` / `deleted` objects by identity, sealed by
  both an inner delta digest and an outer package digest. `applyDelta` is **atomic**:
  1. verify the outer package seal (truncated/corrupt bytes are rejected),
  2. refuse formats newer than the client supports,
  3. verify the inner delta digest and the baseline snapshot (identity + integrity),
  4. build a candidate on a copy, re-check references and the target root digest — the caller's
     snapshot is only replaced after full verification,
  5. applying the same delta again is an idempotent no-op (`already_applied`).

  The result is either the complete target snapshot, or the original snapshot untouched.
- `shared/generation.ts` — generation gate: beginning a newer selection supersedes the in-flight
  generation (its result can never overwrite the newer choice), and generations are cancellable
  through `AbortSignal`.

### Server

`GET/PUT /api/workbench/releases/:id/draft`, `POST .../snapshots` (bound to the release, with
`formatVersion` 1 or 2), `GET .../snapshots/:seq`, and `POST .../delta-jobs` plus
`POST /api/workbench/delta-jobs/:jobId/cancel`. Exporting a draft that deletes a segment still
referenced by a flag fails with `409 reference_broken`.

### UI

The **Offline export** tab lets you reorder/delete draft objects, export at v1 or v2, compare full
snapshot size vs delta size, generate/cancel delta generations, and simulate application —
including fault injection for truncation, wrong baseline, deleting a referenced segment and future
format versions.

## Tests

`npm test` — core scenarios: object reordering, shared segments, deleting referenced objects,
baseline mismatch, truncated deltas, repeated application, v1→v2 upgrade, and cancellation/stale
generation; plus workbench HTTP API tests.
