(() => {
  const modes = ['app', 'pages', 'board'];
  const labels = { app: '体验 App', pages: '页面总览', board: '交互画板' };
  const descriptions = {
    app: '像使用 App 一样，直接点击体验完整流程。',
    pages: '浏览真实页面截图，点击任意页面查看或体验。',
    board: '按功能检查全部页面、入口与交互状态。',
  };
  const base = new URL('./', location.href);
  const frames = new Map();
  const buttons = [...document.querySelectorAll('[data-mode]')];
  const returnButton = document.getElementById('return-app');
  let activeMode = 'app';
  let appKind = 'app';
  let toastTimer;
  const trialScene = 'guided-trial';
  const trialSteps = [
    { title: '接手一段记录', time: '0–1 分钟', route: '#session-detail/session-001/现场', actions: ['这场示例会议从暂停状态开始。点击底部「继续」，观察记录状态变化。', '点击「标记重点」，在弹层中「保存重点」，再点「暂停」。无需讲话或开启麦克风。'], result: '记录状态和重点标记有反馈；暂停不等于结束或删除。', question: '此刻 Oops 在做什么？你知道这段内容会保留在哪里吗？', links: [['打开会议现场', '#session-detail/session-001/现场'], ['看看智能聆听', '#session-listening']] },
    { title: '核对谁说了什么', time: '1–2 分钟', route: '#session-identity/session-001/tr3', actions: ['读一读 00:16:28 的待确认原话，查看身份确认方式。', '可以保留匿名；也可以选一位示例人物，仅确认这一段的显示姓名。'], result: '姓名需要独立确认；给片段命名不等于已建立声纹识别。', question: '你会依据什么确认这个人？不确定时，是否容易保留未知身份？', links: [['打开身份核对', '#session-identity/session-001/tr3'], ['回到这段原文', '#session-transcript/session-001/tr3']] },
    { title: '判断要不要介入', time: '2–4 分钟', route: '#session-notices/session-001', actions: ['点「重新检查」，找到预算冲突提醒，再「查看证据」，对照原话和此前的预算。选「稍后处理」或「忽略此条」。', '打开「决定建议」，对照一条原话，再选择采纳、不采纳或保留待核对。'], result: '提醒有可追溯的原因；只有主动采纳的决定才进入本次确认结论。', question: '哪条提醒会改变你的行动？哪些更像打扰？', links: [['查看会议提醒', '#session-notices/session-001'], ['查看决定建议', '#session-decisions/session-001'], ['看看对话理解', '#session-understanding/session-001']] },
    { title: '把承诺变成任务', time: '4–6 分钟', route: '#session-task-suggestions/session-001', actions: ['找到「首版走查清单」这项建议，点「核对并整理」。检查负责人、截止时间和原话。', '确认建立待承接任务，再点「查看任务」。检查承接入口，若愿意就确认承接。'], result: '会议建议与已承接任务分开；建立任务不会自动开启助手或对外发送。', question: '你能说清楚谁要做什么、何时完成，以及任务现在处于什么状态吗？', links: [['打开任务建议', '#session-task-suggestions/session-001'], ['查看本次行动', '#session-detail/session-001/行动']] },
    { title: '决定什么值得记住', time: '6–8 分钟', route: '#memory-candidate/trial-memory', actions: ['核对「会中资料的呈现偏好」与 00:16:28 原话，查看保存范围。', '选择确认记住、改写或稍后处理，再看看项目背景中已有的预算与规则。'], result: '候选记忆需你确认，私人保存和项目共享分别选择。', question: '这条信息值得长期保存吗？你预期它会在什么时候被用到？', links: [['核对这条记忆', '#memory-candidate/trial-memory'], ['查看项目背景', '#memory-project/project-1']] },
    { title: '找回信息，留下建议', time: '8–10 分钟', route: '#session-personal/session-001', actions: ['看看「我的复盘」是否聚焦你的角色与任务，和共同结论有什么区别。', '打开「问 Oops」，点示例问题「项目预算是多少？」；点答案出处核对资料。', '最后通过「填写建议」留一条：在哪一页、想完成什么、哪里卡住、希望怎么改。可以附截图和反馈人。'], result: '回答能回到依据；把最影响理解或使用的一处问题反馈给我们。', question: '哪一步最有用？如果只能改一个地方，你会改哪里？', links: [['查看我的复盘', '#session-personal/session-001'], ['问 Oops', '#assistant']] },
  ];
  let tourEnabled = false;
  let tourExpanded = true;
  let tourStep = 0;
  let tourFinished = false;
  const guide = document.getElementById('trial-guide');
  const tourToggle = document.getElementById('tour-toggle');
  const feedbackUrl = document.querySelector('.feedback').href;

  function appUrl(route = '#home', scene = null) {
    const url = new URL(base);
    if (scene !== null) url.searchParams.set('board-preview', scene);
    url.hash = route || '#home';
    return url;
  }

  function currentState() {
    const params = new URL(location.href).searchParams;
    const mode = modes.includes(params.get('view')) ? params.get('view') : 'app';
    const scene = params.has('scene') ? params.get('scene') : null;
    const tour = params.get('tour') === '1';
    const step = Number(params.get('step') || 1);
    return { mode, scene, route: location.hash || (tour ? trialSteps[0].route : '#home'), tour,
      step: Number.isInteger(step) && step >= 1 && step <= trialSteps.length ? step - 1 : 0 };
  }

  function writeUrl(method = 'replace') {
    const url = new URL('showcase.html', base);
    url.searchParams.set('view', activeMode);
    if (tourEnabled) { url.searchParams.set('tour', '1'); url.searchParams.set('step', String(tourStep + 1)); }
    if (activeMode === 'app') {
      const app = frames.get(appKind);
      if (appKind === 'preview') url.searchParams.set('scene', app.url.searchParams.get('board-preview') || 'default');
      if (appKind === 'tour') url.searchParams.set('scene', trialScene);
      url.hash = app?.url.hash || '#home';
    }
    if (url.href !== location.href) history[method === 'push' ? 'pushState' : 'replaceState'](null, '', url);
  }

  function updateDescription() {
    const preview = activeMode === 'app' && appKind !== 'app';
    document.getElementById('mode-description').textContent = preview
      ? appKind === 'tour' ? '10 分钟试用 · 同一场示例会议，按自己的节奏体验。' : '正在体验画板中的示例页面。'
      : descriptions[activeMode];
    returnButton.hidden = !preview;
    renderTour();
  }

  function ensureFrame(key, url) {
    if (frames.has(key)) return frames.get(key);
    const example = key === 'preview' || key === 'tour';
    const panel = document.getElementById('panel-' + (example ? 'app' : key));
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.setAttribute('role', 'status');
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const message = document.createElement('p');
    message.textContent = '正在打开' + (example ? '示例页面' : labels[key]) + '…';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新加载';
    retry.hidden = true;
    loading.append(spinner, message, retry);
    const frame = document.createElement('iframe');
    frame.title = key === 'tour' ? 'Oops 10 分钟试用 App' : key === 'preview' ? 'Oops 示例 App' : 'Oops ' + labels[key];
    frame.dataset.frame = key;
    const entry = { frame, loading, message, retry, url: new URL(url), timer: null, loaded: false };
    frames.set(key, entry);
    function startLoading() {
      entry.loaded = false;
      loading.hidden = false;
      retry.hidden = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        message.textContent = '加载时间较长，可以重新试一下。';
        retry.hidden = false;
      }, 15000);
    }
    entry.startLoading = startLoading;
    retry.addEventListener('click', () => {
      startLoading();
      frame.contentWindow.location.replace(entry.url.href);
    });
    frame.addEventListener('load', () => {
      if (frame.contentWindow.location.href === 'about:blank') return;
      entry.loaded = true;
      clearTimeout(entry.timer);
      loading.hidden = true;
      if (key === 'pages' || key === 'board') connectBoard(frame);
    });
    startLoading();
    frame.src = entry.url.href;
    panel.append(frame, loading);
    return entry;
  }

  function setAppTarget(url) {
    const kind = url.searchParams.get('board-preview') === trialScene ? 'tour' : url.searchParams.has('board-preview') ? 'preview' : 'app';
    const entry = ensureFrame(kind, url);
    appKind = kind;
    if (entry.url.href !== url.href) {
      const sameScene = entry.url.search === url.search;
      entry.url = new URL(url);
      if (!sameScene) entry.startLoading();
      // Replacement avoids adding hidden iframe entries to the browser's history.
      entry.frame.contentWindow.location.replace(url.href);
    }
  }

  function show(mode, { method = 'push', target = null } = {}) {
    const previousFrame = activeMode === 'app' ? frames.get(appKind) : frames.get(activeMode);
    previousFrame?.frame.contentDocument?.activeElement?.blur?.();
    if (mode === 'app') {
      if (target) setAppTarget(target);
      else ensureFrame(appKind, appUrl());
    } else {
      ensureFrame(mode, new URL(mode === 'pages' ? 'board.html' : 'interactive-board.html', base));
    }
    activeMode = mode;
    for (const button of buttons) {
      const selected = button.dataset.mode === mode;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      document.getElementById('panel-' + button.dataset.mode).hidden = !selected;
    }
    for (const kind of ['app', 'preview', 'tour']) {
      const entry = frames.get(kind);
      if (entry) {
        entry.frame.hidden = appKind !== kind;
        entry.loading.hidden = appKind !== kind || entry.loaded;
      }
    }
    updateDescription();
    if (method !== 'none') writeUrl(method);
    document.title = 'Oops · ' + labels[mode] + ' · 产品体验中心';
  }

  function connectBoard(frame) {
    const doc = frame.contentDocument;
    if (!doc || doc.documentElement.dataset.showcaseConnected) return;
    doc.documentElement.dataset.showcaseConnected = 'true';
    const external = doc.getElementById('external');
    if (external) external.textContent = '在 App 中体验 →';
    const appLink = doc.getElementById('app-link');
    if (appLink) appLink.textContent = '切换到 App →';
    doc.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link) return;
      const url = new URL(link.href, base);
      if (url.origin !== base.origin) return;
      let mode;
      if (url.pathname === new URL('board.html', base).pathname) mode = 'pages';
      if (url.pathname === new URL('interactive-board.html', base).pathname) mode = 'board';
      if (url.pathname === base.pathname || url.pathname === new URL('index.html', base).pathname) mode = 'app';
      if (!mode) return;
      event.preventDefault();
      // Overview links resume the visitor's App; individual page links use isolated examples.
      show(mode, { target: mode === 'app' && link.id !== 'app-link' ? url : null });
    }, true);
  }

  buttons.forEach(button => {
    button.addEventListener('click', () => show(button.dataset.mode));
    button.addEventListener('keydown', event => {
      const index = buttons.indexOf(button);
      const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
        : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      buttons[next].focus();
      show(buttons[next].dataset.mode);
    });
  });

  function restoreLocation() {
    const state = currentState();
    tourEnabled = state.tour;
    tourStep = state.step;
    show(state.mode, { method: 'none', target: state.mode === 'app' ? appUrl(state.route, state.scene ?? (state.tour ? trialScene : null)) : null });
  }

  function openTrialRoute(route, collapseOnSmallScreen = true) {
    tourEnabled = true;
    if (collapseOnSmallScreen && matchMedia('(max-width:700px)').matches) tourExpanded = false;
    show('app', { target: appUrl(route, trialScene) });
  }

  function selectTrialStep(index) {
    tourStep = Math.max(0, Math.min(trialSteps.length - 1, index));
    tourFinished = false;
    tourExpanded = true;
    openTrialRoute(trialSteps[tourStep].route, false);
  }

  function renderTour() {
    const visible = tourEnabled && tourExpanded && activeMode === 'app' && appKind === 'tour';
    guide.hidden = !visible;
    document.querySelector('.showcase-stage').inert = visible && matchMedia('(max-width:700px)').matches;
    tourToggle.setAttribute('aria-expanded', String(visible));
    tourToggle.textContent = tourEnabled ? `试用引导 ${tourStep + 1}/6` : '10 分钟试用';
    document.getElementById('showcase-content').classList.toggle('with-trial', visible);
    const nav = document.getElementById('trial-steps');
    // Keep the selected step button mounted so keyboard focus survives route messages.
    if (!nav.childElementCount) trialSteps.forEach((step, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${index + 1} · ${step.title}`;
      button.addEventListener('click', () => selectTrialStep(index));
      nav.append(button);
    });
    [...nav.children].forEach((button, index) => {
      if (index === tourStep) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
    const detail = document.getElementById('trial-detail');
    const signature = `${tourStep}:${tourFinished}`;
    if (detail.dataset.step !== signature) {
      detail.dataset.step = signature;
      detail.replaceChildren();
      guide.scrollTop = 0;
      function add(tag, content, className) {
        const element = document.createElement(tag);
        element.textContent = content;
        if (className) element.className = className;
        detail.append(element);
        return element;
      }
      if (tourFinished) {
        add('span', '10 分钟路线已走到终点', 'trial-time');
        add('h3', '谢谢你花时间试一试');
        add('p', '不必每个功能都满意。告诉我们最值得保留的一点，以及最希望改的一处。');
        add('p', '意见表支持截图、想法与建议、反馈人。若没有编辑权限，可把截图和建议直接发给邀请你的人。', 'trial-result');
      } else {
        const step = trialSteps[tourStep];
        add('span', step.time, 'trial-time');
        add('h3', step.title);
        const list = add('ol', '', 'trial-actions');
        step.actions.forEach(action => { const item = document.createElement('li'); item.textContent = action; list.append(item); });
        add('p', '留意：' + step.result, 'trial-result');
        add('p', '想一想：' + step.question, 'trial-question');
        const links = add('div', '', 'trial-links');
        step.links.forEach(([label, route], index) => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = index ? 'trial-secondary' : 'share'; button.textContent = label;
          button.addEventListener('click', () => openTrialRoute(route)); links.append(button);
        });
      }
      if (tourFinished || tourStep === trialSteps.length - 1) {
        const link = add('a', '填写建议 ↗', 'trial-feedback');
        link.href = feedbackUrl; link.target = '_blank'; link.rel = 'noopener';
      }
    }
    document.getElementById('tour-prev').disabled = tourStep === 0;
    document.getElementById('tour-next').hidden = tourFinished;
    document.getElementById('tour-next').textContent = tourStep === trialSteps.length - 1 ? '完成试用' : '下一步 →';
  }

  tourToggle.addEventListener('click', () => {
    tourEnabled = true; tourExpanded = true;
    const target = frames.has('tour') ? frames.get('tour').url : appUrl(trialSteps[tourStep].route, trialScene);
    show('app', { target });
  });
  document.getElementById('tour-collapse').addEventListener('click', () => { tourExpanded = false; renderTour(); tourToggle.focus(); });
  document.getElementById('tour-prev').addEventListener('click', () => selectTrialStep(tourStep - 1));
  document.getElementById('tour-next').addEventListener('click', () => {
    if (tourStep < trialSteps.length - 1) selectTrialStep(tourStep + 1);
    else { tourFinished = true; renderTour(); }
  });
  matchMedia('(max-width:700px)').addEventListener('change', renderTour);
  window.addEventListener('popstate', restoreLocation);
  window.addEventListener('hashchange', restoreLocation);
  window.addEventListener('message', event => {
    if (event.origin !== base.origin || event.data?.type !== 'oops:route' || typeof event.data.href !== 'string') return;
    const entry = [...frames.entries()].find(([, value]) => value.frame.contentWindow === event.source);
    if (!entry || !['app', 'preview', 'tour'].includes(entry[0])) return;
    const url = new URL(event.data.href, base);
    if (url.origin !== base.origin || url.pathname !== base.pathname) return;
    entry[1].url = url;
    if (activeMode === 'app' && appKind === entry[0]) writeUrl();
  });

  returnButton.addEventListener('click', () => {
    frames.get(appKind)?.frame.contentDocument?.activeElement?.blur?.();
    appKind = 'app';
    tourEnabled = false;
    show('app');
  });
  document.querySelector('.skip-link').addEventListener('click', event => {
    event.preventDefault();
    document.getElementById('showcase-content').focus();
  });
  document.getElementById('share').addEventListener('click', async () => {
    const shareUrl = tourEnabled ? new URL('showcase.html?view=app&tour=1', base).href : location.href;
    try {
      await navigator.clipboard.writeText(shareUrl);
      const toast = document.getElementById('toast');
      toast.textContent = tourEnabled ? '试用起点链接已复制，可以发给朋友了' : '链接已复制，可以发给朋友了';
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
    } catch {
      const dialog = document.getElementById('share-dialog');
      const input = document.getElementById('share-url');
      input.value = shareUrl;
      dialog.showModal();
      input.focus();
      input.select();
    }
  });
  document.getElementById('close-share').addEventListener('click', () => document.getElementById('share-dialog').close());

  restoreLocation();
  writeUrl();
  fetch(new URL('board-manifest.json', base)).then(response => {
    if (!response.ok) throw new Error('Unable to load page counts');
    return response.json();
  }).then(({ metadata }) => {
    for (const element of document.querySelectorAll('[data-count]')) {
      const count = metadata?.[element.dataset.count];
      if (Number.isInteger(count) && count > 0) element.textContent = count;
    }
  }).catch(() => { /* The current release counts remain available offline. */ });
})();
