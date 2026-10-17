// Saved content labels for the original sentence-by-sentence playback.
// Completion is driven exclusively by replay sentence.doneAt, never wall time.
(() => {
  'use strict';
  const root = document.getElementById('content-routes');
  if (!root) return;
  const allOrder = ['decision', 'commitment', 'idea', 'fact', 'question', 'constraint', 'chitchat', 'uncertain', 'missing'];
  let order = allOrder.filter(key => !['fact', 'question'].includes(key));
  const layers = Object.freeze({
    decision: Object.freeze({ name: '决定', color: '#51d5a4' }),
    commitment: Object.freeze({ name: '待办候选', color: '#e8c86b' }),
    idea: Object.freeze({ name: '观点／判断', color: '#b99bff' }),
    fact: Object.freeze({ name: '事实陈述', color: '#64c9cc' }),
    question: Object.freeze({ name: '问题／求解', color: '#f28bb5' }),
    constraint: Object.freeze({ name: '条件／限制', color: '#ed9c7f' }),
    chitchat: Object.freeze({ name: '闲聊／衔接', color: '#9aa8b7' }),
    uncertain: Object.freeze({ name: '待厘清', color: '#79bfe4' }),
    missing: Object.freeze({ name: '未记录分类', color: '#858b98' }),
  });
  const notes = {
    decision: '已存分类 · 仍需核对', commitment: '候选 · 不等同已建任务', idea: '观点、建议与方案',
    fact: '原话陈述 · 未核实真伪', question: '需要回答或继续讨论',
    constraint: '条件、范围与边界', chitchat: '对话衔接 · 原话保留', uncertain: '结合上下文再厘清', missing: '未记录不等于无内容',
  };
  const layer = sentence => {
    const tag = sentence?.content_review?.tag || sentence?.tag;
    return Object.prototype.hasOwnProperty.call(layers, tag) ? tag : 'missing';
  };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  let lastData = undefined;
  let cardNodes = [];
  let values = [];
  let totals = [];
  let previousCounts = [];

  function rebuild(data) {
    // Clear old-source bodies before creating the next set of lane references.
    root.replaceChildren();
    cardNodes = [];
    values = [];
    lastData = data;
    const sentences = Array.isArray(data?.sentences) ? data.sentences : [];
    const present = new Set(sentences.map(layer));
    order = allOrder.filter(key => ['fact', 'question'].includes(key) ? present.has(key) : key === 'missing' ? !data?.content_review || present.has(key) : true);
    root.style.setProperty('--content-route-count', String(order.length));
    totals = order.map(() => 0);
    previousCounts = order.map(() => -1);
    sentences.forEach(sentence => { totals[order.indexOf(layer(sentence))] += 1; });
    const fragment = document.createDocumentFragment();
    order.forEach((key, index) => {
      const card = el('article', 'content-playback-card content-playback-' + key);
      card.style.setProperty('--content-lane', layers[key].color);
      card.dataset.contentLayer = key;
      const header = el('header', 'content-playback-heading');
      header.append(el('span', '', layers[key].name), el('span', 'content-playback-phase', '已回放'));
      const body = el('div', 'content-playback-value');
      const value = el('strong', '', '0');
      body.append(value, el('span', 'content-playback-total', '/ 全场 ' + totals[index]));
      body.append(el('span', 'content-playback-note', notes[key]));
      card.append(header, body);
      fragment.append(card);
      cardNodes.push(card);
      values.push(value);
    });
    root.append(fragment);
  }

  function update(state) {
    const data = state?.data || null;
    if (data !== lastData) rebuild(data);
    const counts = order.map(() => 0);
    const now = state?.now;
    if (Number.isFinite(now) && Array.isArray(data?.sentences) && Array.isArray(state?.sentences)) {
      state.sentences.forEach((sentence, index) => {
        const source = data.sentences[index];
        if (!source || source.id !== sentence.id || source.text !== sentence.text || source.tag !== sentence.tag) return;
        if (Number.isFinite(sentence.doneAt) && now >= sentence.doneAt) counts[order.indexOf(layer(sentence))] += 1;
      });
    }
    counts.forEach((count, index) => {
      if (count === previousCounts[index]) return;
      previousCounts[index] = count;
      values[index].textContent = String(count);
      cardNodes[index].setAttribute('aria-label', layers[order[index]].name + '，已回放 ' + count + ' 句，全场 ' + totals[index] + ' 句。' + notes[order[index]]);
    });
  }

  window.OopsContentPlayback = Object.freeze({ cards: () => cardNodes.slice(), get order() { return order; }, layers, layer, update });
  document.addEventListener('funnel:data', event => {
    const state = window.OopsReplay?.state?.();
    update(state?.data === event.detail ? state : { data: event.detail, sentences: [], now: 0 });
  });
  update(window.OopsReplay?.state?.());
  // Register once; update() emits no events and cannot recurse into the renderer.
  document.dispatchEvent(new CustomEvent('funnel:content-routing-ready'));
})();
