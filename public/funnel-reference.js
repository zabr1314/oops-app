/* Presentation of existing records only: no network, generation, confirmation or sending. */
(() => {
  'use strict';
  const KEYS = ['chief', 'listen', 'judge', 'query', 'rules', 'minutes', 'review', 'delivery'];
  const NAMES = ['CHIEF', '聆听', '判断', '资料', '规则', '纪要', '核对', '飞书'];
  const ICONS = ['mascot', 'microphone', 'check-circle', 'magnifying-glass', 'check-circle', 'note-pencil', 'file-text', 'paper-plane-tilt'];
  const validP = p => Number.isFinite(p) && p >= 0 && p <= 1;
  const count = value => Number.isInteger(value) && value >= 0 ? value : null;
  const rowsOf = snapshot => snapshot?.data?.sentences?.length && !['empty', 'invalid'].includes(snapshot.data.source?.kind) ? snapshot.data.sentences : [];
  const stagesOf = post => Array.isArray(post?.handoffs) ? post.handoffs : post?.handoffs?.stages || [];
  const stageOf = (post, id) => stagesOf(post).find(stage => stage.id === id);
  function probabilityPoints(snapshot = {}) {
    if (!rowsOf(snapshot).length || snapshot.data.version === 1) return [];
    const timeline = Array.isArray(snapshot.timeline) ? snapshot.timeline : [];
    const fired = Number.isInteger(snapshot.fired) ? Math.max(0, Math.min(timeline.length, snapshot.fired)) : 0;
    return timeline.slice(0, fired).filter(event => event.f?.layer === 'jev' && event.f.provenance !== 'missing' && validP(event.f.p))
      .map(event => ({ x: event.t, y: event.f.p, sentence: event.i, label: event.f.q || '已存判断' })).slice(-40);
  }
  function evidencePoints(snapshot = {}) {
    const rows = rowsOf(snapshot), post = snapshot.data?.post;
    if (!rows.length || !post) return [];
    let visible = 0;
    if (['quality', 'queue', 'complete'].includes(snapshot.phase)) visible = rows.length;
    else if (snapshot.phase === 'evidence' && Number.isInteger(snapshot.here) && snapshot.here >= 0) visible = Math.min(rows.length, snapshot.here + 1);
    const cited = new Set((post.items || []).flatMap(item => item.ids || []));
    let cumulative = 0;
    return rows.slice(0, visible).map((row, i) => {
      if (cited.has(row.id)) cumulative++;
      return { x: i + 1, y: cumulative, sentence: row.id, label: '已有原话依据' };
    }).slice(-40);
  }
  function wallBars(snapshot = {}, mode = 'live', currentIndex) {
    const rows = rowsOf(snapshot);
    const empty = { bars: [], label: '没有已存概率记录', selectedOnly: false };
    if (!rows.length) return { ...empty, label: '等待有效来源' };
    if (mode === 'after') {
      const post = snapshot.data.post;
      if (!post) return { ...empty, label: '没有可用的已有纪要' };
      return { label: '已有事项分布 · 原纪要', selectedOnly: false, bars: ['task', 'decision', 'open'].map((key, i) => ({ key, label: ['待办', '决定', '未决'][i], value: (post.items || []).filter(item => item.kind === key).length, selected: false })) };
    }
    if (snapshot.data.version === 1) return { ...empty, label: '旧版显示值不能作为已存模型概率' };
    let index = Number.isInteger(currentIndex) ? currentIndex : Number.isInteger(snapshot.selected) ? snapshot.selected : 0;
    if (!Number.isInteger(currentIndex) && !Number.isInteger(snapshot.selected)) rows.forEach((row, i) => { if ((row.start_ms ?? row.end_ms ?? 0) <= (snapshot.now || 0)) index = i; });
    const row = rows[index];
    const reached = Array.isArray(snapshot.timeline)
      ? snapshot.timeline.slice(0, Math.max(0, Math.min(snapshot.timeline.length, snapshot.fired || 0))).reverse()
          .find(event => event.i === index && event.f?.layer === 'jev' && event.f.provenance !== 'missing')?.f
      : [...(row?.forks || [])].reverse().find(item => item.layer === 'jev' && item.provenance !== 'missing');
    const fork = reached;
    if (!fork) return empty;
    // Backend raw_calls stores a flat { option: probability } map. Never infer
    // alternatives or a complement from the winning option's p.
    const bars = Object.entries(fork.probabilities || {}).filter(([, value]) => validP(value)).map(([key, value]) => ({ key, label: key, value, selected: key === fork.choice }));
    if (bars.length) return { label: '已存 · ' + (fork.q || '选项概率 · 非准确率'), bars, selectedOnly: false, sentenceId: row.id };
    if (validP(fork.p)) return { label: '已存选中项 p · 其他选项未记录', bars: [{ key: fork.choice || 'selected', label: fork.choice || '选中项', value: fork.p, selected: true }], selectedOnly: true, sentenceId: row.id };
    return empty;
  }
  function derive(snapshot = {}, mode = 'live') {
    const rows = rowsOf(snapshot), post = rows.length ? snapshot.data.post : null;
    const cards = KEYS.map((key, i) => ({ key, name: NAMES[i], status: 'missing', value: '—', note: '过程未记录', active: false, meter: null }));
    const result = { mode, valid: !!rows.length, playing: !!snapshot.playing && snapshot.mode !== (mode === 'live' ? 'after' : 'live'), cards, points: [], target: 'chief', transition: 0,
      chartLabel: mode === 'live' ? 'Jev 返回选项概率 · 未记录 · 不是准确率' : '已有原话依据累计 · 未记录 · 展示进度，不是实际耗时' };
    if (!rows.length) { cards.forEach(card => { card.note = '等待有效来源'; }); result.playing = false; return result; }
    const byKey = Object.fromEntries(cards.map(card => [card.key, card]));
    const assign = (key, value) => Object.assign(byKey[key], value);
    const forks = rows.flatMap(row => row.forks || []), jev = forks.filter(fork => fork.layer === 'jev');
    const points = mode === 'after' ? evidencePoints(snapshot) : probabilityPoints(snapshot);
    const latest = points.at(-1);
    const reanalysis = snapshot.data.source?.kind === 'reanalysis', example = snapshot.data.source?.kind === 'example';
    assign('chief', { status: 'recorded', value: rows.length + ' 句', note: example ? '示例来源 · 只读回放' : reanalysis ? '重新分析 · 原会议保留' : '已有会议 · 只读回放' });
    assign('listen', { status: 'reused', value: rows.length + ' 句', note: '已有转写 · 本页不录音' });
    assign('judge', { status: jev.length ? 'recorded' : 'missing', value: mode === 'live' && latest ? 'p ' + latest.y.toFixed(3) : jev.length ? jev.length + ' 条' : '—', note: jev.length ? mode === 'live' && latest ? '返回选项概率 · 非准确率' : '已有 Jev 判断记录' : '判断过程未记录', meter: mode === 'live' && latest ? latest.y : null });
    const rules = forks.filter(fork => fork.layer === 'code').length;
    assign('rules', { status: rules || post?.items?.length ? 'recorded' : 'missing', value: mode === 'after' && post ? (post.items || []).length + ' 项' : rules ? rules + ' 条' : '—', note: mode === 'after' && post ? '当前规则映射 · 非人工确认' : rules ? '已有规则步骤' : '规则步骤未记录' });
    if (post) assign('minutes', { status: post.generation?.evidence === 'reused_history' ? 'reused' : 'recorded', value: (post.items || []).length + ' 项', note: post.generation?.evidence === 'reused_history' ? '复用原纪要 · 本次未生成' : example ? '示例纪要' : '原会议已有纪要' });
    const query = stageOf(post, 'research') || stageOf(post, 'query');
    if (query?.provenance === 'recorded' && (count(query.counts?.records) || 0) > 0) assign('query', { status: 'historical', value: query.counts.records + ' 条', note: '已存问题摘要 · 不证明已查询' });
    else assign('query', { note: reanalysis ? '查询未记录 · 本次未运行' : '查询过程未记录' });
    const review = stageOf(post, 'review'), reviews = review?.counts || {};
    const reviewed = ['confirmed', 'rejected', 'merged'].reduce((sum, key) => sum + (count(reviews[key]) || 0), 0);
    if (review?.provenance === 'recorded' && reviewed) assign('review', { status: 'historical', value: reviewed + ' 条', note: '人工核对摘要 · 非全部确认' });
    else if (post) assign('review', { status: 'pending', value: (post.queue || []).length + ' 项', note: '待核对顺序 · 人工过程未记录' });
    const delivery = stageOf(post, 'delivery'), raw = post?.delivery_record || {}, receiptCounts = delivery?.counts || raw;
    const sent = count(receiptCounts.sent_receipts);
    const hasDelivery = delivery?.provenance === 'recorded' || ['document_created', 'ledger_written', 'done'].some(key => typeof raw[key] === 'boolean') || count(raw.sent_receipts) !== null;
    if (hasDelivery) assign('delivery', { status: 'historical', value: sent === null ? '摘要' : sent + ' 回执', note: sent > 0 ? '原会议回执 · 本次不发送' : '投递状态摘要 · 不证明已发送' });
    if (mode === 'after') {
      const target = { minutes: 'minutes', evidence: 'listen', quality: 'rules', queue: 'review', complete: 'chief' }[snapshot.phase] || 'chief';
      result.target = target; result.transition = ['minutes', 'evidence', 'quality', 'queue', 'complete'].indexOf(snapshot.phase);
      // These are presentation stages; missing research and delivery never animate.
      byKey[target].active = result.playing && !!post && !['missing', 'pending'].includes(byKey[target].status);
      result.chartLabel = post ? '已有原话依据累计 · ' + (latest?.y || 0) + ' 句 · 展示进度，不是实际耗时' : result.chartLabel;
    } else {
      const fired = Math.min(snapshot.fired || 0, snapshot.timeline?.length || 0);
      const event = fired ? snapshot.timeline[fired - 1] : null;
      result.target = event?.f?.layer === 'jev' ? 'judge' : event?.f?.layer === 'code' ? 'rules' : event?.f?.layer === 'you' ? 'review' : 'listen';
      result.transition = fired;
      byKey[result.target].active = result.playing && !['missing', 'pending'].includes(byKey[result.target].status);
      const savedProbabilities = snapshot.data.version === 1 ? 0 : jev.filter(fork => fork.provenance !== 'missing' && validP(fork.p)).length;
      result.chartLabel = points.length ? (example ? '示例 ' : '') + 'Jev 返回选项概率 · 最近 ' + points.length + ' 条 · 不是准确率' : savedProbabilities ? '尚未回放到判断 · 已存 ' + savedProbabilities + ' 条概率 · 不是准确率' : result.chartLabel;
    }
    result.points = points;
    return result;
  }
  function legTargets(position, scale = 1) {
    const angle = position.angle || 0, cos = Math.cos(angle), sin = Math.sin(angle);
    return Array.from({ length: 8 }, (_, i) => {
      const side = i < 4 ? -1 : 1, n = i % 4;
      const x = side * (83 + (n === 1 || n === 2 ? 30 : 0)) * scale, y = (n - 1.5) * 49 * scale;
      return { x: position.x + x * cos - y * sin, y: position.y + x * sin + y * cos, group: (n + (side > 0 ? 1 : 0)) % 2 };
    });
  }
  window.OopsReference = Object.freeze({ derive, probabilityPoints, evidencePoints, wallBars, legTargets });
  if (typeof document === 'undefined') return;

  function initialise() {
    const $ = id => document.getElementById(id);
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const slots = [];
    let mode = document.body.classList.contains('mode-after') ? 'after' : 'live';
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const selectStation = (key, selectedMode) => {
      const live = { chief: 'listen', listen: 'listen', judge: 'judge', query: 'query', rules: 'judge', minutes: 'minutes', review: 'judge', delivery: 'delivery' };
      const after = { chief: 'minutes', listen: 'minutes', judge: 'review', query: 'research', rules: 'review', minutes: 'minutes', review: 'review', delivery: 'delivery' };
      const target = document.querySelector(selectedMode === 'live' ? '[data-station="' + live[key] + '"]' : '[data-after-station="' + after[key] + '"]');
      target?.click();
    };
    for (const selectedMode of ['live', 'after']) {
      const dashboard = $('reference-' + selectedMode + '-dashboard');
      if (!dashboard) continue;
      const deck = dashboard.closest('.reference-deck');
      const canvas = deck?.querySelector('canvas.reference-crawler');
      const chart = $('reference-' + selectedMode + '-chart');
      const wall = deck?.querySelector('canvas.reference-wall-chart');
      const cards = KEYS.map((key, i) => {
        const button = el('button', 'reference-card'); button.type = 'button'; button.dataset.referenceKey = key;
        const head = el('span', 'reference-card-head'), icon = el('img', 'reference-card-icon'); icon.alt = '';
        icon.src = i === 0 ? './brand/mascot.png' : './icons/' + ICONS[i] + '.svg';
        head.append(icon, el('b', 'reference-card-name', NAMES[i]));
        const value = el('strong', 'reference-card-value', '—'), note = el('span', 'reference-card-note', '等待有效来源'), meter = el('span', 'reference-card-meter'); meter.append(el('i'));
        button.append(head, value, note, meter); button.addEventListener('click', () => selectStation(key, selectedMode)); return { button, value, note, meter };
      });
      dashboard.replaceChildren(...cards.map(card => card.button));
      if (canvas) { canvas.style.pointerEvents = 'none'; canvas.setAttribute('aria-hidden', 'true'); }
      slots.push({ mode: selectedMode, dashboard, deck, canvas, chart, wall, label: $('reference-' + selectedMode + '-chart-label'), cards, model: null, data: null, snapshot: null, crawler: null });
    }
    if (!slots.length) return;
    const walkTimers = new Set();
    const later = (fn, ms) => { const timer = setTimeout(() => { walkTimers.delete(timer); fn(); }, ms); walkTimers.add(timer); };
    function stopWalking() {
      walkTimers.forEach(clearTimeout); walkTimers.clear();
      document.querySelectorAll('.reference-is-walking, .reference-is-speaking').forEach(node => {
        node.classList.remove('reference-is-walking', 'reference-is-speaking');
        node.style.setProperty('--walk-x', '0px'); node.style.setProperty('--walk-y', '0px');
        const character = node.querySelector('.station-character, .after-mascot');
        character?.style.setProperty('--walk-x', '0px'); character?.style.setProperty('--walk-y', '0px');
        const speech = node.querySelector('.reference-speech'); if (speech) speech.hidden = true;
      });
    }
    function walk(source, target, text) {
      if (!source || !target || motion.matches || document.hidden) return;
      stopWalking();
      const character = source.querySelector('.station-character, .after-mascot'); if (!character) return;
      const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
      const x = Math.max(-150, Math.min(150, (to.left + to.width / 2 - from.left - from.width / 2) * .68));
      const y = Math.max(-95, Math.min(95, (to.top + to.height / 2 - from.top - from.height / 2) * .68));
      source.style.setProperty('--walk-x', x.toFixed(1) + 'px'); source.style.setProperty('--walk-y', y.toFixed(1) + 'px');
      character.style.setProperty('--walk-x', x.toFixed(1) + 'px'); character.style.setProperty('--walk-y', y.toFixed(1) + 'px'); source.classList.add('reference-is-walking');
      let speech = source.querySelector('.reference-speech'); if (!speech) { speech = el('span', 'reference-speech'); source.append(speech); }
      speech.textContent = String(text || '已有判断').slice(0, 34); speech.hidden = true;
      later(() => { source.classList.add('reference-is-speaking'); speech.hidden = false; }, 600);
      later(() => { source.classList.remove('reference-is-speaking'); speech.hidden = true; character.style.setProperty('--walk-x', '0px'); character.style.setProperty('--walk-y', '0px'); }, 1500);
      later(() => source.classList.remove('reference-is-walking'), 2200);
    }
    let lastFired = 0, lastAfterPhase = '', wasPlaying = false, lastData = null;
    function sync() {
      const live = window.OopsReplay?.state() || {}, after = window.OopsAfterReplay?.state() || {};
      const current = mode === 'after' ? after : live;
      if (current.data !== lastData) { stopWalking(); lastFired = live.fired || 0; lastAfterPhase = ''; wasPlaying = false; lastData = current.data; }
      document.body.classList.toggle('reference-motion-stopped', !current.playing || !rowsOf(current).length || document.hidden || motion.matches);
      if (!current.playing || !rowsOf(current).length || document.hidden || motion.matches) stopWalking();
      else if (mode === 'live' && (live.fired || 0) > lastFired) {
        const fresh = (live.timeline || []).slice(lastFired, live.fired).filter(event => event.f?.layer === 'jev' && event.real > 0 && performance.now() - event.real < 350);
        const event = fresh.at(-1);
        if (event) walk(document.querySelector('.station-judge'), document.querySelector('[data-room-review]') || document.querySelector('.station-minutes'), event.f.a);
      } else if (mode === 'after' && (!wasPlaying || after.phase !== lastAfterPhase) && rowsOf(after).length && after.data.post) {
        if (after.phase === 'minutes' || after.phase === 'evidence') walk(document.querySelector('.after-station-minutes'), document.querySelector('.reference-aux-evidence') || document.querySelector('.after-result-paper'), after.phase === 'evidence' ? '展示原话依据' : '展示原有纪要');
      }
      lastFired = live.fired || 0; lastAfterPhase = after.phase || ''; wasPlaying = !!current.playing;
      const auxTranscript = document.querySelector('.reference-aux-transcript [data-aux-state]');
      const auxEvidence = document.querySelector('.reference-aux-evidence [data-aux-state]');
      if (auxTranscript) auxTranscript.textContent = rowsOf(after).length ? '已有转写' : '等待来源';
      if (auxEvidence) auxEvidence.textContent = rowsOf(after).length && after.data.post ? '当前映射' : '等待来源';
      for (const slot of slots) {
        const snapshot = slot.mode === 'after' ? after : live;
        slot.snapshot = snapshot;
        const model = derive({ ...snapshot, mode }, slot.mode);
        if (snapshot.data !== slot.data || !model.valid) {
          slot.crawler = null; clear(slot.canvas); clear(slot.chart); clear(slot.wall); slot.data = snapshot.data;
        } else if (!model.playing && slot.model?.transition !== model.transition) {
          // A deliberate paused seek changes focus without leaving feet at the old step.
          slot.crawler = null; clear(slot.canvas);
        }
        slot.model = model;
        model.cards.forEach((card, i) => {
          const view = slot.cards[i]; view.value.textContent = card.value; view.note.textContent = card.note;
          view.button.classList.toggle('is-active', card.active); view.button.classList.toggle('is-missing', card.status === 'missing'); view.button.classList.toggle('is-reused', card.status === 'reused'); view.button.classList.toggle('is-historical', card.status === 'historical');
          view.button.setAttribute('aria-label', card.name + '：' + card.value + '，' + card.note + '，查看已有详情');
          view.meter.firstChild.style.width = validP(card.meter) ? card.meter * 100 + '%' : '0%';
        });
        if (slot.label) slot.label.textContent = model.chartLabel;
        drawChart(slot);
        drawWallChart(slot);
        if (model.valid && !slot.crawler) { const target = crawlerTarget(slot); slot.crawler = { x: target.x, y: target.y, angle: 0, feet: [], gait: 0 }; drawCrawler(slot, 0, false); }
      }
    }
    function sized(canvas) {
      if (!canvas) return null;
      const bounds = canvas.getBoundingClientRect(); if (!bounds.width || !bounds.height) return null;
      const dpr = Math.min(2, window.devicePixelRatio || 1), width = Math.round(bounds.width * dpr), height = Math.round(bounds.height * dpr);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, width: bounds.width, height: bounds.height };
    }
    function clear(canvas) { if (!canvas) return; const ctx = canvas.getContext('2d'); ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); }
    function drawChart(slot) {
      const surface = sized(slot.chart); if (!surface) return;
      const { ctx, width: w, height: h } = surface; ctx.clearRect(0, 0, w, h);
      const points = slot.model?.points || [], pad = 14, right = Math.max(pad, Math.min(110, w * .2)), top = 24, bottom = h - 16;
      ctx.strokeStyle = 'rgba(130,166,154,.14)'; ctx.lineWidth = .6;
      for (let i = 0; i <= 3; i++) { const y = top + (bottom - top) * i / 3; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - right, y); ctx.stroke(); }
      if (!points.length) { ctx.fillStyle = '#7f8b89'; ctx.font = '10px monospace'; ctx.fillText(slot.mode === 'live' ? '没有已显示的概率记录' : '尚未展示原话依据', pad, h / 2); return; }
      const maximum = slot.mode === 'live' ? 1 : Math.max(1, ...points.map(point => point.y));
      const coords = points.map((point, i) => ({ x: points.length === 1 ? w - right : pad + i * (w - pad - right) / (points.length - 1), y: bottom - point.y / maximum * (bottom - top) }));
      const gradient = ctx.createLinearGradient(0, top, 0, bottom); gradient.addColorStop(0, 'rgba(61,224,168,.23)'); gradient.addColorStop(1, 'rgba(61,224,168,0)');
      ctx.beginPath(); ctx.moveTo(coords[0].x, bottom); coords.forEach(point => ctx.lineTo(point.x, point.y)); ctx.lineTo(coords.at(-1).x, bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
      ctx.beginPath(); coords.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.strokeStyle = '#4fdfb0'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#4fdfb0'; ctx.font = 'bold ' + Math.max(9,Math.min(14,w/45)) + 'px monospace'; ctx.fillText(slot.mode === 'live' ? 'p ' + points.at(-1).y.toFixed(3) : points.at(-1).y + ' 句依据', w-right+9, 43);
      ctx.fillStyle = '#537b72'; ctx.font = '6px monospace'; ctx.fillText(slot.mode === 'live' ? '已存选项概率' : '当前展示累计', w-right+9, 55);
      coords.forEach((point, i) => { ctx.beginPath(); ctx.arc(point.x, point.y, i === coords.length - 1 ? 2.5 : 1.3, 0, Math.PI * 2); ctx.fillStyle = i === coords.length - 1 ? '#ff48a4' : '#80e9cb'; ctx.fill(); });
    }
    function drawWallChart(slot) {
      const surface = sized(slot.wall); if (!surface) return;
      const { ctx, width: w, height: h } = surface;
      ctx.clearRect(0, 0, w, h);
      const index = slot.mode === 'live' && window.OopsStudio?.currentIndex ? window.OopsStudio.currentIndex(slot.snapshot || {}) : undefined;
      const chart = wallBars(slot.snapshot || {}, slot.mode, index);
      const fontSize = Math.max(5, Math.min(9, w / 35));
      ctx.font = fontSize + 'px monospace'; ctx.fillStyle = '#8facaa'; ctx.fillText(chart.label, 2, fontSize + 1);
      if (!chart.bars.length) return;
      const baseline = h - fontSize - 2, top = fontSize * 2.8;
      if (baseline <= top) return;
      const maximum = slot.mode === 'live' ? 1 : Math.max(1, ...chart.bars.map(bar => bar.value));
      const gap = w / chart.bars.length;
      ctx.strokeStyle = 'rgba(103,153,142,.22)'; ctx.lineWidth = .5; ctx.beginPath(); ctx.moveTo(0, baseline); ctx.lineTo(w, baseline); ctx.stroke();
      chart.bars.forEach((bar, i) => {
        const barWidth = Math.max(1, gap * .62), x = gap * i + (gap - barWidth) / 2, height = bar.value / maximum * Math.max(0, baseline - top);
        ctx.fillStyle = bar.selected ? '#f453b3' : '#4ed9b0'; ctx.fillRect(x, baseline - height, barWidth, height);
        ctx.textAlign = 'center'; ctx.fillStyle = bar.selected ? '#f6a7d6' : '#b5dad0';
        ctx.fillText(slot.mode === 'live' ? bar.value.toFixed(3) : String(bar.value), x + barWidth / 2, baseline - height - 2);
        ctx.fillStyle = '#8d9c9b'; const maxChars = Math.max(2, Math.floor(gap / (fontSize * .6))); ctx.fillText(bar.label.slice(0, maxChars), x + barWidth / 2, h - 1);
      });
      ctx.textAlign = 'start';
    }
    function crawlerTarget(slot) {
      const base = slot.canvas?.getBoundingClientRect() || slot.deck.getBoundingClientRect();
      const index = Math.max(0, KEYS.indexOf(slot.model.target));
      const onWall = slot.model.transition > 0 && slot.model.transition % 2 === 0;
      const room = slot.deck.querySelector('.studio-room, .after-studio-room');
      const target = onWall && room ? room.getBoundingClientRect() : slot.cards[index].button.getBoundingClientRect();
      return { x: target.left - base.left + target.width * (onWall ? .54 : .55), y: target.top - base.top + target.height * (onWall ? .2 : .52) };
    }
    function drawCrawler(slot, dt, animate) {
      const surface = sized(slot.canvas); if (!surface || !slot.crawler || !slot.model.valid) return;
      const { ctx, width: w, height: h } = surface, body = slot.crawler, target = crawlerTarget(slot), scale = Math.max(.38, Math.min(.9, w / 1000));
      const dx = target.x - body.x, dy = target.y - body.y, distance = Math.hypot(dx, dy);
      let travel = 0;
      if (animate && distance > .2) { const k = Math.min(1, dt / 180); const oldX = body.x, oldY = body.y; body.x += dx * k; body.y += dy * k; travel = Math.hypot(body.x - oldX, body.y - oldY); body.angle += (Math.atan2(dy, dx) + Math.PI / 2 - body.angle) * Math.min(1, dt / 350); body.gait += travel / (30 * scale); }
      const desired = legTargets(body, scale);
      if (!body.feet.length) body.feet = desired.map(point => ({ x: point.x, y: point.y, swing: null }));
      if (animate && travel > .02) desired.forEach((point, i) => {
        const foot = body.feet[i];
        if (!foot.swing && Math.floor(body.gait) % 2 === point.group && Math.hypot(point.x - foot.x, point.y - foot.y) > 28 * scale) foot.swing = { fromX: foot.x, fromY: foot.y, x: point.x, y: point.y, t: 0 };
        if (foot.swing) { const step = foot.swing; step.t = Math.min(1, step.t + dt / 150); const ease = step.t * step.t * (3 - 2 * step.t); foot.x = step.fromX + (step.x - step.fromX) * ease; foot.y = step.fromY + (step.y - step.fromY) * ease - Math.sin(step.t * Math.PI) * 8 * scale; if (step.t === 1) foot.swing = null; }
      });
      ctx.clearRect(0, 0, w, h); ctx.lineWidth = .85; ctx.lineJoin = 'round';
      body.feet.forEach((foot, i) => {
        const side = i < 4 ? -1 : 1, n = i % 4, hipX = body.x + Math.cos(body.angle) * side * 9 * scale - Math.sin(body.angle) * (n - 1.5) * 7 * scale, hipY = body.y + Math.sin(body.angle) * side * 9 * scale + Math.cos(body.angle) * (n - 1.5) * 7 * scale;
        const mx = (hipX + foot.x) / 2, my = (hipY + foot.y) / 2, vx = foot.x - hipX, vy = foot.y - hipY, len = Math.hypot(vx, vy) || 1;
        const knee = { x: mx - vy / len * side * 26 * scale, y: my + vx / len * side * 26 * scale - 13 * scale };
        ctx.strokeStyle = i % 3 === 0 ? 'rgba(255,67,159,.9)' : 'rgba(71,224,179,.9)'; ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(knee.x, knee.y); ctx.lineTo(foot.x, foot.y); ctx.stroke();
        for (const point of [knee, foot]) { ctx.beginPath(); ctx.arc(point.x, point.y, (point === foot ? 2.3 : 1.8) * scale, 0, Math.PI * 2); ctx.fillStyle = i % 3 === 0 ? '#ff55b2' : '#62e4bd'; ctx.fill(); }
      });
      ctx.save(); ctx.translate(body.x, body.y); ctx.rotate(body.angle); ctx.scale(scale, scale); ctx.strokeStyle = '#75f0d2'; ctx.fillStyle = 'rgba(5,12,17,.75)'; ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(15, -9); ctx.lineTo(11, 16); ctx.lineTo(0, 29); ctx.lineTo(-11, 16); ctx.lineTo(-15, -9); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(0, 29); ctx.moveTo(-15, -9); ctx.lineTo(11, 16); ctx.moveTo(15, -9); ctx.lineTo(-11, 16); ctx.stroke();
      ctx.strokeStyle = '#ff4caa'; ctx.strokeRect(-7, -30, 14, 10); ctx.restore();
    }
    document.querySelector('[data-room-review]')?.addEventListener('click', () => selectStation('review', 'live'));
    const names = ['funnel:data', 'funnel:tick', 'funnel:play', 'funnel:selection', 'funnel:after-data', 'funnel:after-tick', 'funnel:after-play'];
    names.forEach(name => document.addEventListener(name, sync));
    document.addEventListener('funnel:mode', event => { stopWalking(); mode = event.detail?.mode || 'live'; wasPlaying = false; sync(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopWalking(); sync(); });
    motion.addEventListener?.('change', () => { stopWalking(); sync(); });
    new ResizeObserver(() => { slots.forEach(slot => { drawChart(slot); drawWallChart(slot); if (slot.model?.valid) drawCrawler(slot, 0, false); }); }).observe(slots[0].deck);
    let previousFrame = 0;
    function frame(time) { const dt = Math.min(40, Math.max(0, time - previousFrame)); previousFrame = time; for (const slot of slots) if (slot.mode === mode && slot.model?.playing && slot.model.valid && !document.hidden && !motion.matches) drawCrawler(slot, dt, true); requestAnimationFrame(frame); }
    sync(); requestAnimationFrame(frame);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialise, { once: true }); else initialise();
})();
