/* Roadshow-only transport. No reference to the Android bridge, network, storage or media APIs. */
((root) => {
  'use strict';
  if (!/\/roadshow-demo\.html$/.test(root.location?.pathname || '') && root.OOPS_ROADSHOW_DEMO_DOCUMENT !== true) return;
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const rows = value => Array.isArray(value) ? value : [];
  const uid = prefix => prefix + '-' + root.crypto.randomUUID();
  const iso = () => new Date().toISOString();
  const data = copy(root.OopsRoadshowDemoData || {});
  const DEMO = '';
  const hash = 'd'.repeat(64); // UI fixture fingerprint only; never an authorization contract.
  const people = rows(data.team).length ? rows(data.team).map(x => typeof x === 'string' ? x : x.name) : ['林春源', '洪玉麟', '江古月', 'Lydia'];
  const kinds = ['身份', '偏好', '目标', '经历', '日常'];
  const state = { capturing:false, sessionId:'', sessionMs:0, bufferedMs:0, retentionMs:300000,
    recordingMode:'daily', cloudSaveConfirmed:false, audioRetentionDays:30, transcriptRetentionDays:30,
    asr:'off', level:0, playing:false, source:'mic', sourceReady:false, backend:'mock', backendUrl:'', mockBackend:true,
    selfName:people[0], voiceTrigger:true, noticeVibrate:false, memorySync:false, syncStatus:'synced', syncPending:0,
    savedCount:0, tagsSupported:true, analysisPending:0, analysisFailed:0, digestCounts:{}, notices:[],
    agenda:{goal:'产品路演准备',items:[],tracking:'supported'}, asrGaps:[], testWavName:'文字记录',
    voiceprint:{phase:'idle',catalog:{people:people.map(name=>({name,registered:false}))}}, insets:{top:0,bottom:0},
    ...copy(data.state || {}),
  };
  // The seed may describe a screen, never a live connection or active real recording.
  Object.assign(state,{backend:'mock',backendUrl:'',mockBackend:true,capturing:false,sourceReady:false,asr:'off',playing:false});
  const fallbackText = [
    [people[0],'我们先把路演体验入口、视频和源码整理到同一个页面。','commitment'],
    [people[3] || people[0],'先给我一个可以打开的草稿，看完后再决定是否提交。','constraint'],
    [people[1] || people[0],'录音豆接入、会议核对与成果回流都要说明真实状态。','decision'],
    [people[3] || people[0],'我希望产品说明简洁，保留原话依据，重要动作由我确认。','idea'],
    [people[0],'完整功能录屏还要补充，并检查手机端阅读效果。','commitment'],
    [people[1] || people[0],'跨端的结果回到原任务，完成仍等本人验收。','constraint'],
  ];
  function utterance(value, n, sid) {
    const start = Number(value.start_ms ?? value.startMs ?? n*16000);
    const end = Number(value.end_ms ?? value.endMs ?? start+8000);
    return {...value,id:value.id || sid+'-u'+(n+1),text:String(value.text || value.quote || ''),start_ms:start,end_ms:end,
      tag:value.tag || ['idea','commitment','decision'][n%3],speaker:value.speaker || people[n%people.length],mock:true};
  }
  function defaultMeeting(n=0) {
    const sid='demo-meeting-'+(n+1), texts=fallbackText.map(([speaker,text,tag],i)=>utterance({speaker,text,tag},i,sid));
    return {session_id:sid,title:['路演准备与协作推进','录音豆产品体验讨论','个人记忆与隐私设计'][n%3]+DEMO,
      display_title:['路演准备与协作推进','录音豆产品体验讨论','个人记忆与隐私设计'][n%3]+DEMO,
      started_at:'2026-10-17T02:00:00Z',ended_at:'2026-10-17T02:18:00Z',project:n===2?'个人助理探索':'Oops 决赛准备',
      utterances:texts,items:[{id:sid+'-task',kind:'task',title:'整理体验入口、功能视频与源码'+DEMO,detail:'先交草稿，查看后再决定提交。',due:'路演前',owner_hint:people[0],ids:[texts[0].id,texts[1].id]},
        {id:sid+'-decision',kind:'decision',title:'保留原话依据并明确真实范围'+DEMO,ids:[texts[2].id]},
        {id:sid+'-open',kind:'open',title:'完整功能录屏如何安排？'+DEMO,ids:[texts[4].id]}]};
  }
  let meetingSeed=rows(data.meetings || data.history?.items || data.historyItems);
  if (!meetingSeed.length) meetingSeed=[defaultMeeting(0),defaultMeeting(1),defaultMeeting(2)];
  const details=data.meetingDetails || data.details || data.history?.details || {};
  const minuteSeeds=data.minutes || data.meetingMinutes || {};
  const meetings=meetingSeed.map((entry,n)=>{
    const sid=entry.session_id || entry.id || 'demo-meeting-'+(n+1), detail=details[sid] || {};
    const m={...defaultMeeting(n),...entry,...detail,session_id:sid,mock:true};
    m.display_title=m.display_title || m.title || m.goal || '会议'+DEMO;
    m.title=m.title || m.display_title;
    m.utterances=rows(m.utterances || m.transcript).map((u,i)=>utterance(u,i,sid));
    if (!m.utterances.length && !m.read_only_snapshot) m.utterances=defaultMeeting(n).utterances.map((u,i)=>utterance({...u,id:sid+'-u'+(i+1)},i,sid));
    m.items=rows(m.items).map((it,i)=>({...it,id:it.id || sid+'-item-'+i,fingerprint:it.fingerprint || hash,ids:rows(it.ids).length?it.ids:m.utterances.slice(i,i+1).map(u=>u.id),mock:true}));
    m.minutes=minuteSeeds[sid] || m.minutes || null;
    return m;
  });
  const personalSeed=data.personal || {};
  let personal=rows(personalSeed.items || data.personalMemories || data.personalItems).map((item,n)=>({id:item.id || uid('personal'),
    title:item.title || '偏好线索'+DEMO,body:item.body || item.text || '',kind:kinds.includes(item.kind)?item.kind:'日常',createdAt:Date.now()-86400000,updatedAt:Date.now(),...item,mock:true}));
  if (!personal.length) personal=kinds.map((kind,n)=>({id:uid('personal'),kind,title:[ '团队中的角色','表达方式偏好','路演准备目标','产品迭代经历','今天值得留下的想法'][n]+DEMO,
    body:['参与产品需求梳理与体验设计，重要信息仍需本人核对。','偏好：先给结论，保留依据，再说明下一步。','目标：把体验、视频与源码集中展示。','经历：参与录音硬件到移动应用的协作设计。','想法：成果应回到原任务，避免重复寻找。'][n],createdAt:Date.now()-86400000,updatedAt:Date.now(),mock:true}));
  let typed=rows(personalSeed.candidates || data.personalCandidates || data.typedCandidates).map((item,n)=>({...item,id:item.id || 'demo-personal-'+n,
    session_id:item.session_id || 'demo-daily-1',version:item.version || 1,source_fingerprint:item.source_fingerprint || hash,status:'candidate',kind:kinds.includes(item.kind)?item.kind:'偏好',
    title:item.title || '待核对的偏好'+DEMO,summary:item.summary || item.text || '希望重要内容简洁并保留依据。',
    evidence:rows(item.evidence).length?item.evidence:[{id:'demo-personal-u'+n,quote:'我希望重要内容简洁，并保留原话依据。',start_ms:10000,end_ms:14000}],createdAt:Date.now(),updatedAt:Date.now(),subject_confirmed:false,original_available:false,mock:true}));
  if (!typed.length) typed=[{id:'demo-personal-candidate-1',session_id:'demo-daily-1',utterance_id:'demo-personal-u1',version:1,source_fingerprint:hash,
    status:'candidate',kind:'偏好',title:'偏好先结论、后依据'+DEMO,summary:'希望说明简洁，重要结论保留原话依据。',text:'希望说明简洁，重要结论保留原话依据。',
    evidence:[{id:'demo-personal-u1',quote:'我希望产品说明简洁，保留原话依据，重要动作由我确认。',start_ms:48000,end_ms:56000}],createdAt:Date.now(),updatedAt:Date.now(),subject_confirmed:false,original_available:false,mock:true}];
  const dailySeed=data.daily || {};
  let daily=rows(dailySeed.candidates || data.dailyCandidates).map((x,n)=>({...x,id:x.id || 'demo-daily-u'+n,session_id:x.session_id || 'demo-daily-1',quote:x.quote || x.text || x.summary || '',tag:x.tag || 'idea',confirmed:false,status:'candidate',visibility:'private',original_available:false,updated_at:x.updated_at || iso(),mock:true}));
  if (!daily.length) daily=fallbackText.slice(0,4).map(([,quote,tag],n)=>({id:'demo-daily-u'+n,session_id:'demo-daily-1',quote,summary:quote,tag,start_ms:n*16000,end_ms:n*16000+8000,status:'candidate',visibility:'private',confirmed:false,original_available:false,updated_at:iso(),mock:true}));
  let saved=rows(dailySeed.saved_items || data.savedItems).map(x=>({...x,mock:true}));
  const receipts=new Map(rows(dailySeed.sessions || data.dailySessions).map(x=>[x.session_id,{...x,cleanup:{status:'cleared',temporary_audio_cleared:true,temporary_transcript_cleared:true,source_stopped:true},mock:true}]));
  if (data.dailyReceipt?.session_id) receipts.set(data.dailyReceipt.session_id,{...data.dailyReceipt,mock:true});
  if (!receipts.size) receipts.set('demo-daily-1',{session_id:'demo-daily-1',ended_at:'2026-10-17T01:30:00Z',candidate_count_at_end:daily.length,saved_count_at_end:saved.length,cleanup:{status:'cleared',temporary_audio_cleared:true,temporary_transcript_cleared:true,source_stopped:true},mock:true});
  let candidates=rows(data.candidates || data.taskCandidates || data.tasks?.candidates || data.parsedItems || data.reviewTasks);
  if (!candidates.length) candidates=meetings.flatMap(m=>m.items.filter(it=>it.kind==='task').map(it=>({id:'label:'+m.session_id+':'+it.id,item_id:it.id,source:'label_review',kind:'task',
    title:it.title,what:it.title,detail:it.detail || '先核对范围，再准备交接。',due:it.due || '',fingerprint:it.fingerprint,
    source_meeting:{id:m.session_id,title:m.title,started_at:m.started_at},evidence:m.utterances.filter(u=>it.ids.includes(u.id)),reviews:[],source_status:'current',review_contract_version:1,mock:true})));
  // `current` below is only the legacy UI's readable-fixture state. The original demo_only
  // marker remains explicit; it is not an authorization contract and cannot reach native.
  candidates=candidates.map(x=>({...x,item_id:x.item_id || x.id,source:'label_review',kind:x.kind || 'task',fingerprint:x.fingerprint || hash,
    demo_source_status:x.source_status || 'demo_only',source_status:'current',reviews:rows(x.reviews),evidence:rows(x.evidence),mock:true}));
  const meetingTaskItems=rows(data.meetingTaskItems).map(x=>({...x,item_id:x.item_id || x.id,source:'meeting_review',kind:x.kind || 'task',fingerprint:x.fingerprint || hash,
    demo_source_status:x.source_status || 'demo_only',source_status:'current',reviews:rows(x.reviews),evidence:rows(x.evidence),mock:true}));
  let tasks=rows(Array.isArray(data.tasks)?data.tasks:data.tasks?.items || data.formalTasks).map((x,n)=>({...x,op_id:x.op_id || 'demo-op-'+n,
    demo_source_status:x.source_status || 'demo_only',source_status:'current',mock:true}));
  if (!tasks.length) tasks=meetings.slice(0,2).map((m,n)=>({op_id:'demo-op-'+n,what:['整理功能素材','检查移动端展示与资料入口'][n]+DEMO,who:people[n%people.length],when:{raw:'路演前'},quote:m.utterances[0]?.text,
    meeting:{session_id:m.session_id,title:m.title,started_at:m.started_at},url:null,overdue:false,feishu:{state:n?'done':'open'},mock:true}));
  tasks=tasks.map((t,n)=>({...t,what:(t.demo_status==='demo_completed'?'[草稿待核对] ':t.demo_status_label?'['+t.demo_status_label+'] ':'')+(t.what || t.title || '待办'),
    url:'demo-task:'+(t.id || t.op_id || 'demo-task-'+n),mock:true}));
  const projectSeeds=rows(data.projects?.items || data.projects);
  const cards=new Map(), drafts=new Map(), actions=new Map(), personalReceipts=new Map(), typedReceipts=new Map(), deliveries=new Map();
  let transcript=[], tickTimer=null, tickAt=0, paused=false, recorded=0, reviewRevision=1, feishuConnected=true;
  const transport={onmessage:null,postMessage(raw){
    let packet;
    try { packet=JSON.parse(raw); if (!packet || typeof packet.type!=='string') throw new Error('无效命令'); dispatch(packet.type,packet.payload || {}); }
    catch (error) { fail(packet?.type || 'demo',packet?.payload || {},error.message || '操作未能处理'); }
  }};
  root.OopsDemoTransport=transport;
  function emit(type,p={}) { const packet={type,payload:{...copy(p),mock:true,demo:true}}; queueMicrotask(()=>transport.onmessage?.({data:JSON.stringify(packet)})); }
  function toast(message) { emit('toast',{message}); }
  function fail(type,p,message,scope) { emit('error',{...p,operation:type,scope:scope || (type.startsWith('history.')?'history':type.startsWith('personal.')?'personal':type.startsWith('tasks.')?'taskCandidates':type.startsWith('project')?'projects':'demo'),code:'DEMO_BLOCKED',blocked:true,message}); }
  function meeting(id) { const m=meetings.find(x=>x.session_id===id); if (!m) throw new Error('未找到这场会议'); return m; }
  function readOnly(value) { if (value?.read_only_snapshot || value?.provenance?.kind==='real_snapshot') throw new Error('当前内容仅可阅读'); }
  function itemQueue(m) { return m.items.filter(x=>!x.review).map(x=>({kind:'item',id:x.id,item_kind:x.kind})); }
  function evidence(m,it) { return rows(it.evidence).length?it.evidence:m.utterances.filter(u=>rows(it.ids).includes(u.id)); }
  function present(m) { return {...copy(m),sessionId:m.session_id,display_title:m.display_title || m.title,utterance_count:m.utterances.length,effective_utterance_count:m.utterances.length,
    asr_closure:m.asr_closure || 'acknowledged',transcript_status:m.transcript_status || 'available',
    digest:Object.fromEntries(['constraint','commitment','decision','idea'].map(t=>[t,m.utterances.filter(u=>u.tag===t)])),
    items:m.items.map(it=>({...it,evidence:evidence(m,it),review:it.review || null,stale:false,stale_review:false})),review_queue:itemQueue(m),review_pending:{all:itemQueue(m).length},notices:rows(m.notices)}; }
  function minuteResult(m) {
    const raw=m.minutes; if (raw?.status) return copy(raw);
    const value=raw || {version:5,substantive:true,theme:m.title,overview:'围绕产品体验、人工核对、执行回流与路演交付展开讨论。',
      actions:m.items.filter(it=>it.kind==='task').map(it=>({task:it.title,owner:it.review?.owner || '',due:it.due || '',ids:it.ids,priority:'main'})),
      decisions:m.items.filter(it=>it.kind==='decision').map(it=>({text:it.title,ids:it.ids})),topics:[{topic:'产品与交付',points:['原话与整理结果分开，关键操作由本人确认。','待办的负责人、期限与执行范围需要继续核对。']}],
      open_questions:m.items.filter(it=>it.kind==='open').map(it=>({question:it.title,id:it.ids?.[0]})),follow_ups:[{title:'核对内容与资料入口'+DEMO}]};
    return {status:'ready',minutes:value,doc_url:null,sources:Object.fromEntries(m.utterances.map(u=>[u.id,{text:u.text,start_ms:u.start_ms,end_ms:u.end_ms,speaker:u.speaker}]))};
  }
  function dailyResult(p={}) {
    const sessions=[...new Set([...receipts.keys(),...daily.map(x=>x.session_id)])].map(sid=>({session_id:sid,ended_at:receipts.get(sid)?.ended_at || null,candidate_count:daily.filter(x=>x.session_id===sid).length,saved_count:saved.filter(x=>x.session_id===sid).length}));
    const sid=p.sessionId || sessions[0]?.session_id || null,receipt=receipts.get(sid) || null;
    return {version:1,requestId:p.requestId || '',requested_session_id:p.sessionId || null,session_id:sid,ended_at:receipt?.ended_at || null,receipt,cleanup:receipt?.cleanup || null,
      candidate_count:daily.filter(x=>x.session_id===sid).length,saved_count:saved.filter(x=>x.session_id===sid).length,total_candidate_count:daily.length,
      candidates:daily.filter(x=>x.session_id===sid),saved_items:saved.filter(x=>x.session_id===sid),sessions,latest_session_id:sessions[0]?.session_id || null,
      storage:{receipt:receipt?'saved':'missing',candidates:'ok',saved:'ok'},errors:[],auto_open:false};
  }
  function dailyReply(p) { emit('daily.candidates',{requestId:p.requestId,session_id:p.sessionId || null,items:daily.filter(x=>!p.sessionId || x.session_id===p.sessionId),storage:{candidates:'ok'}}); emit('daily.results',dailyResult(p)); }
  function summary() { return {session_id:state.sessionId,decisions:transcript.filter(x=>x.tag==='decision'),constraints:transcript.filter(x=>x.tag==='constraint'),ideas:transcript.filter(x=>x.tag==='idea'),commitments:transcript.filter(x=>x.tag==='commitment'),notices:state.notices}; }
  function makeCard(pool,p={},trigger='button') {
    if (!pool.length) { emit('recall.notFound',{reason:'暂时没有可用片段，请先查看已有记录。'}); return; }
    const live=pool.map((u,n)=>({...u,startMs:u.startMs ?? u.start_ms ?? n*1000,endMs:u.endMs ?? u.end_ms ?? n*1000+900}));
    const card={id:uid('demo-card'),trigger,query:p.query || null,nowMs:state.sessionMs,single:live.length===1,engine:'roadshow-demo',windowMs:300000,latencyMs:0,
      items:live.map(x=>({...x,prob:null})),pool:live,sessionId:p.sessionId || state.sessionId || meetings[0]?.session_id,readOnly:!!p.readOnly,mock:true};
    cards.set(card.id,card); emit('recall.card',card);
  }
  function binding(sid,selected,dailyScope=false) { return {version:1,session_id:sid,demo:true,...(dailyScope?{scope:'daily',proof:hash}:{}),context_sources:[],sources:selected.map(u=>({id:u.id,kind:dailyScope?'daily_excerpt':'transcript',text_hash:hash,source_revision:'demo-memory-only',quote:u.text,speaker:u.speaker || null,review:{}}))}; }
  function draft(p,itemMode=false) {
    let sid=p.sessionId || state.sessionId || meetings[0]?.session_id,selected,title,owner='';
    if (itemMode) { const m=meeting(sid);readOnly(m);const it=m.items.find(x=>x.id===p.itemId);if (!it) throw new Error('事项不存在');selected=evidence(m,it);title=it.review?.title || it.title;owner=it.review?.owner || ''; }
    else { const card=cards.get(p.cardId);selected=card?card.pool.filter(x=>!rows(p.utteranceIds).length || p.utteranceIds.includes(x.id)):transcript.slice(-3);sid=card?.sessionId || sid;title=p.what || selected.find(x=>x.tag==='commitment')?.text || '整理本次讨论的下一步'+DEMO; }
    if (!selected?.length) selected=meetings[0].utterances.slice(0,2);
    const d={draftId:uid('demo-draft'),sessionId:sid,requestId:p.requestId,...(itemMode?{sourceItemId:p.itemId}:{}),who:owner,what:title,whenIso:null,whenRaw:'待核对',constraint:'负责人、期限与执行范围待核对',tier:'C',reason:'根据讨论整理的待办草稿',assigneeCandidates:people,reviewStatus:'unreviewed',modelRevision:1,
      evidence:{utteranceIds:selected.map(x=>x.id),quote:selected.map(x=>x.text).join(' '),startMs:selected[0].start_ms ?? selected[0].startMs,endMs:selected.at(-1).end_ms ?? selected.at(-1).endMs,sourceBinding:binding(sid,selected,state.recordingMode==='daily' && sid===state.sessionId)}};
    drafts.set(d.draftId,d);emit('action.draft',d);
  }
  function projectDetail(name) {
    const seeded=projectSeeds.find(x=>x.name===name),ms=meetings.filter(m=>m.project===name),decisions=ms.flatMap(m=>m.items.filter(it=>it.kind==='decision').map(it=>({id:it.id,text:it.title,session_id:m.session_id,meeting_title:m.title,started_at:m.started_at,confirmed:!!it.review,source_status:'current'})));
    return {...copy(seeded || {}),name,meetings:ms.map(present),decisions:rows(seeded?.decisions).length?seeded.decisions:decisions,tasks:tasks.filter(t=>ms.some(m=>t.meeting?.session_id===m.session_id)),meeting_items:candidates.filter(it=>ms.some(m=>it.source_meeting?.id===m.session_id)),unreviewed_decisions:decisions.filter(d=>!d.confirmed).length};
  }
  function personalReply(action,p) {
    const old=personalReceipts.get(p.requestId); if (old) return emit('personal.result',old);
    let item;
    if (action==='list') return emit('personal.result',{requestId:p.requestId,action,ok:true,items:personal});
    item=personal.find(x=>x.id===p.id); readOnly(item);
    if (action==='save') {
      if (!p.title?.trim() || !p.body?.trim() || !kinds.includes(p.kind)) throw new Error('请填写标题、内容和分类');
      if (p.create!==true && !item) throw new Error('这条记录已不存在');
      item={...item,id:p.id || uid('personal'),title:p.title.trim(),body:p.body.trim(),kind:p.kind,createdAt:item?.createdAt || Date.now(),updatedAt:Date.now(),mock:true,demo:true};
      personal=[item,...personal.filter(x=>x.id!==item.id)];
    } else if (action==='delete') { if (!item) throw new Error('这条记录已不存在');personal=personal.filter(x=>x.id!==p.id); }
    const result={requestId:p.requestId,action,ok:true,item,mock:true};personalReceipts.set(p.requestId,result);emit('personal.result',result);toast(action==='delete'?'条目已移除':'条目已更新');
  }
  function typedReply(action,p) {
    if (action==='list') {
      const response={requestId:p.requestId,action,ok:true,version:2,capabilities:{typed_candidates:true,cloud_sync:false},processing_status:'supported',items:typed};
      if (p.check) { const old=typedReceipts.get(p.check.id);response.resolution=old?{id:p.check.id,version:p.check.version,source_fingerprint:p.check.source_fingerprint,action:p.check.action,status:p.check.action==='confirm'?'confirmed':'discarded',memory_id:old.memory?.id || null,memory:old.memory || null}:{...p.check,status:'unresolved'}; }
      return emit('personal.candidates.result',response);
    }
    const existing=typedReceipts.get(p.id);if (existing) return emit('personal.candidates.result',{...existing,requestId:p.requestId});
    const item=typed.find(x=>x.id===p.id);if (!item || item.version!==p.version || item.source_fingerprint!==p.source_fingerprint) throw new Error('请重新核对当前版本');readOnly(item);
    let memory;
    if (action==='confirm') {
      if (!p.subject_confirmed || !p.content_confirmed || !p.title?.trim() || !p.text?.trim() || !kinds.includes(p.kind)) throw new Error('请先核对归属与内容');
      memory={id:uid('personal'),title:p.title.trim(),body:p.text.trim(),kind:p.kind,createdAt:Date.now(),updatedAt:Date.now(),source:'daily_personal_confirmed',source_status:'current',confirmed:true,subject_confirmed:true,
        summary:item.summary,confirmed_text:p.text.trim(),evidence:copy(item.evidence),candidate_id:item.id,candidate_version:item.version,session_id:item.session_id,utterance_id:item.utterance_id,
        source_fingerprint:item.source_fingerprint,confirmedAt:Date.now(),original_available:false,mock:true,demo:true};personal.unshift(memory);
    }
    typed=typed.filter(x=>x.id!==p.id);
    const result={requestId:p.requestId,action,ok:true,version:2,items:typed,memory,mock:true};typedReceipts.set(p.id,result);emit('personal.candidates.result',result);toast(action==='confirm'?'核对内容已更新':'候选已舍弃');
  }
  function captureTick() {
    if (!state.capturing || paused) return;
    state.sessionMs=Math.round(performance.now()-tickAt);state.bufferedMs=Math.min(state.sessionMs,300000);state.level=0.16+Math.sin(state.sessionMs/500)*0.1;
    const next=Math.floor(state.sessionMs/2200);
    while(recorded<Math.min(next,fallbackText.length)) {
      const i=recorded++,[speaker,text,tag]=fallbackText[i],u={id:state.sessionId+'-u'+i,text,speaker,tag,startMs:i*2200,endMs:i*2200+1800,tagEngine:'roadshow-demo',mock:true};transcript.push(u);emit('asr.final',u);emit('asr.tag',u);
      if (state.recordingMode==='daily') daily.push({id:u.id,session_id:state.sessionId,quote:text,summary:text,tag,start_ms:u.startMs,end_ms:u.endMs,confirmed:false,status:'candidate',visibility:'private',original_available:false,updated_at:iso(),mock:true});
    }
    state.digestCounts=Object.fromEntries(['decision','commitment','constraint','idea'].map(t=>[t,transcript.filter(u=>u.tag===t).length]));emit('state',state);emit('session.summary',summary());
  }
  function stopCapture() {
    clearInterval(tickTimer);tickTimer=null;
    const sid=state.sessionId,mode=state.recordingMode;Object.assign(state,{capturing:false,sourceReady:false,asr:'off',level:0,captureControl:'idle'});
    if (mode==='daily') {
      receipts.set(sid,{session_id:sid,ended_at:iso(),candidate_count_at_end:daily.filter(x=>x.session_id===sid).length,saved_count_at_end:saved.filter(x=>x.session_id===sid).length,cleanup:{status:'cleared',temporary_audio_cleared:true,temporary_transcript_cleared:true,source_stopped:true}});
      transcript=[];emit('capture.cleared',{mode:'daily',session_id:sid});Object.assign(state,{sessionId:'',sessionMs:0,bufferedMs:0});emit('daily.ended',{...dailyResult({sessionId:sid}),auto_open:true});
    } else {
      const m=defaultMeeting(meetings.length);Object.assign(m,{session_id:sid,title:'刚才的会议'+DEMO,display_title:'刚才的会议'+DEMO,started_at:new Date(Date.now()-state.sessionMs).toISOString(),ended_at:iso(),utterances:transcript.map((u,n)=>utterance(u,n,sid))});
      m.items=m.items.map((it,n)=>({...it,id:sid+'-item-'+n,ids:m.utterances.slice(n,n+1).map(u=>u.id)}));meetings.unshift(m);
    }
    emit('state',state);toast('文字记录已结束');
  }
  function dispatch(type,p) {
    switch(type) {
      case 'hello': emit('snapshot',{state,transcript,summary:summary(),team:people,insets:{top:0,bottom:0},pendingActions:[]});emit('daily.results',dailyResult());break;
      case 'history.list': {const all=meetings.map(present),visible=all.filter(m=>p.includeEmpty || !m.history_visibility?.hidden_by_default);emit(type,{requestId:p.requestId,items:visible.slice(0,30),count:visible.length,total_count:all.length,hidden_empty_count:all.length-visible.length,include_empty:!!p.includeEmpty,partial:false});break;}
      case 'history.open': emit(type,{...present(meeting(p.sessionId)),requestId:p.requestId});break;
      case 'history.minutes': emit(type,{...minuteResult(meeting(p.sessionId)),session_id:p.sessionId,requestId:p.requestId});break;
      case 'history.search': {const q=String(p.query || '').trim(),all=meetings.flatMap(m=>m.utterances.map(u=>({...u,id:'h:'+m.session_id+':'+u.id,session_id:m.session_id,started_at:m.started_at,prob:null}))),found=all.filter(u=>!q || u.text.includes(q) || meetings.find(m=>m.session_id===u.session_id)?.title.includes(q));emit(type,{requestId:p.requestId,query:q,engine:'roadshow-demo',items:found.length?found:all.slice(0,3)});break;}
      case 'history.rename': {const m=meeting(p.sessionId);readOnly(m);m.title=m.display_title=String(p.title || '会议'+DEMO);emit('history.renamed',{session_id:m.session_id,title:m.title,title_source:'manual'});toast('会议名称已修改');break;}
      case 'history.delete': {const m=meeting(p.sessionId);readOnly(m);if (!p.confirm) throw new Error('请确认删除');meetings.splice(meetings.indexOf(m),1);emit(type,{sessionId:p.sessionId,session_id:p.sessionId,requestId:p.requestId,deleted:true});toast('会议已移除');break;}
      case 'projects.list': {const names=[...new Set([...projectSeeds.map(x=>x.name),...meetings.map(m=>m.project)].filter(Boolean))];emit(type,{requestId:p.requestId,items:names.map(name=>{const d=projectDetail(name);return {name,meeting_count:d.meetings.length,confirmed_decisions:d.decisions.filter(x=>x.confirmed).length,last_started_at:d.meetings[0]?.started_at || iso()};})});break;}
      case 'project.open': emit(type,{...projectDetail(p.name),requestId:p.requestId});break;
      case 'meeting.project': {const m=meeting(p.sessionId);readOnly(m);m.project=p.project || null;emit(type,{sessionId:p.sessionId,session_id:p.sessionId,project:m.project});break;}
      case 'tasks.list': emit(type,{requestId:p.requestId,mine:!!p.mine,status:p.status,selfName:state.selfName,items:tasks.filter(t=>(!p.mine || t.who===state.selfName) && (!p.status || p.status==='all' || t.feishu?.state===p.status)),archived:[]});break;
      case 'tasks.candidates': emit(type,{requestId:p.requestId,parsed_items:candidates,meeting_items:meetingTaskItems,reviewer:state.selfName,parsed_status:{state:'ready',meetings:meetings.map(m=>({id:m.session_id,status:'ready',count:candidates.filter(c=>c.source_meeting?.id===m.session_id).length})),counts:{total:candidates.length}},meeting_items_status:'ready',review_contract_version:1});break;
      case 'tasks.review.open': case 'tasks.review.save': {const it=candidates.find(x=>x.item_id===p.item_id && x.source_meeting?.id===p.source_meeting_id);if (!it) throw new Error('未找到该候选');if (type.endsWith('save')) {readOnly(it);it.reviews=rows(it.reviews).filter(r=>r.by!==state.selfName);if (p.action!=='reopen') it.reviews.push({by:state.selfName,verdict:{confirm:'confirmed',reject:'rejected',merge:'merged'}[p.action],kind:p.kind || 'task',title:p.title || it.title,detail:p.detail || it.detail,due:p.due || '',owner:p.owner || '',into:p.into,updated_at:iso(),mock:true});reviewRevision++;}
        const own=it.reviews.find(r=>r.by===state.selfName);emit(type.endsWith('save')?'tasks.review.saved':'tasks.review.open',{requestId:p.requestId,request_id:p.request_id,source_meeting_id:p.source_meeting_id,item_id:p.item_id,fingerprint:it.fingerprint,revision:reviewRevision,reviewer:state.selfName,item:{...it,review:own?{...own,status:own.verdict}:null},evidence:it.evidence,owners:[...people,'collective','unknown'],can_review:!it.read_only_snapshot,source_status:'current',saved:type.endsWith('save')});break;}
      case 'items.review': {const m=meeting(p.sessionId);readOnly(m);const it=m.items.find(x=>x.id===p.itemId);if (!it) throw new Error('未找到这条事项');if (p.action==='reopen') it.review=null;else it.review={status:{confirm:'confirmed',reject:'rejected',merge:'merged'}[p.action],kind:p.kind || it.kind,title:p.title || it.title,due:p.due ?? it.due ?? '',owner:p.owner || null,into:p.into,fingerprint:it.fingerprint,by:state.selfName,at:iso(),mock:true};emit('items.saved',{sessionId:p.sessionId,itemId:p.itemId,items:present(m).items,review_queue:itemQueue(m)});toast('核对内容已更新');break;}
      case 'review.set': case 'speaker.correct': {const m=meetings.find(x=>x.session_id===p.sessionId);readOnly(m);const u=m?.utterances.find(x=>x.id===p.utteranceId) || transcript.find(x=>x.id===p.utteranceId);if (!u) throw new Error('未找到对应片段');u.review={...u.review,...(p.fields || {}),...(type==='speaker.correct'?{speaker:p.speaker}:{})};emit(type==='review.set'?'review.saved':'speaker.corrected',{...p,review:u.review,status:'saved'});break;}
      case 'personal.list': case 'personal.save': case 'personal.delete': personalReply(type.slice(9),p);break;
      case 'personal.candidates': typedReply('list',p);break;
      case 'personal.candidate.confirm': typedReply('confirm',p);break;
      case 'personal.candidate.discard': typedReply('discard',p);break;
      case 'daily.results': {const result={...dailyResult(p),auto_open:p.autoOpen===true};emit(type,result);if(p.autoOpen===true)emit('daily.ended',result);break;}
      case 'daily.candidates': dailyReply(p);break;
      case 'daily.candidate.confirm': case 'daily.candidate.discard': {const it=daily.find(x=>x.id===p.id && x.session_id===p.sessionId);if (!it) throw new Error('候选已不在当前列表');readOnly(it);if (type.endsWith('confirm')) {if (!p.confirmed || !p.quote?.trim()) throw new Error('请先核对内容');saved.unshift({id:'daily-'+p.id,session_id:p.sessionId,saved_at:iso(),confirmed:true,audio_expired:true,original_available:false,visibility:'private',quote:p.quote,utterances:[{id:p.id,text:p.quote,start_ms:it.start_ms,end_ms:it.end_ms}],mock:true});}
        daily=daily.filter(x=>x!==it);state.savedCount=saved.length;dailyReply({sessionId:p.scopeSessionId || p.sessionId,requestId:p.requestId});toast('重点已处理');break;}
      case 'saved.list': emit('saved.items',{items:saved});break;
      case 'recall.trigger': emit('recall.pending');makeCard(transcript.length?transcript:meetings[0]?.utterances.slice(0,3) || [],p);break;
      case 'ask.session': {const q=String(p.query || ''),all=transcript.length?transcript:meetings[0]?.utterances || [],matches=all.filter(u=>q.split(/[？?，,\s]+/).some(w=>w && u.text.includes(w)));makeCard(matches.length?matches.slice(0,3):all.slice(0,2),p,'ask');break;}
      case 'digest.open': case 'commitment.open': case 'digest.openMany': {const ids=p.ids || [p.utteranceId],all=transcript.length?transcript:meetings[0]?.utterances || [];makeCard(all.filter(u=>ids.includes(u.id)),p,'commitment');break;}
      case 'recall.dismiss': cards.delete(p.cardId);break;
      case 'recall.save': {const card=cards.get(p.cardId);if (!card) throw new Error('片段已失效');readOnly(card);saved.unshift({id:card.id,session_id:card.sessionId,recording_mode:state.recordingMode,saved_at:iso(),audio_expired:true,utterances:card.pool.filter(x=>!rows(p.utteranceIds).length || p.utteranceIds.includes(x.id)),mock:true});state.savedCount=saved.length;emit('recall.saved',{cardId:p.cardId,savedCount:saved.length});toast('片段已加入当前记录');break;}
      case 'action.draft': draft(p);break;
      case 'items.task.draft': draft(p,true);break;
      case 'action.confirm': {const d=drafts.get(p.draftId);if (!d) throw new Error('草稿已失效');const result={draftId:p.draftId,opId:'demo-operation-'+p.draftId,status:'created',taskGuid:'demo-task-'+p.draftId,taskUrl:null,message:'待办草稿已整理，等待核对',readBackConfirmed:true,polling:false,mock:true};actions.set(p.draftId,result);emit('action.result',result);tasks.unshift({op_id:result.opId,what:p.what || d.what,who:p.who || people[0],when:{raw:p.whenRaw || '待定'},quote:d.evidence.quote,overdue:false,feishu:{state:'open'},url:null,mock:true});break;}
      case 'action.status': emit('action.result',actions.get(p.draftId) || {draftId:p.draftId,status:'failed',message:'没有这次操作的记录',polling:false,mock:true});break;
      case 'capture.meeting': if (state.capturing) stopCapture(); // The next recording is a separate in-memory example.
      case 'capture.start': {clearInterval(tickTimer);Object.assign(state,{capturing:true,sessionId:uid('demo-session'),sessionMs:0,bufferedMs:0,recordingMode:p.recordingMode || 'daily',cloudSaveConfirmed:p.recordingMode==='meeting',asr:'simulated',sourceReady:true,captureControl:'recording',audioRetentionDays:p.audioRetentionDays || 30,transcriptRetentionDays:p.transcriptRetentionDays || 30});transcript=[];recorded=0;paused=false;tickAt=performance.now();emit('state',state);tickTimer=setInterval(captureTick,300);toast('文字记录已开始');break;}
      case 'capture.stop': if (state.capturing) stopCapture();else toast('文字记录当前未开始');break;
      case 'capture.pause': paused=true;state.captureControl='paused';state.level=0;emit('state',state);toast('文字记录已暂停');break;
      case 'capture.resume': tickAt=performance.now()-state.sessionMs;paused=false;state.captureControl='recording';emit('state',state);toast('文字记录已继续');break;
      case 'agenda.set': state.agenda={goal:p.goal || '',items:rows(p.items).map((x,n)=>({id:'demo-agenda-'+n,title:x.title,plannedMs:x.minutes?x.minutes*60000:null,coveredMs:0})),plannedMs:p.minutes?p.minutes*60000:null,tracking:'supported'};emit('state',state);break;
      case 'agenda.clear': state.agenda={goal:'',items:[],tracking:'waiting'};emit('state',state);break;
      case 'notice.dismiss': state.notices=state.notices.map(x=>x.id===p.id?{...x,dismissed:true}:x);emit('state',state);break;
      case 'notice.feedback': state.notices=state.notices.map(x=>x.id===p.id?{...x,useful:p.useful}:x);emit('state',state);break;
      case 'clip.play': case 'clip.remote': emit('clip.state',{key:p.key,state:'unavailable'});toast('当前没有可播放的音频');break;
      case 'clip.stop': emit('clip.state',{key:p.key || '',state:'stopped'});break;
      case 'voiceprint.list': state.voiceprint={phase:'idle',catalog:{people:people.map(name=>({name,registered:false}))},message:'尚未录入声音身份'};emit('state',state);break;
      case 'voiceprint.record': case 'voiceprint.save': case 'voiceprint.delete': case 'voiceprint.cancel': case 'voiceprint.stop': case 'voiceprint.test': toast('当前暂不可操作声音身份');emit('state',state);break;
      case 'settings.set': {for (const k of ['selfName','voiceTrigger','noticeVibrate','memorySync','source']) if (k in p) state[k]=p[k];Object.assign(state,{backend:'mock',backendUrl:'',mockBackend:true});emit('state',state);emit('settings.saved',{requestId:p.requestId});toast('设置已更新');break;}
      case 'feishu.status': case 'feishu.connect': case 'feishu.disconnect': {if (type==='feishu.connect') feishuConnected=true;if (type==='feishu.disconnect') feishuConnected=false;emit('feishu.status',{requestId:p.requestId,status:feishuConnected?'connected':'disconnected',account:feishuConnected?{open_id:'demo-self',name:state.selfName,tenant_name:'Oops 团队',binding_id:'demo-binding'}:null,capabilities:{recipients:true,documents_write:true,sharing:true,messages_send:true}});if (type!=='feishu.status') toast('连接状态已更新');break;}
      case 'feishu.recipients': emit(type,{requestId:p.requestId,items:people.filter(name=>!p.query || name.includes(p.query)).map((name,n)=>({open_id:'demo-person-'+n,name,department:'Oops 团队'}))});break;
      case 'minutes.delivery.open': {if (!deliveries.has(p.sessionId)) deliveries.set(p.sessionId,{revision:1,title:meeting(p.sessionId).title,content:minuteResult(meeting(p.sessionId)).minutes?.overview || '会议整理'+DEMO,recipients:[],permission:'view',source_fingerprint:'demo-only'});emit('minutes.delivery',{session_id:p.sessionId,requestId:p.requestId,status:'ready',draft:deliveries.get(p.sessionId)});break;}
      case 'minutes.delivery.save': {const d=deliveries.get(p.sessionId);if (!d) throw new Error('请先读取纪要草稿');Object.assign(d,{title:p.title,content:p.content,recipients:rows(p.recipients).map(id=>({open_id:id,name:people[Number(String(id).split('-').at(-1))] || '收件人'})),permission:p.permission,revision:d.revision+1});emit('minutes.delivery',{session_id:p.sessionId,requestId:p.requestId,status:'ready',draft:d});break;}
      case 'minutes.delivery.confirm': case 'minutes.delivery.status': emit('minutes.delivery',{session_id:p.sessionId,requestId:p.requestId,op_id:p.opId,status:'sent',draft:deliveries.get(p.sessionId),receipt:{message:'纪要草稿已整理'},delivery:{status:'sent',doc_url:null}});toast('纪要草稿已更新');break;
      case 'meeting.retain': {const m=meeting(p.sessionId);readOnly(m);m.retained_evidence=rows(p.evidence).map(x=>({id:x.id,text:x.quote,confirmed:true,source_status:'current',mock:true}));m.retained_summaries=rows(p.summaries).map(x=>({...x,confirmed:true,source_status:'current',mock:true}));emit('meeting.retained',{sessionId:p.sessionId,session_id:p.sessionId,requestId:p.requestId,retained_evidence:m.retained_evidence,retained_summaries:m.retained_summaries});toast('短依据已加入当前记录');break;}
      case 'open.url': toast('当前没有可打开的链接');break;
      case 'testAudio.pick': case 'testAudio.reset': toast('当前没有可用媒体');break;
      case 'raft.request': emit('raft.result',{requestId:p.requestId,operation:p.operation,ok:false,error:{code:'DEMO_BLOCKED',message:'请从任务页进入协作'}});break;
      default: fail(type,p,'当前不支持此操作：'+type);break;
    }
  }
  // One shared in-memory content registry supports the independent Agent panel.
  root.OopsRoadshowDemoMemory={getMeetings:()=>copy(meetings),getCandidates:()=>copy([...candidates,...meetingTaskItems]),getPersonal:()=>copy(personal),getTeam:()=>copy(people),data:copy(data)};
  root.addEventListener('pagehide',()=>{clearInterval(tickTimer);tickTimer=null;});
})(window);
