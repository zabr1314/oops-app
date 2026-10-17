/* Presentation navigation only: read current source, never copy access tokens. */
(() => {
  'use strict';
  const query = new URLSearchParams(location.search);
  if (query.get('present') === '1' && window.parent !== window) document.body.classList.add('presentation-embedded');
  const entry = document.getElementById('presentation-entry');
  if (!entry) return;
  let currentMode = ['#live', '#after', '#content'].includes(location.hash) ? location.hash.slice(1) : 'live';
  let latestData = null;
  const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : '';
  function updateEntry() {
    const source = (window.OopsReplay?.state?.()?.data || latestData)?.source;
    const destination = new URL('./funnel-present.html', location.href);
    const run = safeId(source?.kind === 'reanalysis' ? source.run_id : '');
    const meeting = safeId(source?.kind === 'history' ? source.session_id : '');
    if (run) destination.searchParams.set('run', run);
    else if (meeting) destination.searchParams.set('meeting', meeting);
    else if (!source || source.kind === 'empty') {
      // A requested source may still be loading. Preserve that exact request;
      // the embedded reader will perform its normal authorization checks.
      const requestedRun = safeId(query.get('run'));
      const requestedMeeting = safeId(query.get('meeting'));
      if (requestedRun) destination.searchParams.set('run', requestedRun);
      else if (requestedMeeting) destination.searchParams.set('meeting', requestedMeeting);
    }
    for (const key of ['auto', 'follow']) if (query.get(key) === '1') destination.searchParams.set(key, '1');
    destination.hash = '#' + currentMode;
    entry.href = destination.href;
  }
  document.addEventListener('funnel:data', event => { latestData = event.detail; updateEntry(); });
  document.addEventListener('funnel:mode', event => { currentMode = ['content', 'live', 'after'].includes(event.detail?.mode) ? event.detail.mode : 'content'; updateEntry(); });
  entry.addEventListener('click', updateEntry);
  entry.addEventListener('pointerdown', updateEntry);
  entry.addEventListener('focus', updateEntry);
  updateEntry();
})();
