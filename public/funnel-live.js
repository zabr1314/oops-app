// Read only server-produced rolling drafts. Rendering never starts model work.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const panel = $('live-minutes-panel');
  const tab = $('tab-after');
  if (!panel || !tab) return;

  const STATUS = {
    ready: '本轮已完成', pending: '正在整理', paused: '已暂停', ended: '已截止',
    stale: '来源已变化', unavailable: '暂不可用', stopped: '已停止',
  };
  const REASONS = {
    global_call_limit_reached: '已达到本次试跑次数。', call_limit_reached: '已达到本场试跑次数。',
    not_recorded: '尚未收到本场整理记录。', meeting_ended: '会议已结束。',
    consent_invalid: '本场云保存授权需要重新核对。', transcript_expired: '原话保存期限已到。',
    scope_withdrawn: '本场已停止授权实时整理。', source_unavailable: '原话暂不可读取。',
    source_changed: '原话来源已变化。', source_changed_before_request: '生成前原话发生变化。',
    source_changed_after_request: '生成后原话发生变化，结果需重新核对。',
    source_read_failed: '读取原话失败。', draft_read_failed: '读取草稿失败。',
    sol_model_unavailable: 'Sol 暂不可用。', sol_model_required: '本场模型配置需要核对。',
    unexpected_model: '模型回包与本场配置不一致。', worker_interrupted: '整理过程曾中断，需要核对处理状态。',
    model_result_unconfirmed: '本轮结果尚未得到确认，已停止继续调用。',
    source_already_attempted: '本段已处理过，已停止重复调用。',
    input_budget_exceeded: '本轮原话超出处理容量。', single_source_exceeds_budget: '单段原话超出处理容量。',
    source_too_large: '本场原话超出读取容量。', result_capacity_exceeded: '本轮整理事项超出容量。',
    invalid_or_oversize_result: '本轮结果格式或容量需要核对。', invalid_result_item: '本轮事项格式需要核对。',
    unbound_result_item: '本轮事项缺少有效原话依据。', missing_result_category: '本轮结果缺少必要类别。',
    empty_result_item: '本轮事项内容需要核对。', invalid_sources: '原话格式需要核对。',
    invalid_source: '原话来源需要核对。', invalid_review: '原话核对记录需要核对。',
    invalid_speaker: '说话人记录需要核对。', invalid_id: '原话标识需要核对。',
    invalid_patch_result: '本轮增量结果格式需要核对。', invalid_patch_coverage: '本轮原话覆盖位置需要核对。',
    unbound_patch_evidence: '本轮修改缺少有效原话依据。', patch_operation_limit: '本轮修改数量超出容量。',
    invalid_patch_operation: '本轮修改格式需要核对。', unknown_or_duplicate_patch_target: '本轮修改目标无效或重复。',
    invalid_patch_category: '本轮事项类别需要核对。', add_cannot_choose_id: '本轮新增事项标识需要核对。',
    duplicate_patch_add: '本轮包含重复新增事项。',
    request_already_attempted: '本次请求已有调用记录，已停止重复调用。', invalid_patch_item: '本轮事项内容需要核对。',
    live_response_incomplete: '本轮回包不完整，尚无可用新草稿。', live_response_too_large: '本轮回包超出容量，需要核对。',
    worker_requires_main_thread: '整理服务的运行状态需要核对。', worker_deadline_unavailable: '整理服务未能设置本轮处理时限。',
  };
  const GROUPS = [
    ['actions', '待办候选', 'task'], ['decisions', '决定候选', 'decision'],
    ['open_questions', '未决问题', 'open'], ['ideas', '观点与方案候选', 'idea'],
  ];
  let current = null, currentSession = '', rendered = '';
  const expanded = new Set();
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const clean = (value, max = 8000) => typeof value === 'string' ? value.slice(0, max) : '';
  const sourceId = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const count = value => Number.isInteger(value) && value >= 0 ? value : null;
  const position = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const mmss = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未记录';
    const seconds = Math.floor(value / 1000);
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  };
  function time(value) {
    if (value == null || value === '') return '未记录';
    const stamp = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return Number.isFinite(stamp.getTime()) ? stamp.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '未记录';
  }
  function metric(label, value) {
    const item = el('div', 'live-minutes-metric');
    item.append(el('dt', '', label), el('dd', '', value));
    return item;
  }
  function references(value, sentences) {
    if (!Array.isArray(value) || !value.length) return null;
    const ids = [...new Set(value.map(sourceId))];
    if (ids.some(id => !id || !sentences.has(id))) return null;
    return ids;
  }
  function openSource(index) {
    const replay = window.OopsReplay;
    if (!replay || typeof replay.select !== 'function') return;
    $('tab-live')?.click();
    replay.select(index);
  }
  function sourceDetails(ids, sentences, key, label = '原话依据') {
    const details = el('details', 'live-minutes-sources');
    details.open = expanded.has(key);
    details.append(el('summary', '', label + ' · ' + ids.join('、')));
    const list = el('ul');
    ids.forEach(id => {
      const source = sentences.get(id);
      const row = el('li');
      const meta = el('div', 'live-minutes-source-meta');
      meta.append(el('span', '', mmss(source.sentence.start_ms) + ' · ' + (clean(source.sentence.speaker, 100) || '未认人') + ' · ' + id));
      if (typeof window.OopsReplay?.select === 'function') {
        const locate = el('button', 'live-minutes-locate', '定位原话');
        locate.type = 'button';
        locate.addEventListener('click', () => openSource(source.index));
        meta.append(locate);
      }
      row.append(meta, el('p', '', clean(source.sentence.text)));
      list.append(row);
    });
    details.append(list);
    details.addEventListener('toggle', () => { if (details.open) expanded.add(key); else expanded.delete(key); });
    return details;
  }
  function contentItem(item, sentences, key) {
    if (!item || typeof item !== 'object') return null;
    const text = clean(item.text).trim();
    const ids = references(item.ids, sentences);
    if (!text || !ids) return null;
    const row = el('li', 'live-minutes-item');
    row.append(el('p', 'live-minutes-item-text', text), sourceDetails(ids, sentences, key));
    return row;
  }
  function conflictItem(item, sentences, seenIds, seenEvidence) {
    if (!item || item.kind !== 'conflict' || item.status !== 'open') return null;
    const id = clean(item.id, 200).trim();
    const text = clean(item.text).trim();
    const earlier = references(item.earlier_ids, sentences);
    const currentIds = references(item.current_ids, sentences);
    if (!id || !text || !earlier || !currentIds || earlier.some(value => currentIds.includes(value))) return null;
    const evidenceKey = JSON.stringify([earlier.slice().sort(), currentIds.slice().sort()]);
    if (seenIds.has(id) || seenEvidence.has(evidenceKey)) return null;
    seenIds.add(id); seenEvidence.add(evidenceKey);
    const row = el('li', 'live-minutes-item live-minutes-conflict');
    row.append(el('p', 'live-minutes-conflict-state', '可能冲突 · 待核对'), el('p', 'live-minutes-item-text', text));
    const question = clean(item.question, 1000).trim();
    if (question) row.append(el('p', 'live-minutes-conflict-question', '待核对：' + question));
    row.append(sourceDetails(earlier, sentences, 'notice:' + id + ':earlier', '先前依据'),
      sourceDetails(currentIds, sentences, 'notice:' + id + ':current', '当前依据'));
    return row;
  }
  function conflictSection(draft, sentences) {
    const section = el('section', 'live-minutes-notices');
    const heading = el('h3', '', 'Agent 冲突提醒');
    section.append(heading);
    if (draft.notice_evaluated !== true) {
      section.append(el('p', 'live-minutes-empty', '本版草稿未记录 Agent 冲突判断。'));
      return section;
    }
    if (!Array.isArray(draft.content.notices)) {
      section.append(el('p', 'live-minutes-empty', '本轮冲突判断记录暂不可用。'));
      return section;
    }
    const list = el('ul', 'live-minutes-notice-list');
    const seenIds = new Set(), seenEvidence = new Set();
    draft.content.notices.forEach(item => {
      const row = conflictItem(item, sentences, seenIds, seenEvidence);
      if (row) list.append(row);
    });
    heading.append(el('span', 'live-minutes-count', String(list.childElementCount)));
    const coverage = draft.notice_context?.coverage;
    if (coverage?.bounded === true) section.append(el('p', 'live-minutes-notice-note', '依据范围：本轮新增原话及检索到的先前依据。'));
    const capacityOmitted = draft.notice_context?.capacity_omitted_count;
    if (Number.isInteger(capacityOmitted) && capacityOmitted > 0) section.append(el('p', 'live-minutes-notice-note',
      '提醒数量已达上限，本轮另有 ' + capacityOmitted + ' 条候选未纳入；现有提醒与实时整理已保留。'));
    if (list.childElementCount) {
      section.append(el('p', 'live-minutes-notice-note', 'AI 发现的可能冲突，尚未经人工核对。'), list);
    } else {
      section.append(el('p', 'live-minutes-empty', draft.content.notices.length ?
        '冲突提醒的原话依据暂不可用，请等待重新核对。' : '本轮暂无带双方原话依据的冲突提醒。'));
    }
    return section;
  }
  function reset() {
    panel.hidden = true;
    panel.replaceChildren();
    document.body.classList.remove('live-minutes-active');
    tab.textContent = '会后 · 整理';
    rendered = '';
  }
  function render(data) {
    current = data;
    const source = data?.source;
    const sid = sourceId(source?.session_id);
    if (sid !== currentSession) { currentSession = sid; expanded.clear(); rendered = ''; }
    const historical = source?.kind === 'history' && Boolean(sid);
    const active = historical && source.live?.active === true;
    const candidate = data?.live_draft;
    const draft = candidate && candidate.version === 1 && sourceId(candidate.session_id) === sid ? candidate : null;
    const draining = historical && !active && draft?.draining === true;
    const closed = historical && !active && (draft?.meeting_ended === true || draft?.status === 'ended');
    if (!active && !closed && !draining) { reset(); return; }

    document.body.classList.toggle('live-minutes-active', active);
    tab.textContent = active ? '会中 · 实时整理' : '会后 · 整理';
    const sentences = new Map();
    let latestEnd = null, latestId = '';
    (Array.isArray(data.sentences) ? data.sentences : []).forEach((sentence, index) => {
      const id = sourceId(sentence?.id);
      if (id) sentences.set(id, { sentence, index });
      const end = position(sentence?.end_ms) ?? position(sentence?.start_ms);
      if (end != null && (latestEnd == null || end >= latestEnd)) { latestEnd = end; latestId = id; }
    });
    latestEnd = position(draft?.latest_source_end_ms) ?? latestEnd;
    latestId = sourceId(draft?.latest_source_id) || latestId;
    const referenced = new Set((Array.isArray(draft?.snapshot?.source_hashes) ? draft.snapshot.source_hashes : []).map(row => sourceId(row?.id)));
    const contentRows = [draft?.content?.summary, ...GROUPS.flatMap(([key]) => Array.isArray(draft?.content?.[key]) ? draft.content[key] : [])];
    contentRows.forEach(item => { if (Array.isArray(item?.ids)) item.ids.forEach(id => referenced.add(sourceId(id))); });
    (Array.isArray(draft?.content?.notices) ? draft.content.notices : []).forEach(item => {
      [item?.earlier_ids, item?.current_ids].forEach(ids => { if (Array.isArray(ids)) ids.forEach(id => referenced.add(sourceId(id))); });
    });
    // Refresh queue progress while preserving expanded evidence across renders.
    const signature = JSON.stringify([sid, active, draft, latestEnd, latestId, [...referenced].map(id => {
      const row = sentences.get(id);
      return [id, row?.index, row?.sentence.text, row?.sentence.speaker, row?.sentence.start_ms];
    })]);
    if (signature === rendered) return;
    rendered = signature;
    panel.replaceChildren();
    panel.hidden = false;
    panel.className = 'live-minutes-panel';
    panel.setAttribute('aria-label', active ? '会中实时整理草稿' : draining ? '已结束会议草稿补齐进度' : '实时草稿截止状态');

    let status = draft ? draft.status : 'unavailable';
    const knownStatus = Object.hasOwn(STATUS, status);
    if (!knownStatus) status = 'unknown';
    const hashes = draft?.snapshot?.source_hashes;
    const missingSource = Array.isArray(hashes) && hashes.some(row => !row || !sentences.has(sourceId(row.id)));
    if (missingSource) status = 'stale';
    const checkpointAvailable = draft?.checkpoint_available !== false && draft?.cp_available !== false &&
      Boolean(draft?.content && draft?.snapshot) && !missingSource && !['stale', 'unavailable'].includes(status);
    const draftInvalidated = draft?.draft_invalidated === true || status === 'stale';
    const previous = checkpointAvailable && ['pending', 'paused', 'stopped'].includes(status) && (draft?.is_previous === true || draft?.updating === true);
    const trialComplete = status === 'stopped' && ['global_call_limit_reached', 'call_limit_reached'].includes(draft?.reason);
    const backlog = count(draft?.new_utterance_count);
    const fullCoverage = checkpointAvailable && backlog === 0 && Array.isArray(hashes) && hashes.length === sentences.size && draft.snapshot.ignored_prefix_count === 0;
    const queued = checkpointAvailable && status === 'ready' && backlog > 0;
    const completing = draining && (status === 'pending' || queued);
    const missingCompleted = !checkpointAvailable && ['ready', 'ended'].includes(status);
    const titleText = active ? '会中 · 实时整理' : completing ? '会中草稿 · 补齐中' : missingCompleted ? '会中草稿 · 暂不可用' : status === 'ended' ? (fullCoverage ? '会后整理草稿' : '会中草稿 · 已截止') : '会中草稿 · 补齐状态';

    const heading = el('div', 'live-minutes-heading');
    const title = el('div');
    title.append(el('h2', '', titleText), el('p', 'live-minutes-subtitle', (active ? '' : '会议已结束 · ') + '待核对草稿 · 候选需人工确认'));
    const badges = el('div', 'live-minutes-badges');
    badges.append(el('span', 'live-minutes-model', clean(draft?.model, 100) || '模型未记录'));
    const state = el('span', 'live-minutes-state', missingCompleted ? '无可用草稿' : trialComplete ? '试跑已完成' : queued ? '待补齐' : STATUS[status] || '状态未识别');
    state.dataset.status = missingCompleted ? 'unavailable' : queued ? 'queued' : status;
    badges.append(state);
    heading.append(title, badges);
    panel.append(heading);
    if (!active) {
      panel.append(el('p', 'live-minutes-ended', completing ? '会议已结束，正在补齐此前尚未覆盖的原话。正式会后纪要保留在下方，处理状态分别核对。' : '会议已结束。下方保留草稿的实际覆盖进度，正式会后纪要的处理状态另行核对。'));
    }
    if (status === 'unknown') {
      const notice = el('p', 'live-minutes-notice', '服务器尚未返回可识别的整理状态。');
      notice.setAttribute('role', 'status'); panel.append(notice); return;
    }

    const interval = Number.isFinite(draft?.interval_seconds) && draft.interval_seconds > 0 ? draft.interval_seconds : 20;
    const note = el('p', 'live-minutes-cadence', !active && !completing ? (checkpointAvailable ? '下方保留最近一版有效草稿与实际覆盖进度。' : '当前没有可展示的有效草稿；调用记录与可用结果分别核对。') : '每 ' + interval + ' 秒检查' + (active ? '新增原话' : '尚未覆盖的原话') + '；一轮完成后再更新，不叠加生成。');
    panel.append(note);
    panel.append(el('p', 'live-minutes-coverage', fullCoverage ? '已覆盖本场当前保存的全部 ' + sentences.size + ' 句原话；草稿及候选仍需核对。' : '草稿仅覆盖下方已完成的原话范围；具体覆盖进度以保存记录为准。'));
    const attempt = draft?.attempt || {};
    const attemptTiming = attempt.timing || attempt;
    const timing = checkpointAvailable ? draft?.timing || {} : {};
    const modelMs = timing.model_ms;
    const duration = typeof modelMs === 'number' && Number.isFinite(modelMs) && modelMs >= 0 ? (modelMs / 1000).toFixed(2) + ' 秒' : checkpointAvailable ? '未记录' : '当前无有效结果';
    const metrics = el('dl', 'live-minutes-metrics');
    const range = checkpointAvailable ? mmss(draft?.snapshot?.coverage_start_ms) + ' – ' + mmss(draft?.snapshot?.covers_through_ms) : '当前无有效结果';
    const coveredEnd = checkpointAvailable ? position(draft?.snapshot?.covers_through_ms) : null;
    const gap = latestEnd != null && coveredEnd != null ? mmss(Math.max(0, latestEnd - coveredEnd)) : '未记录';
    metrics.append(metric('尚未覆盖', backlog == null ? '未记录' : backlog + ' 句'), metric('距最新原话', gap),
      metric('最近成功用时', duration), metric('已完成原话范围', range),
      metric('本轮开始', time(attemptTiming.started_at ?? timing.started_at)), metric('最近完成', checkpointAvailable ? time(timing.finished_at) : '当前无有效结果'));
    panel.append(metrics);
    const targetSeconds = position(draft?.performance?.soft_target_seconds);
    if (checkpointAvailable && targetSeconds > 0) {
      panel.append(el('p', 'live-minutes-coverage', draft.performance.slow === true ? '本轮超过 ' + targetSeconds + ' 秒整理目标；有效结果已保留，实际用时如上。' : '本轮整理目标 ' + targetSeconds + ' 秒；实际用时按已存记录显示。'));
    }
    if (checkpointAvailable && draft?.snapshot?.covers_through_id != null) panel.append(el('p', 'live-minutes-coverage', '已完成至原句 ' + sourceId(draft.snapshot.covers_through_id)));
    if (latestId) panel.append(el('p', 'live-minutes-coverage', '服务器最新原话 ' + latestId + ' · ' + mmss(latestEnd) + '；进度差按原话时间计算。'));
    const batchCount = count(attempt.batch_count);
    const processedCount = count(attempt.processed_count);
    const batchParts = [];
    if (batchCount != null) batchParts.push('本批 ' + batchCount + ' 句');
    if (processedCount != null) batchParts.push((checkpointAvailable ? '本批已完成 ' : '调用回包曾覆盖 ') + processedCount + ' 句' + (checkpointAvailable ? '' : '（当前结果不可用）'));
    if (position(attemptTiming.model_ms) != null) batchParts.push('本次调用用时 ' + (attemptTiming.model_ms / 1000).toFixed(2) + ' 秒');
    if (status === 'pending') batchParts.push('尚未覆盖数包含正在处理的本批原话');
    if (batchParts.length) panel.append(el('p', 'live-minutes-batch', batchParts.join(' · ')));

    let message = '';
    if (!draft) message = '尚未收到本场实时整理记录。';
    else if (status === 'pending') message = previous ? '正在按原话顺序补齐，下方保留最近完成草稿；本批完成后更新覆盖进度。' : 'Sol 正在处理本批原话，完成后显示草稿与实际覆盖进度。';
    else if (status === 'paused') message = previous ? '已停止继续整理。下方是来源仍有效的上一版草稿。' : '已停止继续整理，暂无可显示的上一版草稿。';
    else if (status === 'stopped') message = (trialComplete ? '试跑已完成，已停止继续整理。' : '已停止继续整理。') + (previous ? '下方保留来源仍有效的最后一版草稿。' : '暂无可显示的有效草稿。');
    else if (status === 'stale') message = '原话来源已变化，旧草稿当前不可展示。历史调用记录不能证明当前内容已完成整理。';
    else if (status === 'unavailable') message = '本轮实时整理暂不可用，当前没有可展示的有效草稿。';
    else if (status === 'ended') message = checkpointAvailable ? '本场实时草稿已截止。' + (backlog > 0 ? '仍有 ' + backlog + ' 句未进入这份草稿，请以会后纪要的独立处理状态为准。' : '') : '会议已结束，但当前没有可用的实时草稿。已有调用回包与耗时不代表当前来源的整理结果。正式会后纪要请查看下方独立状态。';
    else if (queued) message = '还有 ' + backlog + ' 句尚未进入已完成草稿。' + (active || draining ? '将按原话顺序继续补齐。' : '尚未收到继续补齐的状态。');
    const reason = clean(draft?.reason, 100);
    if (reason) message += (message ? ' ' : '') + (REASONS[reason] || '处理状态需核对。');
    if (!checkpointAvailable && draftInvalidated && status !== 'stale') message += (message ? ' ' : '') + '旧草稿已失效，不能作为当前来源的整理结果。';
    if (missingCompleted && status !== 'ended') message += (message ? ' ' : '') + '当前没有可用的已完成草稿，调用记录不能代替整理结果。';
    if (message) {
      const notice = el('p', 'live-minutes-notice', message);
      notice.setAttribute('role', 'status');
      panel.append(notice);
    }
    if (!(status === 'ready' || status === 'ended' || previous) || !checkpointAvailable) return;

    const content = draft.content;
    const notices = conflictSection(draft, sentences);
    panel.append(notices);
    const summary = contentItem(content.summary, sentences, 'summary');
    if (summary) {
      const section = el('section', 'live-minutes-summary');
      section.append(el('h3', '', ['stopped', 'ended'].includes(status) ? '最后一版小结' : previous || queued ? '最近完成小结' : '当前小结'));
      const list = el('ul'); list.append(summary); section.append(list); panel.append(section);
    }
    const groups = el('div', 'live-minutes-groups');
    let validItems = (summary ? 1 : 0) + notices.querySelectorAll('.live-minutes-conflict').length;
    GROUPS.forEach(([key, label, tone]) => {
      const section = el('section', 'live-minutes-group');
      section.dataset.tone = tone;
      const list = el('ul');
      const items = Array.isArray(content[key]) ? content[key] : [];
      items.forEach((item, index) => {
        const row = contentItem(item, sentences, key + ':' + (sourceId(item?.id) || index));
        if (row) { list.append(row); validItems++; }
      });
      const header = el('h3', '', label); header.append(el('span', 'live-minutes-count', String(list.childElementCount)));
      section.append(header, list);
      if (!list.childElementCount) section.append(el('p', 'live-minutes-empty', '本轮暂无可用候选'));
      groups.append(section);
    });
    panel.append(groups);
    if (!validItems) panel.append(el('p', 'live-minutes-notice', '本轮暂无带有效原话依据的整理内容。'));
  }
  document.addEventListener('funnel:data', event => render(event.detail));
  document.addEventListener('funnel:mode', () => {
    if (current) render(current);
  });
  const initial = window.OopsReplay?.state?.()?.data;
  if (initial) render(initial);
})();
