// Oops 实时漏斗（视频风格）：按会议时间回放 scripts/funnel_replay.py 生成的数据。
// 每句话被问几个带类型的问题；每个问题由一层来答，线从这句话连到右侧弧上属于那一层的扇区，扇区正对该层的卡片。
// 刻度长度 = 置信度 p（没有 p 的按满长画）。文字一律用 textContent 写入；打开的回放文件只在本机读取，不上传。
(() => {
  'use strict';
  const LAYERS = {
    code: { name: '规则', color: '#3fd9a0', delay: 1 },
    jev: { name: 'Jev', color: '#5cc3ff', delay: 480 },
    sol: { name: 'Sol', color: '#b99bff', delay: 480 },
    model: { name: 'DeepSeek', color: '#f2896b', delay: 950 },
    you: { name: '你', color: '#f4cc4e', delay: 300 },
  };
  LAYERS.unknown = { name: '未记录', color: '#7d848d', delay: 1 };
  const PROVENANCE = { recorded: '历史记录', stored: '已存结果', recomputed: '当前规则重算', required: '确认要求', example: '编写示例', missing: '未记录', reanalysis: '本次重新分析' };
  const ALL_ORDER = ['code', 'jev', 'sol', 'model', 'you'];
  let ORDER = ['code', 'jev', 'model', 'you'];
  let IDX = Object.fromEntries(ORDER.map((k, i) => [k, i]));
  const layerCounts = () => Object.fromEntries([...ALL_ORDER, 'unknown'].map(k => [k, 0]));
  const SPEEDS = [1, 2, 5, 10, 30, 60];
  const PINK = '#ff3d8b';
  const GOLD = 0.6180339887;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'; };

  const ui = {
    stage: $('stage'), fan: $('fan'), canvas: $('canvas'), transcript: $('transcript'), play: $('play'), restart: $('restart'),
    speed: $('speed'), scrub: $('scrub'), clock: $('clock'), file: $('file'), badge: $('source-badge'), label: $('source-label'),
    note: $('source-note'), stream: $('stream'), scope: $('stream-scope'), follow: $('follow'), spark: $('spark'),
    sparkFoot: $('spark-foot'), dots: $('dots'), dotsFoot: $('dots-foot'), bars: $('bars'), exits: $('exits'), lens: $('lens'),
    statusLeft: $('status-left'), statusRight: $('status-right'), drop: $('drop'), paneLine: $('pane-line'),
    cards: ORDER.map((k) => document.querySelector('.route.r-' + k)),
  };
  const ctx = ui.canvas.getContext('2d');

  let data = null, sentences = [], timeline = [], duration = 1;
  let semanticEvents = [], semanticFired = 0, lastSemanticRendered = -1;
  let routingView = 'content';
  let now = 0, fired = 0, playing = false, speed = 1, lastFrame = 0, lastRendered = -1;
  let selected = null, userScrolledAt = -Infinity, lastStudioTick = 0;
  let liveFollowing = false, livePulseUntil = 0, liveFocus = -1;
  let canvasDirty = true, lastDomFrame = 0, lastPaintFrame = 0, drawingBlocked = false;
  let strandCache = null;
  let streamRowCache = new Map();
  const openCallDetails = new Set();
  const spider = { x: 0, y: 0, ready: false };
  const neon = window.OopsSpider ? window.OopsSpider.create({ scale: 0.55, tone: '#3fd9a0' }) : null;

  // Content lanes are a display of saved tags, separate from real processing
  // forks. A sentence contributes once, even when it has no processing trace.
  const contentApi = () => window.OopsContentPlayback;
  const contentRouting = () => routingView === 'content' && Boolean(contentApi());
  const viewOrder = () => contentRouting() ? contentApi().order : ORDER;
  const viewCards = () => contentRouting() ? contentApi().cards() : ui.cards;
  const viewEvents = () => contentRouting() ? semanticEvents : timeline;
  const viewFired = () => contentRouting() ? semanticFired : fired;
  const visualLayer = e => e.semanticKey || e.f.layer;
  const visualMeta = key => contentRouting() ? contentApi().layers[key] : LAYERS[key];
  const viewIndex = key => viewOrder().indexOf(key);
  const visualProbability = e => e.semanticKey ? null : e.f.p;
  const visualSettled = e => !e.semanticKey && e.f.settled;

  function buildSemanticEvents() {
    const api = contentApi();
    if (!api) { semanticEvents = []; semanticFired = 0; return; }
    const counts = Object.fromEntries(api.order.map(key => [key, 0]));
    semanticEvents = sentences.map(s => {
      const semanticKey = api.layer(s);
      s.semanticKey = semanticKey;
      if (s.row) s.row.style.setProperty('--semantic-color', api.layers[semanticKey].color);
      if (s.dot) s.dot.style.setProperty('--semantic-color', api.layers[semanticKey].color);
      return { t: s.doneAt, i: s.i, semanticKey, slot: (counts[semanticKey]++ * GOLD + 0.5 * GOLD) % 1, real: 0 };
    }).sort((a, b) => a.t - b.t);
    semanticFired = semanticEvents.filter(e => e.t <= now).length;
    lastSemanticRendered = -1;
    strandCache = null;
  }

  function updateRoutingLayout() {
    const content = contentRouting();
    document.body.classList.toggle('content-routing', content);
    if ($('process-routes')) $('process-routes').hidden = content;
    if ($('content-routes')) $('content-routes').hidden = !content;
    $('routing-content')?.setAttribute('aria-pressed', String(content));
    $('routing-process')?.setAttribute('aria-pressed', String(!content));
    if ($('routing-explanation')) $('routing-explanation').textContent = content
      ? data?.content_review ? '本次助手复核 · 叠加原时间线；不是当时实时判断，决定和待办仍需核对。'
        : '按已保存分类分流；连线不表示置信度，决定和待办仍需核对。'
      : '按实际保存的处理步骤分流；同一句可能经过多个处理方。';
    if (content && data?.content_review) {
      ui.badge.textContent = '本次助手复核 · 只读';
      ui.note.textContent = '结合前后文重新判读本场全部原话，分类与理由独立保存；原标签、处理过程与会议内容保留。事实陈述不等于事实已核实。';
    } else {
      if (ui.badge.dataset.originalLabel) ui.badge.textContent = ui.badge.dataset.originalLabel;
      if (ui.note.dataset.sourceNote != null) ui.note.textContent = ui.note.dataset.sourceNote;
      if (data?.content_review_status && data.content_review_status.status !== 'ready') {
        ui.note.textContent += data.content_review_status.status === 'source_changed'
          ? ' 本次助手复核的来源已变化，当前仅显示原保存分类和处理记录。'
          : ' 本次助手复核暂不可用，当前仅显示原保存分类和处理记录。';
      }
    }
    if ($('stream-title')) $('stream-title').textContent = content && data?.content_review ? '▪ 本次复核依据' : '▪ 决策流水';
    if ($('stream-columns')) $('stream-columns').textContent = content && data?.content_review ? '原话 · 本次分类 · 理由 · 去向' : '原话 · 问题 · 答案 · p · 去向';
    ui.bars.replaceChildren();
    strandCache = null; canvasDirty = true; lastRendered = -1; lastSemanticRendered = -1;
  }

  // ---------------------------------------------------------------- data
  function validate(raw) {
    if (!raw || ![1, 2].includes(raw.version) || !Array.isArray(raw.sentences)) throw new Error('不是 funnel_replay.py 生成的漏斗数据（version 1 / 2）');
    for (const s of raw.sentences) {
      if (!s || typeof s.text !== 'string' || !Number.isFinite(s.end_ms) || !Array.isArray(s.forks)) throw new Error('句子格式无效：' + (s?.id || '?'));
      for (const f of s.forks) if (!f || !LAYERS[f.layer]) throw new Error('未知的层：' + f?.layer);
    }
    const legacy = raw.version === 1;
    // Missing or malformed probabilities stay unknown, rather than crashing
    // toFixed/canvas or inventing a measured confidence for the old record.
    const fork = f => ({ ...f, p: f.layer !== 'sol' && f.confidence_kind !== 'uncalibrated' && Number.isFinite(f.p) && f.p >= 0 && f.p <= 1 ? f.p : null });
    const floor = raw.thresholds?.tag_floor;
    const review = raw.content_review;
    const reviewTags = new Set(['decision', 'commitment', 'idea', 'fact', 'question', 'constraint', 'chitchat', 'uncertain']);
    if (review && (review.version !== 1 || review.kind !== 'assistant_posthoc' || review.source_session_id !== raw.source?.session_id
        || review.source_snapshot_hash !== (raw.source?.original_source_snapshot_hash || raw.source?.snapshot_hash) || review.sentence_count !== raw.sentences.length)) {
      throw new Error('本次复核与会议来源不匹配，已停止载入');
    }
    const validatedSentences = raw.sentences.map(s => {
      const judgment = review ? s.content_review : null;
      if (review && (!judgment || !reviewTags.has(judgment.tag) || typeof judgment.reason !== 'string'
          || typeof judgment.evidence_quote !== 'string' || !judgment.evidence_quote.trim() || !s.text.includes(judgment.evidence_quote)
          || !['id', 'text', 'start_ms', 'end_ms', 'speaker'].every(key => judgment.source_binding?.[key] === (s[key] ?? null)))) {
        throw new Error('本次复核的原话绑定已失效：' + s.id);
      }
      return { ...s, content_review: judgment, forks: s.forks.map(fork) };
    });
    return { ...raw, sentences: validatedSentences,
      session: (Array.isArray(raw.session) ? raw.session : []).filter(e => e?.fork && LAYERS[e.fork.layer]).map(e => ({ ...e, fork: fork(e.fork) })),
      source: { ...raw.source, note: (raw.source?.note || '') + (legacy ? ' 旧版文件：来源标签与中间步骤未完整记录；0.95 仅为旧展示值，不能证明后端自动结束。' : '') },
      thresholds: { ...raw.thresholds, tag_floor: Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : 0.5 } };
  }

  function load(raw, options = {}) {
    const previous = options.preserve ? { now, playing, speed, selectedId: sentences[selected]?.id, scroll: ui.transcript.scrollTop, data } : null;
    if (!previous) userScrolledAt = -Infinity;
    const liveView = raw.source?.live;
    data = validate(raw);
    renderLayerLayout();
    // Current deployment metadata is independent of this replay's historical configuration.
    data.deployed_pipeline = deployedPipeline || { scope: 'unavailable' };
    timeline = []; openCallDetails.clear(); streamRowCache.clear();
    sentences = data.sentences.map((s, i) => {
      const out = { ...s, i, start_ms: Number.isFinite(s.start_ms) ? s.start_ms : s.end_ms, state: '', firedSteps: 0 };
      let cursor = s.end_ms;
      s.forks.forEach((f, k) => {
        cursor += Number.isFinite(f.ms) && f.ms >= 0 ? f.ms : LAYERS[f.layer].delay;
        timeline.push({ t: cursor, i, k, f });
      });
      out.doneAt = cursor;
      out.route = LAYERS[out.route] ? out.route : 'unknown';
      out.outcome = s.outcome || LAYERS[out.route].name + ' 结束';
      out.filler = s.forks.length === 1 && s.forks[0].layer === 'code' && s.forks[0].settled && raw.source?.kind !== 'history';
      return out;
    });
    for (const e of data.session || []) {
      if (e && e.fork && LAYERS[e.fork.layer]) timeline.push({ t: (e.at_ms || 0) + (e.fork.ms || 0), i: -1, k: 0, f: e.fork });
    }
    timeline.sort((a, b) => a.t - b.t);
    const seq = layerCounts();
    timeline.forEach((e) => { e.slot = (seq[e.f.layer]++ * GOLD + 0.5 * GOLD) % 1; e.real = 0; });
    duration = Math.max(1, ...timeline.map((e) => e.t), ...sentences.map((s) => s.end_ms)) + 1500;

    const replay = data.source && ['replay', 'history', 'reanalysis'].includes(data.source.kind);
    const historical = data.source?.kind === 'history';
    ui.badge.textContent = liveView ? (liveView.active ? '现场同步 · 只读' : '会话已结束 · 只读') : data.source?.kind === 'reanalysis' ? (data.source.deepseek_run ? '重新分析 · Jev / DeepSeek' : '重新分析 · Jev') : historical ? '后端历史 · 只读' : replay ? (privateHistory ? '事后分析 · 只读' : '分析回放 · 仅本机') : '示例数据';
    ui.badge.className = 'badge ' + (replay ? 'replay' : 'example');
    ui.badge.dataset.originalLabel = ui.badge.textContent;
    ui.label.textContent = (data.source && data.source.label) || '';
    ui.note.textContent = (data.source && data.source.note) || '';
    if (liveView?.active) ui.note.textContent = '每 5 秒读取已到达服务器的原话与处理记录；尚未收到会话结束标记。缺失步骤和概率保持空白，不重新调用模型。';
    ui.note.dataset.sourceNote = ui.note.textContent;
    $('pane-title').textContent = data.source?.kind === 'reanalysis' ? 'reanalysis.readonly' : historical ? 'history.readonly' : replay ? 'replay.local' : 'meeting.example';
    renderPipeline();

    buildTranscript();
    buildDots();
    contentApi()?.update(replayState());
    buildSemanticEvents();
    updateRoutingLayout();
    buildExits();
    renderLens();
    speed = SPEEDS.find((v) => v >= duration / 60000) || 60;
    ui.speed.value = String(speed);
    selected = null; ui.follow.hidden = true;
    if (previous) {
      speed = previous.speed; ui.speed.value = String(speed);
      selected = options.followLatest ? null : sentences.findIndex(s => s.id === previous.selectedId);
      if (selected < 0) selected = null;
    }
    seek(options.followLatest ? duration : previous ? (selected != null ? sentences[selected].doneAt : previous.now) : reduceMotion ? duration : 0);
    // Loaded records wait for an explicit playback action; opening a source is read-only.
    setPlaying(Boolean(previous?.playing && !options.followLatest));
    ui.follow.hidden = selected == null;
    if (previous && (scrollCooling() || !options.followLatest && (!previous.playing || selected != null))) ui.transcript.scrollTop = previous.scroll;
    if (options.followLatest && sentences.length) autoScroll(sentences[sentences.length - 1].row);
    if (previous && options.followLatest && !reduceMotion) {
      const old = new Map(previous.data.sentences.map(s => [s.id, s]));
      for (const e of timeline) {
        const prior = old.get(sentences[e.i]?.id);
        if (e.i >= 0 && JSON.stringify(prior?.forks?.[e.k]) !== JSON.stringify(e.f)) {
          e.real = performance.now(); liveFocus = e.i;
          if (!contentRouting()) flash(e.f.layer);
          livePulseUntil = e.real + 1600;
        }
      }
      for (const e of semanticEvents) {
        const s = sentences[e.i], prior = old.get(s.id);
        if (!prior || prior.tag !== s.tag || prior.text !== s.text) {
          e.real = performance.now(); liveFocus = e.i;
          if (contentRouting()) flash(e.semanticKey);
          livePulseUntil = e.real + 1600;
        }
      }
    }
    if (!previous || JSON.stringify([previous.data.sentences, previous.data.post, previous.data.post_status, previous.data.live_draft, previous.data.source?.live, previous.data.content_review, previous.data.content_review_status, previous.data.source?.snapshot_hash]) !== JSON.stringify([data.sentences, data.post, data.post_status, data.live_draft, data.source?.live, data.content_review, data.content_review_status, data.source?.snapshot_hash])) {
      document.dispatchEvent(new CustomEvent('funnel:data', { detail: data }));
    }
    emitReplayState('funnel:tick');
    renderLiveStatus();
  }

  function renderLayerLayout() {
    const forks = data.sentences.flatMap(s => s.forks).concat((data.session || []).map(e => e.fork));
    const hasSol = forks.some(f => f.layer === 'sol');
    const hasJev = forks.some(f => f.layer === 'jev');
    ORDER = ALL_ORDER.filter(k => k === 'sol' ? hasSol : k === 'jev' ? !hasSol || hasJev : true);
    IDX = Object.fromEntries(ORDER.map((k, i) => [k, i]));
    ALL_ORDER.forEach(k => { document.querySelector('.route.r-' + k).hidden = !ORDER.includes(k); });
    $('counter-sol').hidden = !hasSol;
    $('counter-jev').hidden = hasSol && !hasJev;
    document.querySelector('.routes').style.setProperty('--route-count', String(ORDER.length));
    document.querySelector('.counters').style.setProperty('--counter-count', String(ORDER.length + 2));
    ui.cards = ORDER.map(k => document.querySelector('.route.r-' + k));
    // The old model lane records DeepSeek in legacy files. Never label an
    // unused lane as an executed provider in a current Sol meeting.
    LAYERS.model.name = data.source?.kind === 'history' && !forks.some(f => f.layer === 'model') ? '生成模型' : 'DeepSeek';
    $('counter-model-name').textContent = LAYERS.model.name;
    $('route-model-name').textContent = '→ ' + LAYERS.model.name;
    $('spark-title').textContent = hasSol && !hasJev ? '▪ Sol · 语义选择' : '▪ Jev 已存概率 · 最近 40 次';
    ui.spark.setAttribute('aria-label', hasSol && !hasJev ? 'Sol 语义选择不返回概率' : '最近 40 次 Jev 已存概率');
    ui.bars.replaceChildren();
    strandCache = null;
  }

  function renderPipeline() {
    const pipeline = data?.deployed_pipeline || {};
    const deployed = pipeline.scope === 'deployed_source';
    $('research-state').textContent = deployed ? (pipeline.in_meeting_research === true ? '部署源码包含会中研究；执行看记录' : pipeline.in_meeting_research === false ? '部署源码未进入会中研究；历史另核对' : '部署的会中自动研究状态未知') : '部署配置暂不可读取';
    const configured = pipeline.minutes_configured_runs;
    $('pipeline-note').textContent = (deployed ? '流程来源：已部署源码' : '部署配置暂不可读取；当前工作区源码供比较，不代表线上部署') + (pipeline.verified_at ? ' · 核对于 ' + pipeline.verified_at : '') + (configured ? ' · 纪要配置 ' + configured + ' 次独立生成后投票' : '') + '。这些是源码配置；每场实际执行只以保存记录为准。' + (pipeline.legacy_auto_delivery_supported === true ? ' 部署源码还包含旧自动共享链路；本页只读取历史，不触发发送。' : '');
  }

  function clauses(text) {
    const parts = text.match(/[^，。！？,.!?；;、]+[，。！？,.!?；;、]*|[，。！？,.!?；;、]+/g) || [text];
    const visible = parts.map((p) => p.trim()).filter(Boolean);
    return visible.length ? visible : ['（空白原话）'];
  }

  function buildTranscript() {
    ui.transcript.replaceChildren(...sentences.map((s, i) => {
      const li = el('li');
      li.hidden = true; li.tabIndex = 0;
      li.append(el('span', 'ts', mmss(s.start_ms)), el('span', 'spk', s.speaker || '—'));
      s.txt = el('span', 'txt');
      s.typing = el('span', 'typing');
      s.boxes = clauses(s.text).map((c) => el('span', 'box', c));
      li.append(s.txt);
      li.title = '点开看这句话经过的每个问题';
      const pick = () => selectSentence(i);
      li.addEventListener('click', pick);
      li.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
      s.row = li;
      return li;
    }));
  }

  function buildDots() {
    ui.dots.replaceChildren(...sentences.map((s) => { const d = el('i'); d.title = s.id + ' · ' + s.outcome; s.dot = d; return d; }));
  }

  function buildExits() {
    const rows = [];
    [...ORDER, 'unknown'].forEach((k) => {
      const counts = new Map();
      sentences.filter((s) => s.route === k).forEach((s) => counts.set(s.outcome, (counts.get(s.outcome) || 0) + 1));
      [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([label]) => {
        const li = el('li', 'zero');
        li.dataset.layer = k; li.dataset.label = label;
        li.append(el('span', 'ly l-' + k, LAYERS[k].name), el('span', 'lab', label), el('b', null, '0'));
        rows.push(li);
      });
    });
    ui.exits.replaceChildren(...rows);
  }

  // ---------------------------------------------------------------- state
  function setPlaying(on) {
    playing = Boolean(on && data && now < duration && !document.hidden);
    ui.play.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
    ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
    emitReplayState('funnel:play');
  }

  const replayState = () => ({ data, sentences, timeline, now, duration, playing, speed, selected, fired, routingView });
  function emitReplayState(name) {
    document.dispatchEvent(new CustomEvent(name, { detail: replayState() }));
  }

  function selectSentence(index) {
    if (!Number.isInteger(index) || !sentences[index]) return;
    pauseLiveFollow();
    setPlaying(false);
    selected = index; ui.follow.hidden = false;
    // Selecting an already saved sentence reveals its complete recorded steps.
    seek(sentences[index].doneAt);
    markSelected();
    emitReplayState('funnel:selection');
  }

  function followPlayback() {
    selected = null; ui.follow.hidden = true; markSelected(); lastRendered = -1;
    render(true, true); emitReplayState('funnel:selection');
  }

  function seek(t) {
    now = Math.min(Math.max(0, t), duration);
    spider.ready = false;
    if (neon) neon.reset();
    fired = 0;
    sentences.forEach((s) => { s.state = ''; s.firedSteps = 0; });
    while (fired < timeline.length && timeline[fired].t <= now) {
      timeline[fired].real = 0;
      if (timeline[fired].i >= 0) sentences[timeline[fired].i].firedSteps++;
      fired++;
    }
    semanticFired = 0;
    semanticEvents.forEach(e => { e.real = 0; });
    while (semanticFired < semanticEvents.length && semanticEvents[semanticFired].t <= now) semanticFired++;
    lastRendered = -1;
    render(true, selected == null);
    emitReplayState('funnel:tick');
  }

  const stateOf = (s) => now < s.start_ms ? 'hidden' : now < s.end_ms ? 'partial' : now >= s.doneAt ? 'done' : 'thinking';

  // ---------------------------------------------------------------- DOM render
  function render(full, followCurrent = false) {
    if (full) { canvasDirty = true; drawingBlocked = false; strandCache = null; }
    contentApi()?.update(replayState());
    let heard = 0, currentRow = null;
    for (const s of sentences) {
      const st = stateOf(s);
      if (st !== 'hidden') currentRow = s.row;
      if (st === 'partial') {
        const share = (now - s.start_ms) / Math.max(1, s.end_ms - s.start_ms);
        s.typing.textContent = s.text.slice(0, Math.max(1, Math.round(s.text.length * share)));
      }
      if (st === 'thinking' || st === 'done') heard++;
      if (st === s.state && !full) continue;
      if (st === 'partial') s.txt.replaceChildren(s.typing);
      else if (s.state === 'partial' || s.state === '' || s.state === 'hidden' || full) s.txt.replaceChildren(...s.boxes);
      s.state = st;
      s.row.hidden = st === 'hidden';
      s.row.className = [st, st === 'done' ? 'route-' + s.route : '', st === 'done' ? 'semantic-' + s.semanticKey : '', s.filler && st === 'done' ? 'filler' : '', selected === s.i ? 'selected' : ''].join(' ').trim();
      s.dot.className = st === 'done' ? contentRouting() ? 'semantic-done' : s.route : st === 'thinking' ? 'heard' : '';
    }
    // Follow the reached sentence, including typing and short judgements that
    // can jump directly to done between DOM frames at higher playback speeds.
    if (followCurrent && selected == null && currentRow) autoScroll(currentRow);
    ui.paneLine.textContent = '句 ' + heard + ' / ' + sentences.length;
    ui.dotsFoot.textContent = heard + ' / ' + sentences.length + ' 句已听完';
    ui.clock.textContent = mmss(now) + ' / ' + mmss(duration);
    ui.scrub.value = String(Math.round((now / duration) * 1000));
    if ($('routing-progress')) $('routing-progress').textContent = contentRouting()
      ? '已分流 ' + semanticFired + ' / ' + sentences.length + ' 句'
      : '已回放 ' + heard + ' 句 · ' + fired + ' 条处理步骤';
    if (fired === lastRendered && semanticFired === lastSemanticRendered && !full) return;
    lastRendered = fired;
    lastSemanticRendered = semanticFired;

    const c = layerCounts();
    for (let j = 0; j < fired; j++) c[timeline[j].f.layer]++;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    $('c-sent').textContent = heard; $('c-fork').textContent = total;
    const ended = Object.fromEntries([...ALL_ORDER, 'unknown'].map(k => [k, new Map()]));
    const endedN = layerCounts();
    for (const s of sentences) if (now >= s.doneAt) { ended[s.route].set(s.outcome, (ended[s.route].get(s.outcome) || 0) + 1); endedN[s.route]++; }
    ALL_ORDER.forEach((k) => {
      $('c-' + k).textContent = c[k];
      $('r-' + k).textContent = c[k];
      $('r-' + k + '-sub').textContent = '最后有记录的处理方 ' + endedN[k] + ' 句';
      const top = [...ended[k].entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
      $('r-' + k + '-top').replaceChildren(...top.map(([l, n]) => { const li = el('li'); li.append(el('span', null, l), el('span', null, String(n))); return li; }));
    });
    for (const li of ui.exits.children) {
      const n = ended[li.dataset.layer].get(li.dataset.label) || 0;
      li.lastChild.textContent = n; li.classList.toggle('zero', !n);
    }
    if (contentRouting()) {
      const categories = Object.fromEntries(viewOrder().map(key => [key, 0]));
      for (let j = 0; j < semanticFired; j++) categories[semanticEvents[j].semanticKey]++;
      renderBars(categories, semanticFired, heard);
    } else renderBars(c, total, heard);
    renderStream();
    renderSpark();
    ui.statusLeft.textContent = 'oops@funnel · ' + sentences.length + ' 句 · ' + (data.source?.kind === 'reanalysis' ? '重新分析（只读）' : data.source?.kind === 'history' ? '后端历史（只读）' : data.source?.kind === 'replay' ? (privateHistory ? '事后分析回放（只读）' : '重新分析回放（仅本机）') : '示例数据') + ' · ' + mmss(now);
    ui.statusRight.textContent = contentRouting() ? '已分流 ' + semanticFired + ' / ' + sentences.length + ' 句 · 内容分类取自已存结果'
      : '岔口 ' + total + ORDER.map(k => ' · ' + LAYERS[k].name + ' ' + c[k]).join('') + (c.unknown ? ' · 来源未记录 ' + c.unknown : '');
    // A source revocation/load(empty) must remove the old pixels immediately,
    // even when this panel is hidden and its animation is deliberately asleep.
    if (!sentences.length && !timeline.length) {
      ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
      strandCache = null; canvasDirty = false; spider.ready = false;
      if (neon) neon.reset();
    } else if (full) paintSafely(performance.now());
  }

  function renderBars(c, total, heard) {
    const order = viewOrder();
    if (!ui.bars.children.length) {
      for (const k of order) {
        const li = el('li'), track = el('span', 'track'), fill = el('span', 'fill');
        fill.style.background = visualMeta(k).color; track.append(fill);
        li.append(el('span', 'l-' + k, visualMeta(k).name), track, el('span', 'n l-' + k, '0'));
        ui.bars.append(li);
      }
    }
    [...ui.bars.children].forEach((li, idx) => {
      const k = order[idx];
      li.children[1].firstChild.style.width = (total ? (c[k] / total) * 100 : 0) + '%';
      li.children[2].textContent = c[k];
    });
    $('routed-n').textContent = total;
    $('routed-sub').textContent = contentRouting() ? '句已分流 · 全场 ' + sentences.length + ' 句'
      : '个岔口 · 来自 ' + heard + ' 句' + (c.unknown ? ' · ' + c.unknown + ' 条来源未记录' : '');
  }

  function renderStream() {
    if (contentRouting() && data?.content_review) { renderReviewStream(); return; }
    let rows;
    if (selected != null) {
      const s = sentences[selected];
      ui.scope.textContent = '· ' + s.id + ' 的 ' + s.forks.length + ' 个问题';
      const done = s.firedSteps;
      rows = s.forks.map((f, k) => ({ i: selected, k, f, t: null, pending: k >= done || s.state === 'hidden' || s.state === 'partial' }));
    } else {
      ui.scope.textContent = '';
      rows = [];
      for (let j = fired - 1; j >= 0 && rows.length < 9; j--) rows.push(timeline[j]);
    }
    const visibleRows = new Map();
    const nodes = rows.map((e) => {
      const time = e.t != null ? mmss(e.t) : '#' + (e.k + 1);
      const pending = !!e.pending;
      const cached = streamRowCache.get(e.f);
      // The latest window usually changes by just one step. Keep its other
      // rows, including their full request/context details and open state.
      if (cached && cached.pending === pending && cached.time === time) {
        visibleRows.set(e.f, cached);
        return cached.node;
      }
      const li = el('li', e.pending ? 'pending' : '');
      li.title = (PROVENANCE[e.f.provenance] || '旧文件未记来源') + (e.f.engine ? ' · ' + e.f.engine : '');
      const s = e.i >= 0 ? sentences[e.i] : null;
      const w = el('button', 'w', s ? clip(s.text, 12) : '本场');
      w.type = 'button';
      if (s) w.addEventListener('click', () => selectSentence(s.i));
      const a = el('span', 'a', e.pending ? '等待…' : e.f.a);
      if (!e.pending) {
        const source = PROVENANCE[e.f.provenance] || '旧文件未记来源';
        a.append(el('span', 'evidence-origin', ' · ' + source + (e.f.historical_only ? '（旧研究流程）' : '')));
        const detail = [e.f.engine, e.f.recorded_at, e.f.task_clause].filter(Boolean).join(' · ');
        if (detail) { const details = el('details', 'trace-details'); details.append(el('summary', null, '模型 / 记录时间'), el('span', null, detail)); a.append(details); }
      }
      const p = el('span', 'p' + (e.f.layer === 'jev' && e.f.p != null && e.f.p < data.thresholds.tag_floor ? ' low' : ''), !e.pending && e.f.p != null ? 'p ' + e.f.p.toFixed(2) : '');
      li.append(el('span', 't', time), w, el('span', 'q', e.f.q), a, p, el('span', 'to l-' + e.f.layer, '→ ' + LAYERS[e.f.layer].name));
      if (!e.pending && e.f.request) li.append(renderRequestDetail(e.f));
      visibleRows.set(e.f, { node: li, pending, time });
      return li;
    });
    // Retain only this window; old private nodes must not accumulate during
    // playback, and load/clear drops this cache before rendering a new source.
    streamRowCache = visibleRows;
    if (nodes.length !== ui.stream.children.length || nodes.some((node, i) => ui.stream.children[i] !== node)) ui.stream.replaceChildren(...nodes);
    if (!rows.length) {
      const s = selected != null ? sentences[selected] : null;
      ui.stream.append(el('li', 'muted', s ? (s.tag ? s.outcome + '；没有模型及中间判断记录。' : '这句话没有历史判断记录；不补算或重新调用模型。') : '还没有判断记录。'));
    }
  }

  function renderReviewStream() {
    const events = selected != null ? semanticEvents.filter(e => e.i === selected) : semanticEvents.slice(0, semanticFired).slice(-9).reverse();
    ui.scope.textContent = selected != null ? '· ' + sentences[selected].id : '· 当前回放到的原话';
    streamRowCache.clear();
    ui.stream.replaceChildren(...events.map(e => {
      const s = sentences[e.i], judgment = s.content_review;
      const li = el('li');
      li.title = '本次助手复核 · 原处理记录另行保留';
      const original = el('button', 'w', clip(s.text, 12));
      original.type = 'button'; original.addEventListener('click', () => selectSentence(s.i));
      const answer = el('span', 'a', judgment.reason);
      const quote = el('details', 'trace-details');
      quote.append(el('summary', null, '原话依据'), el('span', null, judgment.evidence_quote));
      answer.append(quote);
      const to = el('span', 'to', '→ ' + visualMeta(e.semanticKey).name);
      to.style.color = visualMeta(e.semanticKey).color;
      li.append(el('span', 't', mmss(s.start_ms)), original, el('span', 'q', visualMeta(e.semanticKey).name), answer, el('span', 'p'), to);
      return li;
    }));
    if (!events.length) ui.stream.append(el('li', 'muted', '播放后逐句显示本次复核的分类和原话依据。'));
  }

  function renderRequestDetail(f) {
    const detail = el('details', 'call-detail');
    detail.append(el('summary', null, '实际请求 / 输入上下文 / 全部选项概率'));
    const detailKey = String(f.call_index) + ':' + f.q;
    detail.open = openCallDetails.has(detailKey);
    detail.addEventListener('toggle', () => { if (detail.open) openCallDetails.add(detailKey); else openCallDetails.delete(detailKey); });
    const model = [f.requested_model ? '请求模型 ' + f.requested_model : '请求模型未记录', f.response_model ? '返回模型 ' + f.response_model : '返回模型未记录', Number.isFinite(f.call_latency_ms) ? '实际请求耗时 ' + f.call_latency_ms + ' ms' : '耗时未记录', Number.isInteger(f.attempt) ? '尝试 ' + f.attempt : ''].filter(Boolean).join(' · ');
    detail.append(el('p', null, model));
    if (f.instructions) detail.append(el('p', 'call-instruction', f.instructions));
    const table = el('table', 'probabilities');
    const head = el('tr'); ['选项', '判定标准（实际请求）', '返回概率'].forEach(text => head.append(el('th', null, text))); table.append(head);
    const keys = [...new Set([...Object.keys(f.criteria || {}), ...Object.keys(f.probabilities || {})])];
    keys.forEach(key => {
      const tr = el('tr', f.choice === key ? 'chosen' : '');
      tr.append(el('td', null, key + (f.choice === key ? ' ← 返回选择' : '')), el('td', null, f.criteria?.[key] || '未记录标准'), el('td', null, Number.isFinite(f.probabilities?.[key]) ? String(f.probabilities[key]) : '未返回'));
      table.append(tr);
    });
    detail.append(table, el('p', null, '实际输入 state（原话与上下文）'), el('pre', null, JSON.stringify(f.request.state || {}, null, 2)));
    return detail;
  }

  function markSelected() { sentences.forEach((s) => s.row.classList.toggle('selected', selected === s.i)); }

  function renderSpark() {
    const ps = [];
    for (let j = fired - 1; j >= 0 && ps.length < 40; j--) { const f = timeline[j].f; if (f.layer === 'jev' && f.p != null) ps.unshift(f.p); }
    const W = 300, H = 120, y = (p) => 6 + (1 - p) * (H - 12);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = ui.spark; svg.replaceChildren();
    if (ORDER.includes('sol') && !timeline.some(e => e.f.layer === 'jev')) {
      ui.sparkFoot.textContent = 'Sol 保存的是语义选择，不返回分类概率；此处不绘制概率或套用旧 Jev 门槛。';
      return;
    }
    const add = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
    add('line', { x1: 0, x2: W, y1: y(data.thresholds.tag_floor), y2: y(data.thresholds.tag_floor), stroke: '#4a5058', 'stroke-dasharray': '2 5', 'vector-effect': 'non-scaling-stroke' });
    if (ps.length > 1) {
      const step = W / 39, x0 = W - (ps.length - 1) * step;
      const pts = ps.map((p, k) => (x0 + k * step).toFixed(1) + ',' + y(p).toFixed(1));
      add('polygon', { points: x0.toFixed(1) + ',' + H + ' ' + pts.join(' ') + ' ' + W + ',' + H, fill: 'rgba(255,61,139,.10)' });
      add('polyline', { points: pts.join(' '), fill: 'none', stroke: PINK, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' });
      ps.forEach((p, k) => add('rect', { x: (x0 + k * step - 2).toFixed(1), y: (y(p) - 2).toFixed(1), width: 4, height: 4, fill: p >= data.thresholds.tag_floor ? '#5cc3ff' : '#f4cc4e' }));
    }
    const avg = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
    ui.sparkFoot.textContent = (avg == null ? '没有已记录概率' : '平均 ' + avg.toFixed(3) + ' · ' + ps.length + ' 条已记录概率') + '；虚线 0.5 为本地源码分类下限，不表示自动执行许可。';
  }

  function renderLens() {
    if (data.source?.kind === 'reanalysis') {
      const evidence = data.post?.generation?.evidence;
      const note = evidence === 'reanalysis' ? '本次获准的重新分析包含 DeepSeek 新生成的纪要；这里只回放已存结果，不再次调用模型。' : evidence === 'reused_history' ? '会后纪要复用原有结果；本次 Jev 重新分析没有重新生成纪要。' : '会后生成是否执行以已存记录为准；这里只读回放，不发起模型调用。';
      ui.lens.replaceChildren(el('div', 'big l-jev', (data.source.request_count ?? '—') + ' 次 Jev 请求'), el('p', null, '显示本次重新分析的已存请求、完整选项和返回概率。'), el('p', 'verdict', note));
      return;
    }
    if (data.source?.kind === 'history') {
      const traced = sentences.filter(s => s.forks.length).length;
      const stored = sentences.filter(s => s.tag_provenance === 'stored').length;
      ui.lens.replaceChildren(el('div', 'big l-jev', traced + ' / ' + sentences.length),
        el('p', null, '句有历史处理记录；另有 ' + stored + ' 句仅保存最终标签。'),
        el('p', 'verdict', '缺失的概率、模型与中间步骤保持空白。打开历史只读取，不重跑分类，不把当前规则当作过去的判断。'));
      return;
    }
    const L = data.lens || {};
    const a = el('div'); a.append(el('div', 'big l-code', (L.rules_decided || 0) + ' / ' + sentences.length), el('p', null, '句被当前关键词规则识别为待办或约束；与已有分类一致 ' + (L.agree || 0) + ' 句。'));
    const b = el('div'); b.append(el('div', 'big l-model', String(L.question_skipped || 0)), el('p', null, '条历史研究记录最后跳过；只反映此文件，不代表当前会中运行状态。'));
    ui.lens.replaceChildren(a, b, el('p', 'verdict', '规则重算是旁路比较，不改写历史分类，不能据此估算真实准确率或节省调用量。'));
  }

  const scrollCooling = () => performance.now() - userScrolledAt < 4000;
  function autoScroll(row) {
    if (!row || row.hidden || document.hidden || $('mode-live').hidden || scrollCooling()) return;
    const box = ui.transcript;
    const viewport = box.getBoundingClientRect(), bounds = row.getBoundingClientRect();
    if (!(viewport.height > 0 && box.clientHeight > 0)) return;
    // offsetTop belongs to the positioned pane, not this scrolling list.
    const start = bounds.top - viewport.top + box.scrollTop - (box.clientTop || 0);
    const desired = bounds.height > box.clientHeight * 0.65
      ? start + bounds.height - box.clientHeight + 24
      : start - box.clientHeight * 0.35;
    const maximum = Number.isFinite(box.scrollHeight) ? Math.max(0, box.scrollHeight - box.clientHeight) : Infinity;
    const top = Math.max(0, Math.min(maximum, desired));
    // Continuous playback must reach the current line rather than continually
    // restarting a smooth scroll animation toward an already outdated target.
    if (Math.abs(box.scrollTop - top) > 4) box.scrollTo({ top, behavior: 'auto' });
  }

  // ---------------------------------------------------------------- canvas
  function rel(r, base) { return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, width: r.width, height: r.height }; }

  function geometry() {
    const base = ui.stage.getBoundingClientRect();
    const tr = rel(ui.transcript.getBoundingClientRect(), base);
    const fan = rel(ui.fan.getBoundingClientRect(), base);
    const cards = viewCards().map((c) => rel(c.getBoundingClientRect(), base));
    const side = cards[0].left >= fan.right - 4 && fan.width > 40 ? 'right' : 'bottom';
    const g = { W: base.width, H: base.height, base, tr, fan, cards, side };
    if (side === 'right') {
      const top = cards[0].top + 6, bottom = cards[cards.length - 1].bottom - 6;
      const half = (bottom - top) / 2, cardsLeft = cards[0].left;
      const gap = Math.min(230, Math.max(70, fan.width * 0.8));
      const d = Math.max(30, gap - 22);
      g.R = (half * half + d * d) / (2 * d);
      g.cx = cardsLeft - gap + g.R; g.cy = (top + bottom) / 2; g.limit = cardsLeft - 6;
    } else {
      const half = (fan.width - 24) / 2, d = fan.height * 0.32;
      g.R = (half * half + d * d) / (2 * d);
      g.cx = fan.left + fan.width / 2; g.cy = fan.top + fan.height * 0.3 + g.R; g.limit = fan.bottom - 6;
    }
    return g;
  }

  function arcPoint(g, k, frac) {
    let x, y;
    if (g.side === 'right') {
      const c = g.cards[k];
      y = c.top + 10 + frac * Math.max(4, c.height - 20);
      x = g.cx - Math.sqrt(Math.max(0, g.R * g.R - (y - g.cy) ** 2));
    } else {
      const w = (g.fan.width - 24) / g.cards.length;
      x = g.fan.left + 12 + k * w + 6 + frac * (w - 12);
      y = g.cy - Math.sqrt(Math.max(0, g.R * g.R - (x - g.cx) ** 2));
    }
    const len = Math.hypot(g.cx - x, g.cy - y) || 1;
    return { x, y, ux: (g.cx - x) / len, uy: (g.cy - y) / len };
  }

  function sectorEnds(g, k) { return [arcPoint(g, k, 0), arcPoint(g, k, 1)]; }

  function fractionOrigin(g, i) {
    const f = i >= 0 ? (i + 0.5) / Math.max(1, sentences.length) : 1;
    if (g.side === 'right') return { x: g.tr.right, y: g.tr.top + 8 + f * (g.tr.height - 16) };
    return { x: g.tr.left + 8 + f * (g.tr.width - 16), y: g.tr.bottom };
  }

  function rowOrigin(g, i) {
    if (i < 0) return null;
    const s = sentences[i];
    if (!s || s.row.hidden) return null;
    const node = s.state === 'partial' ? s.typing : s.boxes[s.boxes.length - 1];
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (!r.width) return null;
    const p = { x: r.right - g.base.left, y: r.top + r.height / 2 - g.base.top };
    if (p.y < g.tr.top + 30 || p.y > g.tr.bottom) return null;
    return p;
  }

  function activeSentence() {
    if (liveFollowing && performance.now() < livePulseUntil && sentences[liveFocus]) return liveFocus;
    let latest = -1;
    for (let n = sentences.length - 1; n >= 0; n--) {
      const st = sentences[n].state;
      if (st === 'thinking') return n;
      if (latest < 0 && (st === 'partial' || st === 'done')) latest = n;
    }
    return latest;
  }

  function placeSpider(g, i) {
    if (i < 0) { spider.ready = false; if (neon) neon.reset(); return null; }
    const s = sentences[i];
    if (!s || s.row.hidden) return null;
    let node;
    if (s.state === 'partial') node = s.typing;
    else {
      const progress = s.state === 'thinking' ? s.firedSteps / Math.max(1, s.forks.length) : 1;
      node = s.boxes[Math.min(s.boxes.length - 1, Math.floor(progress * s.boxes.length))];
    }
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (!r.width) return null;
    let x = r.left + r.width * 0.5 - g.base.left, y = r.top - g.base.top - 6;
    y = Math.min(Math.max(y, g.tr.top + 36), g.tr.bottom - 14);
    x = Math.min(Math.max(x, g.tr.left + 24), g.tr.right - 14);
    if (!spider.ready) { spider.x = x; spider.y = y; spider.ready = true; }
    const moving = playing || liveFollowing && performance.now() < livePulseUntil;
    const k = reduceMotion || !moving ? 1 : 0.16;
    spider.x += (x - spider.x) * k; spider.y += (y - spider.y) * k;
    return spider;
  }

  function drawSpider(p, realNow, tips) {
    const moving = playing || (liveFollowing && realNow < livePulseUntil && !document.hidden);
    if (neon) { neon.draw(ctx, p, realNow, { playing: moving, reduce: reduceMotion, tendrils: tips }); return; }
    const t = reduceMotion || !moving ? 0 : realNow / 120;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.strokeStyle = 'rgba(63,217,160,.85)'; ctx.lineWidth = 1.1;
    for (const side of [-1, 1]) {
      for (let n = 0; n < 4; n++) {
        const a = -0.8 + n * 0.53 + Math.sin(t + n * 1.7 + (side > 0 ? 0 : 2.1)) * 0.16;
        const kx = side * Math.cos(a) * 10, ky = Math.sin(a) * 9 - 3;
        const fx = side * Math.cos(a) * 18, fy = Math.sin(a) * 11 + 7;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
      }
    }
    ctx.fillStyle = '#0a0b0d'; ctx.strokeStyle = '#3fd9a0'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 8.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = PINK; ctx.beginPath(); ctx.arc(0, 0.5, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function sizeCanvas() {
    const r = ui.stage.getBoundingClientRect();
    // Hidden panels report zero size during tab transitions. Keep the last
    // valid backing surface until the visible layout is available.
    if (!(r.width > 0 && r.height > 0)) return;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(r.width * dpr); ui.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strandCache = null; canvasDirty = true; drawingBlocked = false;
  }

  function stableStrand(target, g, e) {
    const key = visualLayer(e), index = viewIndex(key);
    if (index < 0 || selected != null && e.i === selected) return;
    const P = arcPoint(g, index, e.slot), O = fractionOrigin(g, e.i);
    const room = g.side === 'right' ? Math.max(8, g.limit - P.x) : Math.max(8, g.limit - P.y);
    const len = Math.min(room, 8 + (visualProbability(e) ?? 1) * room * 0.9);
    target.globalAlpha = selected != null ? 0.03 : 0.07;
    target.strokeStyle = '#c8ccd2'; target.lineWidth = 0.7;
    target.beginPath(); target.moveTo(O.x, O.y); target.quadraticCurveTo((O.x + P.x) / 2, (O.y + P.y) / 2, P.x, P.y); target.stroke();
    target.globalAlpha = selected != null ? 0.35 : 0.85;
    target.strokeStyle = visualMeta(key).color; target.lineWidth = 1.2;
    target.beginPath(); target.moveTo(P.x, P.y); target.lineTo(P.x + P.ux * len, P.y + P.uy * len); target.stroke();
    target.globalAlpha = 1;
  }

  function cachedStrands(g, realNow) {
    if (!(ui.canvas.width > 0 && ui.canvas.height > 0)) return null;
    const events = viewEvents(), through = viewFired();
    const key = [routingView, ui.canvas.width, ui.canvas.height, g.side,
      ...[g.tr, g.fan, ...g.cards].flatMap(r => [r.left, r.top, r.width, r.height])].join(',');
    if (!strandCache || strandCache.key !== key || strandCache.timeline !== events || strandCache.selected !== selected || strandCache.through > through) {
      const surface = document.createElement('canvas');
      const target = typeof surface.getContext === 'function' ? surface.getContext('2d') : null;
      // Older browser/test shells may not provide an offscreen 2D surface.
      if (!target) return null;
      surface.width = ui.canvas.width; surface.height = ui.canvas.height;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      strandCache = { key, timeline: events, selected, surface, target, through: 0,
        selection: selected == null ? [] : events.filter(e => e.i === selected) };
    }
    const cache = strandCache;
    // Events are fired in time order. Commit the stable prefix once, then
    // animate only its young tail and the explicitly selected sentence.
    while (cache.through < through) {
      const e = events[cache.through];
      if (e.real && realNow - e.real < 1600) break;
      stableStrand(cache.target, g, e); cache.through++;
    }
    ctx.drawImage(cache.surface, 0, 0, g.W, g.H);
    return cache;
  }

  function paintSafely(realNow) {
    if (drawingBlocked || document.hidden || $('mode-live').hidden) return;
    try { draw(realNow); }
    catch (error) { stopRender(error); }
  }

  function stopRender(error) {
    // Keep the next rAF alive, but stop this failing painter until a new
    // source/seek/resize or playback attempt; do not flood the console.
    drawingBlocked = true; canvasDirty = false; livePulseUntil = 0;
    setPlaying(false);
    console.error('Oops 判断回放绘制中断，进度已保留。', error);
    ui.note.textContent = '回放显示暂时中断，进度已保留；可继续播放或重新开始。这里只读取已有结果。';
  }

  ui.transcript.addEventListener('scroll', () => { canvasDirty = true; }, { passive: true });
  document.addEventListener('funnel:mode', () => { canvasDirty = true; });
  document.addEventListener('funnel:content-routing-ready', () => {
    buildSemanticEvents(); updateRoutingLayout();
    if (data) render(true);
    sizeCanvas();
  });
  document.addEventListener('funnel:inspect-sentence', (ev) => {
    if (ev.detail?.data === data) setRoutingView('process');
  });
  function setRoutingView(view) {
    if (!['content', 'process'].includes(view)) return;
    routingView = view; updateRoutingLayout();
    spider.ready = false;
    if (neon) neon.reset();
    if (data) render(true);
    sizeCanvas();
  }
  $('routing-content')?.addEventListener('click', () => setRoutingView('content'));
  $('routing-process')?.addEventListener('click', () => setRoutingView('process'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) canvasDirty = true; });

  function draw(realNow) {
    const bounds = ui.stage.getBoundingClientRect();
    if (!(bounds.width > 0 && bounds.height > 0)) return;
    const g = geometry();
    if (![g.R, g.cx, g.cy].every(Number.isFinite) || g.R <= 0) return;
    ctx.clearRect(0, 0, g.W, g.H);
    if (!data) return;
    canvasDirty = false;

    // sector guides: one faint arc per layer, with its name
    viewOrder().forEach((k, idx) => {
      const pts = [];
      for (let f = 0; f <= 1.0001; f += 0.1) pts.push(arcPoint(g, idx, f));
      ctx.strokeStyle = hexA(visualMeta(k).color, 0.35); ctx.lineWidth = 1;
      ctx.beginPath(); pts.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    });

    const active = activeSentence();
    const sp = placeSpider(g, active);
    const fresh = [];
    const cache = cachedStrands(g, realNow);
    const events = viewEvents(), through = viewFired();
    const candidates = cache ? events.slice(cache.through, through).filter(e => e.i !== selected).concat(cache.selection.filter(e => e.t <= now)) : events.slice(0, through);
    for (const e of candidates) {
      const index = viewIndex(visualLayer(e));
      if (index < 0) continue;
      const age = e.real ? (realNow - e.real) / 1000 : 99;
      const P = arcPoint(g, index, e.slot);
      const p = visualProbability(e) ?? 1;
      const room = g.side === 'right' ? Math.max(8, g.limit - P.x) : Math.max(8, g.limit - P.y);
      const len = Math.min(room, 8 + p * room * 0.9);
      const sel = selected != null && e.i === selected;
      if (age < 1.6 || sel) { fresh.push({ e, P, len, age, sel }); continue; }
      stableStrand(ctx, g, e);
    }
    ctx.globalAlpha = 1;

    fresh.sort((a, b) => (a.e.real || 0) - (b.e.real || 0));
    const tips = [];
    fresh.forEach((o, idx) => {
      const { e, P, len } = o;
      const tip = { x: P.x + P.ux * len, y: P.y + P.uy * len };
      if (e.i === active) tips.push(tip);
      const a = o.sel ? 1 : Math.max(0, 1 - o.age / 1.6);
      const O = sp && e.i === active ? sp : rowOrigin(g, e.i) || fractionOrigin(g, e.i);
      ctx.globalAlpha = 0.3 + 0.7 * a;
      ctx.strokeStyle = PINK; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.lineTo(P.x, P.y); ctx.stroke();
      ctx.strokeStyle = visualMeta(visualLayer(e)).color; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(P.x + P.ux * len, P.y + P.uy * len); ctx.stroke();
      if (visualSettled(e)) { ctx.fillStyle = PINK; ctx.beginPath(); ctx.arc(P.x + P.ux * len, P.y + P.uy * len, 2.6, 0, Math.PI * 2); ctx.fill(); }
      const showLabel = o.sel ? true : idx >= fresh.length - (g.side === 'right' ? 5 : 1);
      if (showLabel) label(g, P, e, ctx.globalAlpha);
    });
    ctx.globalAlpha = 1;
    if (sp) drawSpider(sp, realNow, tips);
  }

  function label(g, P, e, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const font = getComputedStyle(document.body).fontFamily;
    ctx.font = '11px ' + font;
    const q = e.semanticKey ? (e.semanticKey === 'missing' ? '本句分类未记录' : data?.content_review ? '本次助手复核' : '本句已存分类')
      : e.f.q + (e.f.p != null ? '  p ' + e.f.p.toFixed(2) : '');
    const a = e.semanticKey ? visualMeta(e.semanticKey).name : clip(e.f.a, 16);
    const right = g.side === 'right';
    const tx = right ? P.x - 12 : P.x, ty = right ? P.y : P.y - 22;
    ctx.fillStyle = '#9aa1ab';
    const qw = ctx.measureText(q).width;
    ctx.fillText(q, Math.min(Math.max(4, right ? tx - qw : tx - qw / 2), g.W - qw - 4), ty - 13);
    ctx.font = '12px ' + font;
    const w = ctx.measureText(a).width + 10;
    const bx = Math.min(Math.max(4, right ? tx - w : tx - w / 2), g.W - w - 4);
    ctx.fillStyle = PINK; ctx.fillRect(bx, ty - 9, w, 18);
    ctx.fillStyle = '#12060b'; ctx.fillText(a, bx + 5, ty + 4);
    ctx.restore();
  }

  // ---------------------------------------------------------------- loop & controls
  const flashTimers = {};
  function flash(layer) {
    const index = viewIndex(layer);
    if (index < 0) return;
    const card = viewCards()[index];
    card.classList.add('flash');
    clearTimeout(flashTimers[layer]);
    flashTimers[layer] = setTimeout(() => card.classList.remove('flash'), 260);
  }

  function frame(realNow) {
    // Schedule before drawing: one malformed visual must not kill the clock
    // and leave a misleading “暂停” button attached to a frozen page.
    requestAnimationFrame(frame);
    const dt = Math.min(250, realNow - lastFrame);
    lastFrame = realNow;
    if (!data || document.hidden || $('mode-live').hidden) return;
    try {
      const advancing = playing;
      if (playing && drawingBlocked) { drawingBlocked = false; canvasDirty = true; }
      if (playing) {
        now = Math.min(duration, now + dt * speed);
        while (fired < timeline.length && timeline[fired].t <= now) {
          const e = timeline[fired];
          e.real = realNow;
          if (e.i >= 0) sentences[e.i].firedSteps++;
          if (!contentRouting()) flash(e.f.layer);
          fired++;
        }
        while (semanticFired < semanticEvents.length && semanticEvents[semanticFired].t <= now) {
          const e = semanticEvents[semanticFired++];
          e.real = realNow;
          // The saved classification itself is the event; no extra model step
          // or new inference is inserted into the processing timeline.
          if (contentRouting()) flash(e.semanticKey);
        }
        if (now >= duration) setPlaying(false);
        canvasDirty = true;
      }
      // Keep text and canvas at the same 20 fps budget; the replay clock still
      // advances on every frame, independently of the drawing frequency.
      if ((advancing || canvasDirty) && (realNow - lastDomFrame >= 50 || !playing)) {
        lastDomFrame = realNow; render(false, advancing);
      }
      const pulsing = liveFollowing && realNow < livePulseUntil;
      if ((canvasDirty || advancing || pulsing) && realNow - lastPaintFrame >= 50) {
        lastPaintFrame = realNow; paintSafely(realNow);
      }
      if (playing && realNow - lastStudioTick >= 33) {
        lastStudioTick = realNow;
        emitReplayState('funnel:tick');
      }
    } catch (error) { stopRender(error); }
  }

  ui.play.addEventListener('click', () => { pauseLiveFollow(); if (selected != null) followPlayback(); if (now >= duration) seek(0); setPlaying(!playing); });
  ui.restart.addEventListener('click', () => { pauseLiveFollow(); followPlayback(); seek(0); setPlaying(true); });
  $('play-60')?.addEventListener('click', () => {
    if (!data || !sentences.length) return;
    pauseLiveFollow(); followPlayback(); speed = 60; ui.speed.value = '60'; seek(0); setPlaying(true);
  });
  ui.speed.addEventListener('change', () => { pauseLiveFollow(); speed = Number(ui.speed.value) || 1; emitReplayState('funnel:tick'); });
  ui.scrub.addEventListener('input', () => { pauseLiveFollow(); seek((Number(ui.scrub.value) / 1000) * duration); });
  ui.follow.addEventListener('click', followPlayback);
  ['wheel', 'touchmove'].forEach((t) => ui.transcript.addEventListener(t, () => { userScrolledAt = performance.now(); }, { passive: true }));
  document.addEventListener('keydown', (ev) => {
    if ($('mode-live').hidden) return;
    if (ev.code !== 'Space' || ev.target.closest('dialog, details') || /^(INPUT|SELECT|BUTTON|TEXTAREA|LI|SUMMARY)$/.test(ev.target.tagName)) return;
    ev.preventDefault(); ui.play.click();
  });

  function readFile(file) {
    if (!file) return;
    recoveryTarget = null; refreshRetryPending = false;
    stopAutomatic();
    pendingRequestedRun = ''; pendingRequestedMeeting = '';
    if (['history', 'reanalysis'].includes(data?.source?.kind)) clearHistoricalData('已清除私有内容，正在打开本机回放。');
    const version = ++requestVersion; currentHistorySid = ''; currentReanalysisId = ''; currentSnapshot = '';
    file.text().then((text) => { if (version === requestVersion) load(JSON.parse(text)); }).catch((err) => {
      ui.note.textContent = '打不开这个文件：' + err.message + '。请选 scripts/funnel_replay.py 生成的 build/funnel-*.json。';
    });
  }
  ui.file.addEventListener('change', () => readFile(ui.file.files[0]));
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => { if ([...(ev.dataTransfer?.types || [])].includes('Files')) { dragDepth++; ui.drop.hidden = false; } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui.drop.hidden = true; });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; ui.drop.hidden = true; readFile(ev.dataTransfer?.files?.[0]); });

  window.oopsFunnel = { pause: () => setPlaying(false), resume: () => { if (data && now < duration) setPlaying(true); } };
  window.OopsReplay = Object.freeze({
    state: replayState,
    select: selectSentence,
    seek: (t) => { pauseLiveFollow(); seek(t); },
    play: (on) => {
      pauseLiveFollow();
      if (on && selected != null) followPlayback();
      if (on && now >= duration) seek(0);
      setPlaying(on);
    },
    setSpeed: (value) => { if (SPEEDS.includes(Number(value))) { pauseLiveFollow(); speed = Number(value); ui.speed.value = String(speed); emitReplayState('funnel:tick'); } },
    follow: followPlayback,
    renderRequestDetail,
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) {
    setPlaying(false); livePulseUntil = 0;
    if (recoveryTarget) { recoveryTarget.playing = false; if (recoveryTarget.after) recoveryTarget.after.playing = false; }
  } });
  document.addEventListener('funnel:mode', () => { livePulseUntil = 0; });
  new ResizeObserver(sizeCanvas).observe(ui.stage);
  sizeCanvas();

  let requestVersion = 0;
  let localReviewActive = false, localReviewChecking = false;
  let listVersion = 0;
  let deployedPipeline = null;
  let currentHistorySid = '', currentReanalysisId = '', currentSnapshot = '', currentValidator = '', checkingHistory = false;
  // Keep only navigation/playback intent while disconnected. Private content is
  // cleared and can return only after a fresh, authorized detail response.
  let recoveryTarget = null, recoveringHistory = false, refreshRetryPending = false;
  const transientRead = error => !error.status || [408, 429, 500, 502, 503, 504].includes(error.status);
  function suspendHistory(error, sid = currentHistorySid, runId = currentReanalysisId, playback = true) {
    const after = window.OopsAfterReplay?.state();
    const target = { sid, runId, now: playback ? now : 0, speed, playing: playback && playing,
      selectedId: playback ? sentences[selected]?.id : null, scroll: playback ? ui.transcript.scrollTop : 0,
      following: liveFollowing, after: playback && after ? { now: after.now, speed: after.speed, playing: after.playing } : null };
    clearHistoricalData(error.message);
    if (transientRead(error) && (sid || runId)) {
      recoveryTarget = target;
      statusMessage(error.message + ' 正在自动重连；恢复后继续原来的位置。');
    } else statusMessage(error.message + ' 已清除失效或无法核对的历史。');
  }
  async function recoverHistory() {
    if (!recoveryTarget || recoveringHistory || !historyConnected || document.hidden) return;
    const target = recoveryTarget, version = requestVersion;
    recoveringHistory = true;
    try {
      const metadata = {};
      const result = await historyRequest(target.runId ? 'reanalyses/' + encodeURIComponent(target.runId) : 'meetings/' + encodeURIComponent(target.sid), {}, metadata);
      if (recoveryTarget !== target || version !== requestVersion || !historyConnected) return;
      load(result);
      currentHistorySid = target.sid; currentReanalysisId = target.runId;
      currentSnapshot = snapshotOf(result); currentValidator = metadata.etag;
      liveFollowing = Boolean(target.following && result.source?.live);
      speed = target.speed; ui.speed.value = String(speed);
      selected = sentences.findIndex(sentence => sentence.id === target.selectedId);
      if (selected < 0) selected = null;
      seek(liveFollowing ? duration : target.now);
      ui.follow.hidden = selected == null; ui.transcript.scrollTop = target.scroll;
      setPlaying(target.playing && !liveFollowing);
      if (target.after && window.OopsAfterReplay) {
        window.OopsAfterReplay.setSpeed(target.after.speed);
        window.OopsAfterReplay.seek(target.after.now);
        window.OopsAfterReplay.play(target.after.playing);
      }
      if (pendingRequestedMeeting === target.sid) pendingRequestedMeeting = '';
      if (pendingRequestedRun === target.runId) pendingRequestedRun = '';
      recoveryTarget = null;
      renderLiveStatus(); statusMessage('连接已恢复，已重新核对服务器内容并恢复原来的位置。');
      beginDirectReplay();
    } catch (error) {
      if (recoveryTarget !== target || version !== requestVersion) return;
      if (!error.code && !error.status) {
        clearHistoricalData('服务器回放数据格式异常，已停止恢复。');
        statusMessage('服务器回放数据格式异常，已停止恢复；可刷新列表后重试。');
        return;
      }
      if (!transientRead(error)) recoveryTarget = null;
      statusMessage(error.message + (recoveryTarget ? ' 正在自动重连；恢复后继续原来的位置。' : ' 已停止重连，请重新选择可读内容。'));
    } finally { recoveringHistory = false; }
  }
  function pauseLiveFollow() {
    stopAutomatic(); liveFollowing = false; livePulseUntil = 0; renderLiveStatus();
  }
  function renderLiveStatus() {
    const live = privateHistory && currentHistorySid ? data?.source?.live : null;
    $('live-follow').hidden = !live;
    $('live-status').hidden = !live;
    if (!live) return;
    const time = value => {
      const stamp = new Date(value);
      return value && Number.isFinite(stamp.getTime()) ? stamp.toLocaleTimeString('zh-CN', { hour12: false }) : '未记录';
    };
    $('live-follow').textContent = liveFollowing ? '暂停跟随' : '跟随最新';
    $('live-follow').setAttribute('aria-pressed', String(liveFollowing));
    $('live-status').textContent = (live.active ? '现场同步 · 未收到结束标记' : '已结束 · ' + time(live.ended_at)) + ' · 最近转写同步 ' + time(live.last_sync_at) + ' · ' + sentences.length + ' 句 / ' + (data.source.trace_count || 0) + ' 句有处理记录 · ' + (liveFollowing ? '每 5 秒核对新内容' : '已暂停跟随，可查看旧句；后台继续核对来源');
  }
  $('live-follow').addEventListener('click', () => {
    if (!data?.source?.live) return;
    if (liveFollowing) { pauseLiveFollow(); return; }
    liveFollowing = true; selected = null; ui.follow.hidden = true; setPlaying(false); userScrolledAt = -Infinity;
    seek(duration); if (sentences.length) autoScroll(sentences[sentences.length - 1].row);
    renderLiveStatus(); verifyHistory();
  });
  function clearHistoricalData(message) {
    localReviewActive = false;
    recoveryTarget = null;
    ++requestVersion;
    liveFollowing = false; livePulseUntil = 0; liveFocus = -1;
    currentHistorySid = ''; currentReanalysisId = ''; currentSnapshot = ''; currentValidator = '';
    load({ version: 2, source: { kind: 'empty', label: '未载入私有历史', note: message }, sentences: [], session: [], post: null, thresholds: { tag_floor: 0.5 }, lens: null });
    setPlaying(false);
    ui.badge.textContent = '历史内容已清除';
    ui.statusLeft.textContent = 'oops@funnel · 未载入私有历史';
  }
  const snapshotOf = result => result.source?.snapshot_hash || JSON.stringify({ sentences: result.sentences, post: result.post, post_status: result.post_status });
  async function loadExample() {
    recoveryTarget = null; refreshRetryPending = false;
    stopAutomatic();
    if (['history', 'reanalysis'].includes(data?.source?.kind)) clearHistoricalData('已清除历史内容，正在载入示例。');
    currentHistorySid = ''; currentReanalysisId = ''; currentSnapshot = ''; currentValidator = '';
    const version = ++requestVersion;
    const response = await fetch('./funnel-sample.json');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const example = await response.json();
    if (version === requestVersion) load(example);
  }

  const privateHistory = /\/oops-meeting\/history\/?(?:index\.html|funnel\.html)?$/.test(location.pathname);
  const historyStatus = $('history-status');
  const historySelect = $('history-meeting');
  const reanalysisSelect = $('reanalysis-run');
  const statusMessage = (message) => { historyStatus.textContent = message; };
  let historyConnected = false;
  let pendingRequestedRun = privateHistory ? new URLSearchParams(location.search).get('run') || '' : '';
  let pendingRequestedMeeting = privateHistory ? new URLSearchParams(location.search).get('meeting') || '' : '';
  let directReplayMeeting = privateHistory && pendingRequestedMeeting && !pendingRequestedRun
    && new URLSearchParams(location.search).get('play') === '1' && new URLSearchParams(location.search).get('speed') === '60'
    && (!location.hash || location.hash === '#live') ? pendingRequestedMeeting : '';
  const requestedFollow = privateHistory && new URLSearchParams(location.search).get('follow') === '1';
  let automatic = privateHistory && (new URLSearchParams(location.search).get('auto') === '1' || !pendingRequestedMeeting && !pendingRequestedRun);
  let autoScopeEnabled = false, autoBusy = false, autoEpoch = 0;
  function stopAutomatic() { directReplayMeeting = ''; automatic = false; autoEpoch++; renderAutomatic(); }
  function beginDirectReplay() {
    if (!directReplayMeeting || document.hidden || $('mode-live').hidden || currentHistorySid !== directReplayMeeting) return;
    directReplayMeeting = '';
    if (data?.content_review_status?.status !== 'ready' || !data.content_review) return;
    liveFollowing = false; followPlayback(); setRoutingView('content');
    speed = 60; ui.speed.value = '60'; seek(0); setPlaying(true);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beginDirectReplay(); });
  function renderAutomatic() {
    $('history-auto').hidden = !privateHistory || !autoScopeEnabled;
    $('auto-status').hidden = !privateHistory || !autoScopeEnabled;
    $('history-auto').textContent = automatic ? '暂停自动切换' : '自动跟随新录音';
    $('history-auto').setAttribute('aria-pressed', String(automatic));
    $('auto-status').textContent = automatic ? '自动接入已开启 · 每 5 秒发现新的云保存录音并跟随最新会话；暂无新录音时保留当前内容。' : '新录音仍会自动加入列表；已暂停自动切换，可查看历史，点“自动跟随新录音”恢复。';
  }
  function setAutoConfig(result) {
    autoScopeEnabled = result.auto_connect?.enabled === true;
    renderAutomatic();
  }
  function renderMeetings(meetings) {
    const previous = currentHistorySid || historySelect.value;
    historySelect.replaceChildren(el('option', null, meetings.length ? '选择一场会议…' : '等待新录音…'));
    historySelect.firstChild.value = '';
    meetings.forEach(meeting => {
      const stamp = new Date(meeting.started_at);
      const time = Number.isFinite(stamp.getTime()) ? stamp.toLocaleString('zh-CN', { hour12: false }) : '开始时间未记录';
      const option = el('option', null, (meeting.is_live ? '现场 · ' : '') + (meeting.title || '未命名会议') + ' · ' + time + ' · ' + (meeting.utterance_count || 0) + ' 句 · ' + (meeting.trace_count || 0) + ' 条过程记录');
      option.value = meeting.session_id; historySelect.append(option);
    });
    if (meetings.some(meeting => meeting.session_id === previous)) historySelect.value = previous;
  }
  function newestMeeting(meetings) {
    return meetings.filter(meeting => meeting.kind !== 'replay' && Number.isFinite(new Date(meeting.started_at).getTime()))
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())[0];
  }
  async function followNewMeeting(meetings) {
    if (!automatic || !autoScopeEnabled || pendingRequestedMeeting || pendingRequestedRun) return;
    const latest = newestMeeting(meetings);
    if (!latest || latest.session_id === currentHistorySid || latest.session_id === recoveryTarget?.sid) return;
    historySelect.value = latest.session_id;
    await loadHistoryMeeting(latest.session_id, false, autoEpoch);
  }
  $('history-auto').addEventListener('click', async () => {
    if (automatic) { stopAutomatic(); return; }
    recoveryTarget = null; automatic = true; autoEpoch++; pendingRequestedMeeting = ''; pendingRequestedRun = '';
    renderAutomatic(); await discoverMeetings();
    if (automatic && currentHistorySid && data?.source?.live) {
      liveFollowing = true; selected = null; userScrolledAt = -Infinity; ui.follow.hidden = true; setPlaying(false); seek(duration);
      if (sentences.length) autoScroll(sentences[sentences.length - 1].row);
      renderLiveStatus();
    }
  });
  async function discoverMeetings() {
    if (!privateHistory || !historyConnected || !autoScopeEnabled || document.hidden || autoBusy) return;
    autoBusy = true;
    const navigation = requestVersion, version = listVersion, epoch = autoEpoch;
    try {
      const result = await historyRequest('meetings');
      if (navigation !== requestVersion || version !== listVersion || epoch !== autoEpoch || !historyConnected || document.hidden) return;
      const meetings = Array.isArray(result.meetings) ? result.meetings : [];
      setAutoConfig(result); renderMeetings(meetings);
      if (currentHistorySid && !meetings.some(meeting => meeting.session_id === currentHistorySid)) clearHistoricalData('当前会话已不在可读范围，已清除旧内容。');
      await followNewMeeting(meetings);
    } catch (error) {
      if (navigation !== requestVersion || version !== listVersion || epoch !== autoEpoch) return;
      if (transientRead(error)) {
        statusMessage(error.message + ' 正在重试列表；当前会话单独核对。');
        if (currentHistorySid || currentReanalysisId) await verifyHistory();
      } else if (currentHistorySid || currentReanalysisId) {
        clearHistoricalData(error.message); statusMessage(error.message + ' 已清除无法核对的内容。');
      } else statusMessage(error.message);
      if ([401, 403].includes(error.status)) { historyConnected = false; stopAutomatic(); }
    } finally { autoBusy = false; }
  }
  // Share only identical reads that are still running. Never retain a response
  // after completion or share a 304 check with a request that needs a body.
  const historyReads = new Map();
  let historyReadScope = 0;
  async function historyRequest(path, options = {}, metadata = {}) {
    const readOnly = (options.method || 'GET').toUpperCase() === 'GET';
    if (!readOnly) {
      historyReadScope++; historyReads.clear();
      return historyTransport(path, options, metadata);
    }
    const headers = new Headers(options.headers || {});
    const mergeable = Object.keys(options).every(key => key === 'method' || key === 'headers')
      && [...headers.keys()].every(key => key === 'if-none-match');
    if (!mergeable) return historyTransport(path, options, metadata);
    const key = JSON.stringify([historyReadScope, path, [...headers.entries()].sort()]);
    let flight = historyReads.get(key);
    if (!flight) {
      const sharedMetadata = {};
      flight = historyTransport(path, options, sharedMetadata).then(result => ({ result, etag: sharedMetadata.etag }));
      historyReads.set(key, flight);
      const release = () => { if (historyReads.get(key) === flight) historyReads.delete(key); };
      flight.then(release, release);
    }
    const shared = await flight;
    if (shared.etag != null) metadata.etag = shared.etag;
    // Replay loading annotates its input; each reader keeps its own object.
    return shared.result === null ? null : typeof structuredClone === 'function'
      ? structuredClone(shared.result) : JSON.parse(JSON.stringify(shared.result));
  }
  async function historyTransport(path, options = {}, metadata = {}) {
    const readOnly = (options.method || 'GET').toUpperCase() === 'GET';
    const validator = new Headers(options.headers || {}).get('if-none-match');
    const waitToRead = attempt => new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
      try {
        const response = await fetch('./api/' + path, { ...options, credentials: 'same-origin', cache: 'no-store', ...(controller ? { signal: controller.signal } : {}) });
        if (response.status === 304 && validator) {
          metadata.etag = response.headers?.get?.('ETag') || validator;
          return null;
        }
        if (response.ok) {
          metadata.etag = response.headers?.get?.('ETag') || '';
          if (response.status === 204) return {};
          try { return await response.json(); }
          catch (cause) {
            if (controller?.signal.aborted) throw cause;
            const error = new Error('历史服务返回格式错误，请刷新列表重试。'); error.status = response.status; error.code = 'invalid_json'; throw error;
          }
        }
        if (readOnly && [408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 2) { await waitToRead(attempt); continue; }
        let message = '读取失败（HTTP ' + response.status + '），可刷新重试。';
        if ([401, 403].includes(response.status)) message = '当前会话无读取权限，请通过私有邀请重新进入。';
        if ([404, 410].includes(response.status)) message = '会议已删除、来源已到期或当前邀请不包含这场会议。';
        if ([502, 503, 504].includes(response.status)) message = '历史服务暂不可用（HTTP ' + response.status + '），请刷新列表重试。';
        if (response.status === 429) message = '历史读取过于频繁（HTTP 429），请稍后刷新列表重试。';
        const error = new Error(message); error.status = response.status;
        try { const body = await response.json(); const code = body?.error?.code; if (typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code)) error.code = code; } catch (_) { /* HTTP status remains the root cause. */ }
        throw error;
      } catch (cause) {
        if (cause.status) throw cause;
        if (controller?.signal.aborted) { const error = new Error('历史服务读取超时。'); error.code = 'read_timeout'; throw error; }
        if (readOnly && attempt < 2) { await waitToRead(attempt); continue; }
        const error = new Error('历史服务网络连接失败，请刷新列表重试。'); error.code = 'network_failure'; throw error;
      } finally { if (timeout != null) clearTimeout(timeout); }
    }
  }
  async function loadHistoryMeeting(sid, userInitiated = true, expectedAutoEpoch = null) {
    if (userInitiated) { stopAutomatic(); pendingRequestedRun = ''; pendingRequestedMeeting = ''; }
    if (!sid || !historyConnected) return;
    clearHistoricalData('正在读取已有会议，首次载入较长会议可能需要几秒。');
    ui.badge.textContent = '正在载入历史';
    const version = requestVersion;
    statusMessage('正在读取已有会议…');
    try {
      const metadata = {};
      const result = await historyRequest('meetings/' + encodeURIComponent(sid), {}, metadata);
      if (version !== requestVersion || !historyConnected || expectedAutoEpoch != null && expectedAutoEpoch !== autoEpoch) return;
      liveFollowing = Boolean(result.source?.live && (result.source.live.active || !userInitiated && (requestedFollow || automatic && autoScopeEnabled)));
      load(result, { followLatest: liveFollowing });
      currentHistorySid = sid; currentReanalysisId = ''; reanalysisSelect.value = ''; currentSnapshot = snapshotOf(result); currentValidator = metadata.etag;
      renderLiveStatus();
      if (pendingRequestedMeeting === sid) pendingRequestedMeeting = '';
      statusMessage('已读取原话与已存处理记录；Sol 语义选择不返回概率，缺失步骤保持空白。未发起模型调用或外部操作。');
      beginDirectReplay();
    } catch (error) { if (version === requestVersion && (expectedAutoEpoch == null || expectedAutoEpoch === autoEpoch)) { pendingRequestedMeeting = automatic && autoScopeEnabled ? '' : sid; suspendHistory(error, sid, '', false); } }
  }
  async function refreshHistory() {
    refreshRetryPending = false;
    historySelect.disabled = true; reanalysisSelect.disabled = true;
    const version = ++listVersion, navigation = requestVersion;
    statusMessage('正在读取会议列表…');
    let listing;
    try {
      const result = await historyRequest('meetings');
      if (version !== listVersion) return { ok: false, aborted: true };
      historyConnected = true;
      const meetings = Array.isArray(result.meetings) ? result.meetings : [];
      setAutoConfig(result); renderMeetings(meetings);
      if (currentHistorySid && !meetings.some(meeting => meeting.session_id === currentHistorySid) && navigation === requestVersion) clearHistoricalData('当前会议已不在可读列表，已清除旧历史。');
      if (navigation === requestVersion) statusMessage(meetings.length + ' 场可读历史。选择会议后查看；已有最终标签不等于保存了 Jev 的概率和推理步骤。');
      if (pendingRequestedMeeting && navigation === requestVersion && version === listVersion) {
        const requested = pendingRequestedMeeting;
        if (meetings.some(meeting => meeting.session_id === requested)) {
          historySelect.value = requested;
          await loadHistoryMeeting(requested, false);
          listing = await refreshReanalyses(version, requestVersion);
        } else {
          pendingRequestedMeeting = '';
          clearHistoricalData('指定会话不在当前可读列表中。'); statusMessage('指定会话当前不可读取，未加载其他会议代替。');
          listing = { ok: false };
        }
        return listing;
      }
      if (automatic && autoScopeEnabled && !pendingRequestedRun && navigation === requestVersion && version === listVersion) {
        await followNewMeeting(meetings);
        listing = await refreshReanalyses(version, requestVersion);
        return listing;
      }
      listing = await refreshReanalyses(version, navigation);
      // Only one readable meeting and nothing chosen yet: open it rather than leaving the example on screen.
      if (meetings.length === 1 && !currentHistorySid && !currentReanalysisId && !pendingRequestedRun && !pendingRequestedMeeting && navigation === requestVersion && version === listVersion) {
        historySelect.value = meetings[0].session_id;
        await loadHistoryMeeting(meetings[0].session_id, false);
      }
    } catch (error) {
      if (version !== listVersion) return { ok: false, aborted: true };
      if (navigation === requestVersion) {
        if (transientRead(error) && (currentHistorySid || currentReanalysisId)) {
          refreshRetryPending = true;
          statusMessage(error.message + ' 正在重试列表；当前会话单独核对。');
          await verifyHistory();
        } else {
          if (currentReanalysisId) pendingRequestedRun = currentReanalysisId;
          historyConnected = false; refreshRetryPending = transientRead(error);
          historySelect.replaceChildren(el('option', null, '历史读取失败，正在重连')); reanalysisSelect.replaceChildren(el('option', null, '列表尚未载入'));
          clearHistoricalData(error.message); statusMessage(error.message + (refreshRetryPending ? ' 正在自动重连。' : ' 已清除先前历史内容。'));
        }
      }
      listing = { ok: false, error };
    } finally {
      if (version === listVersion) {
        historySelect.disabled = !historyConnected || ![...historySelect.options].some(option => option.value && !option.disabled);
        reanalysisSelect.disabled = !historyConnected || ![...reanalysisSelect.options].some(option => option.value && !option.disabled);
      }
    }
    if (!listing?.ok || version !== listVersion) return listing || { ok: false, aborted: true };
    if (pendingRequestedRun && historyConnected) {
      const requestedRun = pendingRequestedRun;
      if (listing.analyses.some(run => run.run_id === requestedRun && run.status === 'ready')) {
        reanalysisSelect.value = requestedRun;
        const selected = await loadReanalysis(requestedRun, false);
        if (selected?.ok && pendingRequestedRun === requestedRun) pendingRequestedRun = '';
        return { ...listing, selected };
      }
      pendingRequestedRun = '';
      clearHistoricalData('指定的重新分析当前不可读取，请核对查看权限或来源是否仍然有效。');
      statusMessage('指定的重新分析当前不可读取；未载入其他会议代替。');
    }
    return listing;
  }
  async function refreshReanalyses(version, navigation) {
    reanalysisSelect.disabled = true;
    try {
      const result = await historyRequest('reanalyses');
      if (version !== listVersion || !historyConnected) return { ok: false, aborted: true };
      const analyses = Array.isArray(result.reanalyses) ? result.reanalyses : [];
      reanalysisSelect.replaceChildren(el('option', null, '选择已完成的重新分析…')); reanalysisSelect.firstChild.value = '';
      analyses.forEach(run => {
        const option = el('option', null, '重新分析 · ' + (run.title || run.source_session_id || '') + ' · ' + (run.created_at || '').slice(0, 16) + ' · ' + run.utterance_count + ' 句' + (run.status === 'ready' ? '' : ' · 来源已失效'));
        option.value = run.run_id; option.disabled = run.status !== 'ready'; reanalysisSelect.append(option);
      });
      if (analyses.some(run => run.run_id === currentReanalysisId && run.status === 'ready')) reanalysisSelect.value = currentReanalysisId;
      else if (currentReanalysisId && navigation === requestVersion) clearHistoricalData('这次重新分析的来源已失效，已清除内容。');
      return { ok: true, analyses };
    } catch (error) {
      if (version !== listVersion) return { ok: false, aborted: true };
      if (navigation === requestVersion) {
        reanalysisSelect.replaceChildren(el('option', null, '重新分析列表读取失败，请刷新重试'));
        if ([401, 403].includes(error.status)) historyConnected = false;
        if ((currentHistorySid || currentReanalysisId) && transientRead(error)) {
          statusMessage('当前会话仍可读取；重新分析列表暂不可用，可刷新重试。');
          if (currentReanalysisId) await verifyHistory();
        } else {
          if (currentReanalysisId) pendingRequestedRun = currentReanalysisId;
          clearHistoricalData(error.message); statusMessage(error.message + ' 已清除私有内容。');
        }
      }
      return { ok: false, error };
    }
  }
  async function loadReanalysis(runId, userInitiated = true) {
    recoveryTarget = null;
    if (userInitiated) { stopAutomatic(); pendingRequestedRun = ''; pendingRequestedMeeting = ''; }
    if (!runId || !historyConnected) return { ok: false, aborted: true };
    const version = ++requestVersion;
    statusMessage('正在只读载入重新分析结果；不会再次调用模型…');
    try {
      const metadata = {};
      const result = await historyRequest('reanalyses/' + encodeURIComponent(runId), {}, metadata);
      if (version !== requestVersion || !historyConnected) return { ok: false, aborted: true };
      if (result.source?.kind !== 'reanalysis') throw new Error('结果未标注为重新分析，已停止显示。');
      load(result); currentReanalysisId = runId; currentHistorySid = ''; historySelect.value = ''; currentSnapshot = snapshotOf(result); currentValidator = metadata.etag;
      statusMessage('已读取获准后的重新分析结果；展开每个问题可看已存输入、选项和完整概率。本页不调用模型。');
      return { ok: true };
    } catch (error) { if (version === requestVersion) { pendingRequestedRun = runId; suspendHistory(error, '', runId, false); } return { ok: false, error }; }
  }
  async function verifyHistory() {
    if (recoveryTarget) return recoverHistory();
    if (!privateHistory || (!currentHistorySid && !currentReanalysisId) || !historyConnected || checkingHistory || document.hidden) return;
    const sid = currentHistorySid, runId = currentReanalysisId, version = requestVersion; checkingHistory = true;
    try {
      const metadata = {};
      const result = await historyRequest(runId ? 'reanalyses/' + encodeURIComponent(runId) : 'meetings/' + encodeURIComponent(sid), currentValidator ? { headers: { 'If-None-Match': currentValidator } } : {}, metadata);
      if (version !== requestVersion || sid !== currentHistorySid || runId !== currentReanalysisId) return;
      if (result === null) return;
      currentValidator = metadata.etag;
      const snapshot = snapshotOf(result);
      if (snapshot !== currentSnapshot) {
        const follow = Boolean(liveFollowing && result.source?.live);
        load(result, { preserve: true, followLatest: follow }); currentHistorySid = sid; currentReanalysisId = runId; currentSnapshot = snapshot;
        renderLiveStatus();
        statusMessage(result.source?.live ? '已读取服务器最新原话与处理记录。' : '来源或已存结果已变化；已重新读取，旧依据已替换。');
      }
    } catch (error) {
      if (version === requestVersion && sid === currentHistorySid && runId === currentReanalysisId) { if (runId) pendingRequestedRun = runId; else if (sid) pendingRequestedMeeting = automatic && autoScopeEnabled ? '' : sid; suspendHistory(error); }
    } finally { checkingHistory = false; }
  }
  window.addEventListener('focus', verifyHistory);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verifyHistory(); });
  setInterval(verifyHistory, 30000);
  async function checkLocalReview(review) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('./api/review-source', { signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('来源当前不可读取或已变化');
      const result = await response.json();
      if (result.valid !== true || result.source_session_id !== review.source_session_id
          || result.source_snapshot_hash !== review.source_snapshot_hash || result.source_hash !== review.source_hash) {
        throw new Error('本次复核的原会议来源已变化');
      }
    } finally { clearTimeout(timer); }
  }
  async function verifyLocalReview() {
    if (!localReviewActive || localReviewChecking || document.hidden || !data?.content_review) return;
    const expected = data; localReviewChecking = true;
    try { await checkLocalReview(expected.content_review); }
    catch (_) { if (data === expected) clearHistoricalData('无法重新核对原会议来源，本次复核内容已清除。刷新可重新核对。'); }
    finally { localReviewChecking = false; }
  }
  setInterval(verifyLocalReview, 30000);
  window.addEventListener('focus', verifyLocalReview);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verifyLocalReview(); });
  setInterval(async () => {
    if (refreshRetryPending && !recoveryTarget) await refreshHistory();
    await recoverHistory();
    await discoverMeetings();
    if (data?.source?.live?.active === true) verifyHistory();
  }, 5000);
  setInterval(refreshDeployedPipeline, 60000);
  async function refreshDeployedPipeline() {
    // This endpoint contains configuration metadata only. Public pages never request meetings or send cookies.
    const endpoint = privateHistory ? './api/pipeline' : 'https://giftedprofessor.xyz/oops-meeting/history/api/pipeline';
    try {
      const response = await fetch(endpoint, { credentials: 'omit', cache: 'no-store' });
      if (!response.ok) throw new Error('deployment metadata unavailable');
      const result = await response.json();
      const pipeline = result.pipeline || result;
      if (pipeline.scope !== 'deployed_source') throw new Error('unverified deployment metadata');
      deployedPipeline = pipeline;
      if (data) {
        data.deployed_pipeline = pipeline; renderPipeline();
        document.dispatchEvent(new CustomEvent('funnel:pipeline', { detail: pipeline }));
      }
    } catch (_) {
      deployedPipeline = null;
      if (data) {
        data.deployed_pipeline = { scope: 'unavailable' };
        renderPipeline();
        document.dispatchEvent(new CustomEvent('funnel:pipeline', { detail: data.deployed_pipeline }));
      }
    }
  }
  // Local preview only: ?local=real-0238.json opens a replay file served beside the page on this machine.
  // Public sites never carry such files, and the name cannot leave ./data/.
  async function loadLocalReplay() {
    const name = new URLSearchParams(location.search).get('local') || '';
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || !/^[\w-]+\.json$/.test(name)) return false;
    const version = ++requestVersion;
    const response = await fetch('./data/' + name, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('本机回放文件读取失败：HTTP ' + response.status);
    const replay = await response.json();
    if (replay.content_review) await checkLocalReview(replay.content_review);
    if (version === requestVersion) {
      load(replay);
      localReviewActive = Boolean(replay.content_review);
      // The local snapshot is explicitly selected; the public-example notice
      // does not describe this read-only local source.
      if ($('history-entry')) $('history-entry').hidden = true;
    }
    return true;
  }
  async function initialise() {
    // History starts with an empty state; never show an unrelated example while waiting.
    if (privateHistory) {
      clearHistoricalData('正在连接历史库…');
      ui.badge.textContent = '正在载入历史';
    } else {
      try {
        const localRequested = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('local');
        if (localRequested) { if (!(await loadLocalReplay())) throw new Error('本机回放文件名无效'); }
        else await loadExample();
      } catch (error) { clearHistoricalData('回放载入失败：' + error.message); ui.badge.textContent = '载入失败'; }
    }
    refreshDeployedPipeline();
    if (!privateHistory) return;
    $('history-panel').hidden = false; $('history-entry').hidden = true;
    const back = document.querySelector('.studio-brand, .back');
    if (back) back.href = 'https://oops-app-demo-hyl-20261008.giftedprofessor516.chatgpt.site/showcase.html?view=app#home';
    const fragment = new URLSearchParams(location.hash.slice(1));
    const invite = fragment.get('invite');
    // The invitation is exchanged once; never persist it or put it into API URLs.
    if (invite) {
      try { history.replaceState(null, '', location.pathname + location.search); } catch (_) { /* optional */ }
      try {
        await historyRequest('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }) });
      } catch (error) { statusMessage(error.message); return; }
    }
    await refreshHistory();
  }
  historySelect.addEventListener('change', () => loadHistoryMeeting(historySelect.value));
  reanalysisSelect.addEventListener('change', () => loadReanalysis(reanalysisSelect.value));
  $('history-refresh').addEventListener('click', refreshHistory);
  $('history-example').addEventListener('click', () => { pendingRequestedRun = ''; pendingRequestedMeeting = ''; historySelect.value = ''; reanalysisSelect.value = ''; loadExample().catch(error => statusMessage(error.message)); });
  $('history-disconnect').addEventListener('click', async () => {
    recoveryTarget = null; refreshRetryPending = false;
    stopAutomatic(); autoScopeEnabled = false; renderAutomatic();
    pendingRequestedRun = ''; pendingRequestedMeeting = ''; ++listVersion; ++requestVersion; historyConnected = false; historySelect.disabled = true; reanalysisSelect.disabled = true;
    clearHistoricalData('已退出历史库。');
    historySelect.replaceChildren(el('option', null, '已退出历史库'));
    reanalysisSelect.replaceChildren(el('option', null, '已退出重新分析'));
    // Clear the visible private data before waiting for the server to revoke the cookie.
    await loadExample().catch(error => statusMessage(error.message));
    try { await historyRequest('session', { method: 'DELETE' }); statusMessage('已退出历史库，页面回到示例。'); }
    catch (error) { statusMessage('本页已清除历史内容；服务端退出失败：' + error.message); }
  });
  initialise();
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
})();
