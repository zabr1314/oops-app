// Oops 会后整理：回放 scripts/funnel_replay.py 输出里的 post 段。
// 第 1 步展示已有纪要，历史调用次数有记录才显示；第 2–4 步是当前确定性代码：
// minutes_items 把纪要变成事项并对回原话，item_quality 复核，review_queue 排出会后核对顺序。
// 蜘蛛按原话顺序爬过全文，抓住被引用的句子，把事项标题提出来放到右侧。文字一律用 textContent 写入。
(() => {
  'use strict';
  const KIND = { task: { name: '待办', color: '#3fd9a0' }, decision: { name: '决定', color: '#f2896b' }, open: { name: '未决问题', color: '#ff3dd2' } };
  const KIND_ORDER = ['task', 'decision', 'open'];
  const QUEUE = { task: '核对待办', commitment: '核对待办', decision: '核对决定', open: '核对未决', speaker: '补说话人' };
  const PINK = '#ff3d8b', CYAN = '#5cc3ff';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const fmt = (ms) => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';

  const ui = {
    stage: $('after-stage'), canvas: $('after-canvas'), doc: $('doc'), docMeta: $('doc-meta'), docTitle: $('doc-title'),
    play: $('after-play'), restart: $('after-restart'), speed: $('after-speed'), note: $('after-note'),
    overview: $('overview'), queue: $('queue'), cost: $('after-cost'), pipeline: [...document.querySelectorAll('#pipeline li')],
    boards: { task: $('board-task'), decision: $('board-decision'), open: $('board-open') },
    counts: { task: $('n-task'), decision: $('n-decision'), open: $('n-open') },
    tabs: [...document.querySelectorAll('.modes button')], live: $('mode-live'), after: $('mode-after'),
  };
  const ctx = ui.canvas.getContext('2d');

  let data = null, post = null, rows = [], items = [], events = [], next = 0;
  let at = 0, playing = false, speed = 1, lastFrame = 0, started = false, total = 1, lastPublished = 0;
  let here = -1, grabUntil = 0, flyers = [], phases = [0, 0, 0, 0], ends = [0, 0, 0, 0];
  const spider = { x: 0, y: 0, ready: false, feet: [] };

  // ---------------------------------------------------------------- build
  function clauses(text) {
    const parts = text.match(/[^，。！？,.!?；;、]+[，。！？,.!?；;、]*|[，。！？,.!?；;、]+/g) || [text];
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function build(raw) {
    // Invalidated history must leave no private text in the last canvas frame.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    ctx.restore();
    const validSource = Array.isArray(raw?.sentences) && raw.sentences.length > 0 && raw.source?.kind !== 'empty';
    data = validSource ? raw : { ...raw, source: raw?.source || { kind: 'empty' }, sentences: [], post: null };
    post = data.post;
    rows = []; items = [];
    events = []; next = 0; at = 0; total = 1; speed = 1; playing = false; started = false; here = -1; flyers = []; phases = [0, 0, 0, 0]; ends = [0, 0, 0, 0]; spider.ready = false; spider.feet = [];
    ui.queue.replaceChildren(); KIND_ORDER.forEach((k) => { ui.boards[k].replaceChildren(); ui.counts[k].textContent = '0'; });
    ui.pipeline.forEach((li) => { li.classList.remove('active', 'done'); li.style.setProperty('--p', '0%'); });
    ['p0', 'p1', 'p2', 'p3'].forEach((id) => { $(id).textContent = ''; });
    const replay = data.source && data.source.kind !== 'example';
    ui.docTitle.textContent = data.source?.kind === 'history' ? 'history.full' : replay ? 'analysis.full' : 'transcript.example';
    renderPipelineLabels();
    if (!post) {
      const state = data.post_status || {};
      const reasons = { in_progress: '会议尚未结束', writing: '已有后台尚在整理', source_changed: '来源已变更，旧纪要不能作为当前依据', source_expired: '完整转写已到期', before_bot: '该会议早于纪要服务启用', failed: '已有生成记录失败', no_end: '未保存会议结束状态', bot_off: '此后端未启用纪要服务' };
      ui.doc.replaceChildren(el('li', null, state.message || reasons[state.reason] || '没有可用的已存会后纪要。'));
      ui.note.textContent = '这里只读历史结果；打开页面不会生成或重试纪要。'; ui.overview.replaceChildren(); ui.cost.replaceChildren();
      setPlaying(false); started = false;
      emitAfterState('funnel:after-data');
      return;
    }
    ui.note.textContent = '读取已有纪要，再按当前确定性代码对回原话、规则复核和排事项核对队列；这三个步骤不调模型。蜘蛛爬行是引用关系的动画，不是模型实时思考。' +
      (data.source?.kind === 'reanalysis' ? ' 复用原有纪要；本次重新分析只调用 Jev，没有调用 DeepSeek 生成新纪要。' : data.source?.kind === 'history' ? ' 后端历史只读；历史调用次数有记录才显示。' : replay ? ' 重新运行的分析回放，不能证明会议当时如何判断。' : ' 示例会议，纪要为演示编写。');

    const byId = new Map();
    rows = data.sentences.map((s, i) => {
      const li = el('li');
      const txt = el('span', 'txt');
      const segs = clauses(s.text).map((c) => el('span', 'seg', c));
      txt.append(...segs);
      li.append(el('span', 'num', s.id), el('span', 'spk', s.speaker || '—'), txt);
      const row = { i, id: s.id, text: s.text, outcome: s.outcome, li, txt, segs, items: [] };
      byId.set(s.id, row);
      return row;
    });
    ui.doc.replaceChildren(...rows.map((r) => r.li));

    items = post.items.map((it, n) => {
      const card = el('li', 'card');
      const meta = el('div', 'm');
      const who = [it.owner ? '负责人线索：' + it.owner + '（待人确认）' : '', it.due].filter(Boolean).join(' · ');
      if (who) meta.append(el('span', null, who));
      const ev = el('span', 'ev');
      const q = el('span', 'q', '');
      meta.append(ev, q);
      card.append(el('div', 't', it.title), meta);
      ui.boards[it.kind].append(card);
      const item = { ...it, n, card, ev, q, shown: false, seen: new Set() };
      it.ids.forEach((id) => { const r = byId.get(id); if (r) r.items.push(item); });
      return item;
    });

    ui.overview.replaceChildren(el('p', null, post.overview || '（纪要没有概览）'));
    if (post.topics && post.topics.length) {
      const t = el('div', 'topics');
      post.topics.forEach((x) => t.append(el('span', null, x)));
      ui.overview.append(t);
    }
    renderCost();
    schedule();
    speed = total > 45000 ? 2 : 1;
    ui.speed.value = String(speed);
    ui.docMeta.textContent = '已读 0 / ' + rows.length;
    started = false;
    if (reduceMotion) { at = total; runUntil(total); }
    setPlaying(false);
    emitAfterState('funnel:after-data');
  }

  function renderPipelineLabels() {
    const configured = data?.pipeline?.minutes_configured_runs;
    const pipeline = data?.pipeline || {};
    $('asr-review-note').textContent = pipeline.asr_review_supported ? '纪要前可选步骤：部署源码支持等待录音上传与第二次 ASR 复核' + (pipeline.asr_review_wait_min ? '（配置等待上限 ' + pipeline.asr_review_wait_min + ' 分钟）' : '') + '。' + (pipeline.asr_review_configured === true ? '部署已配置启用；' : pipeline.asr_review_configured === false ? '部署未配置启用；' : '部署是否启用未知；') + '本场是否实际执行只以历史记录为准，页面不会运行 ASR。' : '纪要前的上传与 ASR 复核：此数据未提供部署配置或本场执行记录；页面不会启动复核。';
    $('minutes-generation').textContent = configured ? (pipeline.scope === 'deployed_source' ? '部署源码' : '本地源码') + '：' + configured + ' 次生成后投票；历史另核对' : '读取已存纪要；历史生成次数另核对';
  }

  function renderCost() {
    const cited = rows.filter((r) => r.items.length).length;
    const rest = new Map();
    rows.filter((r) => !r.items.length).forEach((r) => {
      const key = String(r.outcome || '').split('，')[0] || '其他';
      rest.set(key, (rest.get(key) || 0) + 1);
    });
    const restText = [...rest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => k + ' ' + n).join(' · ');
    const generation = post.generation || {};
    const calls = Number.isInteger(generation.recorded_calls) ? generation.recorded_calls : null;
    const reused = generation.evidence === 'reused_history';
    const a = el('div'); a.append(el('div', 'big l-model', reused ? '复用原纪要' : calls == null ? '次数未记录' : calls + ' 次'), el('p', null, (reused ? '本次没有调用 DeepSeek。以下是原纪要的已存生成记录：' : '该次历史生成调用') + (post.latency_ms ? '，记录耗时 ' + fmt(post.latency_ms) : '；耗时未记录') + '。' + (data.source?.kind === 'example' ? '示例内容不代表真实调用。' : '当前源码配置不补作历史调用证据。')));
    if (Number.isInteger(generation.successful_runs)) a.append(el('p', null, '已存成功投票结果：' + generation.successful_runs + ' 份；不等于精确调用次数。'));
    const b = el('div'); b.append(el('div', 'big l-code', cited + ' / ' + rows.length), el('p', null, '句被纪要引用为依据。没被引用的：' + (restText || '—')));
    const c = el('p', 'verdict', '当前代码派生；规则通过也仍需人确认：' + items.length + ' 个事项，' + post.queue.length + ' 项待你核对。');
    ui.cost.replaceChildren(a, b, c);
    const delivery = post.delivery_record;
    if (delivery && typeof delivery === 'object') {
      const flag = (value, yes, no) => value === true ? yes : value === false ? no : '未记录';
      const sent = Number.isInteger(delivery.sent_receipts) && delivery.sent_receipts >= 0 ? String(delivery.sent_receipts) : '未记录';
      ui.cost.append(el('p', 'verdict', '历史回执摘要：文档创建 ' + flag(delivery.document_created, '有记录', '无记录') +
        '；已存发送回执 ' + sent + '；台账写入 ' + flag(delivery.ledger_written, '有记录', '无记录') +
        '；后台处理标记 ' + flag(delivery.done, '完成', '未完成') + '。这里只展示已保存状态，不表示本页执行过发送或本次会话已重新执行。'));
    }
  }

  // ---------------------------------------------------------------- schedule
  function schedule() {
    let t = 0;
    const T0 = Math.min(3200, Math.max(1400, (post.latency_ms || 3000) * 0.5));
    ends[0] = t + T0; t = ends[0];
    events.push({ t: 0, fn: () => step(0, 'active') });
    events.push({ t: ends[0], fn: () => { step(0, 'done'); $('p0').textContent = (post.latency_ms ? fmt(post.latency_ms) + ' · ' : '') + items.length + ' 条结果'; step(1, 'active'); } });
    const start1 = t;
    rows.forEach((r, i) => {
      const cited = r.items.length > 0;
      const dwell = cited ? 1250 : r.outcome && r.outcome.startsWith('语气词') ? 90 : 170;
      const arrive = t;
      events.push({ t: arrive, fn: () => arriveAt(i) });
      if (cited) events.push({ t: arrive + 260, fn: () => grab(r) });
      t += dwell;
    });
    ends[1] = t; const len1 = t - start1;
    events.push({ t, fn: () => { leave(); step(1, 'done'); step(2, 'active'); } });
    phases.start1 = start1; phases.len1 = len1;
    const start2 = t;
    items.forEach((it) => {
      events.push({ t, fn: () => { it.q.className = 'q checking'; it.q.textContent = '复核中'; } });
      t += 380;
      events.push({ t, fn: () => checked(it) });
    });
    ends[2] = t + 200; t = ends[2];
    phases.start2 = start2;
    events.push({ t, fn: () => { step(2, 'done'); step(3, 'active'); } });
    const start3 = t;
    post.queue.forEach((q, n) => { t += 240; events.push({ t, fn: () => enqueue(q, n) }); });
    if (!post.queue.length) events.push({ t, fn: () => ui.queue.append(el('li', 'empty', '没有当前待核对事项。')) });
    ends[3] = t + 300; t = ends[3];
    phases.start3 = start3;
    events.push({ t, fn: () => { step(3, 'done'); $('p3').textContent = post.queue.length + ' 项 · ' + summary(); } });
    total = t + 400;
    events.sort((a, b) => a.t - b.t);
  }

  function summary() {
    const c = {};
    post.queue.forEach((q) => { const kind = q.item_kind || q.kind; c[kind] = (c[kind] || 0) + 1; });
    return Object.entries(c).filter(([, n]) => n).map(([k, n]) => (QUEUE[k] || k).replace('核对', '') + ' ' + n).join(' · ');
  }

  function step(n, state) {
    const li = ui.pipeline[n];
    li.classList.toggle('active', state === 'active');
    li.classList.toggle('done', state === 'done');
    if (state === 'done') li.style.setProperty('--p', '100%');
  }

  function arriveAt(i) {
    if (here >= 0) { rows[here].li.classList.remove('here'); rows[here].li.classList.add('read'); }
    here = i;
    rows[i].li.classList.add('here');
    ui.docMeta.textContent = '已读 ' + (i + 1) + ' / ' + rows.length;
    $('p1').textContent = '已读 ' + (i + 1) + ' / ' + rows.length + ' · 引用 ' + rows.slice(0, i + 1).filter((r) => r.items.length).length + ' 句';
    follow(rows[i].li);
  }

  function leave() {
    if (here >= 0) { rows[here].li.classList.remove('here'); rows[here].li.classList.add('read'); }
    here = -1;
  }

  function grab(r) {
    grabUntil = at + 800;
    const kinds = KIND_ORDER.filter((k) => r.items.some((it) => it.kind === k));
    r.li.classList.add('cited', 'k-' + kinds[0]);
    kinds.forEach((k) => r.li.querySelector('.txt').append(el('span', 'tagged k-' + k, KIND[k].name)));
    r.items.forEach((it, n) => {
      const from = r.segs[Math.min(r.segs.length - 1, n)];
      if (!it.shown) {
        it.shown = true;
        flyers.push({ text: it.title, color: KIND[it.kind].color, from, to: ui.boards[it.kind].previousElementSibling, start: at + n * 180, dur: 1100, big: true, done: () => land(it, r.id) });
      } else {
        flyers.push({ text: r.id, color: KIND[it.kind].color, from, to: it.card, start: at + n * 180, dur: 700, big: false, done: () => addEvidence(it, r.id, true) });
      }
    });
  }

  function land(it, id) {
    it.card.classList.add('in');
    ui.counts[it.kind].textContent = String(items.filter((x) => x.kind === it.kind && x.card.classList.contains('in')).length);
    addEvidence(it, id, false);
    ensureVisible(it.card);
  }

  function addEvidence(it, id, pulse) {
    if (it.seen.has(id)) return;
    it.seen.add(id);
    const chip = el('span', pulse ? 'new' : '', id);
    chip.title = '定位到原话 ' + id;
    chip.addEventListener('click', () => ping(id));
    it.ev.append(chip);
    if (pulse) { it.card.classList.add('pulse'); setTimeout(() => it.card.classList.remove('pulse'), 450); }
  }

  function checked(it) {
    it.q.className = 'q ' + it.quality.status;
    it.q.textContent = it.quality.label + (it.quality.status === 'accepted' ? '' : '：' + it.quality.reason);
    it.q.title = it.quality.reason;
    const done = items.filter((x) => !x.q.classList.contains('checking') && x.q.textContent).length;
    const c = { accepted: 0, needs_review: 0, rejected: 0 };
    items.forEach((x) => { if (x.q.textContent && !x.q.classList.contains('checking')) c[x.quality.status] = (c[x.quality.status] || 0) + 1; });
    $('p2').textContent = done + ' / ' + items.length + ' · 通过 ' + c.accepted + ' · 待人核对 ' + c.needs_review + (c.rejected ? ' · 否决 ' + c.rejected : '');
    ensureVisible(it.card);
  }

  function enqueue(q, n) {
    const kind = q.item_kind || q.kind;
    const item = items.find(x => x.id === q.id);
    const target = q.ids?.[0] || item?.ids?.[0] || q.id;
    const r = rows.find((x) => x.id === target);
    const li = el('li');
    li.append(el('span', 'k ' + (kind === 'task' || kind === 'commitment' ? 'l-code' : kind === 'decision' ? 'l-model' : 'l-you'), QUEUE[kind] || kind),
      el('span', 'id', q.id), el('span', 'x', item ? item.title : r ? r.text : ''));
    li.addEventListener('click', () => ping(target));
    ui.queue.append(li);
    ui.queue.scrollTop = ui.queue.scrollHeight;
    $('p3').textContent = (n + 1) + ' / ' + post.queue.length + ' 项';
  }

  function ping(id) {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    follow(r.li, true);
    r.li.classList.add('ping');
    setTimeout(() => r.li.classList.remove('ping'), 900);
  }

  function follow(li, force) {
    const box = ui.doc;
    const top = li.offsetTop - box.clientHeight * 0.42;
    if (force || Math.abs(box.scrollTop - top) > 30) box.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function ensureVisible(card) {
    const board = card.closest('.board');
    const b = board.getBoundingClientRect(), c = card.getBoundingClientRect();
    if (c.bottom > b.bottom || c.top < b.top) board.scrollTo({ top: board.scrollTop + (c.top - b.top) - 40, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function runUntil(t) {
    // Deterministic playback: every action uses its own presentation timestamp,
    // including when scrubbing across many events in one frame.
    while (next < events.length && events[next].t <= t) {
      const event = events[next++];
      at = event.t;
      settleFlyers(at);
      event.fn();
      settleFlyers(at);
    }
    at = t;
    settleFlyers(at);
  }

  function settleFlyers(t) {
    flyers = flyers.filter(flyer => {
      if (flyer.start + flyer.dur > t) return true;
      flyer.done();
      return false;
    });
  }

  // ---------------------------------------------------------------- playback
  function setPlaying(on) {
    playing = Boolean(on && post && at < total && !ui.after.hidden && !document.hidden);
    ui.play.textContent = playing ? '❚❚ 暂停' : '▶ 播放';
    emitAfterState('funnel:after-play');
  }

  function afterState() {
    const phase = !post ? 'missing' : at < ends[0] ? 'minutes' : at < ends[1] ? 'evidence' :
      at < ends[2] ? 'quality' : at < ends[3] ? 'queue' : 'complete';
    return { data, post, rows, items, events, next, at, total, now: at, duration: total, here, phases, ends,
      playing, speed, started, available: Boolean(post), phase, timeline_kind: 'presentation',
      mode: ui.after.hidden ? 'live' : 'after' };
  }

  function emitAfterState(name) {
    document.dispatchEvent(new CustomEvent(name, { detail: afterState() }));
  }

  function seek(value) {
    if (!data || !post || !Number.isFinite(Number(value))) return;
    const raw = data, chosenSpeed = speed, target = Math.max(0, Math.min(total, Number(value)));
    build(raw);
    speed = chosenSpeed; ui.speed.value = String(speed);
    runUntil(target);
    started = target > 0;
    setPlaying(false);
    draw(lastFrame);
    emitAfterState('funnel:after-tick');
  }

  function start() {
    if (!post) return;
    started = true;
    setPlaying(!reduceMotion);
  }

  function restart() { if (data) { build(data); start(); } }

  // ---------------------------------------------------------------- canvas
  function sizeCanvas() {
    const r = ui.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ui.canvas.width = Math.round(r.width * dpr); ui.canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (post && !ui.after.hidden) draw(lastFrame);
  }

  function rel(r, base) { return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }; }

  function draw(realNow) {
    const base = ui.stage.getBoundingClientRect();
    ctx.clearRect(0, 0, base.width, base.height);
    if (!post || !base.width) return;
    const doc = rel(ui.doc.getBoundingClientRect(), base);

    // step 1: illustrative sweep over the stored minutes; no model runs here
    if (at < ends[0]) {
      const p = at / ends[0];
      const y = doc.y + p * doc.h;
      const g = ctx.createLinearGradient(0, y - 40, 0, y);
      g.addColorStop(0, 'rgba(242,137,107,0)'); g.addColorStop(1, 'rgba(242,137,107,.28)');
      ctx.fillStyle = g; ctx.fillRect(doc.x, y - 40, doc.w, 40);
      ctx.strokeStyle = '#f2896b'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(doc.x, y); ctx.lineTo(doc.x + doc.w, y); ctx.stroke();
      ctx.font = '12px ' + getComputedStyle(document.body).fontFamily; ctx.fillStyle = '#f2896b';
      ctx.fillText('展示已有纪要' + (post.latency_ms ? ' · 记录耗时 ' + fmt(post.latency_ms) : ' · 历史耗时未记录'), doc.x + 12, Math.max(doc.y + 16, y - 8));
      ui.pipeline[0].style.setProperty('--p', Math.round(p * 100) + '%');
    } else if (at < ends[1] && phases.len1) {
      ui.pipeline[1].style.setProperty('--p', Math.round(((at - phases.start1) / phases.len1) * 100) + '%');
    } else if (at < ends[2] && ends[2] > phases.start2) {
      ui.pipeline[2].style.setProperty('--p', Math.round(((at - phases.start2) / (ends[2] - phases.start2)) * 100) + '%');
    } else if (at < ends[3] && ends[3] > phases.start3) {
      ui.pipeline[3].style.setProperty('--p', Math.round(((at - phases.start3) / (ends[3] - phases.start3)) * 100) + '%');
    }

    if (here >= 0) drawSpider(base, doc, realNow);
    else spider.ready = false;

    flyers = flyers.filter((f) => {
      if (at < f.start) return true;
      const k = Math.min(1, (at - f.start) / f.dur);
      const a = rel(f.from.getBoundingClientRect(), base), b = rel(f.to.getBoundingClientRect(), base);
      const sx = a.x + a.w / 2, sy = a.y + a.h / 2, tx = b.x + 14, ty = b.y + 14;
      const lift = f.big ? 0.38 : 0.15;
      let x, y, size, alpha;
      if (k < lift) { const e = k / lift; x = sx + 8 * e; y = sy - 26 * e; size = (f.big ? 13 + 11 * e : 11); alpha = e; }
      else { const e = (k - lift) / (1 - lift), ease = e * e * (3 - 2 * e); x = sx + 8 + (tx - sx - 8) * ease; y = sy - 26 + (ty - sy + 26) * ease; size = f.big ? 24 - 11 * ease : 11; alpha = 1 - 0.35 * ease; }
      glitch(f.text, x, y, size, f.color, alpha, f.big);
      return k < 1;
    });
  }

  function glitch(text, x, y, size, color, alpha, big) {
    const font = getComputedStyle(document.body).fontFamily;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.font = (big ? '600 ' : '') + size + 'px ' + font;
    const t = big ? clip(text, 22) : text;
    const w = ctx.measureText(t).width;
    const W = ui.canvas.width / Math.min(2, window.devicePixelRatio || 1);
    x = Math.min(Math.max(4, x), W - w - 8);
    ctx.fillStyle = 'rgba(10,11,13,.82)'; ctx.fillRect(x - 5, y - size * 0.9, w + 10, size * 1.3);
    ctx.fillStyle = color; ctx.fillRect(x - 5, y + size * 0.4 - 2, w + 10, 2);
    if (big) {
      ctx.fillStyle = 'rgba(92,195,255,.55)'; ctx.fillText(t, x - 1.5, y);
      ctx.fillStyle = 'rgba(255,61,139,.55)'; ctx.fillText(t, x + 1.5, y);
    }
    ctx.fillStyle = color; ctx.fillText(t, x, y);
    ctx.restore();
  }

  function drawSpider(base, doc, realNow) {
    const r = rows[here];
    const segRects = r.segs.map((s) => rel(s.getBoundingClientRect(), base)).filter((q) => q.w > 0);
    if (!segRects.length) return;
    const first = segRects[0], last = segRects[segRects.length - 1];
    let tx = (first.x + last.x + last.w) / 2, ty = first.y - 18;
    tx = Math.min(Math.max(tx, doc.x + 40), doc.x + doc.w - 40);
    ty = Math.min(Math.max(ty, doc.y + 30), doc.y + doc.h - 30);
    if (!spider.ready) { spider.x = tx; spider.y = ty; spider.ready = true; spider.feet = []; }
    const k = reduceMotion ? 1 : 0.2;
    spider.x += (tx - spider.x) * k; spider.y += (ty - spider.y) * k;
    const grabbing = at < grabUntil && r.items.length;
    const wob = reduceMotion || !playing ? 0 : realNow / 110;
    for (let n = 0; n < 8; n++) {
      const side = n < 4 ? -1 : 1, j = n % 4;
      let want;
      if (grabbing && n < Math.max(2, segRects.length * 2)) {
        const s = segRects[n % segRects.length];
        want = { x: s.x + ((n * 37) % Math.max(8, s.w)), y: s.y + s.h / 2 };
      } else {
        const ang = (-0.9 + j * 0.6) + Math.sin(wob + n) * 0.12;
        want = { x: spider.x + side * Math.cos(ang) * 34, y: spider.y + Math.sin(ang) * 26 + 8 };
      }
      const f = spider.feet[n] || (spider.feet[n] = { x: want.x, y: want.y });
      const d = Math.hypot(want.x - f.x, want.y - f.y);
      if (grabbing || d > 14) { f.x += (want.x - f.x) * (grabbing ? 0.35 : 0.5); f.y += (want.y - f.y) * (grabbing ? 0.35 : 0.5); }
      const mx = (spider.x + f.x) / 2, my = (spider.y + f.y) / 2;
      const nx = -(f.y - spider.y), ny = f.x - spider.x, nl = Math.hypot(nx, ny) || 1;
      const kneeX = mx + (nx / nl) * 9 * side, kneeY = my + (ny / nl) * 9 * side - 6;
      ctx.strokeStyle = grabbing && n < segRects.length * 2 ? PINK : 'rgba(92,195,255,.85)';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(spider.x, spider.y); ctx.lineTo(kneeX, kneeY); ctx.lineTo(f.x, f.y); ctx.stroke();
      ctx.fillStyle = '#e6e8eb';
      ctx.beginPath(); ctx.arc(kneeX, kneeY, 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(f.x, f.y, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(10,11,13,.9)'; ctx.strokeStyle = CYAN; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.ellipse(spider.x, spider.y + 4, 7, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(spider.x, spider.y - 7, 4.5, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = grabbing ? PINK : '#3fd9a0'; ctx.beginPath(); ctx.arc(spider.x, spider.y + 4, 2.6, 0, Math.PI * 2); ctx.fill();
  }

  function frame(realNow) {
    const dt = Math.min(100, realNow - lastFrame);
    lastFrame = realNow;
    if (post && !ui.after.hidden && !document.hidden) {
      if (playing) {
        at = Math.min(total, at + dt * speed);
        runUntil(at);
        if (at >= total) setPlaying(false);
        draw(realNow);
        if (realNow - lastPublished >= 33 || !playing) {
          lastPublished = realNow;
          emitAfterState('funnel:after-tick');
        }
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- tabs & controls
  function showMode(mode) {
    const after = mode === 'after';
    ui.tabs.forEach((b) => { const on = b.dataset.mode === mode; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    ui.live.hidden = after; ui.after.hidden = !after;
    document.body.classList.toggle('mode-after', after);
    if (after) {
      if (window.oopsFunnel) window.oopsFunnel.pause();
      setPlaying(false);
      sizeCanvas();
    } else {
      setPlaying(false);
      if (window.oopsFunnel) window.oopsFunnel.pause();
    }
    try { history.replaceState(null, '', after ? '#after' : '#live'); } catch (e) { /* hash is optional */ }
    document.dispatchEvent(new CustomEvent('funnel:mode', { detail: { mode } }));
  }
  ui.tabs.forEach((b, n) => {
    b.addEventListener('click', () => showMode(b.dataset.mode));
    b.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const other = ui.tabs[(n + 1) % ui.tabs.length]; other.focus(); showMode(other.dataset.mode);
    });
  });
  ui.play.addEventListener('click', () => { if (at >= total) { restart(); return; } if (!started) start(); else setPlaying(!playing); });
  ui.restart.addEventListener('click', restart);
  ui.speed.addEventListener('change', () => { speed = Number(ui.speed.value) || 1; emitAfterState('funnel:after-tick'); });
  window.OopsAfterReplay = Object.freeze({
    state: afterState,
    pause: () => setPlaying(false),
    play: on => {
      if (!on) { setPlaying(false); return; }
      if (at >= total) { restart(); return; }
      started = true; setPlaying(true);
    },
    seek,
    restart,
    setSpeed: value => {
      if (![1, 2, 4].includes(Number(value))) return;
      speed = Number(value); ui.speed.value = String(speed); emitAfterState('funnel:after-tick');
    },
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPlaying(false); });

  document.addEventListener('funnel:pipeline', (ev) => { if (data) { data.pipeline = ev.detail; renderPipelineLabels(); } });
  document.addEventListener('funnel:data', (ev) => {
    build(ev.detail);
    if (location.hash === '#after' && ui.after.hidden) showMode('after');
  });
  new ResizeObserver(sizeCanvas).observe(ui.stage);
  requestAnimationFrame((t) => { lastFrame = t; frame(t); });
})();
