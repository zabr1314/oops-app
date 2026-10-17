// Whole-meeting reading view. Uses saved sentence tags only; never reclassifies,
// writes answers, fetches sources, or starts model work.
(() => {
  'use strict';
  const root = document.getElementById('mode-content');
  if (!root) return;

  const PAGE_SIZE = 40;
  const BUCKETS = [
    { key: 'decision', name: '决定', hint: '已存分类 · 仍需核对', help: '已保存为决定的原话；不代表本人已确认。结合上下文核对，是否真的达成了一致。' },
    { key: 'commitment', name: '待办候选', hint: '行动与约定 · 待核对', help: '已保存为待办的原话；内容、负责人和时间仍需核对，不代表已创建任务或已经完成。' },
    { key: 'idea', name: '观点／判断', hint: '想法、建议与方案', help: '观点、判断、建议或方案，尚未成为决定。这里沿用已保存的观点类标签，不重新判断原话。' },
    { key: 'fact', name: '事实陈述', hint: '原话陈述 · 未核实真伪', help: '原话中的情况、经历或状态陈述；这个类型不表示已经独立核实真伪。' },
    { key: 'question', name: '问题／求解', hint: '需要回答或继续讨论', help: '原话明确提出的问题，结合上下文理解；提问本身不代表已有答案或已经解决。' },
    { key: 'constraint', name: '条件／限制', hint: '条件、范围与边界', help: '已保存为条件或限制的原话，可以结合前后表达核对适用的范围。' },
    { key: 'chitchat', name: '闲聊／衔接', hint: '回应与对话衔接', help: '闲聊、回应或对话衔接。原话完整保留，这个标签不等于内容没有价值。' },
    { key: 'uncertain', name: '待厘清', hint: '还需要上下文', help: '已保存为不确定的表达，需要结合上下文厘清；这里不会替原记录补作判断。' },
    { key: 'missing', name: '未记录分类', hint: '分类缺失或无法识别', help: '没有可识别的已保存分类，不等于没有内容。原话照常保留，页面不会补算历史。' },
  ];
  const BY_KEY = new Map(BUCKETS.map(bucket => [bucket.key, bucket]));
  const ALL_HELP = '按已保存分类浏览全场原话；点选类别后，仍按原话顺序显示。决定与待办候选都需要核对。';
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (cls, text) => {
    const node = el('button', cls, text);
    node.type = 'button';
    return node;
  };
  const string = value => typeof value === 'string' ? value : '';
  const id = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const mmss = value => {
    if (!Number.isFinite(value) || value < 0) return '时间未记录';
    const seconds = Math.floor(value / 1000);
    return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  };
  const bucketKey = sentence => {
    const tag = sentence.content_review?.tag || sentence.tag;
    return BY_KEY.has(tag) ? tag : 'missing';
  };
  const hasTrace = sentence => Array.isArray(sentence.forks) && sentence.forks.length > 0;
  const sourceStatus = sentence => hasTrace(sentence) ? '有原处理记录' : BY_KEY.has(sentence.tag) ? '原存最终标签' : '原分类未记录';

  let activeData = null;
  let sourceKey = '';
  let rows = [];
  let filtered = [];
  let selected = 'all';
  let query = '';
  let page = 0;
  let ui = null;
  let openContext = null;

  function reliableSourceKey(data) {
    const source = data?.source;
    const kind = string(source?.kind);
    const stableId = kind === 'reanalysis' ? id(source.run_id) : id(source?.session_id);
    return kind && kind !== 'empty' && stableId ? kind + ':' + stableId : '';
  }

  function sourceLabel(source) {
    if (source?.kind === 'example') return '示例数据';
    if (source?.kind === 'reanalysis') return '重新分析结果 · 只读';
    if (source?.kind === 'history') {
      if (source.live?.active === true) return '后端历史 · 来源仍在更新';
      if (source.live?.active === false) return '后端历史 · 记录已结束';
      return '后端历史 · 只读';
    }
    return '本机回放 · 只读';
  }

  function metric(value, label) {
    const node = el('div', 'content-metric');
    node.append(el('strong', '', value), el('span', '', label));
    return node;
  }

  function build() {
    const data = activeData;
    const counts = Object.fromEntries(BUCKETS.map(bucket => [bucket.key, 0]));
    rows.forEach(row => { counts[bucketKey(row.sentence)] += 1; });

    const header = el('header', 'content-header');
    const introduction = el('div', 'content-introduction');
    const eyebrow = el('div', 'content-eyebrow');
    eyebrow.append(el('span', 'content-source', sourceLabel(data?.source)), el('span', '', data?.content_review ? '本次助手复核 · 全场内容' : '全场内容'));
    introduction.append(eyebrow, el('h2', 'content-title', string(data?.source?.label) || '会议内容'));
    introduction.append(el('p', 'content-note', data?.content_review
      ? '本次结合前后文重新判读，每句保留理由和原话依据；原分类与处理记录另行保留。'
      : '分类取自已保存结果，可回看原话核对；未记录不等于无内容。'));
    const metrics = el('div', 'content-metrics');
    metrics.append(metric(rows.length, '句原话'), metric(rows.length - counts.missing, '句有分类'), metric(rows.filter(row => hasTrace(row.sentence)).length, '句有处理记录'));
    header.append(introduction, metrics);

    const layout = el('div', 'content-layout');
    const main = el('section', 'content-main');
    main.setAttribute('aria-label', '全场原话');
    const toolbar = el('div', 'content-toolbar');
    const all = button('content-all', '全部原话');
    all.addEventListener('click', () => selectBucket('all'));
    const searchLabel = el('label', 'content-search');
    searchLabel.append(el('span', 'content-sr-only', '搜索原话或说话人'));
    const search = el('input', 'content-search-input');
    search.type = 'search';
    search.placeholder = '搜索原话或说话人';
    search.value = query;
    search.autocomplete = 'off';
    search.maxLength = 500;
    search.addEventListener('input', () => { query = search.value; page = 0; applyFilter(); });
    searchLabel.append(search);
    const clear = button('content-clear', '清空搜索');
    clear.addEventListener('click', () => { query = ''; search.value = ''; page = 0; applyFilter(); search.focus(); });
    toolbar.append(all, searchLabel, clear);
    const selection = el('div', 'content-selection');
    const selectionTitle = el('strong', 'content-selection-title');
    const help = el('p', 'content-selection-help');
    selection.append(selectionTitle, help);
    const resultsHead = el('div', 'content-results-head');
    const resultCount = el('span', 'content-result-count');
    resultCount.setAttribute('role', 'status');
    resultCount.setAttribute('aria-live', 'polite');
    resultsHead.append(resultCount, el('span', 'content-order', '原话顺序 · 全文保留'));
    const list = el('ol', 'content-list');
    list.id = 'content-sentence-list';
    const empty = el('div', 'content-empty');
    empty.hidden = true;
    const pagination = el('nav', 'content-pagination');
    pagination.setAttribute('aria-label', '原话分页');
    const previous = button('content-page-button', '← 上一页');
    const pageLabel = el('span', 'content-page-label');
    const next = button('content-page-button', '下一页 →');
    const changePage = change => {
      page += change;
      renderRows();
      main.scrollIntoView({ block: 'start', behavior: 'auto' });
    };
    previous.addEventListener('click', () => { if (page > 0) changePage(-1); });
    next.addEventListener('click', () => { if ((page + 1) * PAGE_SIZE < filtered.length) changePage(1); });
    pagination.append(previous, pageLabel, next);
    main.append(toolbar, selection, resultsHead, list, empty, pagination);

    const aside = el('aside', 'content-categories');
    aside.setAttribute('aria-label', '按会议内容分类筛选');
    const asideHead = el('div', 'content-categories-head');
    asideHead.append(el('h3', '', '本场内容分布'), el('span', '', '全场 · ' + rows.length + ' 句'));
    const cards = new Map();
    aside.append(asideHead);
    BUCKETS.forEach(bucket => {
      if (['fact', 'question'].includes(bucket.key) && !counts[bucket.key] || data?.content_review && bucket.key === 'missing' && !counts.missing) return;
      const card = button('content-category content-category-' + bucket.key, '');
      card.setAttribute('aria-controls', list.id);
      card.setAttribute('aria-label', bucket.name + '，' + counts[bucket.key] + ' 句，筛选全场原话');
      const top = el('span', 'content-category-top');
      top.append(el('span', 'content-category-name', bucket.name), el('strong', 'content-category-count', counts[bucket.key]));
      const track = el('span', 'content-category-track');
      track.setAttribute('aria-hidden', 'true');
      const fill = el('span', 'content-category-fill');
      fill.style.width = (rows.length ? counts[bucket.key] / rows.length * 100 : 0) + '%';
      track.append(fill);
      card.append(top, el('span', 'content-category-hint', bucket.hint), track);
      card.addEventListener('click', () => selectBucket(selected === bucket.key ? 'all' : bucket.key));
      cards.set(bucket.key, card);
      aside.append(card);
    });
    aside.append(el('p', 'content-categories-note', data?.content_review
      ? '每段原话按主要内容计数；同段的其他内容可在理由下查看。助手复核不代表本人确认。'
      : '每句按一个已保存标签计数。分类只帮助回看，不代替会议结论或人工确认。'));
    layout.append(main, aside);
    root.append(header, layout);
    ui = { all, search, clear, selectionTitle, help, resultCount, list, empty, pagination, previous, next, pageLabel, cards };
    applyFilter();
  }

  function selectBucket(key) {
    selected = key;
    page = 0;
    applyFilter();
  }

  function applyFilter() {
    if (!ui) return;
    const needle = query.trim().toLocaleLowerCase();
    filtered = rows.filter(row => (selected === 'all' || bucketKey(row.sentence) === selected)
      && (!needle || (row.sentence.text + '\n' + string(row.sentence.speaker)).toLocaleLowerCase().includes(needle)));
    ui.all.setAttribute('aria-pressed', String(selected === 'all'));
    ui.cards.forEach((card, key) => card.setAttribute('aria-pressed', String(selected === key)));
    ui.clear.hidden = !query;
    const bucket = BY_KEY.get(selected);
    ui.selectionTitle.textContent = bucket?.name || '全部原话';
    ui.help.textContent = activeData?.content_review && !bucket ? '按本次助手复核分类浏览全场原话，逐条查看理由与原话依据。' : bucket?.help || ALL_HELP;
    renderRows();
  }

  function contextRow(row, label) {
    const item = el('li', 'content-context-row');
    const sentence = row.sentence;
    item.append(el('div', 'content-context-meta', label + ' · ' + mmss(sentence.start_ms) + ' · ' + (string(sentence.speaker) || '说话人未记录')),
      el('p', 'content-context-text', sentence.text));
    return item;
  }

  function sentenceRow(row, snapshot) {
    const sentence = row.sentence;
    const key = bucketKey(sentence);
    const item = el('li', 'content-sentence content-sentence-' + key);
    item.value = row.index + 1;
    const meta = el('div', 'content-sentence-meta');
    meta.append(el('span', 'content-index', '#' + (row.index + 1)), el('span', 'content-time', mmss(sentence.start_ms)),
      el('span', 'content-speaker', string(sentence.speaker) || '说话人未记录'), el('span', 'content-tag', BY_KEY.get(key).name),
      el('span', 'content-record-status', sourceStatus(sentence)));
    const text = el('p', 'content-sentence-text', sentence.text);
    const actions = el('div', 'content-sentence-actions');
    const context = el('details', 'content-context');
    context.append(el('summary', '', '看上下文'));
    const contextBody = el('div', 'content-context-body');
    context.append(contextBody);
    context.addEventListener('toggle', () => {
      if (activeData !== snapshot || !root.contains(context)) return;
      contextBody.replaceChildren();
      if (!context.open) { if (openContext === context) openContext = null; return; }
      if (openContext && openContext !== context) openContext.open = false;
      openContext = context;
      const adjacent = el('ul', 'content-context-list');
      if (row.index > 0) adjacent.append(contextRow(rows[row.index - 1], '前一句'));
      else contextBody.append(el('p', 'content-context-boundary', '这是本场第一句原话。'));
      if (row.index + 1 < rows.length) adjacent.append(contextRow(rows[row.index + 1], '后一句'));
      if (adjacent.childElementCount) contextBody.append(adjacent);
      if (row.index + 1 === rows.length) contextBody.append(el('p', 'content-context-boundary', '这是本场最后一句原话。'));
    });
    const inspect = button('content-inspect', '看处理过程 ↗');
    const sentenceId = id(sentence.id);
    inspect.disabled = !sentenceId;
    inspect.addEventListener('click', () => {
      if (activeData !== snapshot || !root.contains(inspect) || !sentenceId) return;
      document.dispatchEvent(new CustomEvent('funnel:inspect-sentence', { detail: { id: sentenceId, data: snapshot } }));
    });
    actions.append(context, inspect);
    item.append(meta, text);
    if (sentence.content_review) {
      const review = sentence.content_review;
      const reasoning = el('div', 'content-review-reason');
      reasoning.append(el('strong', '', '本次判断：'), el('span', '', review.reason));
      reasoning.append(el('div', 'content-review-previous', '原分类：' + (BY_KEY.get(sentence.tag)?.name || '未记录分类') + ' · 本次复核：' + BY_KEY.get(key).name));
      const evidence = el('details', 'content-review-evidence');
      evidence.append(el('summary', '', '看判断依据'), el('blockquote', '', review.evidence_quote));
      for (const extra of review.secondary || []) {
        if (BY_KEY.has(extra.tag) && typeof extra.quote === 'string' && sentence.text.includes(extra.quote)) {
          evidence.append(el('p', '', '同段还包含 ' + BY_KEY.get(extra.tag).name + '：「' + extra.quote + '」'));
        }
      }
      reasoning.append(evidence); item.append(reasoning);
    }
    if (key === 'missing' && string(sentence.tag)) item.append(el('p', 'content-unknown-tag', '原标签：' + sentence.tag + '（当前页面未识别）'));
    item.append(actions);
    return item;
  }

  function renderRows() {
    if (!ui) return;
    const pageCount = Math.ceil(filtered.length / PAGE_SIZE);
    page = Math.max(0, Math.min(page, Math.max(0, pageCount - 1)));
    const start = page * PAGE_SIZE;
    const visible = filtered.slice(start, start + PAGE_SIZE);
    openContext = null;
    ui.list.replaceChildren(...visible.map(row => sentenceRow(row, activeData)));
    ui.resultCount.textContent = filtered.length + ' 句' + (query.trim() ? '匹配原话' : selected === 'all' ? '原话' : '属于此类') + ' / 全场 ' + rows.length + ' 句';
    ui.empty.hidden = filtered.length > 0;
    ui.empty.replaceChildren();
    if (!filtered.length) {
      ui.empty.append(el('strong', '', query.trim() ? '没有匹配的原话' : '本场没有记录为此类的原话'),
        el('p', '', query.trim() ? '换个关键词，或清空搜索后继续查看。' : '可以切换其他类别，或查看全部原话。'));
    }
    ui.pagination.hidden = pageCount <= 1;
    ui.previous.disabled = page === 0;
    ui.next.disabled = page + 1 >= pageCount;
    ui.pageLabel.textContent = (start + 1) + '–' + (start + visible.length) + ' / ' + filtered.length + ' 句 · ' + (page + 1) + '/' + pageCount + ' 页';
  }

  function render(data) {
    const nextKey = reliableSourceKey(data);
    const nextRows = Array.isArray(data?.sentences) ? data.sentences : [];
    const sameSource = Boolean(nextKey && nextKey === sourceKey && rows.length && nextRows.length);
    const searchFocus = sameSource && ui?.search === document.activeElement
      ? { start: ui.search.selectionStart, end: ui.search.selectionEnd } : null;
    // Remove old private bodies and event closures before installing a new source.
    root.replaceChildren();
    ui = null;
    openContext = null;
    filtered = [];
    if (!sameSource) { selected = 'all'; query = ''; page = 0; }
    activeData = data && typeof data === 'object' ? data : null;
    sourceKey = nextRows.length ? nextKey : '';
    rows = nextRows.map((sentence, index) => ({ sentence, index }));
    if (!rows.length) {
      activeData = null;
      const empty = el('div', 'content-no-data');
      empty.append(el('span', 'content-eyebrow', '会议内容'), el('h2', '', '载入一场会议，看看这场谈了什么'),
        el('p', '', '从上方选择后端历史或打开回放文件，即可按已保存分类查看原话。'));
      root.append(empty);
      return;
    }
    build();
    if (searchFocus) {
      ui.search.focus({ preventScroll: true });
      if (searchFocus.start != null && searchFocus.end != null) ui.search.setSelectionRange(searchFocus.start, searchFocus.end);
    }
  }

  document.addEventListener('funnel:data', event => render(event.detail));
  render(window.OopsReplay?.state?.()?.data || null);
})();
