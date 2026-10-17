/* Opens a separate, disposable demo document. It never changes the native backend or user records. */
(() => {
  'use strict';
  if (window.parent !== window || window.OopsDemoTransport) return;
  const style = document.createElement('style');
  style.textContent = '.rs-enter{position:fixed;right:15px;bottom:calc(111px + env(safe-area-inset-bottom,0px));z-index:48;border:1px solid #d5c5fc;border-radius:22px;background:#fff6ffed;color:#6d4dd2;box-shadow:0 5px 18px #4e2f8f13;padding:9px 14px;font:600 11px -apple-system,sans-serif}.rs-cover{position:fixed;inset:0;z-index:1000;background:#f2efff}.rs-cover iframe{width:100%;height:100%;border:0;display:block}.rs-enter:focus-visible{outline:3px solid #a48bea;outline-offset:3px}';
  document.head.append(style);
  const entry = document.createElement('button'); entry.type = 'button'; entry.className = 'rs-enter'; entry.textContent = '完整内容'; entry.setAttribute('aria-label','打开完整内容'); document.body.append(entry);
  let cover = null, frame = null;
  const close = () => { if (!cover) return; frame.src = 'about:blank'; cover.remove(); cover = null; frame = null; entry.hidden = false; entry.focus(); };
  entry.addEventListener('click', () => {
    if (cover) return;
    if (!document.getElementById('rc')?.hidden) { alert('当前仍在录音。请先处理本场记录，再打开完整内容。'); return; }
    cover = document.createElement('section'); cover.className = 'rs-cover'; cover.setAttribute('aria-label','Oops 完整内容');
    frame = document.createElement('iframe'); frame.title = 'Oops'; frame.src = 'roadshow-demo.html'; frame.setAttribute('sandbox','allow-scripts allow-same-origin');
    cover.append(frame); document.body.append(cover); entry.hidden = true;
  });
  window.addEventListener('message', event => { if (frame && event.source === frame.contentWindow && event.origin === location.origin && event.data?.type === 'oops-roadshow-exit') close(); });
  const previousBack = window.OopsBack;
  window.OopsBack = () => { if (cover) { if (!frame.contentWindow.OopsBack?.()) close(); return true; } return previousBack?.() || false; };
})();
