'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function ui() {
  const elements=new Map(),messages=[];
  const el=id=>{if(!elements.has(id)){const node={id,dataset:{},children:[],renderVersion:0,style:{setProperty(){}},classList:{toggle(){},add(){},remove(){}},setAttribute(){},appendChild(){},insertBefore(){},querySelectorAll:()=>[],listeners:{},addEventListener(t,fn){(this.listeners[t]||=[]).push(fn);}};let html='';Object.defineProperty(node,'innerHTML',{get:()=>html,set:value=>{html=value;node.renderVersion++;}});elements.set(id,node);}return elements.get(id);};
  const native={postMessage(raw){messages.push(JSON.parse(raw));}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../main/assets/web/app.js'),'utf8'),{window:{OopsNative:native,addEventListener(){}},location:{search:''},URLSearchParams,document:{addEventListener(){},getElementById:el,createElement:()=>el(Symbol()),querySelectorAll:()=>[],documentElement:{dataset:{}}},console,setTimeout:()=>1,clearTimeout(){}});
  const receive=(type,payload)=>native.onmessage({data:JSON.stringify({type,payload})});
  const click=(act,data={},sheet=false)=>el(sheet?'sheet':'root').listeners.click.forEach(fn=>fn({stopPropagation(){},target:{closest(sel){return sel==='#sheet'?null:{dataset:{act,...data}};}}}));
  // Browser keeps the original event path after an action replaces sheet markup.
  const bubblingClick=(act,data={})=>{const revision=el('sheet').renderVersion;let stopped=false;const event={stopPropagation(){stopped=true;},target:{closest(sel){return sel==='#sheet'?(el('sheet').renderVersion===revision?el('sheet'):null):{dataset:{act,...data}};}}};el('sheet').listeners.click.forEach(fn=>fn(event));if(!stopped)el('root').listeners.click.forEach(fn=>fn(event));};
  receive('snapshot',{state:{capturing:false,recordingMode:'daily'},team:[],transcript:[]});
  return{el,receive,click,bubblingClick,messages,sheet:()=>el('sheet').innerHTML,last:type=>messages.filter(x=>x.type===type).at(-1)?.payload};
}
test('default is daily; opening and cancelling do not start capture or grant cloud consent',()=>{
  const u=ui();u.click('capture-start');assert.match(u.sheet(),/停止即清除/);assert.match(u.sheet(),/云端ASR/);
  u.click('close',{},true);assert.equal(u.last('capture.start'),undefined);
  u.click('capture-start');u.click('capture-confirm',{},true);
  assert.deepEqual(u.last('capture.start'),{recordingMode:'daily',cloudSaveConfirmed:false,audioRetentionDays:30,transcriptRetentionDays:30});
});
test('meeting requires an unchecked per-capture consent and independent valid deadlines',()=>{
  const u=ui();u.click('capture-start');u.click('capture-mode',{mode:'meeting'},true);
  assert.match(u.sheet(),/原始录音保留/);assert.doesNotMatch(u.sheet(),/id="capture-cloud"[^>]*checked/);
  u.el('capture-cloud').checked=false;u.click('capture-confirm',{},true);assert.equal(u.last('capture.start'),undefined);
  u.el('capture-cloud').checked=true;u.el('capture-audio-days').value='7';u.el('capture-transcript-days').value='90';u.click('capture-confirm',{},true);
  assert.deepEqual(u.last('capture.start'),{recordingMode:'meeting',cloudSaveConfirmed:true,audioRetentionDays:7,transcriptRetentionDays:90});
  u.click('capture-start');u.click('capture-mode',{mode:'meeting'},true);u.el('capture-audio-days').value='0';u.click('capture-confirm',{},true);
  assert.equal(u.messages.filter(x=>x.type==='capture.start').length,1);
});
test('daily to meeting starts separately; selecting prior evidence never starts an archive',()=>{
  const u=ui();u.receive('state',{capturing:true,recordingMode:'daily',sessionId:'daily-1'});u.click('capture-meeting');
  assert.match(u.sheet(),/此前缓冲不会自动归档/);u.click('capture-before-recall',{},true);
  assert.equal(u.messages.at(-1).type,'recall.trigger');assert.equal(u.last('capture.meeting'),undefined);
  u.click('capture-meeting');u.el('capture-cloud').checked=true;u.el('capture-audio-days').value='30';u.el('capture-transcript-days').value='7';u.click('capture-confirm',{},true);
  assert.deepEqual(u.last('capture.meeting'),{recordingMode:'meeting',cloudSaveConfirmed:true,audioRetentionDays:30,transcriptRetentionDays:7});
  assert.equal(u.last('capture.meeting').importPreviousBuffer,undefined);
});
test('private candidate requires its own explicit confirmation and binds the selected session and id',()=>{
  const u=ui();u.receive('daily.candidates',{items:[{session_id:'d1',id:'u1',quote:'周五核对预算',updated_at:'2026-10-12T00:00:00Z'}]});
  u.click('daily-confirm-open',{session:'d1',id:'u1'},true);assert.match(u.sheet(),/不自动创建任务/);assert.doesNotMatch(u.sheet(),/id="daily-confirmed"[^>]*checked/);
  u.el('daily-confirmed').checked=false;u.click('daily-confirm-save',{},true);assert.equal(u.last('daily.candidate.confirm'),undefined);
  u.el('daily-confirmed').checked=true;u.el('daily-quote').value='已核对：周五检查预算';u.click('daily-confirm-save',{},true);
  assert.deepEqual(u.last('daily.candidate.confirm'),{sessionId:'d1',id:'u1',quote:'已核对：周五检查预算',confirmed:true});
});
function mock() {
  let now=0,interval;const events=[],writes=[];
  const context={window:{},location:{search:'?preview=1'},URLSearchParams,crypto:{randomUUID:(()=>{let n=0;return()=>String(++n)})()},performance:{now:()=>now},Date,console,
    localStorage:{getItem:()=>null,setItem:(...x)=>writes.push(x)},queueMicrotask:fn=>fn(),setTimeout:fn=>{fn();return 1;},clearTimeout(){},setInterval:fn=>{interval=fn;return 1;},clearInterval(){interval=null;}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../main/assets/web/bridge-mock.js'),'utf8'),context);
  const native=context.window.OopsNative;native.onmessage=e=>events.push(JSON.parse(e.data));
  return{send:(type,payload={})=>native.postMessage(JSON.stringify({type,payload})),advance:ms=>{now=ms;interval?.();},last:type=>events.filter(x=>x.type===type).at(-1)?.payload,writes};
}
test('simulator daily full text expires at five minutes, stop clears it while unconfirmed short private evidence remains',()=>{
  const m=mock();m.send('capture.start');m.advance(26000);assert.ok(m.last('asr.final'));m.send('daily.candidates');assert.equal(m.last('daily.candidates').items.length,4);
  m.advance(326000);m.send('hello');assert.equal(m.last('snapshot').transcript.length,0);assert.equal(m.last('snapshot').summary.commitments.length,0);
  m.send('capture.stop');m.send('hello');assert.equal(m.last('snapshot').state.sessionId,'');assert.equal(m.last('snapshot').transcript.length,0);
  m.send('daily.candidates');assert.equal(m.last('daily.candidates').items.length,4);assert.ok(m.last('daily.candidates').items.every(x=>x.visibility==='private'&&!x.confirmed&&!x.original_available));
  assert.equal(m.writes.length,0);
});
test('simulator denies absent meeting consent and switches to a new empty session only after confirmed choice',()=>{
  const m=mock();m.send('capture.start',{recordingMode:'meeting'});assert.match(m.last('error').message,/明确选择/);
  m.send('capture.start');m.advance(26000);m.send('hello');const old=m.last('snapshot').state.sessionId;
  m.send('capture.meeting',{recordingMode:'meeting',cloudSaveConfirmed:true,audioRetentionDays:7,transcriptRetentionDays:90});m.send('hello');
  const snap=m.last('snapshot');assert.notEqual(snap.state.sessionId,old);assert.equal(snap.transcript.length,0);assert.equal(snap.state.sessionMs,0);assert.equal(snap.state.recordingMode,'meeting');
});
test('native bridge contract connects per-capture mode and separate deadlines to engine state and service intent',()=>{
  const root=path.resolve(__dirname,'../../main/java/com/oops/app');
  const read=name=>fs.readFileSync(path.join(root,name),'utf8');
  const policy=read('store/RecordingPolicy.kt'),bridge=read('bridge/BridgeJson.kt'),service=read('service/CaptureService.kt');
  for(const field of ['recordingMode','cloudSaveConfirmed','audioRetentionDays','transcriptRetentionDays']) {
    assert.ok(policy.includes('"'+field+'"'),field+' native consent input');
    assert.ok(bridge.includes('"'+field+'"'),field+' state output');
    assert.ok(service.includes('"'+field+'"'),field+' service handoff');
  }
  const native=read('MainActivity.kt');assert.match(native,/"capture\.meeting"\s*->\s*recordingRequest/);assert.match(native,/if \(policy\.archives\) OopsEngine\.requireRecordingPolicySupport/);
  assert.match(read('backend/HttpOopsApi.kt'),/health\.optInt\("archive_policy_version"\) >= 1/);
});
test('native archive call sites attach persisted per-session contract at top level and daily creates no archive queue',()=>{
  const root=path.resolve(__dirname,'../../main/java/com/oops/app'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
  const engine=read('engine/OopsEngine.kt'),sync=read('backend/MeetingSync.kt'),upload=read('store/RecordingUploader.kt'),recovery=read('store/SessionRecovery.kt');
  assert.match(engine,/recorder = if \(!policy\.archives\) null/);assert.match(engine,/syncContext = if \(policy\.archives\)/);
  assert.match(sync,/attachContract\(body\)/);assert.match(upload,/policy\?\.contract\(meta\.getString\("archive_started_at"\)\)/);assert.match(upload,/manifest\.put\(key, contract\.get\(key\)\)/);
  assert.match(recovery,/RecordingPolicy\.fromMeta\(meta\)\?\.contract\(meta\.getString\("archive_started_at"\)\)/);
  assert.doesNotMatch(engine,/Log\.i\([^\n]*u\.text/);assert.doesNotMatch(engine,/Log\.i\([^\n]*query=\$query/);
});
test('daily expiry closes a quoted recall sheet instead of keeping an old full-text copy in the UI',()=>{
  const u=ui();u.receive('state',{recordingMode:'daily',capturing:true,sessionId:'d'});
  const quote={id:'u1',startMs:0,endMs:1000,text:'到期后不应继续展示的完整原话',speaker:null};
  u.receive('recall.card',{id:'c1',items:[quote],pool:[quote],single:true,nowMs:2000,engine:'mock'});assert.match(u.sheet(),/到期后不应继续展示/);
  u.receive('transcript.pruned',{ids:['u1']});assert.equal(u.el('sheet').hidden,true);
});
test('expired archived transcript has an explicit boundary and separate confirmed excerpts remain visible',()=>{
  const u=ui();u.click('meeting-open',{id:'s'});
  u.receive('history.open',{session_id:'s',title:'有到期期限的会议',transcript_status:'expired',utterances:[],review_queue:[],digest:{},retained_evidence:[{id:'u1',text:'已独立核对的短结论',confirmed:true,source_status:'expired'}]});
  assert.match(u.el('screen').innerHTML,/完整原文已按期限清理/);assert.match(u.el('screen').innerHTML,/已独立核对的短结论/);
  u.click('tab',{tab:'transcript'});assert.match(u.el('screen').innerHTML,/完整文字已到期清理/);assert.doesNotMatch(u.el('screen').innerHTML,/这场会议没有文字/);
});
function retention(u) {
  u.click('meeting-open',{id:'s'});
  u.receive('history.open',{session_id:'s',title:'正式会议',utterances:[{id:'u1',text:'预算不得超过十万',start_ms:1000,end_ms:2000}],review_queue:[],digest:{}});
  u.click('retain-open');
}
test('independent retention is explicit; no selection, no confirmation, or cancel performs no write',()=>{
  const u=ui();retention(u);assert.doesNotMatch(u.sheet(),/id="retain-confirmed"[^>]*checked/);
  u.el('retain-confirmed').checked=false;u.click('retain-save',{},true);assert.equal(u.last('meeting.retain'),undefined);
  u.el('retain-confirmed').checked=true;u.click('retain-save',{},true);assert.equal(u.last('meeting.retain'),undefined);
  u.click('close',{},true);assert.equal(u.last('meeting.retain'),undefined);
});
test('retention failure preserves the selected draft, retries the same request, and waits for the matching receipt',()=>{
  const u=ui();retention(u);u.el('retain-summary').value='确认首版预算上限';u.click('retain-pick',{id:'u1'},true);u.el('retain-summary').value='确认首版预算上限';u.el('retain-confirmed').checked=true;u.click('retain-save',{},true);
  const sent=u.last('meeting.retain');assert.equal(sent.confirm,true);assert.equal(sent.evidence[0].sourceText,'预算不得超过十万');assert.deepEqual(sent.summaries[0].source_ids,['u1']);assert.match(u.sheet(),/等待保存回执/);
  u.receive('meeting.retained',{sessionId:'other',requestId:sent.requestId,retained_evidence:[]});assert.equal(u.el('sheet').hidden,false);
  u.receive('error',{scope:'retention',sessionId:'s',requestId:sent.requestId,message:'来源已变，需要重新核对'});assert.match(u.sheet(),/来源已变/);
  u.click('retain-retry',{},true);assert.deepEqual(u.last('meeting.retain'),sent);
  u.receive('meeting.retained',{sessionId:'s',requestId:sent.requestId,retained_evidence:[{id:'u1',text:'预算不得超过十万',confirmed:true,source_status:'available'}],retained_summaries:[{id:'sum',text:'确认首版预算上限',confirmed:true,source_status:'available'}]});
  assert.equal(u.el('sheet').hidden,true);assert.match(u.el('screen').innerHTML,/确认首版预算上限/);
});
test('simulated retention binds current source and keeps only chosen short evidence, without persistent writes',()=>{
  const m=mock();const p={sessionId:'demo',requestId:'r',confirm:true,evidence:[{id:'u1',quote:'预算不能超过10万',sourceText:'旧的全文'}],summaries:[]};
  m.send('meeting.retain',p);assert.match(m.last('error').message,/来源已变化/);
  p.evidence[0].sourceText='预算不能超过10万。';m.send('meeting.retain',p);
  assert.equal(m.last('meeting.retained').retained_evidence[0].text,'预算不能超过10万');assert.equal(m.last('meeting.retained').retained_evidence[0].sourceText,undefined);
  m.send('history.open',{sessionId:'demo'});assert.equal(m.last('history.open').retained_evidence.length,1);assert.equal(m.writes.length,0);
});
test('source-changed retention requires rereading the meeting instead of resubmitting stale confirmation',()=>{
  const u=ui();retention(u);u.click('retain-pick',{id:'u1'},true);u.el('retain-confirmed').checked=true;u.click('retain-save',{},true);const p=u.last('meeting.retain');
  u.receive('error',{scope:'retention',sessionId:'s',requestId:p.requestId,sourceChanged:true,message:'原话已变化'});
  assert.match(u.sheet(),/重新读取会议/);assert.doesNotMatch(u.sheet(),/重试保存相同内容/);u.click('retain-reopen',{},true);assert.equal(u.last('history.open').sessionId,'s');
});
test('discarding an unconfirmed daily candidate removes only that item and never saves or creates a task',()=>{
  const m=mock();m.send('capture.start');m.advance(26000);m.send('daily.candidates');const items=m.last('daily.candidates').items;
  m.send('daily.candidate.discard',{sessionId:items[0].session_id,id:items[0].id});const left=m.last('daily.candidates').items;
  assert.equal(left.length,3);assert.ok(!left.some(x=>x.id===items[0].id));m.send('saved.list');assert.equal(m.last('saved.items').items.length,0);assert.equal(m.writes.length,0);
});

test('sheet actions run once when replacing markup detaches the clicked target before root bubbling',()=>{
  const u=ui();retention(u);u.bubblingClick('retain-pick',{id:'u1'});assert.match(u.sheet(),/data-id="u1" aria-pressed="true"/);
  u.el('retain-confirmed').checked=true;u.el('retain-summary').value='已核对预算上限';u.bubblingClick('retain-save');
  assert.equal(u.messages.filter(x=>x.type==='meeting.retain').length,1);assert.equal(u.last('meeting.retain').evidence.length,1);
  u.click('close',{},true);u.click('capture-start');u.bubblingClick('capture-confirm');assert.equal(u.messages.filter(x=>x.type==='capture.start').length,1);
});
test('idle and active labels follow daily versus formal policy without claiming daily archive or disabled sync',()=>{
  const u=ui();u.click('go',{route:'home'});assert.match(u.el('screen').innerHTML,/日常临时聆听/);assert.doesNotMatch(u.el('screen').innerHTML,/record-under.*>会议 ·/);
  u.receive('state',{capturing:true,sessionId:'daily-label',recordingMode:'daily',memorySync:false,sourceReady:true,asr:'ready'});
  assert.match(u.el('screen').innerHTML,/日常临时聆听/);assert.doesNotMatch(u.el('screen').innerHTML,/会议文字同步已关闭/);
  u.receive('state',{capturing:true,sessionId:'meeting-label',recordingMode:'meeting',memorySync:true,sourceReady:true});u.click('go',{route:'home'});
  assert.match(u.el('screen').innerHTML,/正式会议 ·/);u.click('go',{route:'sessions'});assert.match(u.el('screen').innerHTML,/分别保留所选7、30或90天/);assert.doesNotMatch(u.el('screen').innerHTML,/长期保留在团队服务器/);
});

const board = (session, text='合并后的真实会议任务') => ({session_id:session,pending:false,tasks:[{id:'t1',what:text,owner:'',priority:'P0',status:'open',sources:['u1'],reason:'主线任务'}]});
const showActions = u => {u.click('go',{route:'live'});u.click('tab',{tab:'actions'});};
test('daily rejects live and restored task boards even after five-minute prune and stop',()=>{
  const u=ui();u.receive('state',{capturing:true,recordingMode:'daily',sessionId:'daily-board'});u.receive('tasks.board',board('daily-board','不应长期留下的日常内容'));showActions(u);
  assert.doesNotMatch(u.el('screen').innerHTML,/不应长期留下的日常内容/);
  u.receive('transcript.pruned',{ids:['u1']});u.receive('tasks.board',board('daily-board','不应长期留下的日常内容'));showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/不应长期留下的日常内容/);
  u.receive('snapshot',{state:{capturing:true,recordingMode:'daily',sessionId:'daily-board'},transcript:[],team:[],board:board('daily-board','旧快照里的日常内容')});showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/旧快照里的日常内容/);
  u.receive('capture.cleared',{mode:'daily'});u.receive('state',{capturing:false,sessionId:''});u.receive('tasks.board',board('daily-board','停止后的日常内容'));showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/停止后的日常内容/);
});
test('formal board survives normal subtitle pruning but never actual transcript expiry or a stale restore',()=>{
  const u=ui();u.receive('state',{capturing:true,recordingMode:'meeting',sessionId:'formal-board',transcriptExpired:false});u.receive('tasks.board',board('formal-board'));showActions(u);assert.match(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('transcript.pruned',{ids:['u1']});showActions(u);assert.match(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('capture.assetsExpired',{asset:'transcript'});u.receive('tasks.board',board('formal-board'));showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('snapshot',{state:{capturing:false,recordingMode:'meeting',sessionId:'formal-board',transcriptExpired:false},transcript:[],team:[],board:board('formal-board')});showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/合并后的真实会议任务/);
});
test('mode change and authoritative expired state immediately revoke board; another session cannot restore it',()=>{
  const u=ui();u.receive('state',{capturing:true,recordingMode:'meeting',sessionId:'mode-board',transcriptExpired:false});u.receive('tasks.board',board('mode-board'));showActions(u);assert.match(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('state',{recordingMode:'daily'});assert.doesNotMatch(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('state',{recordingMode:'meeting',transcriptExpired:true});u.receive('tasks.board',board('mode-board'));showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('state',{sessionId:'new-formal',recordingMode:'meeting',transcriptExpired:false});u.receive('tasks.board',board('mode-board'));showActions(u);assert.doesNotMatch(u.el('screen').innerHTML,/合并后的真实会议任务/);
  u.receive('tasks.board',board('new-formal','新正式会议任务'));assert.match(u.el('screen').innerHTML,/新正式会议任务/);
});
test('a restored formal board requires usable source IDs and old-service replies cannot override it',()=>{
  const u=ui();u.receive('snapshot',{state:{capturing:true,recordingMode:'meeting',sessionId:'restore-board',transcriptExpired:false,backendUrl:'new-server'},transcript:[],team:[],board:{...board('restore-board'),tasks:[...board('restore-board').tasks,{id:'bad',what:'没有来源不应显示',priority:'P0',status:'open'}]}});showActions(u);
  assert.match(u.el('screen').innerHTML,/合并后的真实会议任务/);assert.doesNotMatch(u.el('screen').innerHTML,/没有来源不应显示/);
  u.receive('tasks.board',{...board('restore-board','旧服务器内容'),backendUrl:'old-server'});assert.doesNotMatch(u.el('screen').innerHTML,/旧服务器内容/);
});
test('simulator matches the native meeting-only board contract',()=>{
  const daily=mock();daily.send('capture.start');daily.advance(26000);assert.equal(daily.last('tasks.board'),undefined);daily.advance(326000);assert.equal(daily.last('tasks.board'),undefined);
  const meeting=mock();meeting.send('capture.start',{recordingMode:'meeting',cloudSaveConfirmed:true,audioRetentionDays:30,transcriptRetentionDays:30});meeting.advance(26000);assert.ok(meeting.last('tasks.board')?.tasks.length);
});
