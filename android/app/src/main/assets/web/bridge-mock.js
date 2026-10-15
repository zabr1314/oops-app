/* Desktop-only simulator. Native Android always owns the real bridge. */
(() => {
  'use strict';
  if (window.OopsNative) return;
  const preview = new URLSearchParams(location.search).get('preview') === '1';
  const flow = preview ? new URLSearchParams(location.search).get('flow') || 'normal' : 'normal';
  const failedOnce = new Set();
  let minutesChanged = false;
  let retainedEvidence=[],retainedSummaries=[];
  let feishuStatus = flow === 'feishu-unconfigured' ? 'unconfigured' : flow === 'feishu-expired' ? 'expired' : 'disconnected';
  let feishuAccount = null;
  const deliveryDrafts = new Map(), deliveryOperations = new Map();
  const workflowDrafts=new Map(),workflowOperations=new Map(),mockJob='d'.repeat(32);
  const feishuPeople = [{open_id:'mock-jason',name:'Jason',department:'示例产品团队'}, {open_id:'mock-lip',name:'黄丽萍',department:'示例设计团队'}, {open_id:'mock-yue',name:'江古月',department:'示例开发团队'}];
  const emitFeishuStatus = requestId => emit('feishu.status', {requestId, status:feishuStatus, account:feishuAccount,
    binding_revision:1,capabilities:{minutes_delivery:feishuStatus==='connected',recipients:feishuStatus==='connected',documents_write:feishuStatus==='connected',sharing:feishuStatus==='connected',messages_send:feishuStatus==='connected',calendar_delivery:feishuStatus==='connected',calendar_invite:feishuStatus==='connected',agent_file_delivery:feishuStatus==='connected'},mock:true});
  const deliveryReply = (p, status, extra = {}) => emit('minutes.delivery', {session_id:p.sessionId, requestId:p.requestId, status, draft:deliveryDrafts.get(p.sessionId), mock:true, ...extra});
  const team = ['Jason', '黄丽萍', '江古月', '洪玉麟', '林春源'];
  // Real device ASR observations for assets/test/dialog.wav (2026-10-06).
  const sample = [
    { startMs: 0, endMs: 4482, text: '我们这次要在两周内上线，预算不能超过10万。' },
    { startMs: 4852, endMs: 11112, text: '我觉得注册前应该先让用户体验一下产品不然转化率会很低' },
    { startMs: 11442, endMs: 16841, text: '这个想法不错，不过方案A要时上线，大概要13万。' },
    { startMs: 17162, endMs: 20181, text: '那我周五前把新方案发你' },
    { startMs: 20521, endMs: 24802, text: '把刚刚那个想法留下来' },
  ];
  const key = 'oops-browser-saved-v1';
  let saved;
  try { saved = preview ? [] : JSON.parse(localStorage.getItem(key) || '[]'); } catch { saved = []; }
  const state = { capturing: false, sessionId: '', source: 'wav', sessionMs: 0, bufferedMs: 0,
    retentionMs: 300000, recordingMode: 'daily', cloudSaveConfirmed: false, audioRetentionDays: 30, transcriptRetentionDays: 30, asr: 'off', asrDetail: null, level: 0, playing: false,
    voiceTrigger: true, noticeVibrate: true, memorySync: true, syncStatus: 'synced', syncPending: 0, digestCounts: {}, notices: [], agenda: {goal: '', items: [], tracking: 'waiting'},
    savedCount: saved.length, backend: 'mock', backendUrl: '', speakerInfo: false, ...(preview ? {selfName: '洪玉麟'} : {}),
    testWavName: '内置合成对话（浏览器模拟）', asrGaps: [], sourceDetail: null, sourceReady: false, remoteAddress: '127.0.0.1:7790' };
  const bridge = { onmessage: null, postMessage: (raw) => {
    try { const { type, payload = {} } = JSON.parse(raw); handle(type, payload); }
    catch (e) { emit('error', { scope: 'mock', message: e.message }); }
  } };
  window.OopsNative = bridge;
  const emit = (type, payload) => bridge.onmessage?.({ data: JSON.stringify({ type, payload }) });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
  // Isolated fixture only: no real signature, server credential, or external write.
  const mockBinding = (sessionId, rows, daily = false) => ({ version: 1, session_id: sessionId,
    ...(daily ? {scope: 'daily', proof: '0'.repeat(64)} : {}), context_sources: [],
    sources: rows.map(row => ({id: row.id, kind: daily ? 'daily_excerpt' : 'transcript', text_hash: '0'.repeat(64), source_revision: 'mock-v1', quote: row.text.slice(0, 280), speaker: row.speaker || null, review: {}})) });
  let startedAt = 0, timer = null, transcript = [], cards = new Map(), drafts = new Map();
  let sessionTranscript = [], dailyCandidates = [];
  const emitted = new Set();
  let actions = new Map(), draftOps = new Map(), recallCount = 0, playingKey = null;
  const audio = preview ? null : new Audio('../test/dialog.wav');
  let clipTimer = null;
  const day = 86400000;
  const mockTasks = [
    { op_id: 'op-mock-1', what: '周五前把新方案发出来', who: '洪玉麟', quote: '那我周五前把新方案发你', url: 'https://example.com/task/1',
      meeting: { started_at: '2026-10-06T09:00:00+08:00', goal: '上线方案' }, overdue: true, feishu: { state: 'open', due_ms: Date.now() - day } },
    { op_id: 'op-mock-2', what: '整理预算上限', who: '林春源', quote: '预算不能超过10万', url: 'https://example.com/task/2',
      meeting: { started_at: '2026-10-06T09:00:00+08:00', goal: '上线方案' }, overdue: false, feishu: { state: 'done', due_ms: Date.now() - 2 * day } },
    { op_id: 'op-mock-3', what: '确认体验版注册流程', who: '江古月', quote: '注册前应该先让用户体验一下产品', url: 'https://example.com/task/3',
      meeting: null, overdue: false, feishu: { state: 'unknown', stale: true } },
  ];
  function stopClip() {
    audio?.pause(); clearTimeout(clipTimer);
    if (playingKey) emit('clip.state', { key: playingKey, state: 'stopped' });
    playingKey = null; state.playing = false;
  }
  function tick() {
    if (!state.capturing) return;
    state.sessionMs = Math.floor(performance.now() - startedAt);
    state.bufferedMs = Math.min(state.sessionMs, state.retentionMs);
    state.level = state.sessionMs < 25000 ? (Math.sin(state.sessionMs / 90) + 1) * 0.2 : 0;
    sample.forEach((u, i) => {
      const uid = `${state.sessionId}-u${i + 1}`;
      if (state.sessionMs >= u.endMs + 300 && !emitted.has(uid)) {
        const final = { ...u, id: uid, speaker: null };
        emitted.add(uid); transcript.push(final); sessionTranscript.push(final); emit('asr.final', final);
        final.tag = ['constraint', 'idea', 'decision', 'commitment', 'uncertain'][i];
        final.tagEngine = 'rules-mock';
        if (state.recordingMode === 'daily' && ['constraint','idea','decision','commitment'].includes(final.tag)) {
          dailyCandidates = [...dailyCandidates, {id:final.id,session_id:state.sessionId,quote:final.text.slice(0,280),start_ms:final.startMs,end_ms:final.endMs,tag:final.tag,visibility:'private',confirmed:false,original_available:false,updated_at:new Date().toISOString()}].slice(-50);
        }
        emit('asr.tag', { ...final });
        state.commitmentCount = sessionTranscript.filter((u) => u.tag === 'commitment').length;
        state.tagsSupported = true; state.analysisPending = 0; state.analysisFailed = 0;
        state.digestCounts = Object.fromEntries(['decision', 'commitment', 'constraint', 'idea'].map(t => [t, sessionTranscript.filter(u => u.tag === t).length]));
        if (i === 2) {
          const n = {id: id('notice'), kind: 'conflict', title: '可能与之前的约束冲突', detail: `之前：「${sessionTranscript[0].text}」\n本场：「${final.text}」`, atMs: state.sessionMs, evidenceIds: [sessionTranscript[0].id, final.id]};
          state.notices.push(n); emit('notice', n);
        }
        emit('session.summary', summary());
        if (state.recordingMode === 'meeting' && final.tag === 'commitment') { // Native task_board is formal-meeting only.
          const tasks = sessionTranscript.filter((x) => x.tag === 'commitment').map((x, n) => ({ id: `t${n + 1}`, what: x.text.replace(/[。！？]$/, ''),
            owner: '', priority: n ? 'P2' : 'P0', status: 'open', sources: [x.id], source_binding: mockBinding(state.sessionId, [x]), reason: n ? '有参考价值，可以排期（模拟）' : '直接影响本次结论（模拟）' }));
          emit('tasks.board', { session_id: state.sessionId, tasks, pending: false, updated_at: new Date().toISOString() });
        }
      } else if (state.sessionMs >= u.startMs && state.sessionMs < u.endMs) {
        const chars = Math.ceil(u.text.length * (state.sessionMs - u.startMs) / (u.endMs - u.startMs));
        emit('asr.partial', { ...u, text: u.text.slice(0, chars) });
      }
    });
    const expired = transcript.filter((u) => u.endMs < state.sessionMs - state.retentionMs);
    if (state.recordingMode === 'daily') {
      sessionTranscript = sessionTranscript.filter(u => u.endMs >= state.sessionMs - state.retentionMs);
      state.notices = state.notices.filter(n => n.atMs >= state.sessionMs - state.retentionMs && n.evidenceIds.every(id => sessionTranscript.some(u => u.id === id)));
      for (const [key,card] of cards) if (card.pool.some(u => !sessionTranscript.some(x => x.id === u.id))) cards.delete(key);
      for (const [key,draft] of drafts) if (draft.evidence.utteranceIds.some(id => !sessionTranscript.some(u => u.id === id))) drafts.delete(key);
    }
    if (expired.length) { transcript = transcript.filter((u) => !expired.includes(u));emit('transcript.pruned', { ids: expired.map((u) => u.id) }); }
    emit('state', { ...state });
  }
  function summary() {
    return { sessionId: state.sessionId, ...Object.fromEntries([['commitments','commitment'],['decisions','decision'],['constraints','constraint'],['ideas','idea']].map(([key, tag]) => [key, sessionTranscript.filter(u => u.tag === tag).map(u => ({...u, audioExpired: false, whenRaw: tag === 'commitment' ? '周五前' : null}))])), notices: state.notices };
  }
  async function recall(p) {
    const session = state.sessionId; emit('recall.pending', { trigger: 'button' }); await sleep(350); if (session !== state.sessionId) return;
    const pool = (p.ask ? sessionTranscript : transcript).filter((u) => !/oops|欧普斯|哦普斯|奥普斯|把刚刚那个想法留下来/i.test(u.text));
    if (!pool.length) return emit('recall.notFound', { reason: '最近 5 分钟内还没有可召回的原话' });
    const ideas = pool.filter((u) => /想法|觉得|方案|周五/.test(u.text));
    let ranked = (ideas.length ? ideas : pool).slice().sort((a,b) => (/觉得/.test(b.text) ? 1 : 0) - (/觉得/.test(a.text) ? 1 : 0));
    if (p.ask && p.query) {
      const grams = s => new Set(s.replace(/[^\p{L}\p{N}]/gu, '').split('').slice(0,-1).map((c,i) => c+s.replace(/[^\p{L}\p{N}]/gu, '')[i+1]));
      const q = grams(p.query); const score = u => [...q].filter(x => grams(u.text).has(x)).length;
      ranked = pool.slice().sort((a,b) => score(b)-score(a));
      if (!score(ranked[0])) return emit('recall.notFound', {reason:'本场原话里没有找到答案'});
    }
    recallCount++;
    const single = recallCount % 2 === 1 || ranked.length < 2;
    const items = ranked.slice(0, single ? 1 : 2).map((u,i) => ({ ...u, prob: single ? 0.82 : i ? 0.4 : 0.48 }));
    const card = { id: id('c'), trigger: p.ask ? 'ask' : 'button', query: p.query || null, nowMs: state.sessionMs,
      single, engine: 'browser-mock', windowMs: 120000, latencyMs: 350, items, pool };
    cards.set(card.id, card);emit('recall.card', card);emit('latency', { recentMs: [350], medianMs: 350 });
  }
  async function draft(p) {
    const card = cards.get(p.cardId);
    if (!card) throw new Error('卡片已失效');
    const session = state.sessionId || 'demo', mode = state.recordingMode;
    const chosen = card.pool.filter((u) => p.utteranceIds.includes(u.id)).map((u) => sessionTranscript.find((x) => x.id === u.id) || u);
    if (!chosen.length) throw new Error('没有选中原话');
    await sleep(250);
    if (session !== (state.sessionId || 'demo') || mode !== state.recordingMode || !cards.has(p.cardId)) throw new Error('草稿来源已变化，请重新选择当前原话');
    const daily = mode === 'daily';
    const d = { draftId: id('d'), cardId: card.id, sessionId: session, who: '', what: chosen.map((u) => u.text).join(' '),
      whenIso: null, whenRaw: null, constraint: '预算不能超过10万', assigneeCandidates: team,
      evidence: { utteranceIds: chosen.map((u) => u.id), quote: chosen.map((u) => u.text).join(' '),
        startMs: chosen[0].startMs, endMs: chosen.at(-1).endMs,
        sourceBinding: flow === 'task-source-missing' || daily && Array.from(chosen.map(u => u.text).join(' ')).length > 280 ? null : mockBinding(session, chosen, daily) },
      ...(flow === 'task-source-changed' ? {sourceError: 'source_changed'} : {}) };
    drafts.set(d.draftId, d);emit('action.draft', d);
  }
  async function confirm(p) {
    const d = drafts.get(p.draftId);
    if (!d) throw new Error('草稿已失效');
    const opId = draftOps.get(d.draftId) || id('op');draftOps.set(d.draftId, opId);
    const previous = actions.get(opId);
    if (previous) return emit('action.result', previous);
    if (d.sourceError || !d.evidence.sourceBinding) throw new Error('示例原话依据尚未核验或已经变化，请重新读取后核对');
    Object.assign(d, { who: p.who, what: p.what, whenIso: p.whenIso, constraint: p.constraint });
    emit('action.result', { draftId: d.draftId, opId, status: 'pending', polling: true, mock: true });
    await sleep(600);
    const r = { draftId: d.draftId, opId, status: 'created', taskGuid: `mock-${opId}`, taskUrl: null,
      message: '浏览器模拟：没有实际写入飞书', readBackConfirmed: true, mock: true, polling: false };
    actions.set(opId, r);emit('action.result', r);
  }
  let mockMeetings = [{session_id: 'demo', started_at: '2026-10-06T09:00:00+08:00', ended_at: '2026-10-06T10:00:00+08:00', project: 'Oops 首版', goal: '上线方案评审（模拟）', utterance_count: 3}];
  const historicalRows = [{id: 'u1', text: '预算不能超过10万。', start_ms: 0, end_ms: 4482, tag: 'constraint', speaker: null},
    {id: 'u2', text: '那我周五前把新方案发你。', start_ms: 17162, end_ms: 20181, tag: 'commitment', speaker: null, owner_hint: null, when_raw: '周五前'},
    {id: 'u3', text: '这个想法不错，不过方案A要时上线，大概要13万。', start_ms: 11442, end_ms: 16841, tag: 'decision', speaker: '林春源'}]
    .sort((a, b) => a.start_ms - b.start_ms);
  // Same order as the server's review_queue: tasks, decisions, then unknown speakers of long enough lines.
  const reviewQueue = (rows) => [
    ...rows.filter((u) => u.tag === 'commitment' && !u.review?.verdict).map((u) => ({kind: 'commitment', id: u.id})),
    ...rows.filter((u) => u.tag === 'decision' && !u.review?.verdict).map((u) => ({kind: 'decision', id: u.id})),
    ...rows.filter((u) => !u.speaker && !u.review?.speaker && u.text.replace(/[^\p{L}\p{N}]/gu, '').length >= 4).map((u) => ({kind: 'speaker', id: u.id}))];
  // Items the server builds from the meeting's minutes (minutes_items.py); reviews kept apart from sentences.
  const mockItemReviews = {};
  const mockItems = () => [
    {id: 'mi-t1', kind: 'task', title: '核对并提交新方案', due: '周五前', owner_hint: '洪玉麟', priority: 'main', ids: ['u2']},
    {id: 'mi-d1', kind: 'decision', title: '预算上限为10万', ids: ['u1']},
    {id: 'mi-o1', kind: 'open', title: '13万的方案A如何压到10万以内？', detail: '方案A报价约13万，超出预算，会上没有结论', ids: ['u3']},
  ].map((it) => ({...it, fingerprint: 'mock-' + it.id, stale: false, stale_review: false, task_status: null, task_url: null,
    review: mockItemReviews[it.id] || null,
    evidence: it.ids.map((id) => { const u = historicalRows.find((r) => r.id === id); return {id, text: u.text, start_ms: u.start_ms, end_ms: u.end_ms, speaker: u.review?.speaker || u.speaker}; })}));
  const itemQueue = (items) => items.filter((i) => !i.review).map((i) => ({kind: 'item', id: i.id, item_kind: i.kind}));
  function personalWorkflowMock(type,p) {
    if(type==='assistant.jobs') {emit(type,{...p,items:[{job_id:mockJob,session_id:'demo',title:'首版方案报告（隔离示例）',kind:'report',generation_status:'ready',status:'done',delivery_status:'needs_personal_review'}],mock:true});return true;}
    const agent=type.startsWith('assistant.delivery.'),calendar=type.startsWith('calendar.');
    if(!agent && !calendar)return false;
    const key=agent?p.jobId:`${p.sessionId}:${p.followupId || 'manual'}`,action=type.split('.').at(-1);
    const reply=(extra={})=>emit(agent?'assistant.delivery':'calendar.delivery',{...p,session_id:p.sessionId,job_id:agent?p.jobId:undefined,followup_id:p.followupId || 'manual',draft:workflowDrafts.get(key),mock:true,...extra});
    if(!workflowDrafts.has(key))workflowDrafts.set(key,agent?{revision:1,job_id:p.jobId,title:'首版方案报告（隔离示例）',content:'这是已有报告的隔离示例。读取或恢复交付均不重新生成。',recipients:[],permission:'view',artifacts:[{name:'首版方案.pptx',kind:'file',size:1024}],attachments:[],attachment_copies_confirmed:false,binding_revision:1,account_open_id:'mock-self'}:{revision:1,title:'后续评审（隔离示例）',description:'浏览器不创建真实日程',start:'2026-10-20T15:00:00+08:00',end:'2026-10-20T15:30:00+08:00',time_zone:'Asia/Shanghai',attendees:[],reviewed:false,binding_revision:1,account_open_id:'mock-self'});
    const draft=workflowDrafts.get(key),fail=(code,message)=>emit('error',{...p,scope:'feishu',operation:type,code,message});
    if(action==='save') {
      if(feishuStatus!=='connected'){fail('FEISHU_NOT_CONNECTED','请先连接本人示例飞书');return true;}
      if(p.revision!==draft.revision){fail('REVIEW_REVISION_CHANGED','草稿版本已变化');return true;}
      if(agent && p.attachments?.length && !p.attachment_copies_confirmed){fail('FILE_COPY_CONFIRMATION_REQUIRED','请确认原文件会作为可下载副本发送');return true;}
      const fields=agent?['title','content','recipients','permission','attachments','attachment_copies_confirmed']:['title','description','start','end','time_zone','attendees'];
      for(const field of fields)if(field in p)draft[field]=p[field];draft.revision++;if(calendar)draft.reviewed=true;
      reply();return true;
    }
    let op=[...workflowOperations.values()].find(o=>o.key===key);
    if(action==='confirm') {
      if(feishuStatus!=='connected' || p.confirmed!==true || p.revision!==draft.revision || agent && !draft.recipients.length || calendar && !draft.reviewed){fail('CONFIRMATION_REQUIRED','请保存并单独确认本版内容');return true;}
      if(!op){op={key,op_id:p.opId,revision:draft.revision,status:flow.includes('timeout')?'unknown':agent?'sending':'created_unverified',mock:true};workflowOperations.set(p.opId,op);}
      else if(op.status!=='unknown')op.status=agent?'sent':'created';
      if(calendar && op.status!=='unknown'){op.event_verified=op.status==='created';op.event_id='mock-event-only';}
    }else if(action==='status' && op && op.status!=='unknown'){op.status=agent?'sent':'created';if(calendar)op.event_verified=true;}
    reply(agent?{delivery:op || null}:{calendar:op || null});return true;
  }
  function handle(type, p) {
    if(personalWorkflowMock(type,p))return;
    const listFailure = flow === 'list-failure' && ['history.list', 'projects.list', 'project.open', 'tasks.list'].includes(type);
    const reviewFailure = flow === 'review-failure' && ['review.set', 'speaker.correct'].includes(type);
    const minutesFailure = flow === 'minutes-failure' && type === 'history.minutes';
    if ((listFailure || reviewFailure || minutesFailure) && !failedOnce.has(type)) {
      failedOnce.add(type);
      const scope = type === 'history.list' ? 'history' : type === 'tasks.list' ? 'tasks' : type.startsWith('project') ? 'projects' : type === 'history.minutes' ? 'minutes' : type === 'review.set' ? 'review' : 'speaker';
      const selfName = state.selfName || '';
      setTimeout(() => emit('error', {...p, selfName, scope, operation: type, message: '模拟：本次连接失败，重试会恢复。'}), 180);
      return;
    }
    switch (type) {
      case 'feishu.status': emitFeishuStatus(p.requestId); break;
      case 'feishu.connect':
        if (feishuStatus === 'unconfigured') { emitFeishuStatus(p.requestId); break; }
        emit('feishu.authorization', {requestId:p.requestId,status:'authorizing',message:'隔离模拟：正在体验官方授权返回。不会访问真实飞书。'});
        setTimeout(() => {
          feishuStatus = flow === 'feishu-cancelled' ? 'cancelled' : 'connected';
          feishuAccount = feishuStatus === 'connected' ? {open_id:'mock-self',name:'我的飞书（模拟）',tenant_name:'Oops 示例组织',binding_id:id('mock-binding')} : null;
          emitFeishuStatus(p.requestId);
        }, 250); break;
      case 'feishu.disconnect': feishuStatus = 'disconnected'; feishuAccount = null; emitFeishuStatus(p.requestId); break;
      case 'feishu.recipients':
        emit('feishu.recipients', {requestId:p.requestId, items:feishuStatus === 'connected' ? feishuPeople.filter(person => person.name.toLowerCase().includes(String(p.query || '').toLowerCase())) : [], message:feishuStatus === 'connected' ? null : '请先绑定自己的飞书账号',mock:true}); break;
      case 'minutes.delivery.open':
        if (!deliveryDrafts.has(p.sessionId)) deliveryDrafts.set(p.sessionId, {revision:1,source_fingerprint:'mock-source-'+p.sessionId,title:'首版上线方案与预算',content:'会议结论（模拟）\n预算上限为10万。\n待办：核对并提交新方案，负责人和期限待人工核对。\n未决：13万方案如何满足预算？',recipients:[],permission:'view'});
        deliveryReply(p, flow === 'minutes-source-changed' ? 'source_changed' : 'ready'); break;
      case 'minutes.delivery.save': {
        const draft = deliveryDrafts.get(p.sessionId);
        if (feishuStatus !== 'connected') { deliveryReply(p,'expired',{message:'请先绑定自己的飞书账号'}); break; }
        if (!draft || p.revision !== draft.revision || flow === 'minutes-source-changed') {deliveryReply(p,'source_changed',{message:'来源或草稿版本已变化，请重新读取后核对'});break;}
        if (!p.title?.trim() || !p.content?.trim() || !Array.isArray(p.recipients) || p.recipients.some(id => !feishuPeople.some(person => person.open_id === id))) {deliveryReply(p,'failed',{message:'请核对正文和可访问的收件人'});break;}
        deliveryDrafts.set(p.sessionId,{...draft,title:p.title.trim(),content:p.content.trim(),recipients:p.recipients.map(id => feishuPeople.find(person => person.open_id === id)),permission:p.permission === 'edit' ? 'edit' : 'view',revision:draft.revision+1});
        deliveryReply(p,'ready'); break;
      }
      case 'minutes.delivery.confirm': {
        const draft = deliveryDrafts.get(p.sessionId), old = deliveryOperations.get(p.opId);
        if (old) {deliveryReply(p,old.status,{op_id:p.opId,receipt:old.receipt});break;}
        if (feishuStatus !== 'connected' || !draft || p.revision !== draft.revision || !draft.recipients.length || !p.confirmed || !p.opId) {deliveryReply(p,'failed',{message:'账号、草稿版本、收件人或确认无效'});break;}
        const op = {sessionId:p.sessionId,status:flow === 'minutes-delivery-partial' ? 'partial' : 'pending',receipt:null};deliveryOperations.set(p.opId,op);
        if (flow === 'minutes-delivery-timeout') break;
        deliveryReply(p,op.status,{op_id:p.opId});break;
      }
      case 'minutes.delivery.status': {
        const op = deliveryOperations.get(p.opId);
        if (!op || op.sessionId !== p.sessionId) {deliveryReply(p,'not_found',{message:'没有找到这次操作，请人工核对，不自动重发'});break;}
        if (op.status === 'pending') {op.status='sent';op.receipt={message:'模拟回执：文档已按本次所选收件人与权限交付，未向真实飞书发送。'};}
        deliveryReply(p,op.status,{op_id:p.opId,receipt:op.receipt});break;
      }
      case 'hello': queueMicrotask(() => emit('snapshot', { state, transcript, summary: summary(), team, insets: { top: 0, bottom: 0 } }));break;
      case 'capture.meeting':
        if (!state.capturing || state.recordingMode !== 'daily') throw new Error('请先开始日常聆听，再切换正式会议');
        if (p.recordingMode !== 'meeting' || p.cloudSaveConfirmed !== true) throw new Error('须明确选择本次云端保存');
        // A separate session begins now, with no implicit import of the previous buffer.
        clearInterval(timer); state.capturing = false;
        // fall through
      case 'capture.start':
        if (state.capturing) break;
        if (!['daily','meeting'].includes(p.recordingMode || 'daily')) throw new Error('记录方式无效');
        if (p.recordingMode === 'meeting' && p.cloudSaveConfirmed !== true) throw new Error('须明确选择本次云端保存');
        if (![7,30,90].includes(p.audioRetentionDays ?? 30) || ![7,30,90].includes(p.transcriptRetentionDays ?? 30)) throw new Error('保存期限无效');
        Object.assign(state,{recordingMode:p.recordingMode || 'daily',cloudSaveConfirmed:p.recordingMode==='meeting',audioRetentionDays:p.audioRetentionDays ?? 30,transcriptRetentionDays:p.transcriptRetentionDays ?? 30,memorySync:p.recordingMode==='meeting'});
        stopClip();transcript = [];sessionTranscript = [];cards.clear();drafts.clear();emitted.clear();state.sessionId = id('session');
        state.notices = []; state.digestCounts = {};
        Object.assign(state, { capturing: true, sourceReady: true, sessionMs: 0, bufferedMs: 0, asr: 'simulated', commitmentCount: 0, analysisPending: 0, analysisFailed: 0, tagsSupported: null });
        startedAt = performance.now();emit('state', { ...state });clearInterval(timer);timer = setInterval(tick, 100);break;
      case 'capture.stop':
        state.capturing = false;state.sourceReady = false;state.asr = 'off';state.level = 0;clearInterval(timer);stopClip();
        if (state.recordingMode === 'daily') {
          const ids=transcript.map(u=>u.id); transcript=[];sessionTranscript=[];cards.clear();drafts.clear();
          Object.assign(state,{sessionId:'',sessionMs:0,bufferedMs:0,notices:[],digestCounts:{},commitmentCount:0});
          emit('transcript.pruned',{ids});emit('capture.cleared',{mode:'daily'});emit('session.summary',summary());
        }
        emit('state', { ...state });break;
      case 'ask.session': void recall({...p, ask: true}); break;
      case 'agenda.set':
        state.agenda = {goal: p.goal, items: p.items.map((i,n) => ({id: 'a'+(n+1), title: i.title, plannedMs: i.minutes ? i.minutes * 60000 : null, coveredMs: 0})), plannedMs: p.minutes ? p.minutes * 60000 : null, tracking: 'supported'}; emit('state', {...state}); break;
      case 'agenda.clear': state.agenda = {goal: '', items: [], tracking: 'waiting'}; emit('state', {...state}); break;
      case 'notice.dismiss': {const n = state.notices.find(x => x.id === p.id); if (n) n.dismissed = true; emit('state', {...state}); emit('session.summary', summary()); break;}
      case 'notice.feedback': {const n = state.notices.find(x => x.id === p.id); if (n) n.useful = p.useful; emit('state', {...state}); emit('session.summary', summary()); break;}
      case 'digest.openMany': {
        const rows = sessionTranscript.filter(u => p.ids.includes(u.id));
        const card = {id: id('c'), trigger: 'conflict', single: rows.length === 1, engine: 'browser-mock', latencyMs: 0, items: rows.map(u => ({...u, prob: 1})), pool: rows}; cards.set(card.id, card); emit('recall.card', card); break;
      }
      case 'meeting.retain': {
        const fail=(message,sourceChanged=false)=>emit('error',{scope:'retention',operation:'meeting.retain',sessionId:p.sessionId,requestId:p.requestId,message,sourceChanged});
        if(p.confirm!==true || !p.evidence?.length || p.evidence.length>50 || (p.summaries || []).length>20) return fail('请先核对并选择必要短依据');
        if(p.sessionId!==state.sessionId && !mockMeetings.some(m=>m.session_id===p.sessionId)) return fail('会议不存在');
        const rows=p.sessionId===state.sessionId?sessionTranscript:historicalRows;
        if(p.evidence.some(x=>!rows.some(u=>u.id===x.id && u.text===x.sourceText && x.quote?.trim() && x.quote.length<=280 && u.text.includes(x.quote))))return fail('来源已变化，请重新打开并核对',true);
        const ids=p.evidence.map(x=>x.id);
        if((p.summaries || []).some(x=>!x.text?.trim() || x.text.length>2000 || !x.source_ids?.length || x.source_ids.length>10 || x.source_ids.some(id=>!ids.includes(id))))return fail('摘要须绑定本次选定短依据');
        retainedEvidence=[...retainedEvidence.filter(x=>!ids.includes(x.id)),...p.evidence.map(x=>({id:x.id,text:x.quote,confirmed:true,excerpt:true,source_status:'available',confirmed_at:new Date().toISOString()}))];
        const summaryIds=(p.summaries || []).map(x=>x.id);
        retainedSummaries=[...retainedSummaries.filter(x=>!summaryIds.includes(x.id)),...(p.summaries || []).map(x=>({...x,confirmed:true,source_status:'available'}))];
        emit('meeting.retained',{sessionId:p.sessionId,session_id:p.sessionId,requestId:p.requestId,retained_evidence:retainedEvidence,retained_summaries:retainedSummaries});break;
      }
      case 'history.list': emit('history.list', {requestId: p.requestId || '', count: mockMeetings.length, items: mockMeetings.map((m) => ({...m, title: m.manualTitle || m.goal, review_pending: {all: itemQueue(mockItems()).length}}))}); break;
      case 'history.open': {
        if (p.sessionId === state.sessionId) {
          const rows = sessionTranscript.map((u) => ({id: u.id, text: u.text, start_ms: u.startMs, end_ms: u.endMs, tag: u.tag, speaker: u.speaker || null}));
          return emit('history.open', {session_id: state.sessionId, sessionId: p.sessionId, requestId: p.requestId || '', started_at: new Date().toISOString(), utterances: rows, review_queue: reviewQueue(rows),
            digest: {constraint: [], commitment: [], decision: [], idea: []}, notices: []});
        }
        const meeting = mockMeetings.find(i => i.session_id === p.sessionId); if (!meeting) return emit('error', {scope: 'history', operation: 'history.open', sessionId: p.sessionId, requestId: p.requestId || '', message: '会议已删除'});
        emit('history.open', {...meeting, sessionId: p.sessionId, requestId: p.requestId || '', project: meeting.project || null, display_title: meeting.manualTitle || meeting.goal, title_source: meeting.manualTitle ? 'manual' : 'generated', utterances: historicalRows, items: mockItems(), review_queue: itemQueue(mockItems()),
          digest: {constraint: historicalRows.filter(u => u.tag === 'constraint'), commitment: historicalRows.filter(u => u.tag === 'commitment' && u.review?.verdict !== 'rejected'),
            decision: historicalRows.filter(u => u.tag === 'decision' && u.review?.verdict !== 'rejected'), idea: []}, notices: [],retained_evidence:retainedEvidence,retained_summaries:retainedSummaries}); break;
      }
      case 'history.minutes': {
        const changed = minutesChanged || flow === 'minutes-source-changed';
        const payload = {session_id: p.sessionId, requestId: p.requestId || ''};
        if (flow === 'minutes-pending') Object.assign(payload, {status: 'pending', reason: 'writing'});
        else if (changed) Object.assign(payload, {status: 'unavailable', reason: 'source_changed', message: '核对结果已变化，旧纪要需重新核对。', historical_doc_url: 'https://example.com/historical-minutes'});
        else Object.assign(payload, {status: 'ready', doc_url: null, minutes: {version: 4, substantive: true, theme: '首版上线方案与预算', overview: '首版围绕两周内上线展开，预算上限与方案成本需要核对。', decisions: [{text: '预算上限为10万', ids: ['u1']}], actions: [{owner: '洪玉麟', task: '核对并提交新方案', due: '周五前', priority: 'main', ids: ['u2']}, {owner: '', task: '预约下周评审会议室', due: '', priority: 'other', ids: ['u3']}], topics: [{topic: '上线计划与预算', points: ['先明确首版体验与预算范围'],ids:['u1'],source_status:'available'}], open_questions: [{question: '13万方案如何满足10万预算？', quote: historicalRows.find(u => u.id === 'u3').text, id: 'u3'}], follow_ups: []}, sources: Object.fromEntries(historicalRows.map(u => [u.id, {text: u.text, start_ms: u.start_ms, end_ms: u.end_ms, speaker: u.review?.speaker || u.speaker}]))});
        setTimeout(() => emit('history.minutes', payload), 220); break;
      }
      case 'history.delete': if (p.confirm) {mockMeetings = mockMeetings.filter(i => i.session_id !== p.sessionId); emit('history.delete', {deleted: true, sessionId: p.sessionId, session_id: p.sessionId, requestId: p.requestId || ''});} break;
      case 'projects.list': {
        const groups = {};
        mockMeetings.forEach((m) => { if (m.project) (groups[m.project] ||= []).push(m); });
        setTimeout(() => emit('projects.list', {items: Object.entries(groups).map(([name, ms]) => ({name, meeting_count: ms.length,
          confirmed_decisions: historicalRows.filter((u) => u.review?.verdict === 'confirmed' && ['decision', 'constraint'].includes(u.tag)).length,
          last_started_at: ms[0].started_at}))}), 200); break;
      }
      case 'project.open': {
        const ms = mockMeetings.filter((m) => m.project === p.name).map((m) => ({...m, title: m.manualTitle || m.goal}));
        const decisions = ms.length ? historicalRows.filter((u) => u.review?.verdict === 'confirmed' && ['decision', 'constraint'].includes(u.tag))
          .map((u) => ({...u, session_id: 'demo', started_at: ms[0].started_at, meeting_title: ms[0].title})) : [];
        setTimeout(() => emit('project.open', {name: p.name, meetings: ms, decisions, tasks: ms.length ? mockTasks.slice(0, 1) : [],
          unreviewed_decisions: historicalRows.filter((u) => u.tag === 'decision' && !u.review?.verdict).length}), 200); break;
      }
      case 'meeting.project': {
        const meeting = mockMeetings.find((m) => m.session_id === p.sessionId);
        if (meeting) meeting.project = p.project || null;
        setTimeout(() => emit('meeting.project', {session_id: p.sessionId, project: p.project || null}), 200); break;
      }
      case 'history.rename': {
        const meeting = mockMeetings.find((m) => m.session_id === p.sessionId);
        if (meeting) { meeting.manualTitle = p.title || null; }
        const title = p.title || '上线方案评审（模拟）';
        setTimeout(() => emit('history.renamed', { session_id: p.sessionId, title, title_source: p.title ? 'manual' : 'generated' }), 200); break;
      }
      case 'history.search': emit('history.search', {requestId: p.requestId || '', query: p.query, engine: 'browser-mock', items: mockMeetings.length ? historicalRows.map(u => ({...u, id: 'h:demo:'+u.id, session_id: 'demo', started_at: '2026-10-06T09:00:00+08:00', prob: .9})) : []}); break;
      case 'recall.trigger': void recall(p);break;
      case 'digest.open':
      case 'commitment.open': {
        const u = sessionTranscript.find((u) => u.id === p.utteranceId);
        if (!u) break;
        const at = sessionTranscript.indexOf(u);
        const card = { id: id('c'), trigger: 'commitment', query: null, nowMs: state.sessionMs,
          single: true, engine: 'rules-mock', windowMs: 0, latencyMs: 0, items: [{ ...u, prob: 1 }],
          pool: sessionTranscript.slice(Math.max(0, at - 2), at + 3) };
        cards.set(card.id, card); emit('recall.card', card); break;
      }
      case 'clip.play':
        stopClip();
        if (preview) { emit('clip.state', {key:p.key,state:'unavailable'});emit('toast',{message:'此示例只演示文字流程，未提供原声。'});break; }
        if (p.startMs < state.sessionMs - state.retentionMs && !sessionTranscript.some((u) => u.tag === 'commitment' && u.startMs <= p.startMs && u.endMs >= p.endMs)) { emit('clip.state', { key: p.key, state: 'expired' });break; }
        playingKey = p.key;audio.currentTime = Math.max(0, p.startMs / 1000);state.playing = true;
        emit('clip.state', { key: p.key, state: 'playing' });
        audio.play().catch(() => { emit('toast', { message: '浏览器未允许音频播放，请再次点击回听' });stopClip(); });
        clipTimer = setTimeout(stopClip, Math.max(100, p.endMs - p.startMs));break;
      case 'clip.stop': stopClip();break;
      case 'clip.remote': emit('clip.state', { key: p.key, state: 'unavailable' }); emit('toast', { message: '浏览器没有服务器录音，请在 Android App 中回听' }); break;
      case 'speaker.correct': {
        minutesChanged = true;
        const u = sessionTranscript.find((x) => x.id === p.utteranceId);
        if (p.sessionId === state.sessionId && u) { u.manualSpeaker = p.speaker; emit('speaker.corrected', { ...p, status: 'local' }); }
        const h = historicalRows.find((x) => x.id === p.utteranceId);
        if (h) { h.review = {...(h.review || {}), speaker: p.speaker}; if (p.speaker == null) delete h.review.speaker; }
        setTimeout(() => emit('speaker.corrected', { ...p, status: 'saved' }), 300); break;
      }
      case 'items.review': {
        const it = mockItems().find((x) => x.id === p.itemId);
        if (!it) return emit('error', {scope: 'items', sessionId: p.sessionId, itemId: p.itemId, message: '纪要里没有这件事'});
        const stamp = {fingerprint: it.fingerprint, by: state.selfName || null, at: new Date().toISOString()};
        if (p.action === 'reopen') delete mockItemReviews[it.id];
        else if (p.action === 'reject') mockItemReviews[it.id] = {status: 'rejected', ...stamp};
        else if (p.action === 'merge') mockItemReviews[it.id] = {status: 'merged', into: p.into, ...stamp};
        else if (p.action === 'confirm') {
          const kind = p.kind || it.kind;
          if (kind === 'task' && !p.owner) return emit('error', {scope: 'items', sessionId: p.sessionId, itemId: p.itemId, message: '待办需要先选负责人'});
          const title = p.title || it.title, due = p.due ?? it.due ?? '';
          mockItemReviews[it.id] = {status: 'confirmed', kind, title, due, owner: kind === 'task' ? p.owner : null,
            edited: kind !== it.kind || title !== it.title || due !== (it.due || ''), ...stamp};
        }
        const items = mockItems();
        setTimeout(() => emit('items.saved', {sessionId: p.sessionId, itemId: p.itemId, items, review_queue: itemQueue(items)}), 200); break;
      }
      case 'review.set': {
        minutesChanged = true;
        const u = historicalRows.find((x) => x.id === p.utteranceId);
        if (u) u.review = {...(u.review || {}), ...p.fields};
        setTimeout(() => emit('review.saved', {sessionId: p.sessionId, utteranceId: p.utteranceId, review: u?.review || p.fields}), 200); break;
      }
      case 'tasks.list': {
        if (p.mine && !state.selfName) throw new Error('请先在设置里选择本人');
        const selfName = state.selfName || '';
        const all = mockTasks.filter((t) => (!p.mine || t.who === state.selfName) && (p.status === 'all' || t.feishu.state === p.status || (p.status === 'open' && t.feishu.state === 'unknown')));
        setTimeout(() => emit('tasks.list', { items: all, parsed_items: [], meeting_items: [], parsed_status: {state: 'disabled', meetings: [], counts: {total: 0}}, requestId: p.requestId || '', mine: p.mine, status: p.status, selfName }), 300); break;
      }
      case 'recall.dismiss': cards.delete(p.cardId);break;
      case 'recall.save': {
        const c = cards.get(p.cardId);if (!c) throw new Error('卡片已失效');
        const item = { id: c.id, saved_at: new Date().toISOString(), utterances: c.pool.filter((u) => p.utteranceIds.includes(u.id)), audio_expired: false };
        saved = saved.filter((x) => x.id !== c.id);saved.unshift(item);if (!preview) localStorage.setItem(key, JSON.stringify(saved));
        state.savedCount = saved.length;emit('recall.saved', { cardId: c.id, savedCount: saved.length });break;
      }
      case 'daily.candidate.discard': dailyCandidates=dailyCandidates.filter(x=>x.id!==p.id || x.session_id!==p.sessionId);emit('daily.candidates',{items:dailyCandidates});break;
      case 'daily.candidates': emit('daily.candidates',{items:dailyCandidates});break;
      case 'daily.candidate.confirm': {
        if (p.confirmed !== true || !p.quote?.trim() || p.quote.length > 280) throw new Error('请先核对1–280字短依据');
        const candidate=dailyCandidates.find(x=>x.id===p.id && x.session_id===p.sessionId);
        if (!candidate) throw new Error('候选已失效');
        const savedId=`daily-${p.sessionId}-${p.id}`;
        saved=saved.filter(x=>x.id!==savedId);
        saved.push({id:savedId,session_id:p.sessionId,saved_at:new Date().toISOString(),visibility:'private',confirmed:true,audio_expired:true,original_available:false,utterances:[{id:p.id,text:p.quote,start_ms:candidate.start_ms,end_ms:candidate.end_ms}]});
        dailyCandidates=dailyCandidates.filter(x=>x!==candidate);state.savedCount=saved.length;
        if (!preview) localStorage.setItem(key,JSON.stringify(saved));
        emit('recall.saved',{cardId:savedId,savedCount:saved.length});break;
      }
      case 'saved.list': emit('saved.items', { items: saved });break;
      case 'action.draft': void draft(p).catch((e) => emit('error', { scope: 'action', message: e.message }));break;
      case 'action.confirm': void confirm(p).catch((e) => emit('error', { scope: 'action', message: e.message }));break;
      case 'action.status': {
        const r = actions.get(draftOps.get(p.draftId));
        if (r) emit('action.result', r);else emit('action.result', { draftId: p.draftId, opId: draftOps.get(p.draftId), status: 'pending', polling: false, mock: true, message: '模拟操作仍在处理，请继续查询' });break;
      }
      case 'voiceprint.list':
      case 'voiceprint.record':
      case 'voiceprint.save':
      case 'voiceprint.delete':
        state.voiceprint = {phase: 'idle', message: '浏览器不录入真实声纹，请在已连接服务器的 Android App 中使用'};
        emit('state', {...state});break;
      case 'voiceprint.cancel': break;
      case 'settings.set':
        state.source = p.source || state.source;
        if ('backendBaseUrl' in p) state.backendUrl = p.backendBaseUrl || '';
        if ('speakerInfo' in p) state.speakerInfo = !!p.speakerInfo;
        state.remoteAddress = p.remoteAddress || state.remoteAddress;
        ['voiceTrigger','noticeVibrate','memorySync','selfName'].forEach(k => { if (k in p) state[k] = p[k]; });
        emit('state', { ...state });emit('settings.saved', {requestId: p.requestId || '', mock: true});emit('toast', { message: '浏览器只模拟后端；真实配置请在 Android App 中设置' });break;
      case 'testAudio.pick': emit('toast', { message: '外部 WAV 导入请在 Android App 中使用' });break;
      case 'testAudio.reset': state.testWavName = '内置合成对话（浏览器模拟）';emit('state', { ...state });break;
      case 'open.url': if (preview) emit('toast', {message: '模拟历史链接，没有打开真实文档或任务。'}); else if (/^https?:\/\//.test(p.url)) window.open(p.url, '_blank', 'noopener');break;
      default: break;
    }
  }
})();
