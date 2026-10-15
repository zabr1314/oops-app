'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function ui() {
  const elements = new Map(), errors = [], messages = [], timers = [];
  function el(id) {
    if (!elements.has(id)) elements.set(id, {id, dataset:{}, children:[], style:{setProperty(){}},classList:{toggle(){},add(){},remove(){}},setAttribute(){},appendChild(){},insertBefore(child){this.children.push(child);},querySelectorAll:()=>[],listeners:{},addEventListener(type,fn){(this.listeners[type] ||= []).push(fn);}});
    return elements.get(id);
  }
  const native = {postMessage(raw){messages.push(JSON.parse(raw));}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../main/assets/web/app.js'),'utf8'), {
    window:{OopsNative:native,addEventListener(){}},location:{search:''},URLSearchParams,
    document:{addEventListener(){},getElementById:el,createElement:()=>el(Symbol('node')),querySelectorAll:()=>[],documentElement:{dataset:{}}},
    console:{...console,error(error){errors.push(error);}},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},
  });
  const receive=(type,payload)=>native.onmessage({data:JSON.stringify({type,payload})});
  const click=(act,data={},sheet=true)=>el(sheet?'sheet':'root').listeners.click.forEach(fn=>fn({stopPropagation(){},target:{closest(selector){return selector==='#sheet'?null:{dataset:{act,...data}};}}}));
  const change=(id,props={})=>el('sheet').listeners.change.forEach(fn=>fn({target:Object.assign(el(id),props)}));
  const input=(id,value)=>el('sheet').listeners.input.forEach(fn=>fn({target:Object.assign(el(id),{value})}));
  receive('snapshot',{state:{capturing:false,selfName:'Alice'},team:['Alice','Bob'],transcript:[]});
  const last=type=>messages.filter(x=>x.type===type).at(-1)?.payload;
  const status=(revision=1,account='ou_self',capabilities={})=>receive('feishu.status',{requestId:last('feishu.status')?.requestId,status:'bound',binding_revision:revision,account:{open_id:account,name:'Alice',tenant_key:'t1'},capabilities:{recipients:true,minutes_delivery:true,...capabilities}});
  return {el,receive,click,change,input,messages,errors,last,status,timers,sheet:()=>el('sheet').innerHTML};
}
const DRAFT={revision:1,source_fingerprint:'source-1',title:'会议纪要',content:'需要核对的正文',recipients:[],permission:'view',binding_revision:1,account_open_id:'ou_self'};
function open(u) {
  u.click('feishu-open');u.status();
  u.click('meeting-open',{id:'s1'},false);
  u.receive('history.open',{...u.last('history.open'),session_id:'s1',title:'评审',started_at:'2026-10-12T00:00:00Z',ended_at:'2026-10-12T01:00:00Z',utterances:[],digest:{},items:[],review_queue:[]});
  u.click('delivery-open');u.status();
  reply(u,DRAFT);return u;
}
function reply(u,draft,delivery=null,request='minutes.delivery.open') {u.receive('minutes.delivery',{session_id:'s1',requestId:u.last(request).requestId,draft,delivery});}
function selected(u) {
  u.click('delivery-search');u.receive('feishu.recipients',{requestId:u.last('feishu.recipients').requestId,items:[{open_id:'ou_bob',name:'Bob'}]});
  u.change('recipient',{dataset:{deliveryRecipient:'ou_bob'},checked:true});
  u.click('delivery-save');reply(u,{...DRAFT,revision:2,recipients:['ou_bob']},null,'minutes.delivery.save');
  u.change('delivery-confirmed',{checked:true});
}
test('personal settings opens a bound account without granting automatic send or preselecting participants',()=>{
  const u=open(ui()); assert.match(u.sheet(),/发送账号：Alice/);assert.match(u.sheet(),/选择收件人 · 0人/);assert.match(u.sheet(),/id="delivery-confirmed" type="checkbox"  disabled/);
  u.click('delivery-confirm');assert.equal(u.last('minutes.delivery.confirm'),undefined);assert.equal(u.errors.length,0);
});
test('recipient selection must be saved and explicit confirmation follows the acknowledged revision',()=>{
  const u=open(ui());selected(u);u.click('delivery-confirm');
  assert.equal(u.last('minutes.delivery.save').recipients[0],'ou_bob');assert.equal(u.last('minutes.delivery.save').permission,'view');
  assert.equal(u.last('minutes.delivery.confirm').revision,2);assert.equal(u.last('minutes.delivery.confirm').confirmed,true);
});
test('editing a saved version immediately revokes confirmation and requires another save',()=>{
  const u=open(ui());selected(u);u.input('delivery-content','新正文');u.click('delivery-confirm');
  assert.equal(u.last('minutes.delivery.confirm'),undefined);u.click('delivery-save');assert.equal(u.last('minutes.delivery.save').content,'新正文');
});
test('pending confirmation cannot double send and only matching session and request receipt is accepted',()=>{
  const u=open(ui());selected(u);u.click('delivery-confirm');u.click('delivery-confirm');
  assert.equal(u.messages.filter(x=>x.type==='minutes.delivery.confirm').length,1);
  const request=u.last('minutes.delivery.confirm');u.receive('minutes.delivery',{session_id:'other',requestId:request.requestId,status:'sent'});assert.doesNotMatch(u.sheet(),/发送成功/);
  reply(u,{...DRAFT,revision:2,recipients:['ou_bob']},{status:'sent',revision:2,op_id:request.opId,message:'已按核对内容发送'},'minutes.delivery.confirm');
  assert.match(u.sheet(),/发送成功/);u.click('delivery-confirm');assert.equal(u.messages.filter(x=>x.type==='minutes.delivery.confirm').length,1);
});
test('timeout keeps the original operation and queries its status without a fresh send',()=>{
  const u=open(ui());selected(u);u.click('delivery-confirm');const old=u.last('minutes.delivery.confirm');
  u.timers.filter(t=>t.ms===20000).forEach(t=>t.fn());assert.match(u.sheet(),/发送结果尚未确认/);u.click('delivery-confirm');assert.equal(u.messages.filter(x=>x.type==='minutes.delivery.confirm').length,1);
  u.click('delivery-status');assert.equal(u.last('minutes.delivery.status').opId,old.opId);
});
test('binding revision change invalidates confirmation even when the account name stays the same',()=>{
  const u=open(ui());selected(u);u.status(2);u.click('delivery-confirm');assert.equal(u.last('minutes.delivery.confirm'),undefined);
});
test('out of order recipient searches cannot replace the current recipient query',()=>{
  const u=open(ui());u.click('delivery-search');const old=u.last('feishu.recipients');u.click('delivery-search');
  u.receive('feishu.recipients',{requestId:u.last('feishu.recipients').requestId,items:[{open_id:'ou_new',name:'Current'}]});
  u.receive('feishu.recipients',{requestId:old.requestId,items:[{open_id:'ou_old',name:'Old'}]});assert.match(u.sheet(),/Current/);assert.doesNotMatch(u.sheet(),/>Old</);
});
test('source conflict blocks editing and sending until the current draft is explicitly reloaded',()=>{
  const u=open(ui());selected(u);u.click('delivery-save');u.receive('error',{scope:'feishu',sessionId:'s1',requestId:u.last('minutes.delivery.save').requestId,code:'MINUTES_SOURCE_CHANGED',message:'纪要依据已变化'});
  assert.match(u.sheet(),/纪要依据已变化/);u.click('delivery-confirm');assert.equal(u.last('minutes.delivery.confirm'),undefined);
});
test('ordinary topic links open the returned original sentence without needing a task',()=>{
  const u=open(ui());u.click('minutes-refresh',{},false);
  u.receive('history.minutes',{...u.last('history.minutes'),session_id:'s1',status:'ready',minutes:{topics:[{topic:'预算',points:['预算五千'],ids:['u8'],source_status:'available'}]},sources:{u8:{text:'预算先控制在五千。',start_ms:8000,end_ms:10000,speaker:'Bob'}}});
  assert.match(u.el('screen').innerHTML,/讨论要点/);assert.match(u.el('screen').innerHTML,/data-act="minutes-source" data-id="u8"/);
  u.click('minutes-source',{id:'u8'},false);assert.match(u.sheet(),/预算先控制在五千/);
});
test('legacy topic without citations states that they were not recorded instead of inventing a source',()=>{
  const u=open(ui());u.click('minutes-refresh',{},false);
  u.receive('history.minutes',{...u.last('history.minutes'),session_id:'s1',status:'ready',minutes:{topics:[{topic:'预算',points:['预算五千'],ids:[],source_status:'unrecorded'}]},sources:{}});
  assert.match(u.el('screen').innerHTML,/旧纪要未保存本组原话引用/);assert.doesNotMatch(u.el('screen').innerHTML,/data-act="minutes-source"/);
});

const JOB='a'.repeat(32);
function result(u=ui()) {
  u.click('assistant-jobs',{},false);
  u.receive('assistant.jobs',{requestId:u.last('assistant.jobs').requestId,items:[{id:JOB,session_id:'s1',title:'现有报告',generation_status:'ready'}]});
  u.click('assistant-result',{job:JOB,session:'s1'});u.status(1,'ou_self',{agent_file_delivery:true});
  u.receive('assistant.delivery',{...u.last('assistant.delivery.open'),session_id:'s1',job_id:JOB,draft:{...DRAFT,job_id:JOB,result_revision:1,artifacts:[{name:'演示.pptx',kind:'file',size:100}],attachments:[]}});
  return u;
}
function resultSelected(u) {
  u.click('delivery-search');u.receive('feishu.recipients',{requestId:u.last('feishu.recipients').requestId,items:[{open_id:'ou_bob',name:'Bob'}]});
  u.change('recipient',{dataset:{deliveryRecipient:'ou_bob'},checked:true});
  u.change('file',{dataset:{deliveryFile:'演示.pptx'},checked:true});
  u.change('delivery-file-copies',{checked:true});u.click('delivery-save');
  u.receive('assistant.delivery',{...u.last('assistant.delivery.save'),session_id:'s1',job_id:JOB,draft:{...DRAFT,revision:2,job_id:JOB,result_revision:1,recipients:['ou_bob'],attachments:['演示.pptx'],attachment_copies_confirmed:true}});
  u.change('delivery-confirmed',{checked:true});
}
test('existing agent result explicitly selects original files and acknowledges downloadable copies before delivery',()=>{
  const u=result();assert.match(u.sheet(),/核对并交付工作成果/);assert.match(u.sheet(),/不重新生成/);
  resultSelected(u);assert.equal(u.last('assistant.delivery.save').attachment_copies_confirmed,true);assert.deepEqual(u.last('assistant.delivery.save').attachments,['演示.pptx']);
  u.click('delivery-confirm');assert.equal(u.last('assistant.delivery.confirm').jobId,JOB);assert.equal(u.last('assistant.delivery.confirm').revision,2);
  assert.equal(u.last('minutes.delivery.confirm'),undefined);
});
test('known partial agent delivery resumes the same operation and job, while unknown delivery only queries',()=>{
  const u=result();resultSelected(u);u.click('delivery-confirm');const op=u.last('assistant.delivery.confirm');
  u.receive('assistant.delivery',{...op,session_id:'s1',job_id:JOB,delivery:{status:'partial',op_id:op.opId,revision:2}});
  u.click('delivery-resume');assert.equal(u.last('assistant.delivery.confirm').opId,op.opId);assert.equal(u.last('assistant.delivery.confirm').jobId,JOB);
  const pending=u.last('assistant.delivery.confirm');u.receive('assistant.delivery',{...pending,session_id:'s1',job_id:JOB,delivery:{status:'unknown',op_id:op.opId,revision:2}});
  const count=u.messages.filter(x=>x.type==='assistant.delivery.confirm').length;u.click('delivery-resume');u.click('delivery-confirm');assert.equal(u.messages.filter(x=>x.type==='assistant.delivery.confirm').length,count);
  u.click('delivery-status');assert.equal(u.last('assistant.delivery.status').opId,op.opId);
});
const CALENDAR={revision:1,source_fingerprint:'source-1',title:'评审',description:'确认范围',start:'2026-10-16T15:00:00+08:00',end:'2026-10-16T15:30:00+08:00',time_zone:'Asia/Shanghai',attendees:[],reviewed:false,binding_revision:1,account_open_id:'ou_self'};
function calendar(u=open(ui())) {
  u.click('calendar-open',{},false);u.status(1,'ou_self',{calendar_delivery:true,calendar_invite:true});
  u.receive('calendar.delivery',{...u.last('calendar.open'),session_id:'s1',followup_id:'manual',draft:CALENDAR,suggestions:[{followup_id:'fu-test',title:'原安排',start:CALENDAR.start,attendee_hints:['Bob']}]});return u;
}
function saveCalendar(u) {u.click('calendar-save');u.receive('calendar.delivery',{...u.last('calendar.save'),session_id:'s1',followup_id:'manual',draft:{...CALENDAR,revision:2,reviewed:true}});u.change('calendar-confirmed',{checked:true});}
test('calendar participant hints stay unselected and creation needs saved review plus separate confirmation',()=>{
  const u=calendar();assert.match(u.sheet(),/无，仅本人日程/);u.click('calendar-confirm');assert.equal(u.last('calendar.confirm'),undefined);
  saveCalendar(u);assert.deepEqual(u.last('calendar.save').attendees,[]);assert.equal(u.last('calendar.save').time_zone,'Asia/Shanghai');
  u.click('calendar-confirm');u.click('calendar-confirm');assert.equal(u.messages.filter(x=>x.type==='calendar.confirm').length,1);assert.equal(u.last('calendar.confirm').revision,2);
});
test('calendar edit or account change revokes a saved confirmation immediately',()=>{
  const u=calendar();saveCalendar(u);u.input('start',CALENDAR.start);u.input('calendar-time',CALENDAR.start);
  u.el('sheet').listeners.input.forEach(fn=>fn({target:{dataset:{calendarField:'start'},value:'2026-10-16T16:00:00+08:00'}}));
  u.click('calendar-confirm');assert.equal(u.last('calendar.confirm'),undefined);
  const v=calendar();saveCalendar(v);v.status(2);v.click('calendar-confirm');assert.equal(v.last('calendar.confirm'),undefined);
});
test('calendar readback recovery keeps the same operation and unknown create cannot be retried',()=>{
  const u=calendar();saveCalendar(u);u.click('calendar-confirm');const op=u.last('calendar.confirm');
  u.receive('calendar.delivery',{...op,session_id:'s1',followup_id:'manual',calendar:{status:'created_unverified',op_id:op.opId,event_id:'event-1',revision:2}});
  u.click('calendar-resume');assert.equal(u.last('calendar.confirm').opId,op.opId);
  const retry=u.last('calendar.confirm');u.receive('calendar.delivery',{...retry,session_id:'s1',followup_id:'manual',calendar:{status:'unknown',op_id:op.opId,revision:2}});
  const count=u.messages.filter(x=>x.type==='calendar.confirm').length;u.click('calendar-resume');u.click('calendar-confirm');assert.equal(u.messages.filter(x=>x.type==='calendar.confirm').length,count);
  u.click('calendar-status');assert.equal(u.last('calendar.status').opId,op.opId);
});
test('explicitly incomplete document permission chain blocks confirmation before creating any document',()=>{
  const u=open(ui());selected(u);u.status(1,'ou_self',{minutes_delivery:false,documents_write:true,sharing:true,messages_send:true,sharing_settings_read:false,metadata_read:false});
  u.change('delivery-confirmed',{checked:true});u.click('delivery-confirm');assert.equal(u.last('minutes.delivery.confirm'),undefined);assert.match(u.sheet(),/核对文档隐私/);assert.match(u.sheet(),/核对文档归属/);
});
test('agent draft for another job is cleared and cannot be confirmed for the current job',()=>{
  const u=result();u.click('delivery-reload');
  u.receive('assistant.delivery',{...u.last('assistant.delivery.open'),session_id:'s1',job_id:JOB,draft:{...DRAFT,job_id:'b'.repeat(32),content:'wrong job private body'}});
  assert.match(u.sheet(),/成果回包与当前任务不一致/);assert.doesNotMatch(u.sheet(),/wrong job private body/);u.click('delivery-confirm');assert.equal(u.last('assistant.delivery.confirm'),undefined);
});
test('calendar source withdrawal clears cached text and prevents resuming the old operation',()=>{
  const u=calendar();saveCalendar(u);u.click('calendar-confirm');const op=u.last('calendar.confirm');u.receive('calendar.delivery',{...op,session_id:'s1',followup_id:'manual',calendar:{status:'created_unverified',op_id:op.opId,revision:2}});u.click('calendar-status');
  u.receive('calendar.delivery',{...u.last('calendar.status'),session_id:'s1',followup_id:'manual',draft:null,calendar:{status:'created_unverified',op_id:op.opId,revision:2,source_status:'source_changed'}});
  assert.doesNotMatch(u.sheet(),/value="评审"|确认范围|data-act="calendar-resume"/);u.click('calendar-resume');assert.equal(u.messages.filter(x=>x.type==='calendar.confirm').length,1);
});
test('calendar source conflict can be corrected by loading and reviewing the current version',()=>{
  const u=calendar();u.click('calendar-save');u.receive('error',{scope:'feishu',sessionId:'s1',requestId:u.last('calendar.save').requestId,code:'CALENDAR_SOURCE_CHANGED',message:'来源已变更'});
  u.click('calendar-reload');u.receive('calendar.delivery',{...u.last('calendar.open'),session_id:'s1',followup_id:'manual',draft:{...CALENDAR,revision:3,source_fingerprint:'source-2'}});
  u.click('calendar-save');assert.equal(u.last('calendar.save').revision,3);
  u.receive('calendar.delivery',{...u.last('calendar.save'),session_id:'s1',followup_id:'manual',draft:{...CALENDAR,revision:4,source_fingerprint:'source-2',reviewed:true}});u.change('calendar-confirmed',{checked:true});u.click('calendar-confirm');assert.equal(u.last('calendar.confirm').revision,4);
});

test('withdrawn agent source hides cached result text even after a known operation was reserved',()=>{
  const u=result();resultSelected(u);u.click('delivery-confirm');const op=u.last('assistant.delivery.confirm');
  u.receive('assistant.delivery',{...op,session_id:'s1',job_id:JOB,delivery:{status:'partial',op_id:op.opId,revision:2}});u.click('delivery-resume');
  u.receive('error',{scope:'feishu',sessionId:'s1',requestId:u.last('assistant.delivery.confirm').requestId,code:'MINUTES_SOURCE_CHANGED',sourceChanged:true,message:'来源已撤回'});
  assert.doesNotMatch(u.sheet(),/需要核对的正文|data-act="delivery-resume"/);u.click('delivery-confirm');assert.equal(u.messages.filter(x=>x.type==='assistant.delivery.confirm').length,2);
});
