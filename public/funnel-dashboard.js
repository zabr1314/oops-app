/* Dashboard blocks for the live replay: agent cards, desks, the Jev confidence curve and the rules panel.
   Everything is counted from saved replay steps already reached; nothing is estimated or invented. */
(() => {
  'use strict';
  const ORDER = ['code', 'jev', 'model', 'you'];
  const clip = (text, n) => { const s = String(text ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const prob = p => (Number.isFinite(p) ? p.toFixed(2) : null);

  function reached(snapshot) {
    const now = snapshot.now || 0;
    return (snapshot.timeline || []).filter(e => e.i >= 0 && e.f && e.t <= now);
  }

  /* One card per role. `active` only while that role's saved step was just reached during playback. */
  function deriveAgents(snapshot = {}) {
    const rows = snapshot.data?.sentences?.length ? (snapshot.sentences || snapshot.data.sentences) : [];
    const now = snapshot.now || 0, recent = Math.max(1, snapshot.speed || 1) * 1200;
    const events = rows.length ? reached(snapshot) : [];
    const by = layer => events.filter(e => e.f.layer === layer);
    const latest = list => list.length ? list[list.length - 1] : null;
    const fresh = e => !!e && !!snapshot.playing && now - e.t <= recent;
    const heard = rows.filter(r => (r.start_ms ?? r.end_ms) <= now);
    const lastHeard = heard[heard.length - 1];
    const post = rows.length ? snapshot.data.post : null;
    const card = (layer, extra) => {
      const list = by(layer), last = latest(list);
      return { count: list.length, last, active: fresh(last), ...extra(list, last) };
    };
    const kind = snapshot.data?.source?.kind;
    return {
      chief: { count: heard.length, value: rows.length ? heard.length + ' / ' + rows.length : '—', line: lastHeard ? (lastHeard.speaker || '未认人') + ' · ' + clip(lastHeard.text, 16) : '等待来源', bar: rows.length ? heard.length / rows.length : 0, active: !!snapshot.playing && rows.length > 0, status: !rows.length ? '等待来源' : snapshot.playing ? '回放中' : '已暂停' },
      listen: { count: heard.length, value: heard.length + ' 句', line: kind === 'example' ? '示例原话' : '已有转写 · 不重新转录', bar: rows.length ? heard.length / rows.length : 0, active: !!snapshot.playing && !!lastHeard && now - (lastHeard.start_ms ?? lastHeard.end_ms) < recent, status: rows.length ? '复用转写' : '等待来源' },
      code: card('code', (list, last) => ({ value: list.length + ' 次', line: last ? clip(last.f.q, 10) + ' → ' + clip(last.f.a, 8) : '尚未回放到', bar: events.length ? list.length / events.length : 0, status: list.length ? '本地规则 · 不调模型' : '等待' })),
      jev: card('jev', (list, last) => ({ value: last ? prob(last.f.p) ?? '无概率' : '—', line: last ? clip(last.f.a, 14) : '尚未回放到', bar: Number.isFinite(last?.f.p) ? last.f.p : 0, status: list.length + ' 次已存判断', asks: true })),
      model: card('model', (list, last) => ({ value: last ? prob(last.f.p) ?? list.length + ' 次' : '—', line: last ? clip(last.f.q, 9) + ' → ' + clip(last.f.a, 8) : '尚未回放到', bar: Number.isFinite(last?.f.p) ? last.f.p : events.length ? list.length / events.length : 0, status: list.length ? '已存生成记录' : '本场未运行' })),
      you: card('you', (list, last) => ({ value: list.length + ' 处', line: last ? clip(last.f.q || last.f.a, 14) : '暂无需要你决定的', bar: events.length ? list.length / Math.max(1, rows.length) : 0, status: '只问你需要决定的' })),
      minutes: { count: post?.items?.length || 0, value: post ? (post.items?.length || 0) + ' 项' : '—', line: post ? (post.generation?.evidence === 'reused_history' ? '复用原纪要' : '已有纪要') + ' · 待人工核对' : '没有可用纪要', bar: post ? 1 : 0, active: false, status: post ? '会后查看' : '未记录' },
      delivery: { count: Number.isInteger(post?.delivery_record?.sent_receipts) ? post.delivery_record.sent_receipts : 0, value: Number.isInteger(post?.delivery_record?.sent_receipts) ? post.delivery_record.sent_receipts + ' 份' : '—', line: post?.delivery_record ? '原会议历史回执摘要' : '发送过程未记录', bar: 0, active: false, status: '回放不发送' },
    };
  }

  /* The curve: every reached Jev probability over meeting time; bars: each finished sentence's last handler. */
  function trend(snapshot = {}) {
    const rows = snapshot.data?.sentences?.length ? (snapshot.sentences || snapshot.data.sentences) : [];
    if (!rows.length) return { points: [], bars: [], span: 1 };
    const now = snapshot.now || 0;
    const points = reached(snapshot).filter(e => e.f.layer === 'jev' && Number.isFinite(e.f.p)).map(e => ({ t: e.t, p: e.f.p }));
    const bars = rows.filter(r => Number.isFinite(r.doneAt) && r.doneAt <= now).map(r => ({ t: r.end_ms, route: r.route }));
    const last = rows[rows.length - 1];
    return { points, bars, span: Math.max(1, last.doneAt || last.end_ms || 1), latest: points.length ? points[points.length - 1].p : null };
  }

  /* Rules panel: the current sentence's reached rule checks, plus the order every sentence passes. */
  function rules(snapshot = {}, index = -1) {
    const rows = snapshot.data?.sentences?.length ? (snapshot.sentences || snapshot.data.sentences) : [];
    const row = rows[index];
    const thresholds = Object.entries(snapshot.data?.thresholds || {}).filter(([, v]) => Number.isFinite(v));
    if (!row) return { checks: [], thresholds, path: ORDER.map(layer => ({ layer, state: 'idle' })) };
    const reachedForks = window.OopsWeb?.reachedForks ? window.OopsWeb.reachedForks(snapshot, index).map(x => x.fork) : [];
    const checks = reachedForks.filter(f => f.layer === 'code').map(f => ({ q: f.q, a: f.a, settled: !!f.settled }));
    const seen = new Set(reachedForks.map(f => f.layer));
    const done = Number.isFinite(row.doneAt) && (snapshot.selected === index || (snapshot.now || 0) >= row.doneAt);
    return { checks, thresholds, path: ORDER.map(layer => ({ layer, state: done && row.route === layer ? 'end' : seen.has(layer) ? 'passed' : 'idle' })) };
  }

  window.OopsDashboard = Object.freeze({ deriveAgents, trend, rules, ORDER });
})();
