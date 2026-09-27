export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

/** 低于该分数的候选必须逐字段看过冲突并选好保留侧，才允许确认 */
export const LOW_SCORE_GATE = 0.68;

/** 冲突字段忽略另一侧时可选用的留档原因（另可自定义） */
export const IGNORE_REASONS = [
  '另一侧为转录笔误',
  '另一侧信息不完整',
  '另一侧为重复登记',
  '以更权威来源为准',
  '日期/编号经原件核对有误',
  '人工核对后判定不采用'
] as const;

/** 单个字段的核对处置：保留了哪一侧、为什么忽略另一侧 */
export interface FieldResolution {
  source: RecordGroup | 'combine';
  ignoreReason: string;
  resolvedAt: string;
}

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
  /** 合并生成记录的逐字段来源与忽略原因留档 */
  fieldProvenance?: Partial<Record<FieldKey, FieldResolution>>;
  provenanceMergeId?: string;
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
  /** 低分候选逐字段核对结果；冲突字段全部处置过才允许确认 */
  resolutions?: Partial<Record<FieldKey, FieldResolution>>;
  /** 是否已在字段对照里完成把关（看过所有冲突字段并选好保留侧） */
  gateClearedAt?: string;
}

/** 合并留档：每个字段最终值、来源和忽略原因 */
export interface FieldTraceEntry extends FieldResolution {
  kept: string;
  ignoredSide: RecordGroup | 'none';
  ignoredValue: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  fieldTrace: Partial<Record<FieldKey, FieldTraceEntry>>;
  mergedRecordId?: string;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
}

export interface ArchiveState {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}
