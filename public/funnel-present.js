/* Same-origin meeting viewer + a static slide deck. No model calls or meeting writes. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const workspace = $('presentation-workspace');
  const meetingFrame = $('meeting-frame');
  const splitter = $('presentation-splitter');
  let slideImage = $('slide-image');
  const deckMessage = $('deck-message');
  const slideSelect = $('slide-select');
  const previous = $('previous-slide');
  const next = $('next-slide');
  const ratioSelect = $('meeting-ratio');
  const fullscreen = $('fullscreen');
  const query = new URLSearchParams(location.search);
  const narrow = window.matchMedia('(max-width: 760px)');
  let slides = [], selected = 0, ratio = 50, dragging = null;
  let imageEpoch = 0;
  const imageCache = new Map();
  function preparedImage(index) {
    let cached = imageCache.get(index);
    if (cached) return cached;
    const node = new Image(); node.draggable = false; node.decoding = 'async';
    node.fetchPriority = index === selected ? 'high' : 'low';
    const ready = new Promise((resolve, reject) => { node.onload = () => resolve(node); node.onerror = () => reject(new Error('slide_unavailable')); });
    cached = { node, ready }; imageCache.set(index, cached); node.src = slides[index].src;
    // Retain decoded adjacent images so returning to a page does not reload it.
    if (imageCache.size > 4) {
      const farthest = [...imageCache.keys()].filter(key => key !== selected && key !== index).sort((a,b) => Math.abs(b-selected)-Math.abs(a-selected))[0];
      if (farthest != null) imageCache.delete(farthest);
    }
    ready.catch(() => { if (imageCache.get(index) === cached) imageCache.delete(index); });
    return cached;
  }

  // Keep the history page at its existing path: its URL identifies the private
  // history reader, and its scoped HttpOnly cookie never leaves this origin.
  const meetingUrl = new URL('./funnel.html', location.href);
  for (const key of ['meeting', 'run', 'auto', 'follow']) {
    const value = query.get(key);
    if (value && value.length <= 256) meetingUrl.searchParams.set(key, value);
  }
  meetingUrl.hash = ['#live', '#content'].includes(location.hash) ? location.hash : '#after';
  $('back-to-meeting').href = meetingUrl.href;
  $('open-meeting').href = meetingUrl.href;
  const embeddedUrl = new URL(meetingUrl);
  embeddedUrl.searchParams.set('present', '1');
  meetingFrame.src = embeddedUrl.href;

  function setRatio(value) {
    ratio = Math.min(75, Math.max(25, Math.round(Number(value) || 50)));
    workspace.style.setProperty('--meeting-ratio', ratio + '%');
    splitter.setAttribute('aria-valuenow', String(ratio));
    splitter.setAttribute('aria-valuetext', '会议 ' + ratio + '%，PPT ' + (100 - ratio) + '%');
    let custom = ratioSelect.querySelector('[data-custom]');
    if (![35, 50, 65].includes(ratio)) {
      if (!custom) { custom = document.createElement('option'); custom.dataset.custom = 'true'; ratioSelect.append(custom); }
      custom.value = String(ratio); custom.textContent = ratio + '%';
    } else if (custom) custom.remove();
    ratioSelect.value = String(ratio);
    document.querySelectorAll('button[data-layout]').forEach(button => {
      const preset = { split: 50, meeting: 65, slides: 35 }[button.dataset.layout];
      button.setAttribute('aria-pressed', String(ratio === preset));
    });
  }
  function setLayout(layout) {
    if (!['split', 'meeting', 'slides'].includes(layout)) layout = 'split';
    workspace.dataset.layout = 'split';
    // Both areas stay visible and the one meeting iframe keeps its state.
    setRatio({ split: 50, meeting: 65, slides: 35 }[layout]);
    $('layout-note').textContent = narrow.matches ? '窄屏上下展示。PPT 翻页与会议整理分别操作。' : '拖动中间分隔条调整宽度。PPT 翻页与会议整理分别操作。';
  }
  document.querySelectorAll('button[data-layout]').forEach(button => button.addEventListener('click', () => setLayout(button.dataset.layout)));
  ratioSelect.addEventListener('change', () => setRatio(ratioSelect.value));
  narrow.addEventListener('change', () => { $('layout-note').textContent = narrow.matches ? '窄屏上下展示。PPT 翻页与会议整理分别操作。' : '拖动中间分隔条调整宽度。PPT 翻页与会议整理分别操作。'; });

  function dragRatio(event) {
    const bounds = workspace.getBoundingClientRect();
    if (bounds.width > 0) setRatio((event.clientX - bounds.left) * 100 / bounds.width);
  }
  splitter.addEventListener('pointerdown', event => {
    if (event.button !== 0 || narrow.matches || workspace.dataset.layout !== 'split') return;
    dragging = event.pointerId; splitter.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing'); dragRatio(event); event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => { if (event.pointerId === dragging) dragRatio(event); });
  function finishDrag(event) {
    if (event.pointerId !== dragging) return;
    dragging = null; document.body.classList.remove('is-resizing');
    if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
  }
  splitter.addEventListener('pointerup', finishDrag);
  splitter.addEventListener('pointercancel', finishDrag);
  splitter.addEventListener('lostpointercapture', () => { dragging = null; document.body.classList.remove('is-resizing'); });
  splitter.addEventListener('keydown', event => {
    const change = { ArrowLeft: -5, ArrowRight: 5 }[event.key];
    if (change) { setRatio(ratio + change); event.preventDefault(); event.stopPropagation(); }
    else if (event.key === 'Home' || event.key === 'End') { setRatio(event.key === 'Home' ? 25 : 75); event.preventDefault(); event.stopPropagation(); }
  });

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else { fullscreen.textContent = '请使用浏览器全屏'; return; }
    } catch (_) { fullscreen.textContent = '请使用浏览器全屏'; }
  }
  fullscreen.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => { fullscreen.textContent = document.fullscreenElement ? '退出全屏' : '全屏'; });

  function showSlide(index, updateAddress = true) {
    if (!slides.length) return;
    selected = Math.max(0, Math.min(slides.length - 1, index));
    const slide = slides[selected], epoch = ++imageEpoch;
    deckMessage.hidden = false; deckMessage.textContent = '正在载入第 ' + (selected + 1) + ' 页…';
    const cached = preparedImage(selected); cached.node.fetchPriority = 'high';
    cached.ready.then(node => {
      if (epoch !== imageEpoch) return;
      node.alt = '第 ' + (selected + 1) + ' 页：' + slide.title;
      if (slideImage !== node) { slideImage.id = ''; node.id = 'slide-image'; slideImage.replaceWith(node); slideImage = node; }
      slideImage.hidden = false; deckMessage.hidden = true; $('slide-viewer').classList.add('has-image');
      if (selected + 1 < slides.length) preparedImage(selected + 1).ready.catch(() => {});
    }).catch(() => {
      if (epoch === imageEpoch) { deckMessage.hidden = false; deckMessage.textContent = '这一页暂时无法显示。可切换其他页或刷新重试。'; }
    });
    $('slide-title').textContent = slide.title;
    $('slide-position').textContent = (selected + 1) + ' / ' + slides.length;
    slideSelect.value = String(selected);
    previous.disabled = selected === 0; next.disabled = selected === slides.length - 1;
    if (updateAddress) {
      const url = new URL(location.href); url.searchParams.set('slide', String(selected + 1));
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }
  previous.addEventListener('click', () => showSlide(selected - 1));
  next.addEventListener('click', () => showSlide(selected + 1));
  slideSelect.addEventListener('change', () => showSlide(Number(slideSelect.value)));
  $('slide-viewer').addEventListener('pointerdown', () => $('slide-viewer').focus({ preventScroll: true }));
  document.addEventListener('keydown', event => {
    if (!slides.length || $('slides-panel').hidden || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const active = document.activeElement;
    if (active === meetingFrame || active === splitter || active?.matches('input,select,textarea,[contenteditable="true"]')) return;
    const target = { ArrowLeft: selected - 1, PageUp: selected - 1, ArrowRight: selected + 1, PageDown: selected + 1, Home: 0, End: slides.length - 1 }[event.key];
    if (target != null) { event.preventDefault(); showSlide(target); }
  });

  async function loadDeck() {
    const manifestUrl = new URL('./presentation/oops-demo/manifest.json', location.href);
    const imageDirectory = new URL('.', manifestUrl).pathname;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(manifestUrl, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error('deck_unavailable');
      const manifest = await response.json();
      if (!Array.isArray(manifest.slides) || !manifest.slides.length || manifest.slides.length > 80) throw new Error('invalid_deck');
      slides = manifest.slides.map((slide, index) => {
        if (!slide || typeof slide.src !== 'string' || slide.src.length > 300) throw new Error('invalid_slide');
        const source = new URL(slide.src, manifestUrl);
        // The supplied deck contains only local, static images. It cannot embed
        // another site or send meeting URLs/cookies to a document provider.
        if (source.origin !== location.origin || !source.pathname.startsWith(imageDirectory) || !/\.(png|jpe?g|webp)$/i.test(source.pathname) || source.search || source.hash || source.username || source.password) throw new Error('invalid_slide');
        return { src: source.href, title: typeof slide.title === 'string' ? slide.title.slice(0, 150) : '幻灯片 ' + (index + 1) };
      });
      $('deck-title').textContent = typeof manifest.title === 'string' && manifest.title ? manifest.title.slice(0, 100) : 'Oops 演示文稿';
      slideSelect.replaceChildren(...slides.map((slide, index) => {
        const option = document.createElement('option'); option.value = String(index); option.textContent = (index + 1) + '. ' + slide.title; return option;
      }));
      slideSelect.disabled = false;
      const initial = Number(query.get('slide') || 1);
      showSlide(Number.isInteger(initial) && initial > 0 ? initial - 1 : 0, false);
    } catch (_) {
      slides = []; deckMessage.hidden = false; deckMessage.textContent = '演示文稿暂时无法读取。会议页面可继续使用，请稍后刷新。';
      $('slide-position').textContent = '未载入';
      slideSelect.replaceChildren(new Option('演示文稿未载入', '')); slideSelect.disabled = true;
    } finally { clearTimeout(deadline); }
  }
  setRatio(50); setLayout('split'); loadDeck();
})();
