/* Optional 16:9 view for the existing live replay. This changes presentation
   only: the same stage, source reader and playback clock remain in place. */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const toggle = $('wide-toggle');
  const live = $('mode-live');
  if (!toggle || !live) return;

  const options = $('wide-options');
  const records = $('wide-records');
  const fullscreen = $('wide-fullscreen');
  const settingsPanel = $('workspace-settings');
  const recordsPanel = $('playback-records');
  const message = $('wide-message');
  const sourceNote = $('source-note');
  const historyStatus = $('history-status');
  const sourceSummary = $('wide-source-summary');
  const largeScreen = window.matchMedia('(min-width: 960px) and (min-height: 480px)');
  const embedded = new URLSearchParams(location.search).get('present') === '1' || window.self !== window.top;
  const requestFromUrl = () => {
    const value = new URLSearchParams(location.search).get('wide');
    return value === '1' || (value !== '0' && !embedded && document.body.dataset.wideDefault === 'true');
  };
  let requested = requestFromUrl();
  let active = false;
  let openPanel = '';
  let fullscreenPending = false;
  let actionMessage = '';
  let layoutMessage = '';
  let sourceMessage = '';

  function renderMessage() {
    if (!message) return;
    const text = [active ? sourceMessage : '', actionMessage, layoutMessage].filter(Boolean).join(' ');
    if (message.textContent !== text) message.textContent = text;
    message.hidden = !text;
    document.body.classList.toggle('wide-has-message', active && Boolean(text));
  }

  function announce(text) {
    actionMessage = text;
    renderMessage();
  }

  function updateSourceMessages() {
    const note = (sourceNote?.textContent || '').trim();
    const status = (historyStatus?.textContent || '').trim();
    if (sourceSummary) {
      if (sourceSummary.textContent !== note) sourceSummary.textContent = note;
      sourceSummary.hidden = !note;
    }
    const empty = window.OopsReplay?.state?.()?.data?.source?.kind === 'empty';
    const loading = text => /^(?:正在|尚未|未选择)|正在(?:载入|读取|连接|打开)/.test(text);
    const recovered = text => /连接已恢复|已重新读取|已重新核对/.test(text);
    const problem = text => !loading(text) && !recovered(text)
      && /失败|超时|异常|中断|打不开|不可用|不可读|无读取权限|无权限|无法.{0,12}核对|已删除|已到期|失效|已不在|不在.{0,12}可读|来源已变化/.test(text);
    // Reuse the reader's actual cause; never infer permission or retention from
    // missing rows. Successful reads/recovery replace these same source nodes.
    // Keep the actual cause visible without repeating the full source preface.
    // The complete original note remains in the meeting/source panel above.
    const noteCause = (note.match(/[^。！？]+[。！？]?/g) || []).map(part => part.trim()).filter(problem).join(' ');
    sourceMessage = problem(status) ? status
      : problem(note) ? noteCause || note
      : empty && note && !loading(note) ? note : '';
    renderMessage();
  }

  function focusButton(button) {
    if (button && !button.hidden && !button.disabled) button.focus({ preventScroll: true });
  }

  function panelButton(name) {
    return name === 'options' ? options : name === 'records' ? records : null;
  }

  function panelElement(name) {
    return name === 'options' ? settingsPanel : name === 'records' ? recordsPanel : null;
  }

  function showPanel(name, restoreFocus = false) {
    const previous = openPanel;
    openPanel = active && ['options', 'records'].includes(name) ? name : '';
    document.body.classList.toggle('wide-options-open', openPanel === 'options');
    document.body.classList.toggle('wide-records-open', openPanel === 'records');
    options?.setAttribute('aria-expanded', String(openPanel === 'options'));
    records?.setAttribute('aria-expanded', String(openPanel === 'records'));
    if (restoreFocus && previous && !openPanel) focusButton(panelButton(previous));
    if (openPanel && openPanel !== previous) {
      const shown = openPanel;
      requestAnimationFrame(() => {
        if (openPanel === shown) focusButton($(shown === 'options' ? 'wide-options-close' : 'wide-records-close'));
      });
    }
  }

  function isLiveMode() {
    // The original tabs update hidden and replaceState, then emit funnel:mode;
    // replaceState does not emit hashchange. Never navigate or replay on their behalf.
    return !live.hidden && location.hash === '#live';
  }

  function updateFullscreenButton() {
    if (!fullscreen) return;
    fullscreen.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
    fullscreen.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
    fullscreen.disabled = fullscreenPending;
  }

  function updateLayout() {
    const inLive = isLiveMode();
    const wasActive = active;
    active = requested && !embedded && inLive && largeScreen.matches;
    const focusedPanel = panelElement(openPanel);
    const focusWasInside = focusedPanel?.contains(document.activeElement);
    document.body.classList.toggle('wide-replay', active);
    toggle.textContent = requested ? '返回完整页' : '16:9 展示';
    toggle.setAttribute('aria-pressed', String(requested));
    toggle.disabled = !inLive && !requested;
    toggle.title = !inLive && !requested ? '在逐句回放中开启 16:9 展示' : '';
    for (const button of [options, records, fullscreen]) {
      if (button) button.hidden = !active;
    }
    if (!active) showPanel('');
    if (wasActive && !active && focusWasInside) focusButton(toggle);
    actionMessage = '';
    layoutMessage = requested && inLive && !largeScreen.matches
      ? '16:9 展示已保留；请将窗口放大至至少 960 × 480。'
      : '';
    updateSourceMessages();
    updateFullscreenButton();
  }

  function saveRequest() {
    // Preserve the exact meeting/run, all other query parameters and the hash.
    const url = new URL(location.href);
    url.searchParams.set('wide', requested ? '1' : '0');
    try {
      history.replaceState(history.state, '', url.href);
      return true;
    } catch (_) {
      return false;
    }
  }

  toggle.addEventListener('click', () => {
    if (!isLiveMode() && !requested) return;
    requested = !requested;
    const saved = saveRequest();
    updateLayout();
    if (!saved) announce('展示已切换，浏览器未能更新当前地址。');
  });

  options?.setAttribute('aria-controls', 'workspace-settings');
  records?.setAttribute('aria-controls', 'playback-records');
  options?.addEventListener('click', () => showPanel(openPanel === 'options' ? '' : 'options'));
  records?.addEventListener('click', () => showPanel(openPanel === 'records' ? '' : 'records'));
  $('wide-options-close')?.addEventListener('click', () => showPanel('', true));
  $('wide-records-close')?.addEventListener('click', () => showPanel('', true));

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !openPanel) return;
    event.preventDefault();
    event.stopPropagation();
    showPanel('', true);
  }, true);

  document.addEventListener('pointerdown', event => {
    if (!openPanel) return;
    const panel = panelElement(openPanel);
    const button = panelButton(openPanel);
    if (panel?.contains(event.target) || button?.contains(event.target)) return;
    showPanel('');
  });

  document.addEventListener('focusin', event => {
    if (!openPanel) return;
    if (panelElement(openPanel)?.contains(event.target) || panelButton(openPanel)?.contains(event.target)) return;
    showPanel('');
  });

  fullscreen?.addEventListener('click', async () => {
    if (!active || fullscreenPending) return;
    fullscreenPending = true;
    updateFullscreenButton();
    announce('');
    try {
      if (document.fullscreenElement) {
        if (typeof document.exitFullscreen !== 'function') throw new Error('fullscreen_unavailable');
        await document.exitFullscreen();
      } else {
        if (typeof document.documentElement.requestFullscreen !== 'function') throw new Error('fullscreen_unavailable');
        await document.documentElement.requestFullscreen();
      }
    } catch (_) {
      announce('未能切换全屏，可使用浏览器的全屏功能。');
    } finally {
      fullscreenPending = false;
      updateFullscreenButton();
    }
  });
  document.addEventListener('fullscreenchange', updateFullscreenButton);

  const sourceObserver = new MutationObserver(updateSourceMessages);
  for (const node of [sourceNote, historyStatus]) {
    if (node) sourceObserver.observe(node, { childList: true, subtree: true, characterData: true });
  }
  document.addEventListener('funnel:data', updateSourceMessages);

  // No data fetches, storage writes or changes to the playback clock occur here.
  document.addEventListener('funnel:mode', updateLayout);
  window.addEventListener('hashchange', updateLayout);
  window.addEventListener('popstate', () => {
    requested = requestFromUrl();
    updateLayout();
  });
  largeScreen.addEventListener('change', updateLayout);
  updateLayout();
})();
