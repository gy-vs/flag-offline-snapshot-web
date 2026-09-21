# Feature Evaluation Lab

Local workbench for evaluation rules.

Run `npm install`, then `npm run dev`.

## Offline snapshot export & delta packages

The server exports evaluation snapshots (spec config, cohorts, flags and the
dependency topology, each with a content digest) bound to a release, and
generates delta packages between two snapshots. Deltas list additions,
replacements and removals by object identity. Clients verify baseline identity
and integrity before applying, and verify the target root digest afterwards;
application is atomic — it either yields the complete target snapshot or
leaves the original untouched.

- `POST /api/releases/:id/exports` — async snapshot export task
- `POST /api/releases/:id/deltas` — async delta generation task (`{baseSnapshotId, targetSnapshotId}`)
- `GET /api/tasks/:id` / `POST /api/tasks/:id/cancel` / `GET /api/tasks/:id/artifact` — task polling, cancellation, artifact download
- `GET /api/releases/:id/snapshots` / `GET /api/snapshots/:id` — snapshot summaries and full snapshots
- `DELETE /api/cohorts/:id` — refuses (`409 cohort_in_use`) while still referenced

The frontend compares full vs. delta sizes, simulates delta application
locally, and guards against stale generation tasks overwriting newer
selections.

Run `npm test` for the scenario suite (reordering, shared cohorts, dangling
deletes, baseline mismatch, truncation, duplicate application, version
upgrade, cancellation).
