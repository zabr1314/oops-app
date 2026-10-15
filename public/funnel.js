// Oops 实时漏斗（视频风格）：按会议时间回放 scripts/funnel_replay.py 生成的数据。
// 每句话被问几个带类型的问题；每个问题由一层来答，线从这句话连到右侧弧上属于那一层的扇区，扇区正对该层的卡片。
// 刻度长度 = 置信度 p（没有 p 的按满长画）。文字一律用 textContent 写入；打开的回放文件只在本机读取，不上传。
(() => {
  'use strict';
  const LAYERS = {
    code: { name: '规则', color: '#3fd9a0', delay: 1 },
    jev: { name: 'Jev', color: '#5cc3ff', delay: 480 },
    model: { name: 'DeepSeek', color: '#f2896b', delay: 950 },
    you: { name: '你', color: '#f4cc4e', delay: 300 },
  };
  LAYERS.unknown = { name: '未记录', color: '#7d848d', delay: 1 };
  const PROVENANCE = { recorded: '历史记录', stored: '已存结果', recomputed: '当前规则重算', required: '确认要求', example: '编写示例', missing: '未记录', reanalysis: '本次重新分析' };
  const ORDER = ['code', 'jev', 'model', 'you'];
  const IDX = { code: 0, jev: 1, model: 2, you: 3 };
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
  let now = 0, fired = 0, playing = false, speed = 1, lastFrame = 0, lastRendered = -1;
  let selected = null, userScrolledAt = 0, lastStudioTick = 0;
  const openCallDetails = new Set();
  const spider = { x: 0, y: 0, ready: false };
  const neon = window.OopsSpider ? window.OopsSpider.create({ scale: 0.55, tone: '#3fd9a0' }) : null;

  // ---------------------------------------------------------------- data
  function validate(raw) {
    if (!raw || ![1, 2].includes(raw.version) || !Array.isArray(raw.sentences)) throw new Error('不是 funnel_replay.py 生成的漏斗数据（version 1 / 2）');
    for (const s of raw.sentences) {
      if (typeof s.text !== 'string' || !Number.isFinite(s.end_ms) || !Array.isArray(s.forks)) throw new Error('句子格式无效：' + (s.id || '?'));
      for (const f of s.forks) if (!LAYERS[f.layer]) throw new Error('未知的层：' + f.layer);
    }
    const legacy = raw.version === 1;
    return { ...raw, source: { ...raw.source, note: (raw.source?.note || '') + (legacy ? ' 旧版文件：来源标签与中间步骤未完整记录；0.95 仅为旧展示值，不能证明后端自动结束。' : '') }, thresholds: { tag_floor: 0.5, ...raw.thresholds } };
  }

  function load(raw) {
    data = validate(deployedPipeline && !['history', 'reanalysis'].includes(raw.source?.kind) ? { ...raw, pipeline: deployedPipeline } : raw);
    timeline = []; openCallDetails.clear();
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
    const seq = { code: 0, jev: 0, model: 0, you: 0, unknown: 0 };
    timeline.forEach((e) => { e.slot = (seq[e.f.layer]++ * GOLD + 0.5 * GOLD) % 1; e.real = 0; });
    duration = Math.max(1, ...timeline.map((e) => e.t), ...sentences.map((s) => s.end_ms)) + 1500;

    const replay = data.source && ['replay', 'history', 'reanalysis'].includes(data.source.kind);
    const historical = data.source?.kind === 'history';
    ui.badge.textContent = data.source?.kind === 'reanalysis' ? '重新分析 · Jev' : historical ? '后端历史 · 只读' : replay ? (privateHistory ? '事后分析 · 只读' : '分析回放 · 仅本机') : '示例数据';
    ui.badge.className = 'badge ' + (replay ? 'replay' : 'example');
    ui.label.textContent = (data.source && data.source.label) || '';
    ui.note.textContent = (data.source && data.source.note) || '';
    $('pane-title').textContent = data.source?.kind === 'reanalysis' ? 'reanalysis.readonly' : historical ? 'history.readonly' : replay ? 'replay.local' : 'meeting.example';
    renderPipeline();

    buildTranscript();
    buildDots();
    buildExits();
    renderLens();
    speed = SPEEDS.find((v) => v >= duration / 60000) || 60;
    ui.speed.value = String(speed);
    selected = null; ui.follow.hidden = true;
    seek(reduceMotion ? duration : 0);
    // Loaded records wait for an explicit playback action; opening a source is read-only.
    setPlaying(false);
    document.dispatchEvent(new CustomEvent('funnel:data', { detail: data }));
    emitReplayState('funnel:tick');
  }

  function renderPipeline() {
    const pipeline = data?.pipeline || {};
    const deployed = pipeline.scope === 'deployed_source';
    $('research-state').textContent = deployed ? (pipeline.in_meeting_research === true ? '部署源码包含会中研究；执行看记录' : pipeline.in_meeting_research === false ? '部署源码未进入会中研究；历史另核对' : '部署的会中自动研究状态未知') : '部署配置暂不可读取';
    const configured = pipeline.minutes_configured_runs;
    $('pipeline-note').textContent = (deployed ? '流程来源：已部署源码' : '部署配置暂不可读取；当前工作区源码供比较，不代表线上部署') + (pipeline.verified_at ? ' · 核对于 ' + pipeline.verified_at : '') + (configured ? ' · 纪要配置 ' + configured + ' 次独立生成后投票' : '') + '。这些是源码配置；每场实际执行只以保存记录为准。' + (pipeline.legacy_auto_delivery_supported === true ? ' 部署源码还包含旧自动共享链路；本页只读取历史，不触发发送。' : '');
  }

  function clauses(text) {
    const parts = text.match(/[^，。！？,.!?；;、]+[，。！？,.!?；;、]*|[，。！？,.!?；;、]+/g) || [text];
    return parts.map((p) => p.trim()).filter(Boolean);
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

  const replayState = () => ({ data, sentences, timeline, now, duration, playing, speed, selected, fired });
  function emitReplayState(name) {
    document.dispatchEvent(new CustomEvent(name, { detail: replayState() }));
  }

  function selectSentence(index) {
    if (!Number.isInteger(index) || !sentences[index]) return;
    setPlaying(false);
    selected = index; ui.follow.hidden = false;
    // Selecting an already saved sentence reveals its complete recorded steps.
    seek(sentences[index].doneAt);
    markSelected();
    emitReplayState('funnel:selection');
  }

  function followPlayback() {
    selected = null; ui.follow.hidden = true; markSelected(); lastRendered = -1;
    render(true); emitReplayState('funnel:selection');
  }

  function seek(t) {
    now = Math.min(Math.max(0, t), duration);
    fired = 0;
    sentences.forEach((s) => { s.state = ''; s.firedSteps = 0; });
    while (fired < timeline.length && timeline[fired].t <= now) {
      timeline[fired].real = 0;
      if (timeline[fired].i >= 0) sentences[timeline[fired].i].firedSteps++;
      fired++;
    }
    lastRendered = -1;
    render(true);
    emitReplayState('funnel:tick');
  }

  const stateOf = (s) => now < s.start_ms ? 'hidden' : now < s.end_ms ? 'partial' : now >= s.doneAt ? 'done' : 'thinking';

  // ---------------------------------------------------------------- DOM render
  function render(full) {
    let heard = 0;
    for (const s of sentences) {
      const st = stateOf(s);
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
      s.row.className = [st, st === 'done' ? 'route-' + s.route : '', s.filler && st === 'done' ? 'filler' : '', selected === s.i ? 'selected' : ''].join(' ').trim();
      s.dot.className = st === 'done' ? s.route : st === 'thinking' ? 'heard' : '';
      if (st === 'thinking' && playing && !full) autoScroll(s.row);
    }
    ui.paneLine.textContent = '句 ' + heard + ' / ' + sentences.length;
    ui.dotsFoot.textContent = heard + ' / ' + sentences.length + ' 句已听完';
    ui.clock.textContent = mmss(now) + ' / ' + mmss(duration);
    ui.scrub.value = String(Math.round((now / duration) * 1000));
    if (fired === lastRendered && !full) return;
    lastRendered = fired;

    const c = { code: 0, jev: 0, model: 0, you: 0, unknown: 0 };
    for (let j = 0; j < fired; j++) c[timeline[j].f.layer]++;
    const total = c.code + c.jev + c.model + c.you + c.unknown;
    $('c-sent').textContent = heard; $('c-fork').textContent = total;
    const ended = { code: new Map(), jev: new Map(), model: new Map(), you: new Map(), unknown: new Map() };
    const endedN = { code: 0, jev: 0, model: 0, you: 0, unknown: 0 };
    for (const s of sentences) if (now >= s.doneAt) { ended[s.route].set(s.outcome, (ended[s.route].get(s.outcome) || 0) + 1); endedN[s.route]++; }
    ORDER.forEach((k) => {
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
    renderBars(c, total, heard);
    renderStream();
    renderSpark();
    ui.statusLeft.textContent = 'oops@funnel · ' + sentences.length + ' 句 · ' + (data.source?.kind === 'reanalysis' ? '重新分析（只读）' : data.source?.kind === 'history' ? '后端历史（只读）' : data.source?.kind === 'replay' ? (privateHistory ? '事后分析回放（只读）' : '重新分析回放（仅本机）') : '示例数据') + ' · ' + mmss(now);
    ui.statusRight.textContent = '岔口 ' + total + ' · 规则 ' + c.code + ' · Jev ' + c.jev + ' · DeepSeek ' + c.model + ' · 你 ' + c.you + (c.unknown ? ' · 来源未记录 ' + c.unknown : '');
  }

  function renderBars(c, total, heard) {
    if (!ui.bars.children.length) {
      for (const k of ORDER) {
        const li = el('li'), track = el('span', 'track'), fill = el('span', 'fill');
        fill.style.background = LAYERS[k].color; track.append(fill);
        li.append(el('span', 'l-' + k, LAYERS[k].name), track, el('span', 'n l-' + k, '0'));
        ui.bars.append(li);
      }
    }
    [...ui.bars.children].forEach((li, idx) => {
      const k = ORDER[idx];
      li.children[1].firstChild.style.width = (total ? (c[k] / total) * 100 : 0) + '%';
      li.children[2].textContent = c[k];
    });
    $('routed-n').textContent = total;
    $('routed-sub').textContent = '个岔口 · 来自 ' + heard + ' 句' + (c.unknown ? ' · ' + c.unknown + ' 条来源未记录' : '');
  }

  function renderStream() {
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
    ui.stream.replaceChildren(...rows.map((e) => {
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
      const p = el('span', 'p' + (e.f.p != null && e.f.p < data.thresholds.tag_floor ? ' low' : ''), !e.pending && e.f.p != null ? 'p ' + e.f.p.toFixed(2) : '');
      li.append(el('span', 't', e.t != null ? mmss(e.t) : '#' + (e.k + 1)), w, el('span', 'q', e.f.q), a, p, el('span', 'to l-' + e.f.layer, '→ ' + LAYERS[e.f.layer].name));
      if (!e.pending && e.f.request) li.append(renderRequestDetail(e.f));
      return li;
    }));
    if (!rows.length) {
      const s = selected != null ? sentences[selected] : null;
      ui.stream.append(el('li', 'muted', s ? (s.tag ? s.outcome + '；没有 Jev 概率、模型及中间判断记录。' : '这句话没有历史判断记录；不补算或重新调用 Jev。') : '还没有判断记录。'));
    }
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
      ui.lens.replaceChildren(el('div', 'big l-jev', (data.source.request_count ?? '—') + ' 次实际请求'), el('p', null, '显示本次重新分析的请求、完整选项和返回概率。'), el('p', 'verdict', '原会议历史保持原样；会后纪要若有展示，是复用原有结果，本次没有调用 DeepSeek。'));
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

  function autoScroll(row) {
    if (performance.now() - userScrolledAt < 4000) return;
    const box = ui.transcript;
    const top = row.offsetTop - box.clientHeight * 0.55;
    if (Math.abs(box.scrollTop - top) > 4) box.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // ---------------------------------------------------------------- canvas
  function rel(r, base) { return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, width: r.width, height: r.height }; }

  function geometry() {
    const base = ui.stage.getBoundingClientRect();
    const tr = rel(ui.transcript.getBoundingClientRect(), base);
    const fan = rel(ui.fan.getBoundingClientRect(), base);
    const cards = ui.cards.map((c) => rel(c.getBoundingClientRect(), base));
    const side = cards[0].left >= fan.right - 4 && fan.width > 40 ? 'right' : 'bottom';
    const g = { W: base.width, H: base.height, base, tr, fan, cards, side };
    if (side === 'right') {
      const top = cards[0].top + 6, bottom = cards[3].bottom - 6;
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
      const w = (g.fan.width - 24) / 4;
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
    if (s.row.hidden) return null;
    const node = s.state === 'partial' ? s.typing : s.boxes[s.boxes.length - 1];
    const r = node.getBoundingClientRect();
    if (!r.width) return null;
    const p = { x: r.right - g.base.left, y: r.top + r.height / 2 - g.base.top };
    if (p.y < g.tr.top + 30 || p.y > g.tr.bottom) return null;
    return p;
  }

  function activeSentence() {
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
    if (s.row.hidden) return null;
    let node;
    if (s.state === 'partial') node = s.typing;
    else {
      const progress = s.state === 'thinking' ? s.firedSteps / Math.max(1, s.forks.length) : 1;
      node = s.boxes[Math.min(s.boxes.length - 1, Math.floor(progress * s.boxes.length))];
    }
    const r = node.getBoundingClientRect();
    if (!r.width) return null;
    let x = r.left + r.width * 0.5 - g.base.left, y = r.top - g.base.top - 6;
    y = Math.min(Math.max(y, g.tr.top + 36), g.tr.bottom - 14);
    x = Math.min(Math.max(x, g.tr.left + 24), g.tr.right - 14);
    if (!spider.ready) { spider.x = x; spider.y = y; spider.ready = true; }
    const k = reduceMotion ? 1 : 0.16;
    spider.x += (x - spider.x) * k; spider.y += (y - spider.y) * k;
    return spider;
  }

  function drawSpider(p, realNow, tips) {
    if (neon) { neon.draw(ctx, p, realNow, { playing, reduce: reduceMotion, tendrils: tips }); return; }
    const t = reduceMotion || !playing ? 0 : realNow / 120;
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
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(r.width * dpr); ui.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(realNow) {
    if (!ui.stage.getBoundingClientRect().width) return;
    const g = geometry();
    ctx.clearRect(0, 0, g.W, g.H);
    if (!data) return;

    // sector guides: one faint arc per layer, with its name
    ORDER.forEach((k, idx) => {
      const pts = [];
      for (let f = 0; f <= 1.0001; f += 0.1) pts.push(arcPoint(g, idx, f));
      ctx.strokeStyle = hexA(LAYERS[k].color, 0.35); ctx.lineWidth = 1;
      ctx.beginPath(); pts.forEach((p, n) => (n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    });

    const active = activeSentence();
    const sp = placeSpider(g, active);
    const fresh = [];
    for (let j = 0; j < fired; j++) {
      const e = timeline[j];
      if (e.f.layer === 'unknown') continue;
      const age = e.real ? (realNow - e.real) / 1000 : 99;
      const P = arcPoint(g, IDX[e.f.layer], e.slot);
      const color = LAYERS[e.f.layer].color;
      const p = e.f.p != null ? e.f.p : 1;
      const room = g.side === 'right' ? Math.max(8, g.limit - P.x) : Math.max(8, g.limit - P.y);
      const len = Math.min(room, 8 + p * room * 0.9);
      const sel = selected != null && e.i === selected;
      if (age < 1.6 || sel) { fresh.push({ e, P, len, age, sel }); continue; }
      const O = fractionOrigin(g, e.i);
      ctx.globalAlpha = selected != null ? 0.03 : 0.07;
      ctx.strokeStyle = '#c8ccd2'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.quadraticCurveTo((O.x + P.x) / 2, (O.y + P.y) / 2, P.x, P.y); ctx.stroke();
      ctx.globalAlpha = selected != null ? 0.35 : 0.85;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(P.x + P.ux * len, P.y + P.uy * len); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    fresh.sort((a, b) => (a.e.real || 0) - (b.e.real || 0));
    const tips = [];
    fresh.forEach((o, idx) => {
      const { e, P, len } = o;
      const tip = { x: P.x + P.ux * len, y: P.y + P.uy * len };
      if (e.i === active) tips.push(tip);
      // A newly reached judgement lands with a burst at the end of its strand.
      if (neon && !e.landed && o.age < 0.25 && playing && !reduceMotion) { e.landed = true; neon.land(tip.x, tip.y, LAYERS[e.f.layer].color); }
      const a = o.sel ? 1 : Math.max(0, 1 - o.age / 1.6);
      const O = sp && e.i === active ? sp : rowOrigin(g, e.i) || fractionOrigin(g, e.i);
      ctx.globalAlpha = 0.3 + 0.7 * a;
      ctx.strokeStyle = PINK; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(O.x, O.y); ctx.lineTo(P.x, P.y); ctx.stroke();
      ctx.strokeStyle = LAYERS[e.f.layer].color; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(P.x + P.ux * len, P.y + P.uy * len); ctx.stroke();
      if (e.f.settled) { ctx.fillStyle = PINK; ctx.beginPath(); ctx.arc(P.x + P.ux * len, P.y + P.uy * len, 2.6, 0, Math.PI * 2); ctx.fill(); }
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
    const q = e.f.q + (e.f.p != null ? '  p ' + e.f.p.toFixed(2) : '');
    const a = clip(e.f.a, 16);
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
    if (!ORDER.includes(layer)) return;
    const card = ui.cards[IDX[layer]];
    card.classList.add('flash');
    clearTimeout(flashTimers[layer]);
    flashTimers[layer] = setTimeout(() => card.classList.remove('flash'), 260);
  }

  function frame(realNow) {
    const dt = Math.min(250, realNow - lastFrame);
    lastFrame = realNow;
    if (data) {
      if (playing) {
        now = Math.min(duration, now + dt * speed);
        while (fired < timeline.length && timeline[fired].t <= now) {
          const e = timeline[fired];
          e.real = realNow;
          if (e.i >= 0) sentences[e.i].firedSteps++;
          flash(e.f.layer);
          fired++;
        }
        if (now >= duration) setPlaying(false);
      }
      render(false);
      draw(realNow);
      if (playing && realNow - lastStudioTick >= 33) {
        lastStudioTick = realNow;
        emitReplayState('funnel:tick');
      }
    }
    requestAnimationFrame(frame);
  }

  ui.play.addEventListener('click', () => { if (selected != null) followPlayback(); if (now >= duration) seek(0); setPlaying(!playing); });
  ui.restart.addEventListener('click', () => { followPlayback(); seek(0); setPlaying(true); });
  ui.speed.addEventListener('change', () => { speed = Number(ui.speed.value) || 1; emitReplayState('funnel:tick'); });
  ui.scrub.addEventListener('input', () => seek((Number(ui.scrub.value) / 1000) * duration));
  ui.follow.addEventListener('click', followPlayback);
  ['wheel', 'touchmove'].forEach((t) => ui.transcript.addEventListener(t, () => { userScrolledAt = performance.now(); }, { passive: true }));
  document.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.target.closest('dialog, details') || /^(INPUT|SELECT|BUTTON|TEXTAREA|LI|SUMMARY)$/.test(ev.target.tagName)) return;
    ev.preventDefault(); ui.play.click();
  });

  function readFile(file) {
    if (!file) return;
    pendingRequestedRun = '';
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
    seek,
    play: (on) => {
      if (on && selected != null) followPlayback();
      if (on && now >= duration) seek(0);
      setPlaying(on);
    },
    setSpeed: (value) => { if (SPEEDS.includes(Number(value))) { speed = Number(value); ui.speed.value = String(speed); emitReplayState('funnel:tick'); } },
    follow: followPlayback,
    renderRequestDetail,
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });
  new ResizeObserver(sizeCanvas).observe(ui.stage);
  sizeCanvas();

  let requestVersion = 0;
  let listVersion = 0;
  let deployedPipeline = null;
  let currentHistorySid = '', currentReanalysisId = '', currentSnapshot = '', checkingHistory = false;
  function clearHistoricalData(message) {
    ++requestVersion;
    currentHistorySid = ''; currentReanalysisId = ''; currentSnapshot = '';
    load({ version: 2, source: { kind: 'empty', label: '未载入私有历史', note: message }, sentences: [], session: [], post: null, thresholds: { tag_floor: 0.5 }, lens: null });
    setPlaying(false);
    ui.badge.textContent = '历史内容已清除';
    ui.statusLeft.textContent = 'oops@funnel · 未载入私有历史';
  }
  const snapshotOf = result => result.source?.snapshot_hash || JSON.stringify({ sentences: result.sentences, post: result.post, post_status: result.post_status });
  async function loadExample() {
    if (['history', 'reanalysis'].includes(data?.source?.kind)) clearHistoricalData('已清除历史内容，正在载入示例。');
    currentHistorySid = ''; currentReanalysisId = ''; currentSnapshot = '';
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
  async function historyRequest(path, options = {}) {
    const readOnly = (options.method || 'GET').toUpperCase() === 'GET';
    const waitToRead = attempt => new Promise(resolve => setTimeout(resolve, (attempt + 1) * 500));
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await fetch('./api/' + path, { ...options, credentials: 'same-origin', cache: 'no-store' }); }
      catch (_) {
        if (readOnly && attempt < 2) { await waitToRead(attempt); continue; }
        const error = new Error('历史服务网络连接失败，请刷新列表重试。'); error.code = 'network_failure'; throw error;
      }
      if (response.ok) {
        if (response.status === 204) return {};
        try { return await response.json(); }
        catch (_) { const error = new Error('历史服务返回格式错误，请刷新列表重试。'); error.status = response.status; error.code = 'invalid_json'; throw error; }
      }
      if (readOnly && [429, 502, 503, 504].includes(response.status) && attempt < 2) { await waitToRead(attempt); continue; }
      let message = '读取失败（HTTP ' + response.status + '），可刷新重试。';
      if ([401, 403].includes(response.status)) message = '当前会话无读取权限，请通过私有邀请重新进入。';
      if ([404, 410].includes(response.status)) message = '会议已删除、来源已到期或当前邀请不包含这场会议。';
      if ([502, 503, 504].includes(response.status)) message = '历史服务暂不可用（HTTP ' + response.status + '），请刷新列表重试。';
      if (response.status === 429) message = '历史读取过于频繁（HTTP 429），请稍后刷新列表重试。';
      const error = new Error(message); error.status = response.status;
      try { const body = await response.json(); const code = body?.error?.code; if (typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code)) error.code = code; } catch (_) { /* HTTP status remains the root cause. */ }
      throw error;
    }
  }
  async function loadHistoryMeeting(sid, userInitiated = true) {
    if (userInitiated) pendingRequestedRun = '';
    if (!sid || !historyConnected) return;
    const version = ++requestVersion;
    statusMessage('正在读取已有会议…');
    try {
      const result = await historyRequest('meetings/' + encodeURIComponent(sid));
      if (version !== requestVersion || !historyConnected) return;
      load(result);
      currentHistorySid = sid; currentReanalysisId = ''; reanalysisSelect.value = ''; currentSnapshot = snapshotOf(result);
      statusMessage('已读取历史；缺失的 Jev 概率与模型步骤保持空白。未发起模型调用或外部操作。');
    } catch (error) { if (version === requestVersion) { clearHistoricalData(error.message); statusMessage(error.message + ' 已清除先前历史内容。'); } }
  }
  async function refreshHistory() {
    historySelect.disabled = true; reanalysisSelect.disabled = true;
    const version = ++listVersion, navigation = requestVersion;
    statusMessage('正在读取会议列表…');
    let listing;
    try {
      const result = await historyRequest('meetings');
      if (version !== listVersion) return { ok: false, aborted: true };
      historyConnected = true;
      const meetings = Array.isArray(result.meetings) ? result.meetings : [];
      const previous = historySelect.value;
      historySelect.replaceChildren(el('option', null, meetings.length ? '选择一场历史会议…' : '没有可读取的会议'));
      historySelect.firstChild.value = '';
      meetings.forEach(meeting => {
        const option = el('option', null, (meeting.title || '未命名会议') + ' · ' + (meeting.started_at || '').slice(0, 16) + ' · ' + meeting.utterance_count + ' 句 · ' + (meeting.trace_count || 0) + ' 条过程记录');
        option.value = meeting.session_id; historySelect.append(option);
      });
      if (meetings.some(meeting => meeting.session_id === previous)) historySelect.value = previous;
      else if (currentHistorySid && navigation === requestVersion) clearHistoricalData('当前会议已不在可读列表，已清除旧历史。');
      if (navigation === requestVersion) statusMessage(meetings.length + ' 场可读历史。选择会议后查看；已有最终标签不等于保存了 Jev 的概率和推理步骤。');
      listing = await refreshReanalyses(version, navigation);
      // Only one readable meeting and nothing chosen yet: open it rather than leaving the example on screen.
      if (meetings.length === 1 && !currentHistorySid && !currentReanalysisId && !pendingRequestedRun && navigation === requestVersion && version === listVersion) {
        historySelect.value = meetings[0].session_id;
        await loadHistoryMeeting(meetings[0].session_id, false);
      }
    } catch (error) {
      if (version !== listVersion) return { ok: false, aborted: true };
      if (navigation === requestVersion) {
        if (currentReanalysisId) pendingRequestedRun = currentReanalysisId;
        historyConnected = false; historySelect.replaceChildren(el('option', null, '历史读取失败，请刷新重试')); reanalysisSelect.replaceChildren(el('option', null, '列表尚未载入，请刷新重试'));
        clearHistoricalData(error.message); statusMessage(error.message + ' 已清除先前历史内容。');
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
        if (currentReanalysisId) pendingRequestedRun = currentReanalysisId;
        reanalysisSelect.replaceChildren(el('option', null, '重新分析列表读取失败，请刷新重试'));
        if ([401, 403].includes(error.status)) historyConnected = false;
        clearHistoricalData(error.message); statusMessage(error.message + ' 已清除私有内容。');
      }
      return { ok: false, error };
    }
  }
  async function loadReanalysis(runId, userInitiated = true) {
    if (userInitiated) pendingRequestedRun = '';
    if (!runId || !historyConnected) return { ok: false, aborted: true };
    const version = ++requestVersion;
    statusMessage('正在只读载入重新分析结果；不会再次调用模型…');
    try {
      const result = await historyRequest('reanalyses/' + encodeURIComponent(runId));
      if (version !== requestVersion || !historyConnected) return { ok: false, aborted: true };
      if (result.source?.kind !== 'reanalysis') throw new Error('结果未标注为重新分析，已停止显示。');
      load(result); currentReanalysisId = runId; currentHistorySid = ''; historySelect.value = ''; currentSnapshot = snapshotOf(result);
      statusMessage('重新分析：这是获准后新运行的 Jev 结果，原会议历史未改；展开每个问题可看输入、选项和完整概率。');
      return { ok: true };
    } catch (error) { if (version === requestVersion) { pendingRequestedRun = runId; clearHistoricalData(error.message); statusMessage(error.message); } return { ok: false, error }; }
  }
  async function verifyHistory() {
    if (!privateHistory || (!currentHistorySid && !currentReanalysisId) || !historyConnected || checkingHistory || document.hidden) return;
    const sid = currentHistorySid, runId = currentReanalysisId, version = requestVersion; checkingHistory = true;
    try {
      const result = await historyRequest(runId ? 'reanalyses/' + encodeURIComponent(runId) : 'meetings/' + encodeURIComponent(sid));
      if (version !== requestVersion || sid !== currentHistorySid || runId !== currentReanalysisId) return;
      const snapshot = snapshotOf(result);
      if (snapshot !== currentSnapshot) {
        load(result); currentHistorySid = sid; currentReanalysisId = runId; currentSnapshot = snapshot;
        statusMessage('来源或已存结果已变化；已重新读取，旧依据已替换。');
      }
    } catch (error) {
      if (version === requestVersion && sid === currentHistorySid && runId === currentReanalysisId) { if (runId) pendingRequestedRun = runId; ++requestVersion; clearHistoricalData(error.message); statusMessage(error.message + ' 已清除失效或无法核对的历史。'); }
    } finally { checkingHistory = false; }
  }
  window.addEventListener('focus', verifyHistory);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verifyHistory(); });
  setInterval(verifyHistory, 30000);
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
      if (data && !['history', 'reanalysis'].includes(data.source?.kind)) {
        data.pipeline = pipeline; renderPipeline();
        document.dispatchEvent(new CustomEvent('funnel:pipeline', { detail: pipeline }));
      }
    } catch (_) {
      deployedPipeline = null;
      if (data && !['history', 'reanalysis'].includes(data.source?.kind)) {
        data.pipeline = { scope: 'unavailable' };
        renderPipeline();
        document.dispatchEvent(new CustomEvent('funnel:pipeline', { detail: data.pipeline }));
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
    if (version === requestVersion) load(replay);
    return true;
  }
  async function initialise() {
    try { if (!(await loadLocalReplay().catch(error => { ui.note.textContent = error.message; return false; }))) await loadExample(); }
    catch (error) { ui.badge.textContent = '载入失败'; ui.note.textContent = '示例数据载入失败：' + error.message; }
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
  $('history-example').addEventListener('click', () => { pendingRequestedRun = ''; historySelect.value = ''; reanalysisSelect.value = ''; loadExample().catch(error => statusMessage(error.message)); });
  $('history-disconnect').addEventListener('click', async () => {
    pendingRequestedRun = ''; ++listVersion; ++requestVersion; historyConnected = false; historySelect.disabled = true; reanalysisSelect.disabled = true;
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
