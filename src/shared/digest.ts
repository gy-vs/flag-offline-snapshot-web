import {canonicalJson, sha256Hex} from './encode';
import type {ContentObject, ObjectMap, TopologyEdge} from './types';

/**
 * Content digest of a single object.
 *
 * The object id and kind participate so that moving content under a different
 * identity is detected. The format version participates too: a v1→v2 upgrade
 * changes the wire representation and therefore must appear as a replacement
 * even when authored content is unchanged. Array order inside the object is
 * significant (rule order is evaluation order); object collection order is
 * handled by callers sorting ids before digesting the map.
 */
export async function digestObject(object: ContentObject, formatVersion: number): Promise<string> {
  return sha256Hex(canonicalJson({formatVersion, kind: object.kind, id: object.id, data: dataOf(object)}));
}

function dataOf(object: ContentObject): Omit<ContentObject, 'kind' | 'id'> {
  const {kind: _kind, id: _id, ...data} = object;
  return data;
}

/**
 * Derive the dependency topology from the objects themselves. The topology is
 * never transmitted separately — both sides recompute it, so it cannot be
 * desynchronised from the content.
 */
export function deriveTopology(objects: ObjectMap): TopologyEdge[] {
  const edges: TopologyEdge[] = [];
  for (const object of objects.values()) {
    if (object.kind !== 'flag') continue;
    for (const rule of object.rules) {
      if (rule.segmentId) edges.push({from: object.id, to: rule.segmentId});
    }
  }
  return edges
    .filter((edge, index, all) => all.findIndex((e) => e.from === edge.from && e.to === edge.to) === index)
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
}

export class ReferenceError_ extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReferenceError';
  }
}

/**
 * Verify every edge points at an existing segment and every object reference is
 * well formed. Used before sealing a snapshot and after assembling an applied
 * delta, so a delta that removes a still-referenced segment can never land.
 */
export function checkReferences(objects: ObjectMap, edges: TopologyEdge[] = deriveTopology(objects)): void {
  for (const edge of edges) {
    const target = objects.get(edge.to);
    if (!target) throw new ReferenceError_(`object '${edge.from}' references missing object '${edge.to}'`);
    if (target.kind !== 'segment') throw new ReferenceError_(`flag '${edge.from}' references '${edge.to}', which is not a segment`);
    if (!objects.has(edge.from)) throw new ReferenceError_(`edge starts at missing flag '${edge.from}'`);
  }
}

export type RootDigestInput = {
  label: string;
  releaseId: string;
  sequence: number;
  formatVersion: number;
  objects: Array<{id: string; digest: string}>;
  topology: TopologyEdge[];
};

/**
 * Root digest: binds the whole snapshot to a release, a sequence, a format
 * version, every object digest, and the derived topology. Sorted object ids
 * mean pure reordering produces the identical snapshot.
 */
export async function computeRootDigest(input: RootDigestInput): Promise<string> {
  const objects = input.objects.map((entry) => ({id: entry.id, digest: entry.digest})).sort((a, b) => a.id.localeCompare(b.id));
  return sha256Hex(canonicalJson({root: input.label, releaseId: input.releaseId, sequence: input.sequence, formatVersion: input.formatVersion, objects, topology: input.topology}));
}
