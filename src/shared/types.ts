// Content model for the feature rule workbench.
//
// A workspace configuration is made of independent objects:
//   - flags      : evaluation rule specifications ("规范配置")
//   - segments   : reusable audiences ("分群"), shared by multiple flags
// References from flags to segments form the dependency topology ("依赖拓扑").
// Objects are addressed by stable ids; reordering objects never changes a digest.

export type RuleDef = {
  id: string;
  segmentId?: string;
  enabled: boolean;
  value: unknown;
};

export type FlagContent = {
  kind: 'flag';
  id: string;
  name: string;
  revision: number;
  rules: RuleDef[];
  // v2 addition; absent on v1 content.
  defaultVariant?: string;
};

export type SegmentContent = {
  kind: 'segment';
  id: string;
  name: string;
  revision: number;
  // v2 addition; absent on v1 content.
  match?: string;
};

export type ContentObject = FlagContent | SegmentContent;

export type FormatVersion = 1 | 2;
export const MIN_FORMAT: FormatVersion = 1;
export const CURRENT_FORMAT: FormatVersion = 2;

export type ObjectMap = ReadonlyMap<string, ContentObject>;

/** One dependency edge: flag (from) references segment (to). */
export type TopologyEdge = { from: string; to: string };
