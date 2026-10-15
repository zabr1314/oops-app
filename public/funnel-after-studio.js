/* Existing after-meeting results only. No generation, research, writes or delivery. */
(() => {
  'use strict';
  const ORDER = ['minutes', 'research', 'review', 'delivery'];
  function phaseAt(snapshot = {}) {
    const named = { minutes: 0, evidence: 1, quality: 2, queue: 3, complete: 3, missing: 0 };
    if (Object.prototype.hasOwnProperty.call(named, snapshot.phase)) return named[snapshot.phase];
    const fraction = Math.min(1, Math.max(0, (snapshot.at || 0) / Math.max(1, snapshot.total || 1)));
    return Math.min(3, Math.floor(fraction * 4));
  }
  function derive(snapshot = {}) {
    const data = snapshot.data;
    const empty = () => ({ status: 'empty', label: '等待来源', note: '没有可用的会后成果。', presenting: false });
    if (!data?.sentences?.length || !data.post) return Object.fromEntries(ORDER.map(key => [key, empty()]));
    const post = data.post;
    const stages = Array.isArray(post.handoffs) ? post.handoffs : post.handoffs?.stages || [];
    const find = id => stages.find(stage => stage.id === id);
    const minutes = find('minutes'); const query = find('research') || find('query'); const review = find('review'); const delivery = find('delivery');
    const reused = post.generation?.evidence === 'reused_history' || minutes?.provenance === 'reused';
    const realQuery = query && ['recorded', 'reused'].includes(query.provenance) && query.status !== 'missing';
    const receipts = post.delivery_record;
    const rawHistory = !!receipts && (['document_created', 'ledger_written', 'done'].some(key => typeof receipts[key] === 'boolean') || (Number.isInteger(receipts.sent_receipts) && receipts.sent_receipts >= 0));
    const hasReceipt = !!(delivery && delivery.provenance === 'recorded' && ['historical_receipt', 'recorded_summary', 'recorded', 'historical'].includes(delivery.status)) || rawHistory;
    const hasSentReceipt = (delivery?.counts?.sent_receipts || receipts?.sent_receipts || 0) > 0;
    const hasReviewSummary = review && review.provenance === 'recorded' && ['confirmed', 'recorded_summary'].includes(review.status);
    const playing = !!snapshot.playing && snapshot.mode !== 'live';
    return {
      minutes: { status: reused ? 'reused' : 'recorded', label: reused ? '复用原纪要' : '已有纪要', note: minutes?.note || '读取已有纪要与原话依据；本页没有生成新纪要。', presenting: playing && phaseAt(snapshot) === 0 },
      research: { status: realQuery ? 'historical' : 'missing', label: realQuery ? '已存问题摘要' : '查询过程未记录', note: query?.note || (realQuery ? '只读取原会议已存问题记录，未据此推断查询成功；本次不查询。' : '没有保存查询过程，不能据此判断是否曾查询；此处不补查。'), presenting: false },
      review: { status: hasReviewSummary ? 'historical' : 'pending', label: hasReviewSummary ? '人工核对摘要' : '人工核对未记录', note: review?.note || '当前事项与待核对顺序来自确定性代码；规则通过不等于人工已确认。', presenting: false },
      delivery: { status: hasReceipt ? 'historical' : 'missing', label: hasReceipt ? (hasSentReceipt ? '原会议历史回执' : '原会议投递状态摘要') : '发送过程未记录', note: (delivery?.provenance === 'recorded' ? delivery.note : '') || (hasReceipt ? '这里只展示原会议已存回执或处理记录，不代表本次重新发送。' : '没有保存发送过程或回执，不能据此断言已发送或未发送；本页不发送。'), presenting: false },
    };
  }
  window.OopsAfterStudio = { derive, phaseAt };
  const $ = id => document.getElementById(id);
  if (!$('after-studio')) return;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const api = () => window.OopsAfterReplay;
  const time = ms => { const sec = Math.floor(Math.max(0, ms || 0) / 1000); return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const NAMES = { minutes: '纪要 Oops', research: '资料 Oops', review: '核对 Oops', delivery: '飞书 Oops' };
  const KIND = { task: '待办', decision: '决定', open: '未决问题' };
  const PHASES = ['纪要成果', '对回原话', '规则复核', '待核对顺序'];
  let snapshot = {}, currentData = null, selectedItem = null, selectedStation = 'minutes', detailKey = '', itemButtons = [], mode = document.body.classList.contains('mode-after') ? 'after' : 'live';
  const buttons = [...document.querySelectorAll('[data-after-station]')];
  const web = window.OopsWeb?.createWeb && $('after-web') ? window.OopsWeb.createWeb($('after-web'), { onPick: id => pickItem(id), outsideSpider: () => mode === 'after' && !!window.OopsCrawler?.active }) : null;
  const crawler = () => (mode === 'after' ? window.OopsCrawler : null);
  const STATION_OF_PHASE = ['minutes', 'review', 'review', 'review'];
  let crawlKey = '';
  /* Jev visits each item as it is revealed or checked: list entry, then its node on the minutes web. */
  function crawl(post, phase, playing) {
    if (!post || !playing || !web) return;
    const scene = window.OopsWeb.afterScene(snapshot, selectedItem);
    if (!scene.nodes.length) return;
    const at = snapshot.at ?? snapshot.now ?? 0;
    const node = phase === 0 ? scene.nodes.reduce((a, b) => (post.items.findIndex(i => i.id === b.id) > post.items.findIndex(i => i.id === a.id) ? b : a)) : scene.nodes[Math.floor(at / 900) % scene.nodes.length];
    const key = phase + ':' + node.id;
    if (key === crawlKey) return;
    const phaseChanged = !crawlKey.startsWith(phase + ':');
    crawlKey = key;
    const item = post.items.find(i => i.id === node.id);
    const steps = [];
    if (phaseChanged) steps.push({ el: buttons.find(b => b.dataset.afterStation === STATION_OF_PHASE[phase]), label: PHASES[phase], tone: 'jev', dwell: 260, ax: 0.5, ay: 0.3 });
    steps.push({ el: itemButtons.find(b => b.id === node.id)?.button, tone: 'idle', dwell: 140, ax: 0.92 });
    const tagText = phase === 0 ? (KIND[item.kind] || '事项') : phase === 1 ? (item.ids?.length || 0) + ' 句依据' : phase === 2 ? (item.quality?.label || item.quality?.status || '复核未记录') : '待核对 #' + ((post.queue || []).findIndex(q => q.id === item.id) + 1 || '—');
    steps.push({ point: () => web.anchors().nodes.find(n => n.id === node.id) || null, label: tagText, tone: phase === 2 && item.quality?.status === 'accepted' ? 'code' : 'jev', dwell: 240 });
    crawler()?.visit(steps);
  }
  function openInspector() { if (window.innerWidth <= 900) $('after-studio-inspector').classList.add('is-open'); }
  function pickItem(id) {
    api()?.pause(); selectedItem = id; detailKey = ''; render(api()?.state() || snapshot); openInspector();
    const item = (snapshot.data?.post?.items || []).find(i => i.id === id);
    crawler()?.visit([{ point: () => web?.anchors().nodes.find(n => n.id === id) || null, label: item ? (KIND[item.kind] || '事项') + ' · ' + (item.ids?.length || 0) + ' 句依据' : '', tone: 'jev', dwell: 200 },
      ...[...document.querySelectorAll('#after-inspector-content .after-detail-evidence')].slice(0, 3).map(el => ({ el, tone: 'idle', dwell: 160, ax: 0.94, ay: 0.3 }))]);
  }
  function buildItems(post) {
    const items = post?.items || [];
    itemButtons = items.map(item => {
      const button = el('button', 'after-item-button'); button.type = 'button';
      const copy = el('span', null, item.title); copy.append(el('em', null, (item.ids?.length || 0) + ' 句原话依据 · 待人工核对'));
      button.append(el('small', null, KIND[item.kind] || '事项'), copy); button.addEventListener('click', () => pickItem(item.id));
      return { id: item.id, button };
    });
    $('after-studio-items').replaceChildren(...itemButtons.map(item => item.button));
    if (!items.length) $('after-studio-items').append(el('p', 'after-item-empty', '没有可用的已有纪要事项；页面不会重新生成。'));
    $('after-studio-item-count').textContent = items.length;
  }
  function render(state = {}) {
    snapshot = { ...state, mode };
    const data = snapshot.data;
    const post = data?.sentences?.length ? data.post : null;
    if (data !== currentData || (!post && itemButtons.length)) {
      if (mode === 'after') window.OopsCrawler?.clear(); crawlKey = ''; currentData = data; selectedItem = null; selectedStation = 'minutes'; detailKey = '';
      $('after-studio-inspector').classList.remove('is-open'); buildItems(post);
    }
    const roles = derive(snapshot); const phase = phaseAt(snapshot);
    const stageName = PHASES[phase];
    const generation = post?.generation || {};
    $('after-studio-origin').textContent = !post ? '没有可用的会后成果' : generation.evidence === 'reused_history' ? '复用原纪要 · 原会议成果' : data.source?.kind === 'example' ? '示例会后成果' : '原会议已有成果';
    $('after-result-label').textContent = !post ? '会后成果未就绪' : '原文 ' + data.sentences.length + ' 句 → 已有纪要 ' + (post.items?.length || 0) + ' 项';
    const phaseCopy = [
      ['读取已有纪要', post?.overview || '纪要概览未记录。'],
      ['把事项对回原话', '按每条事项保存的句子 ID 展示依据；这一步是当前代码派生，不冒充历史查询。'],
      ['展示确定性规则复核', '检查事项与原话是否匹配；通过规则不表示人工已核对或业务已完成。'],
      ['把事项交给你核对', '按待办、决定、未决事项排列；人工核对与飞书发送过程分别显示已有记录。'],
    ];
    $('after-result-title').textContent = post ? phaseCopy[phase][0] : '没有可用的已有纪要';
    $('after-result-copy').textContent = post ? phaseCopy[phase][1] : data?.post_status?.message || '页面只读已有结果，不生成新纪要、不查询资料、不发送飞书。';
    $('after-studio-moment').textContent = !post ? '保留真实记录断点' : snapshot.playing && mode === 'after' ? '正在展示 · ' + stageName : '已暂停 · 可点工位或事项';
    $('after-studio-phase').textContent = stageName;
    const at = snapshot.at ?? snapshot.now ?? 0; const total = snapshot.total ?? snapshot.duration ?? 1;
    $('after-studio-scrub').value = String(Math.round(Math.min(1, at / Math.max(1, total)) * 1000)); $('after-studio-scrub').disabled = !post;
    $('after-studio-clock').textContent = time(at) + ' / ' + time(total);
    const room = $('after-studio-room');
    const playing = !!snapshot.playing && mode === 'after' && !!post && !reduced.matches;
    room.classList.toggle('is-handoff', playing && phase === 1);
    buttons.forEach(button => {
      const key = button.dataset.afterStation; const role = roles[key];
      button.querySelector('[data-after-state]').textContent = role.label;
      button.classList.toggle('is-selected', selectedItem == null && selectedStation === key);
      button.classList.toggle('is-missing', role.status === 'missing' || role.status === 'empty');
      button.classList.toggle('is-pending', role.status === 'pending');
      button.classList.toggle('is-presenting', playing && role.presenting);
      button.setAttribute('aria-pressed', String(selectedItem == null && selectedStation === key));
    });
    $('after-room-footnote').textContent = '展示顺序不代表历史发生顺序；人工核对和发送不自动推进。';
    if (web && mode === 'after') web.draw(window.OopsWeb.afterScene(mode === 'after' ? snapshot : { ...snapshot, playing: false }, selectedItem));
    if (mode === 'after' && post) crawler()?.rest(() => web?.anchors().hub || null);
    crawl(post, phase, playing);
    itemButtons.forEach(item => item.button.classList.toggle('is-selected', item.id === selectedItem));
    renderDetail(post, roles);
  }
  function appendEvidence(container, item) {
    const byId = new Map((snapshot.data?.sentences || []).map(row => [row.id, row]));
    container.append(el('h3', null, '原话依据'));
    let found = 0;
    for (const id of item.ids || []) {
      const row = byId.get(id); if (!row) continue; found++;
      const quote = el('blockquote', 'after-detail-evidence');
      quote.append(el('small', null, id + ' · ' + (row.speaker || '说话人未核对') + ' · ' + time(row.start_ms ?? row.end_ms)), el('p', null, row.text)); container.append(quote);
    }
    if (!found) container.append(el('p', 'after-detail-meta', '当前可用原话中没有找到这条事项的依据，不能补造引用。'));
  }
  function stat(container, label, value) { const card = el('div', null, label); card.append(el('b', null, String(value))); container.append(card); }
  function renderDetail(post, roles) {
    const phase = phaseAt(snapshot); const key = [selectedStation, selectedItem, phase, !!post].join(':');
    if (detailKey === key) return; detailKey = key;
    const body = $('after-inspector-content'); body.replaceChildren();
    $('after-inspector-kicker').textContent = selectedItem == null ? '已有成果与断点' : '事项与原话依据';
    if (!post) { body.append(el('h2', null, '会后成果未就绪'), el('p', 'after-detail-copy', snapshot.data?.post_status?.message || '没有可用的已有纪要。来源变化或到期后旧成果不能继续当作当前依据。')); return; }
    const item = selectedItem == null ? null : post.items?.find(value => value.id === selectedItem);
    if (item) {
      body.append(el('h2', null, item.title), el('p', 'after-detail-status', (KIND[item.kind] || '事项') + ' · 沿用已有纪要 · 待人工核对'));
      if (item.owner) body.append(el('p', 'after-detail-meta', '负责人线索：' + item.owner + '（未据此自动确认负责人）'));
      if (item.due) body.append(el('p', 'after-detail-meta', '纪要中的时间线索：' + item.due));
      if (item.quality) body.append(el('h3', null, '当前规则复核'), el('p', 'after-detail-copy', (item.quality.label || item.quality.status || '状态未记录') + ' · ' + (item.quality.reason || '原因未记录')), el('p', 'after-detail-meta', '确定性代码重算，规则通过不代表人工已确认。'));
      appendEvidence(body, item); return;
    }
    const role = roles[selectedStation]; body.append(el('h2', null, NAMES[selectedStation]), el('p', 'after-detail-status', role.label), el('p', 'after-detail-copy', role.note));
    if (selectedStation === 'minutes') {
      if (post.overview) body.append(el('p', 'after-detail-copy', post.overview));
      const stats = el('div', 'after-detail-stats'); stat(stats, '沿用纪要中的事项', post.items?.length || 0); stat(stats, '保存的成功结果份数', Number.isInteger(post.generation?.successful_runs) ? post.generation.successful_runs : '未记录'); body.append(stats);
      body.append(el('p', 'after-detail-meta', '成功结果份数不等于精确模型调用次数；本次没有重新生成纪要。'));
      if (post.topics?.length) body.append(el('h3', null, '纪要主题'), el('p', 'after-detail-copy', post.topics.join(' · ')));
    } else if (selectedStation === 'research') {
      body.append(el('p', 'after-detail-copy', role.status === 'missing' ? '纪要中的“待查问题”可以来自会议讨论，本身不能证明后台已经搜索过资料。当前没有保存的查询链路，动画在这里保留断点。' : '这些是原会议已有记录；回放不提交新的查询，也不把原会议的结果当作本次重新分析产生。'));
      const researchStage = (post.handoffs?.stages || []).find(stage => stage.id === 'research');
      if (Number.isInteger(researchStage?.counts?.records) && researchStage.counts.records > 0) body.append(el('p', 'after-detail-meta', '已存问题记录 ' + researchStage.counts.records + ' 条；不代表已经成功查询或找到外部资料。'));
      const clues = (post.items || []).filter(item => item.kind === 'open');
      if (clues.length) {
        body.append(el('h3', null, '纪要交来的待查线索'), el('p', 'after-detail-meta', '这些是纪要中的未决问题；线索不等于已经查询，也不触发补查。'));
        const list = el('ul', 'after-detail-list');
        clues.forEach(item => { const li = el('li'); const button = el('button', 'after-detail-link', item.title); button.type = 'button'; button.addEventListener('click', () => pickItem(item.id)); li.append(button); list.append(li); });
        body.append(list);
      }
    } else if (selectedStation === 'review') {
      const reviewStage = (post.handoffs?.stages || []).find(stage => stage.id === 'review');
      if (reviewStage?.provenance === 'recorded') {
        const counts = reviewStage.counts || {}; const stats = el('div', 'after-detail-stats');
        [['confirmed', '历史已确认'], ['rejected', '历史已排除'], ['merged', '历史已合并'], ['pending', '当前待核对']].forEach(([key, label]) => stat(stats, label, Number.isInteger(counts[key]) ? counts[key] : '未记录')); body.append(stats);
      }
      body.append(el('h3', null, '当前待核对顺序'));
      const list = el('ol', 'after-detail-list');
      for (const entry of post.queue || []) { const target = post.items?.find(value => value.id === entry.id); const li = el('li'); const button = el('button', 'after-detail-link', target?.title || entry.title || entry.id || '待核对事项'); button.type = 'button'; button.addEventListener('click', () => pickItem(entry.id)); li.append(button); list.append(li); }
      body.append(list, el('p', 'after-detail-meta', '队列由当前代码派生，不是人工已经核对的回执；在此查看不会确认事项。'));
    } else if (selectedStation === 'delivery') {
      const record = post.delivery_record;
      if (record) {
        const bool = value => value === true ? '有记录' : value === false ? '无已存记录' : '未记录';
        const stats = el('div', 'after-detail-stats'); stat(stats, '原会议文档创建', bool(record.document_created)); stat(stats, '原会议已存发送回执', Number.isInteger(record.sent_receipts) ? record.sent_receipts : '未记录'); stat(stats, '原会议台账写入', bool(record.ledger_written)); stat(stats, '原后台处理标记', bool(record.done)); body.append(stats);
      }
      body.append(el('p', 'after-detail-meta', '这些仅是原会议的已存状态。本次 Jev 重新分析没有重发；没有回执不能推断未发送。'));
    }
  }
  buttons.forEach(button => button.addEventListener('click', () => { api()?.pause(); selectedStation = button.dataset.afterStation; selectedItem = null; detailKey = ''; render(api()?.state() || snapshot); openInspector(); }));
  $('after-studio-scrub').addEventListener('input', event => {
    // pause emits a synchronous redraw, so capture the selected value first.
    const target = (Number(event.target.value) / 1000) * (snapshot.total || snapshot.duration || 1);
    api()?.pause(); api()?.seek(target);
  });
  $('after-inspector-close').addEventListener('click', () => { $('after-studio-inspector').classList.remove('is-open'); const item = itemButtons.find(value => value.id === selectedItem); (item?.button || buttons.find(button => button.dataset.afterStation === selectedStation))?.focus({ preventScroll: true }); });
  function sync(event) { render(event?.detail?.data !== undefined ? event.detail : api()?.state() || snapshot); }
  ['funnel:after-data', 'funnel:after-tick', 'funnel:after-play'].forEach(name => document.addEventListener(name, sync));
  document.addEventListener('funnel:data', event => { currentData = null; render({ ...(api()?.state() || {}), data: event.detail }); });
  document.addEventListener('funnel:mode', event => { mode = event.detail?.mode || 'live'; $('after-studio-inspector').classList.remove('is-open'); sync(); });
  reduced.addEventListener?.('change', sync);
  if ($('after-studio-room') && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (mode === 'after') sync(); }).observe($('after-studio-room'));
  sync();
})();
