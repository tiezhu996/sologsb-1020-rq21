import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Modal, Tabs } from '@qwik-ui/headless';
import type {
  ArchiveRecord, ArchiveState, FieldKey, FieldResolution, MatchCandidate, MergeResult, RecordGroup
} from './types';
import { computeMatches, fieldValue, scorePair } from './utils/matching';
import { seedState } from './data/seed';
import { IGNORE_REASONS, LOW_SCORE_GATE } from './types';

const STORAGE_KEY = 'sologsb-1020-archive-state-v1';
const SAME_FIELD_REASON = '两侧内容一致，直接沿用';
const fieldLabels: Array<[FieldKey, string]> = [
  ['title', '标题'], ['date', '日期'], ['people', '人物'], ['places', '地点'], ['identifier', '编号'],
  ['medium', '载体'], ['extent', '数量'], ['rights', '权利'], ['notes', '备注']
];

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};

/** 两侧取值不同的字段，即核对人必须看过并处置的冲突字段 */
const conflictFields = (state: ArchiveState, match: MatchCandidate): FieldKey[] => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  if (!left || !right) return [];
  return fieldLabels
    .map(([field]) => field)
    .filter((field) => fieldValue(left, field) !== fieldValue(right, field));
};

/** 低分候选：冲突字段是否都已看过、选好保留侧并写明忽略原因 */
const pendingConflictFields = (state: ArchiveState, match: MatchCandidate): FieldKey[] => {
  if (match.score >= LOW_SCORE_GATE) return [];
  return conflictFields(state, match).filter((field) => {
    const resolution = match.resolutions?.[field];
    return !resolution || !resolution.ignoreReason.trim();
  });
};

const isGateCleared = (state: ArchiveState, match: MatchCandidate) =>
  pendingConflictFields(state, match).length === 0;

/** 合并追溯列表，独立组件以便 merges 变化时整体重新求值渲染 */
const MergeTraceList = component$((props: { merges: MergeResult[]; records: ArchiveRecord[] }) => {
  const find = (id?: string) => (id ? props.records.find((record) => record.id === id) : undefined);
  if (!props.merges.length) {
    return <div class="empty-state">还没有合并记录。完成一次字段合并后，逐字段来源与忽略原因会出现在这里。</div>;
  }
  return <>
    {props.merges.map((merge) => {
      const left = find(merge.leftId);
      const right = find(merge.rightId);
      const merged = find(merge.mergedRecordId);
      return (
        <details class="merge-log" key={merge.id}>
          <summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary>
          <p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}{merged ? ` · 生成记录：${merged.title}` : ''}</p>
          <ul>
            {fieldLabels.map(([field, label]) => {
              const trace = merge.fieldTrace?.[field];
              const choice = merge.chosen[field];
              if (!trace && !choice) return null;
              const source = trace?.source ?? choice;
              const sourceLabel = source === 'A' ? 'A 来源' : source === 'B' ? 'B 来源' : '双来源拼接';
              return (
                <li key={field}>
                  <strong>{label}<span class={`source-tag ${source}`}>{sourceLabel}</span></strong>
                  <span>{trace?.kept ?? merge.values[field] ?? '—'}</span>
                  {trace && trace.ignoredSide !== 'none' && <span class="ignored-line">忽略 {trace.ignoredSide} 侧：{trace.ignoredValue || '—'} · 原因：{trace.ignoreReason}</span>}
                  {trace && trace.ignoredSide === 'none' && <span class="ignored-line">原因：{trace.ignoreReason}</span>}
                </li>
              );
            })}
          </ul>
        </details>
      );
    })}
  </>;
});

/** 渲染前由 main.tsx 从 localStorage 读入的初始状态（仅 CSR 挂载时恢复一次） */
export const loadInitialState = (): ArchiveState => {
  const base = seedState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...base, hydrated: true };
    const saved = JSON.parse(raw) as Partial<ArchiveState>;
    return {
      ...base,
      revision: saved.revision ?? base.revision,
      records: saved.records ?? base.records,
      matches: saved.matches ?? base.matches,
      merges: saved.merges ?? base.merges,
      audit: saved.audit ?? base.audit,
      activeMatchId: saved.activeMatchId ?? base.activeMatchId,
      selectedRecordIds: saved.selectedRecordIds ?? base.selectedRecordIds,
      hydrated: true
    };
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return { ...base, hydrated: true };
  }
};

export default component$(() => {
  const state = useStore<ArchiveState>(typeof window === 'undefined' ? seedState() : loadInitialState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);
  /** 正在逐字段核对的低分匹配，用于把同一条的多次处置合并成一次撤销步 */
  const gateSessionId = useSignal('');
  const customReason = useSignal<Record<string, string>>({});
  /** merges 变化版本号：驱动懒加载的「合并追溯」面板重渲染 */
  const mergesVersion = useSignal(0);

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit
  });

  const capture = () => {
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
  };

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 2800);
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    if (state.audit.length > 300) state.audit.splice(300);
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    future.value = [...future.value, snapshot()];
    history.value = history.value.slice(0, -1);
    restore(raw);
    gateSessionId.value = '';
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    history.value = [...history.value, snapshot()];
    future.value = future.value.slice(0, -1);
    restore(raw);
    gateSessionId.value = '';
  });

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));

  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < LOW_SCORE_GATE).length);

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });
  const mergeReasons = useStore<Record<FieldKey, string>>({
    title: '', date: '', people: '', places: '', identifier: '', medium: '', extent: '', rights: '', notes: ''
  });

  /**
   * 写入一个冲突字段的核对处置。reason 为空时点保留侧的入口会先带入预置原因，
   * 核对人随后可在下拉里改选或自定义。
   */
  const setFieldResolution = $((matchId: string, field: FieldKey, source: RecordGroup, reason?: string) => {
    const match = state.matches.find((item) => item.id === matchId);
    if (!match || match.status !== 'suggested') return;
    const existing = match.resolutions?.[field];
    const finalReason = (reason ?? '').trim()
      || existing?.ignoreReason?.trim()
      || mergeReasons[field]?.trim()
      || IGNORE_REASONS[0];
    // 同一条匹配的连续字段处置只记一次撤销步
    if (gateSessionId.value !== matchId) {
      capture();
      gateSessionId.value = matchId;
    }
    if (!match.resolutions) match.resolutions = {};
    const resolution: FieldResolution = { source, ignoreReason: finalReason, resolvedAt: new Date().toISOString() };
    match.resolutions[field] = resolution;
    match.gateClearedAt = undefined;
    const remaining = pendingConflictFields(state, match);
    if (!remaining.length) {
      match.gateClearedAt = new Date().toISOString();
      const labels = conflictFields(state, match).map((key) => fieldLabels.find(([key2]) => key2 === key)?.[1]).join('、');
      commit('低分匹配字段核对', `已核对全部冲突字段（${labels || '无冲突'}）并选定保留侧，允许确认`, [match.leftId, match.rightId]);
      notify(`冲突字段已全部核对（${conflictFields(state, match).length} 个），现在可以确认`);
    }
  });

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    if (status === 'confirmed' && match.status === 'suggested' && !isGateCleared(state, match)) {
      const pending = pendingConflictFields(state, match);
      const labels = pending.map((field) => fieldLabels.find(([key]) => key === field)?.[1]).join('、');
      panelTab.value = 0;
      notify(`匹配分低于 68%：请先在字段对照中核对 ${pending.length} 个冲突字段（${labels}）并选定保留侧`);
      return;
    }
    gateSessionId.value = '';
    capture();
    match.status = status;
    match.reviewedAt = new Date().toISOString();
    state.records.forEach((record) => {
      if ((record.id === match.leftId || record.id === match.rightId) && status === 'confirmed') record.status = 'confirmed';
    });
    if (status === 'confirmed') {
      const cleared = match.score < LOW_SCORE_GATE;
      commit(
        '确认匹配',
        cleared
          ? `低分候选已完成字段把关后确认（核对于 ${new Date(match.gateClearedAt ?? '').toLocaleString('zh-CN')}）：${matchLabel(state, match)}`
          : matchLabel(state, match),
        [match.leftId, match.rightId]
      );
      notify(cleared ? '已确认：字段核对结果随匹配一并留档' : '已确认此项匹配');
    } else {
      commit('忽略可疑匹配', matchLabel(state, match), [match.leftId, match.rightId]);
      notify('已忽略此项匹配');
    }
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const requested = selectedMatchIds.value;
    if (!requested.length) return;
    // 批量确认：尚未完成字段把关的低分候选一律跳过
    const skipped = status === 'confirmed'
      ? requested.filter((id) => {
        const match = state.matches.find((item) => item.id === id);
        return !!match && match.status === 'suggested' && !isGateCleared(state, match);
      })
      : [];
    const ids = requested.filter((id) => !skipped.includes(id))
      .filter((id) => state.matches.find((item) => item.id === id)?.status === 'suggested');
    if (!ids.length) {
      notify(`已跳过 ${skipped.length} 条未完成字段核对的低分候选，未确认任何匹配`);
      return;
    }
    gateSessionId.value = '';
    capture();
    const nowIso = new Date().toISOString();
    ids.forEach((id) => {
      const match = state.matches.find((item) => item.id === id);
      if (!match) return;
      match.status = status;
      match.reviewedAt = nowIso;
      if (status === 'confirmed') {
        state.records.forEach((record) => {
          if (record.id === match.leftId || record.id === match.rightId) record.status = 'confirmed';
        });
      }
    });
    if (status === 'confirmed') {
      commit(
        '批量确认',
        `确认 ${ids.length} 条匹配；跳过 ${skipped.length} 条未在字段对照中核对冲突的低分候选`,
        ids.flatMap((id) => {
          const match = state.matches.find((item) => item.id === id);
          return match ? [match.leftId, match.rightId] : [];
        })
      );
      notify(skipped.length
        ? `已确认 ${ids.length} 条；跳过 ${skipped.length} 条未核对的低分候选（保留勾选）`
        : `已批量确认 ${ids.length} 条匹配`);
    } else {
      commit('批量复核', `${ids.length} 条匹配被标记为忽略`, ids.flatMap((id) => {
        const match = state.matches.find((item) => item.id === id);
        return match ? [match.leftId, match.rightId] : [];
      }));
      notify(`已批量忽略 ${ids.length} 条匹配`);
    }
    // 被跳过的候选保留勾选，方便核对人继续处理
    selectedMatchIds.value = skipped;
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    gateSessionId.value = '';
    fieldLabels.forEach(([field]) => {
      const same = fieldValue(left, field) === fieldValue(right, field);
      const reviewed = match.resolutions?.[field];
      if (reviewed) {
        choices[field] = reviewed.source === 'combine' ? 'combine' : reviewed.source;
        mergeReasons[field] = reviewed.ignoreReason;
      } else if (same) {
        // 一致字段无需取舍，默认沿用 A 并留档原因
        choices[field] = 'A';
        mergeReasons[field] = SAME_FIELD_REASON;
      } else {
        // 冲突字段不替核对人预设保留侧
        choices[field] = 'A';
        mergeReasons[field] = '';
      }
    });
    mergeOpen.value = true;
  });

  const mergeReady = (left: ArchiveRecord, right: ArchiveRecord) => fieldLabels.every(([field]) => {
    const conflicting = fieldValue(left, field) !== fieldValue(right, field);
    // 拼接保留两侧，无需忽略原因；单选一侧必须写明为什么忽略另一侧
    return !conflicting || choices[field] === 'combine' || mergeReasons[field].trim().length > 0;
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    if (!mergeReady(left, right)) {
      notify('还有冲突字段未写明忽略原因，请逐字段补全后再生成合并记录');
      return;
    }
    capture();
    const values: Partial<Record<FieldKey, string>> = {};
    const fieldTrace: NonNullable<MergeResult['fieldTrace']> = {};
    const fieldProvenance: NonNullable<ArchiveRecord['fieldProvenance']> = {};
    fieldLabels.forEach(([field]) => {
      const source = choices[field];
      const conflicting = fieldValue(left, field) !== fieldValue(right, field);
      const reason = mergeReasons[field].trim()
        || (!conflicting ? SAME_FIELD_REASON : source === 'combine' ? '双来源拼接，两侧均保留' : '');
      const leftValue = fieldValue(left, field);
      const rightValue = fieldValue(right, field);
      const pick = source === 'combine'
        ? `${leftValue}；${rightValue}`
        : fieldValue(source === 'A' ? left : right, field);
      values[field] = pick;
      const ignoredSide: RecordGroup | 'none' = !conflicting ? 'none' : source === 'A' ? 'B' : source === 'B' ? 'A' : 'none';
      const resolution: FieldResolution = { source, ignoreReason: reason, resolvedAt: new Date().toISOString() };
      fieldProvenance[field] = resolution;
      fieldTrace[field] = {
        ...resolution,
        kept: pick,
        ignoredSide,
        ignoredValue: ignoredSide === 'A' ? leftValue : ignoredSide === 'B' ? rightValue : ''
      };
      // 把关结果回写到匹配，撤销重做后仍随匹配留档
      if (!match.resolutions) match.resolutions = {};
      match.resolutions[field] = resolution;
    });
    const mergedId = crypto.randomUUID();
    const merged: ArchiveRecord = {
      ...left,
      id: mergedId,
      ...values,
      people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
      places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
      status: 'merged',
      updatedAt: new Date().toISOString(),
      fieldProvenance,
      provenanceMergeId: ''
    };
    // 原地增删，避免整体替换 store 顶层数组导致 Qwik 响应式断链
    state.records.splice(0, state.records.length,
      ...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged);
    state.matches.forEach((item) => {
      if (item.id === match.id) {
        item.status = 'merged';
        item.gateClearedAt = item.gateClearedAt ?? new Date().toISOString();
      }
      else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
    });
    const keptA = fieldLabels.filter(([field]) => choices[field] === 'A').length;
    const keptB = fieldLabels.filter(([field]) => choices[field] === 'B').length;
    const keptBoth = fieldLabels.filter(([field]) => choices[field] === 'combine').length;
    const mergeRecord: MergeResult = {
      id: crypto.randomUUID(),
      matchId: match.id,
      leftId: left.id,
      rightId: right.id,
      chosen: { ...choices },
      values,
      fieldTrace,
      mergedRecordId: mergedId,
      mergedAt: new Date().toISOString()
    };
    merged.provenanceMergeId = mergeRecord.id;
    state.merges.unshift(mergeRecord);
    mergesVersion.value += 1;
    commit('合并两条记录', `保留 ${keptA} 个 A 来源字段、${keptB} 个 B 来源字段${keptBoth ? `、${keptBoth} 个双来源拼接` : ''}；每个冲突字段的忽略原因已逐字段留档`, [left.id, right.id, merged.id]);
    mergeOpen.value = false;
    notify('记录已合并，逐字段来源与忽略原因已写入合并记录和审计轨迹');
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    capture();
    rows.forEach((row) => {
      const record: ArchiveRecord = {
        id: crypto.randomUUID(),
        group: importGroup.value,
        title: row.title || '未命名记录',
        date: row.date || '',
        people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
        places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
        identifier: row.identifier || '',
        medium: row.medium || '',
        extent: row.extent || '',
        rights: row.rights || '',
        notes: row.notes || '',
        updatedAt: new Date().toISOString(),
        status: 'unreviewed'
      };
      state.records.push(record);
    });
    state.matches.splice(0, state.matches.length, ...computeMatches(state.records));
    commit('导入档案记录', `从 ${importGroup.value} 组导入 ${rows.length} 条记录`, []);
    importRaw.value = '';
    importText.value = '';
    importOpen.value = false;
    notify(`已导入 ${rows.length} 条记录并重新匹配`);
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records: state.records, matches: state.matches, merges: state.merges, audit: state.audit }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  useVisibleTask$(({ track }) => {
    const payload = track(() => JSON.stringify({ revision: state.revision, records: state.records, matches: state.matches, merges: state.merges, audit: state.audit }));
    if (state.hydrated) localStorage.setItem(STORAGE_KEY, payload);
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat"><span class="online-dot" />{state.hydrated ? `离线保存 · r${state.revision}` : '正在恢复本地工作区'}</div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} title="低于 68% 且未完成字段核对的候选会被自动跳过" onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <input
                      type="checkbox"
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      checked={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => event.stopPropagation()}
                      onChange$={() => {
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    />
                    <span class={`score ${match.score < LOW_SCORE_GATE ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
                    {match.status === 'suggested' && match.score < LOW_SCORE_GATE && (
                      isGateCleared(state, match)
                        ? <span class="gate-badge cleared">字段已核对</span>
                        : <span class="gate-badge pending">待字段核对 · 剩 {pendingConflictFields(state, match).length}</span>
                    )}
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const match = activeMatch.value!;
                const left = recordById(state, match.leftId);
                const right = recordById(state, match.rightId);
                if (!left || !right) {
                  const merge = state.merges.find((item) => item.matchId === match.id);
                  if (merge) {
                    return <div class="empty-state">该匹配的原始记录已在合并后归档。<br />逐字段来源与忽略原因请见「合并追溯」{merge.mergedAt ? `（${new Date(merge.mergedAt).toLocaleString('zh-CN')}）` : ''}。</div>;
                  }
                  return <div class="empty-state">该匹配的原始记录已在合并后归档，逐字段来源请见「合并追溯」。</div>;
                }
                const lowGate = match.score < LOW_SCORE_GATE && match.status === 'suggested';
                const gateCleared = isGateCleared(state, match);
                const pending = pendingConflictFields(state, match);
                const conflicts = new Set(conflictFields(state, match));
                return <>
                  <div class="active-score"><span>{Math.round(match.score * 100)}</span><div><strong>综合匹配分</strong><small>{match.reasons.join(' · ')}</small></div></div>
                  {lowGate && (
                    <div class={`gate-banner ${gateCleared ? 'cleared' : 'pending'}`}>
                      {gateCleared
                        ? <>冲突字段已全部核对并选定保留侧（{match.gateClearedAt ? new Date(match.gateClearedAt).toLocaleString('zh-CN') : ''}），可以确认。</>
                        : <>匹配分低于 68%：需在下方字段对照中逐个核对 <strong>{pending.length}</strong> 个冲突字段，选定保留侧并写明忽略原因后，才允许确认。</>}
                    </div>
                  )}
                  {match.score < LOW_SCORE_GATE && match.status !== 'suggested' && (
                    <div class={`gate-banner ${match.status === 'confirmed' ? 'cleared' : 'skipped'}`}>
                      {match.status === 'confirmed'
                        ? `此低分候选已于 ${match.reviewedAt ? new Date(match.reviewedAt).toLocaleString('zh-CN') : ''} 完成字段核对后确认。`
                        : match.status === 'merged'
                          ? '此低分候选已逐字段核对并合并，完整来源见「合并追溯」。'
                          : '此低分候选已被忽略，字段核对结果仍保留在匹配记录中。'}
                      {conflicts.size > 0 && (
                        <ul class="gate-summary">
                          {fieldLabels.filter(([field]) => conflicts.has(field)).map(([field, label]) => {
                            const resolution = match.resolutions?.[field];
                            return <li key={field}>{label}：{resolution ? <>保留 {resolution.source} 侧 · {resolution.ignoreReason}</> : '未逐字段处置'}</li>;
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                  {lowGate ? (
                    <div class="gate-compare">
                      <div class="gate-grid-head"><span>字段</span><span>A 来源</span><span>B 来源</span><span>保留侧 / 忽略原因</span></div>
                      {fieldLabels.map(([field, label]) => {
                        const leftValue = fieldValue(left, field) || '—';
                        const rightValue = fieldValue(right, field) || '—';
                        const conflicting = conflicts.has(field);
                        const resolution = match.resolutions?.[field];
                        const customKey = `${match.id}:${field}`;
                        const isCustom = !!resolution && ![...IGNORE_REASONS, SAME_FIELD_REASON].includes(resolution.ignoreReason);
                        return (
                          <div class={`gate-row ${conflicting ? 'conflict' : 'same'} ${resolution ? 'resolved' : ''}`} key={field}>
                            <div class="gate-field"><strong>{label}</strong><small>{conflicting ? '冲突' : '一致'}</small></div>
                            <div class={conflicting ? 'different' : ''}>{leftValue}</div>
                            <div class={conflicting ? 'different' : ''}>{rightValue}</div>
                            <div class="gate-decide">
                              {conflicting ? <>
                                <div class="gate-side">
                                  <button
                                    class={`side-button ${resolution?.source === 'A' ? 'selected' : ''}`}
                                    onClick$={() => setFieldResolution(match.id, field, 'A')}
                                  >留 A</button>
                                  <button
                                    class={`side-button ${resolution?.source === 'B' ? 'selected' : ''}`}
                                    onClick$={() => setFieldResolution(match.id, field, 'B')}
                                  >留 B</button>
                                </div>
                                <select
                                  class="input reason-select"
                                  value={resolution ? (isCustom ? '__custom__' : resolution.ignoreReason) : ''}
                                  onChange$={(event) => {
                                    const value = (event.target as HTMLSelectElement).value;
                                    if (value === '__custom__') {
                                      customReason.value = { ...customReason.value, [customKey]: resolution?.ignoreReason ?? '' };
                                      return;
                                    }
                                    const source = resolution?.source === 'B' ? 'B' : 'A';
                                    mergeReasons[field] = value;
                                    setFieldResolution(match.id, field, source, value);
                                  }}
                                >
                                  <option value="" disabled>选择忽略另一侧的原因…</option>
                                  {IGNORE_REASONS.map((reason) => <option value={reason} key={reason}>{reason}</option>)}
                                  <option value="__custom__">自定义原因…</option>
                                </select>
                                  {(isCustom || (!resolution && (customReason.value[customKey] ?? '') !== '')) ? (
                                    <input
                                      class="input reason-input"
                                      placeholder="填写自定义忽略原因"
                                      value={isCustom ? resolution!.ignoreReason : (customReason.value[customKey] ?? '')}
                                      onInput$={(event) => {
                                        customReason.value = { ...customReason.value, [customKey]: (event.target as HTMLInputElement).value };
                                      }}
                                      onChange$={(event) => {
                                        const value = (event.target as HTMLInputElement).value.trim();
                                        if (!value) return;
                                        const source = resolution?.source === 'B' ? 'B' : 'A';
                                        setFieldResolution(match.id, field, source, value);
                                      }}
                                    />
                                  ) : null}
                                {resolution && <small class="decide-ok">已选保留 {resolution.source} 侧 · {resolution.ignoreReason}</small>}
                              </> : <small class="decide-same">内容一致，合并时沿用并留档</small>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                      {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                    </div>
                  )}
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" disabled={lowGate && !gateCleared} onClick$={() => updateMatch(match.id, 'confirmed')}>{lowGate && !gateCleared ? `先核对 ${pending.length} 个冲突字段` : '确认匹配'}</button><button class="button ghost" onClick$={() => updateMatch(match.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              <MergeTraceList key={mergesVersion.value} merges={state.merges} records={state.records} />
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配（低分候选需先完成字段核对）</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，必须先在字段对照中逐个核对冲突字段、选定保留侧并写明忽略原因，才允许确认。</p>
          <div class="rule-row"><span>1</span><p>低分候选在字段对照中逐字段留痕；批量确认自动跳过未核对项，并写明跳过几条。</p></div>
          <div class="rule-row"><span>2</span><p>每个字段保留 A / B 来源或双来源拼接，忽略另一侧的原因逐字段留档。</p></div>
          <div class="rule-row"><span>3</span><p>字段核对标记、合并来源与审计轨迹一并进入撤销快照，撤销重做后仍保留。</p></div>
          <div class="rule-row"><span>4</span><p>记录列表使用分批窗口渲染，导入大量数据时仍只挂载当前窗口。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。冲突字段必须选好保留侧并写明忽略另一侧的原因；生成的新记录会逐字段留档，撤销重做后标记仍在。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span><span>忽略另一侧的原因</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  const reasonMissing = !same && !mergeReasons[field].trim();
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : reasonMissing ? <small>待写原因</small> : <small>冲突 · 已留档</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><div class="reason-cell"><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button><select
                    class="input reason-field"
                    value={IGNORE_REASONS.includes(mergeReasons[field].trim() as typeof IGNORE_REASONS[number]) ? mergeReasons[field].trim() : mergeReasons[field].trim() ? '__custom__' : ''}
                    onChange$={(event) => {
                      const value = (event.target as HTMLSelectElement).value;
                      if (value !== '__custom__') mergeReasons[field] = value;
                    }}
                  >
                    <option value="" disabled>{same ? '选择或填写原因' : '必填：为什么忽略另一侧'}</option>
                    {IGNORE_REASONS.map((reason) => <option value={reason} key={reason}>{reason}</option>)}
                    <option value="__custom__">自定义（在下方填写）</option>
                  </select><input
                    class="input reason-field"
                    placeholder={IGNORE_REASONS.includes(mergeReasons[field].trim() as typeof IGNORE_REASONS[number]) ? '需自定义时在此填写' : '填写忽略另一侧的原因'}
                    value={IGNORE_REASONS.includes(mergeReasons[field].trim() as typeof IGNORE_REASONS[number]) ? '' : mergeReasons[field]}
                    onInput$={(event) => { mergeReasons[field] = (event.target as HTMLInputElement).value; }}
                  /></div></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!mergeReady(left, right)} onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
