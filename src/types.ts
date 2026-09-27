export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';
export type FieldSource = RecordGroup | 'combine';

export interface FieldDecision {
  source: FieldSource;
  kept: string;
  dropped: string;
  reason: string;
}

export interface FieldReview {
  choices: Partial<Record<FieldKey, FieldSource>>;
  reasons: Partial<Record<FieldKey, string>>;
  reviewedAt: string;
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
  fieldSources?: Partial<Record<FieldKey, FieldDecision>>;
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
  fieldReview?: FieldReview;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  mergedId: string;
  chosen: Partial<Record<FieldKey, FieldSource>>;
  values: Partial<Record<FieldKey, string>>;
  decisions: Partial<Record<FieldKey, FieldDecision>>;
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
