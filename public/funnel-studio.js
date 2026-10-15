/* Read-only presentation of saved replay records. Never starts model or delivery work. */
(() => {
  'use strict';
  function currentIndex(snapshot) {
    const rows = snapshot.sentences || snapshot.data?.sentences || [];
    if (Number.isInteger(snapshot.selected) && rows[snapshot.selected]) return snapshot.selected;
    if (snapshot.playing) {
      const fired = Math.min(snapshot.fired || 0, snapshot.timeline?.length || 0);
      for (let j = fired - 1; j >= 0; j--) {
        const event = snapshot.timeline[j];
        if (event.f?.layer !== 'jev' || !Number.isInteger(event.i) || !rows[event.i] || !(event.real > 0)) continue;
        const elapsed = (snapshot.now || 0) - event.t;
        if (elapsed >= 0 && elapsed <= Math.max(1, snapshot.speed || 1) * 700) return event.i;
        break;
      }
    }
    let index = 0;
    for (let i = 0; i < rows.length; i++) if ((rows[i].start_ms ?? rows[i].end_ms ?? 0) <= (snapshot.now || 0)) index = i;
    return index;
  }
  function deriveStations(snapshot = {}) {
    const data = snapshot.data;
    const rows = snapshot.sentences || data?.sentences || [];
    const empty = () => ({ status: 'empty', note: '等待来源', active: false });
    if (!data || !data.sentences?.length || !rows.length) return Object.fromEntries(['listen', 'judge', 'query', 'minutes', 'delivery'].map(key => [key, empty()]));
    const reanalysis = data.source?.kind === 'reanalysis';
    const example = data.source?.kind === 'example';
    const running = !!snapshot.playing && snapshot.mode !== 'after';
    const row = rows[currentIndex(snapshot)];
    const currentHasJudgements = !!row && (row.forks || []).some(f => f.layer === 'jev');
    const hasJudgements = rows.some(s => (s.forks || []).some(f => f.layer === 'jev'));
    const reusedMinutes = data.post?.generation?.evidence === 'reused_history';
    return {
      listen: { status: 'reused', note: reanalysis ? '复用原转写' : example ? '示例原话' : '已有转写', active: false },
      judge: { status: hasJudgements ? 'recorded' : 'empty', note: hasJudgements ? reanalysis ? '本次重新分析' : example ? '示例判断' : '已有判断记录' : '判断未记录', active: running && currentHasJudgements && Number.isFinite(row.doneAt) && snapshot.now >= row.end_ms && snapshot.now <= row.doneAt },
      query: { status: 'idle', note: reanalysis ? '本次未运行' : '无执行记录', active: false },
      minutes: { status: reusedMinutes ? 'reused' : data.post ? 'recorded' : 'empty', note: reusedMinutes ? '复用原纪要' : data.post ? '已有纪要' : '没有可用纪要', active: false },
      delivery: { status: 'idle', note: reanalysis ? '本次未运行' : '无本次发送', active: false },
    };
  }
  window.OopsStudio = { deriveStations, currentIndex };
  const $ = id => document.getElementById(id);
  if (!$('studio')) return;
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const mmss = ms => { const s = Math.floor(Math.max(0, ms || 0) / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const percentage = p => Number.isFinite(p) ? (p * 100).toFixed(p < .01 && p > 0 ? 2 : 1) + '%' : '未记录';
  const api = () => window.OopsReplay;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let snapshot = {}, mode = 'live', currentData = null, sentenceNodes = [], detailKey = '', chosenStation = 'judge';
  let previousCurrent = -1, lastScroll = 0, lastFired = 0, presentationTimer = 0, presentationUntil = 0;
  function stopPresentation() { clearTimeout(presentationTimer); presentationTimer = 0; presentationUntil = 0; $('studio-room').classList.remove('is-presenting'); }
  function presentResult() {
    if (motion.matches || mode !== 'live' || !snapshot.playing) return;
    clearTimeout(presentationTimer); presentationUntil = performance.now() + 700;
    const room = $('studio-room'); room.classList.remove('is-presenting'); void room.offsetWidth; room.classList.add('is-presenting');
    presentationTimer = setTimeout(() => { presentationUntil = 0; room.classList.remove('is-presenting'); }, 700);
  }
  const stations = [...document.querySelectorAll('[data-station]')];
  const roleNames = { listen: '聆听 Oops', judge: '判断 Oops', query: '查询 Oops', minutes: '纪要 Oops', delivery: '飞书 Oops' };
  const web = window.OopsWeb?.createWeb ? window.OopsWeb.createWeb($('studio-web')) : null;
  stations.forEach(button => {
    button.setAttribute('aria-label', '查看' + roleNames[button.dataset.station] + '的分工');
    button.addEventListener('click', () => { chosenStation = button.dataset.station; detailKey = ''; renderInspector(); openInspector(); });
  });
  function openInspector() { if (window.innerWidth <= 900) $('studio-inspector').classList.add('is-open'); }
  function select(index) { chosenStation = 'judge'; detailKey = ''; api()?.select(index); render(api()?.state() || snapshot); openInspector(); }
  function rebuildSentences(rows) {
    previousCurrent = -1;
    sentenceNodes = rows.map((row, index) => {
      const item = el('li'); const button = el('button'); button.type = 'button';
      button.append(el('span', 'sentence-time', mmss(row.start_ms ?? row.end_ms)), el('span', 'sentence-speaker', row.speaker || '未认人'), el('span', 'sentence-copy', row.text));
      button.title = row.text; button.addEventListener('click', () => select(index));
      button.setAttribute('aria-label', '查看第 ' + (index + 1) + ' 句的判断：' + row.text);
      item.append(button); return { item, button };
    });
    $('studio-sentences').replaceChildren(...sentenceNodes.map(row => row.item));
    $('studio-sentence-count').textContent = rows.length;
  }
  function render(state) {
    snapshot = { ...state, mode };
    const data = snapshot.data;
    const rows = data?.sentences?.length ? (snapshot.sentences || data.sentences) : [];
    if (data !== currentData) {
      currentData = data; detailKey = ''; chosenStation = 'judge'; stopPresentation(); lastFired = snapshot.fired || 0; $('studio-inspector').classList.remove('is-open');
      rebuildSentences(rows);
      $('studio-title').textContent = data?.source?.label || (rows.length ? '会议回放' : '请选择会议');
    }
    if (!snapshot.playing || mode !== 'live' || !rows.length || (snapshot.fired || 0) < lastFired) stopPresentation();
    if (snapshot.playing && (snapshot.fired || 0) > lastFired) {
      const fresh = (snapshot.timeline || []).slice(lastFired, snapshot.fired);
      if (fresh.some(event => event.f?.layer === 'jev' && event.real > 0 && performance.now() - event.real < 250)) presentResult();
    }
    lastFired = snapshot.fired || 0;
    const current = rows.length ? currentIndex(snapshot) : -1;
    const row = rows[current];
    $('studio-current-label').textContent = row ? '原话 ' + String(current + 1).padStart(2, '0') + ' / ' + rows.length : '当前原话';
    $('studio-current-time').textContent = row ? (row.speaker ? row.speaker + ' · ' : '') + mmss(row.start_ms ?? row.end_ms) : '—';
    $('studio-current-text').textContent = row?.text || '选一句原话，看 Jev 怎么判断。';
    $('studio-moment').textContent = !rows.length ? '等待会议来源' : snapshot.selected != null ? '正在看选中的原话' : snapshot.playing ? 'Jev 正按原话顺序回放已存判断' : '已暂停 · 点任意一句原话看判断';
    $('studio-stats').textContent = statsLine(rows, snapshot);
    $('studio-speed').textContent = '×' + (snapshot.speed || 1);
    $('studio-follow').hidden = snapshot.selected == null;
    const roles = deriveStations(snapshot);
    stations.forEach(button => {
      const key = button.dataset.station; const role = roles[key];
      button.classList.toggle('is-current', role.active);
      button.classList.toggle('is-reused', role.status === 'reused');
      button.classList.toggle('is-idle', role.status === 'idle' || role.status === 'empty');
      button.classList.toggle('is-selected', key === chosenStation);
      button.querySelector('[data-state]').textContent = role.note;
      button.setAttribute('aria-pressed', String(key === chosenStation));
    });
    const room = $('studio-room');
    room.classList.toggle('is-playing', !!snapshot.playing && mode === 'live' && !motion.matches);
    room.classList.toggle('is-paused', !snapshot.playing || mode !== 'live');
    if (web && mode === 'live') web.draw(window.OopsWeb.liveScene(mode === 'live' ? snapshot : { ...snapshot, playing: false }, current));
    sentenceNodes.forEach((node, index) => {
      node.button.classList.toggle('is-active', index === current);
      node.button.classList.toggle('is-selected', index === snapshot.selected);
      node.button.classList.toggle('is-future', (rows[index].start_ms ?? rows[index].end_ms) > snapshot.now);
      node.button.setAttribute('aria-current', index === current ? 'true' : 'false');
    });
    if (current !== previousCurrent && snapshot.selected == null && performance.now() - lastScroll > 3500 && sentenceNodes[current]) {
      const tray = $('studio-sentences'); const node = sentenceNodes[current].item;
      tray.scrollTop = Math.max(0, node.offsetTop - tray.offsetTop - tray.clientHeight / 2 + node.clientHeight / 2);
    }
    previousCurrent = current;
    renderInspector();
  }
  function statsLine(rows, state) {
    if (!rows.length) return '';
    const done = rows.filter(row => !Number.isFinite(row.doneAt) || row.doneAt <= (state.now || 0)).length;
    const count = layer => rows.reduce((n, row) => n + (row.forks || []).filter(f => f.layer === layer).length, 0);
    return '已回放 ' + Math.min(done, rows.length) + ' / ' + rows.length + ' 句 · Jev ' + count('jev') + ' 次 · 规则 ' + count('code') + ' 次 · 待你 ' + count('you');
  }
  function stepName(fork) {
    if (fork.layer === 'code') return '规则检查';
    if (fork.layer === 'you') return '待人核对';
    if (fork.layer !== 'jev') return '已有记录';
    if (fork.task_clause || /小句|子句/.test(fork.q || '')) return '小句判断';
    if (/矛盾|冲突/.test(fork.q || '') || /conflict/.test(fork.stage || '')) return '矛盾检查';
    return '整句判断';
  }
  function renderFork(fork, index) {
    const card = el('section', 'detail-step');
    const title = el('div', 'detail-step-title');
    const source = fork.provenance === 'reanalysis' ? '本次重新分析' : fork.provenance === 'recomputed' ? '当前规则重算' : fork.provenance === 'required' ? '确认要求' : fork.provenance === 'missing' ? '未记录' : fork.provenance === 'example' ? '示例' : '已有记录';
    title.append(el('span', null, String(index + 1).padStart(2, '0') + ' / ' + stepName(fork)), el('span', 'step-provenance', source));
    card.append(title, el('h3', null, fork.q || '判断问题未记录'), el('p', 'step-answer', fork.a || '答案未记录'));
    const probabilities = fork.probabilities;
    if (probabilities && Object.keys(probabilities).length) {
      const list = el('div', 'probability-list');
      for (const [key, p] of Object.entries(probabilities)) {
        const line = el('div', 'probability-row' + (fork.choice === key ? ' is-chosen' : ''));
        const label = el('div', 'probability-label');
        label.append(el('b', null, key + (fork.choice === key ? ' · 选中' : '')));
        if (fork.criteria?.[key]) label.title = fork.criteria[key];
        const track = el('div', 'probability-track'); const bar = el('i'); bar.style.width = (Number.isFinite(p) ? Math.min(100, Math.max(0, p * 100)) : 0) + '%'; track.append(bar); label.append(track);
        const value = el('span', 'probability-value', percentage(p)); value.title = Number.isFinite(p) ? '原始返回值：' + String(p) : '未记录';
        line.append(label, value); list.append(line);
      }
      card.append(list);
    } else card.append(el('p', 'detail-note', fork.layer === 'code' ? '确定性规则检查，不使用模型概率。' : fork.p != null ? '已存选中项概率 ' + percentage(fork.p) + '；完整选项未记录。' : '选项概率未记录。'));
    if (fork.request && api()?.renderRequestDetail) {
      const technical = api().renderRequestDetail(fork); technical.classList.add('trace-technical');
      technical.querySelector('summary').textContent = '技术详情 · 实际输入与完整精度'; card.append(technical);
    } else if (fork.engine) card.append(el('p', 'detail-note', fork.engine));
    return card;
  }
  function renderInspector() {
    const rows = snapshot.data?.sentences?.length ? (snapshot.sentences || snapshot.data.sentences) : [];
    const index = rows.length ? currentIndex(snapshot) : -1;
    const key = [currentData, chosenStation, index].map(value => typeof value === 'object' ? '' : value).join(':');
    if (key === detailKey) return;
    detailKey = key;
    const body = $('studio-inspector-content');
    const roles = deriveStations(snapshot);
    $('studio-inspector-kicker').textContent = chosenStation === 'judge' ? '判断详情 · 已保存的结果' : '这只 Oops 的分工';
    if (!rows.length) {
      body.replaceChildren(el('h2', null, '每一步，都有来处'), el('p', 'empty-detail', '选一句原话，或点工位查看分工与保存的结果。')); return;
    }
    if (chosenStation !== 'judge') {
      const image = el('img', 'station-detail-character'); image.src = './brand/mascot.png'; image.alt = '';
      body.replaceChildren(image, el('h2', null, roleNames[chosenStation]), el('p', 'station-status-card', roles[chosenStation].note));
      const copy = {
        listen: '把声音转成可定位的原话，再交给判断 Oops。本回放直接读取已保存的转写，没有重新转录音频。',
        query: '需要资料时负责查询并带回来源。此工位没有本次查询记录；本页只读回放，不会发起查询。已有后台支持某项能力，也不表示这场实际运行过。',
        minutes: snapshot.data?.post ? '这里沿用会议已有纪要及其原话依据。事项对回原话、规则复核与核对顺序来自确定性代码，本次没有重新调用模型生成纪要。' : '这场会议没有可用的已存纪要。本页不会自动生成或收费重试。',
        delivery: '纪要和收件人核对后才可以发送。这里没有本次发送记录；历史回执不代表本次发送，动画不会触发对外操作。',
      };
      body.append(el('p', 'station-explanation', copy[chosenStation]));
      if (chosenStation === 'minutes' && snapshot.data?.post) {
        const post = snapshot.data.post;
        if (post.overview) body.append(el('p', 'inspector-quote', post.overview));
        body.append(el('p', 'detail-note', '沿用纪要中的 ' + (post.items?.length || 0) + ' 个事项；仍需人工核对，不代表已经创建或完成任务。'));
        const button = el('button', 'text-button', '查看会后结果 →'); button.type = 'button'; button.addEventListener('click', () => { $('studio-inspector').classList.remove('is-open'); $('tab-after').click(); }); body.append(button);
      }
      return;
    }
    const row = rows[index];
    body.replaceChildren(el('h2', null, '判断 Oops'));
    const quote = el('blockquote', 'inspector-quote'); quote.append(el('small', null, '原话 ' + (index + 1) + ' · ' + (row.speaker || '说话人未核对') + ' · ' + mmss(row.start_ms ?? row.end_ms)), el('span', null, row.text)); body.append(quote);
    const forks = row.forks || [];
    const main = forks.find(f => f.layer === 'jev' && f.probabilities) || forks.find(f => f.layer === 'jev');
    const summary = el('div', 'judgement-summary');
    summary.append(el('b', null, row.tag ? (row.outcome || row.tag) : main?.a || row.outcome || '没有判断记录'), el('small', null, '最终归类'));
    body.append(summary);
    body.append(el('p', 'detail-note', '以下是已保存的输出；概率表示本次模型对选项的评分，不是实测准确率或内部思维过程。'));
    forks.forEach((fork, i) => body.append(renderFork(fork, i)));
    if (!forks.length) body.append(el('p', 'empty-detail', '没有保存中间判断与选项概率，保留为空，不重新调用模型补算。'));
  }
  function sync() { render(api()?.state() || snapshot); }
  document.addEventListener('funnel:data', ev => { currentData = null; render({ ...(api()?.state() || {}), data: ev.detail, sentences: api()?.state()?.sentences || ev.detail?.sentences || [] }); });
  document.addEventListener('funnel:selection', stopPresentation);
  ['funnel:tick', 'funnel:selection', 'funnel:play'].forEach(name => document.addEventListener(name, ev => render(ev.detail?.data !== undefined ? ev.detail : api()?.state() || snapshot)));
  document.addEventListener('funnel:mode', ev => { mode = ev.detail?.mode || 'live'; $('studio-inspector').classList.remove('is-open'); sync(); });
  $('studio-follow').addEventListener('click', () => { chosenStation = 'judge'; api()?.follow(); sync(); });
  $('inspector-close').addEventListener('click', () => { $('studio-inspector').classList.remove('is-open'); const index = currentIndex(snapshot); sentenceNodes[index]?.button.focus({ preventScroll: true }); });
  $('studio-sentences').addEventListener('wheel', () => { lastScroll = performance.now(); }, { passive: true });
  $('studio-sentences').addEventListener('touchmove', () => { lastScroll = performance.now(); }, { passive: true });
  document.querySelector('#studio-room .current-paper').addEventListener('click', () => { const rows = snapshot.sentences || []; if (rows.length) select(currentIndex(snapshot)); });
  new ResizeObserver(() => { if (mode === 'live') sync(); }).observe($('studio-room'));
  function openDialog(id) { api()?.play(false); window.OopsAfterReplay?.pause(); $(id).showModal(); }
  $('meeting-open').addEventListener('click', () => openDialog('meeting-dialog'));
  $('more-open').addEventListener('click', () => openDialog('more-dialog'));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  ['meeting-dialog', 'more-dialog'].forEach(id => $(id).addEventListener('click', event => { if (event.target === $(id)) { const bounds = $(id).getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $(id).close(); } }));
  $('restart').addEventListener('click', () => $('more-dialog').close());
  $('after-restart').addEventListener('click', () => $('more-dialog').close());
  $('file').addEventListener('change', () => $('more-dialog').close());
  motion.addEventListener?.('change', sync);
  sync();
})();
