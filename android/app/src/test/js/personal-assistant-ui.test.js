'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname,'../../main/assets/web/personal-assistant.js'),'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function storage() { const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values}; }
function ui(saved=storage(),persistent=true) {
  const window={},messages=[],timers=[];
  vm.runInNewContext(source,{window,setTimeout,console});
  const instance=window.OopsPersonalAssistant.create({storage:saved,persistent:()=>persistent,send:(type,payload)=>messages.push({type,payload:clone(payload)}),render(){},schedule:fn=>timers.push(fn)});
  const last=type=>messages.filter(x=>x.type===type).at(-1)?.payload;
  const receive=(payload,type='personal.context')=>instance.receive(type,{...payload,requestId:messages.at(-1)?.payload.requestId});
  const bind=(key='account-a',revision=1,scope='http:https://example.test')=>instance.identity(key,revision,true,scope);
  const read=(patch={})=>receive({identity_revision:1,context_revision:0,profile:null,preferences:null,memories:[],...patch});
  instance.open();bind();read();
  return {instance,messages,timers,last,receive,bind,read,saved,html:()=>instance.html()};
}
const item=(kind,id,revision,value)=>({kind,id,revision,value,source:{kind:'manual'},confirmed:true,status:'current',updated_at:'2026-10-16T10:00:00Z'});
function edit(u,name='本人草稿') { u.instance.input('name',name);u.instance.input('confirmed',true);u.instance.action('save');return u.last('personal.context.profile'); }

test('personal context needs an authenticated account and explicit per-edit confirmation',()=>{
  const u=ui();u.instance.input('name','本人草稿');u.instance.action('save');assert.equal(u.last('personal.context.profile'),undefined);
  const write=edit(u);assert.equal(write.confirmed,true);assert.equal(write.expected_revision,0);assert.equal(write.value.name,'本人草稿');
  assert.ok(write.op_id);assert.equal(write.value.role,'');assert.doesNotMatch(JSON.stringify(write),/token|principal|account/);
  u.instance.identity(null,0,false,'http:https://example.test');assert.match(u.html(),/先在「我的飞书」连接/);
  assert.match(u.html(),/data-act="feishu-open">连接我的飞书/);
});
test('unknown writes retain one immutable request and operation through retries and a WebView restart',()=>{
  const u=ui(),original=edit(u);u.instance.action('save');assert.equal(u.messages.filter(x=>x.type==='personal.context.profile').length,1);
  u.timers.at(-1)();u.instance.input('name','不能改掉原操作');u.instance.action('retry');
  const replay=u.last('personal.context.profile');assert.equal(replay.op_id,original.op_id);assert.deepEqual({...replay,requestId:null},{...original,requestId:null});
  const restored=ui(u.saved);assert.match(restored.html(),/原保存操作待核实/);restored.instance.action('retry');
  const recovered=restored.last('personal.context.profile');assert.equal(recovered.op_id,original.op_id);assert.deepEqual(recovered.value,original.value);
  restored.receive({identity_revision:1,context_revision:1,item:item('profile','current',1,original.value),operation_revision:1,replayed:true});
  assert.match(restored.html(),/已保存到当前账号/);assert.equal(restored.saved.values.size,0);
});
test('a version conflict preserves the local draft until the person compares a newly read version',()=>{
  const u=ui(),original=edit(u,'我的修改稿');
  u.receive({httpStatus:409,code:'PERSONAL_CONTEXT_REVISION_CONFLICT',message:'其他设备已更新'},'error');
  assert.match(u.html(),/我的修改稿/);assert.equal(u.saved.values.size,0);
  u.instance.action('save');assert.equal(u.messages.filter(x=>x.type==='personal.context.profile').length,1);
  u.instance.action('refresh');u.read({context_revision:4,profile:item('profile','current',4,{name:'另一设备的更新',role:'同事',context:''})});
  assert.match(u.html(),/我的修改稿/);assert.match(u.html(),/另一设备的更新/);
  u.instance.action('rebase');u.instance.input('confirmed',true);u.instance.action('save');
  const next=u.last('personal.context.profile');assert.equal(next.expected_revision,4);assert.equal(next.value.name,'我的修改稿');assert.notEqual(next.op_id,original.op_id);
});
test('refresh updates a clean form while a dirty form is kept and marked for comparison',()=>{
  const u=ui();u.instance.action('refresh');u.read({context_revision:2,profile:item('profile','current',2,{name:'设备同步来的名字',role:'负责人',context:''})});
  assert.match(u.html(),/设备同步来的名字/);u.instance.input('name','我的未保存稿');
  u.instance.action('refresh');u.read({context_revision:3,profile:item('profile','current',3,{name:'新版本',role:'负责人',context:''})});
  assert.match(u.html(),/我的未保存稿/);assert.match(u.html(),/其他设备已更新/);assert.match(u.html(),/新版本/);
});
test('binding, service and response identity changes clear all cached body and cannot revive late responses',()=>{
  for (const change of [u=>u.bind('account-b',2),u=>u.bind('account-a',1,'http:https://another.test'),u=>u.instance.reset()]) {
    const u=ui();edit(u,'私有原稿');const old=u.messages.at(-1).payload.requestId;change(u);
    u.instance.receive('personal.context',{requestId:old,identity_revision:1,context_revision:1,item:item('profile','current',1,{name:'私有原稿'}),operation_revision:1});
    assert.doesNotMatch(u.html(),/私有原稿/);assert.equal(u.saved.values.size,0);
  }
  const u=ui();u.instance.action('refresh');u.receive({identity_revision:2,context_revision:1,profile:item('profile','current',1,{name:'不属于当前绑定'}),preferences:null,memories:[]});
  assert.doesNotMatch(u.html(),/不属于当前绑定/);assert.match(u.html(),/先在「我的飞书」连接/);
});
test('late reads cannot replace a newer explicit refresh',()=>{
  const u=ui();u.instance.action('refresh');const old=u.messages.at(-1).payload.requestId;u.timers.at(-1)();u.instance.action('refresh');
  const latest=u.messages.at(-1).payload.requestId;
  u.instance.receive('personal.context',{requestId:old,identity_revision:1,context_revision:1,profile:item('profile','current',1,{name:'旧请求'}),preferences:null,memories:[]});
  u.instance.receive('personal.context',{requestId:latest,identity_revision:1,context_revision:2,profile:item('profile','current',2,{name:'最新请求'}),preferences:null,memories:[]});
  assert.match(u.html(),/最新请求/);assert.doesNotMatch(u.html(),/旧请求/);
});
test('an unrecognized native 403 clears the recovery journal and old body without accepting a later success',()=>{
  const u=ui(),original=edit(u,'403后不能留下的正文');
  u.receive({scope:'personalContext',httpStatus:403,code:'NEW_PERMISSION_DENIED',message:'权限已变化'},'error');
  assert.equal(u.saved.values.size,0);assert.doesNotMatch(u.html(),/403后不能留下的正文/);assert.match(u.html(),/连接我的飞书/);
  u.instance.receive('personal.context',{requestId:original.requestId,identity_revision:1,context_revision:1,item:item('profile','current',1,original.value),operation_revision:1});
  assert.doesNotMatch(u.html(),/403后不能留下的正文/);
});
test('an original successful write replayed after another device update never overwrites the newer item',()=>{
  const u=ui(),old=edit(u,'原操作正文');u.timers.at(-1)();u.instance.action('retry');
  u.receive({identity_revision:1,context_revision:3,item:item('profile','current',3,{name:'之后设备改过的内容',role:'',context:''}),operation_revision:1,replayed:true});
  assert.match(u.html(),/原操作已保存，随后已有其他更新/);assert.match(u.html(),/原操作正文/);assert.match(u.html(),/之后设备改过的内容/);
  u.instance.action('save');assert.equal(u.messages.filter(x=>x.type==='personal.context.profile').length,2);assert.equal(u.saved.values.size,0);assert.ok(old.op_id);
});
test('memory save uses an explicit manual source and deletion stays versioned',()=>{
  const u=ui();u.instance.action('new');u.instance.input('title','本人确认的目标');u.instance.input('body','先完成首版试用');u.instance.input('category','goal');u.instance.input('confirmed',true);u.instance.action('save');
  const write=u.last('personal.context.memory');assert.equal(write.source.kind,'manual');assert.equal(write.value.category,'goal');assert.match(write.memory_id,/^MEM-/);
  u.receive({identity_revision:1,context_revision:1,item:item('memory',write.memory_id,1,write.value),operation_revision:1});
  u.instance.input('confirmed',true);u.instance.action('delete');const remove=u.last('personal.context.delete');assert.equal(remove.memory_id,write.memory_id);assert.equal(remove.expected_revision,1);assert.equal(remove.value,undefined);
});
test('invalid sources hide stale memory bodies and server HTML is escaped',()=>{
  const u=ui();u.instance.action('refresh');u.read({context_revision:2,memories:[{kind:'memory',id:'withdrawn',revision:2,status:'needs_review',confirmed:false,value:null,source:null,updated_at:''},item('memory','safe',1,{title:'<script>bad()</script>',body:'<img src=x>',category:'fact'})]});
  u.instance.action('tab','memory');assert.match(u.html(),/旧正文已隐藏/);assert.match(u.html(),/&lt;script&gt;/);assert.doesNotMatch(u.html(),/<script>bad/);
});
test('failure to persist the original operation blocks a real write before it leaves the device',()=>{
  const bad={getItem:()=>null,setItem(){throw new Error('blocked');},removeItem(){}};
  const u=ui(bad);edit(u);assert.equal(u.last('personal.context.profile'),undefined);assert.match(u.html(),/无法保留原操作/);
});
test('explicit scenario limits survive server refresh and a saved edit without silently becoming general',()=>{
  const u=ui();u.instance.action('refresh');u.read({context_revision:1,preferences:item('preferences','current',1,{enabled:true,tone:'先结论',answer_length:'简短',focus:'首版',avoid:'',context:'团队讨论',scenarios:['会议']})});
  u.instance.action('tab','preferences');u.instance.input('focus','确认后再执行');u.instance.input('confirmed',true);u.instance.action('save');
  const write=u.last('personal.context.preferences');assert.deepEqual(write.value.scenarios,['会议']);assert.equal(write.value.context,'团队讨论');
});
test('scenario checkboxes require an explicit nonempty choice and general excludes specific scopes',()=>{
  const u=ui();u.instance.input('scenario:会议',true);u.instance.input('confirmed',true);u.instance.action('save');
  assert.deepEqual(u.last('personal.context.profile').value.scenarios,['会议']);
  const v=ui();v.instance.input('scenario:通用',false);v.instance.input('confirmed',true);v.instance.action('save');assert.equal(v.last('personal.context.profile'),undefined);assert.match(v.html(),/至少一个适用场景/);
});

const personMemory=(id,personId,body,name='同名人物',personKind='fact')=>item('memory',id,1,{title:'关于此人的记录',body,category:'person',person_id:personId,person_name:name,person_kind:personKind,scenarios:['通用']});
function openPerson(u,person,memories=[],people=[]) {u.instance.open({person,memory:true,people});u.bind();u.read({memories});}
test('a person entry filters by an explicitly selected stable ID and does not mix same-name or ordinary memories',()=>{
  const u=ui();
  openPerson(u,{id:'person-a',name:'同名人物'},[personMemory('ma','person-a','只属于甲的记录'),personMemory('mb','person-b','只属于乙的记录'),item('memory','plain',1,{title:'普通记忆',body:'我的个人背景',category:'background'})], [{id:'person-a',name:'同名人物'},{id:'person-b',name:'同名人物'}]);
  assert.match(u.html(),/只属于甲的记录/);assert.doesNotMatch(u.html(),/只属于乙的记录|我的个人背景/);assert.match(u.html(),/本人手工记录，不是对方原话/);
  u.instance.action('new');u.instance.input('title','交流偏好');u.instance.input('body','我记录他偏好提前收到议程');u.instance.input('person_kind','preference');u.instance.input('person_id','person-b');u.instance.input('confirmed',true);u.instance.action('save');
  const write=u.last('personal.context.memory');assert.equal(write.value.person_id,'person-a');assert.equal(write.value.person_kind,'preference');assert.equal(write.source.kind,'manual');assert.equal(write.value.category,'person');
});
test('name-only voice entries require a deliberate manual person record and never derive an ID from the name',()=>{
  const u=ui();openPerson(u,{name:'同名人物'});
  assert.match(u.html(),/尚无稳定人物编号/);assert.match(u.html(),/同名不会合并/);
  u.instance.action('person-new');u.instance.input('title','会面背景');u.instance.input('body','这是我的手工记录');u.instance.input('confirmed',true);u.instance.action('save');
  const first=u.last('personal.context.memory');assert.match(first.value.person_id,/^PERSON-/);assert.notEqual(first.value.person_id,'同名人物');assert.equal(first.value.person_name,'同名人物');
  u.receive({identity_revision:1,context_revision:1,item:item('memory',first.memory_id,1,first.value),operation_revision:1});
  openPerson(u,{name:'同名人物'},[item('memory',first.memory_id,1,first.value)]);u.instance.action('person-new');u.instance.input('title','另一个人的记录');u.instance.input('body','不同人，同一个称呼');u.instance.input('confirmed',true);u.instance.action('save');
  assert.notEqual(u.last('personal.context.memory').value.person_id,first.value.person_id);
});
test('manual person memory works without voiceprint enrollment and preserves the ID when its label changes',()=>{
  const u=ui();u.instance.action('tab','memory');u.instance.action('person-new');
  u.instance.input('person_name','手工人物');u.instance.input('title','约好的下一步');u.instance.input('body','本人记录：下周联系');u.instance.input('person_kind','commitment');u.instance.input('confirmed',true);u.instance.action('save');
  const first=u.last('personal.context.memory');assert.equal(first.value.person_kind,'commitment');assert.match(first.value.person_id,/^PERSON-/);
  u.receive({identity_revision:1,context_revision:1,item:item('memory',first.memory_id,1,first.value),operation_revision:1});
  u.instance.input('person_name','改过的显示称呼');u.instance.input('confirmed',true);u.instance.action('save');
  const second=u.last('personal.context.memory');assert.equal(second.value.person_id,first.value.person_id);assert.equal(second.expected_revision,1);assert.equal(second.value.person_name,'改过的显示称呼');
});
test('person selection is mandatory and switching back to an ordinary category strips every person metadata field',()=>{
  const u=ui();u.instance.action('new');u.instance.input('category','person');u.instance.input('person_name','只有名字');u.instance.input('title','没有明确人物');u.instance.input('body','不能凭名字关联');u.instance.input('confirmed',true);u.instance.action('save');
  assert.equal(u.last('personal.context.memory'),undefined);assert.match(u.html(),/明确选择人物档案/);
  u.instance.input('category','fact');u.instance.input('confirmed',true);u.instance.action('save');
  const value=u.last('personal.context.memory').value;for(const key of ['person_id','person_name','person_kind'])assert.equal(Object.hasOwn(value,key),false);
});
test('person memory keeps its selected identity and subtype through unknown-request recovery',()=>{
  const u=ui();openPerson(u,{id:'person-a',name:'甲'});u.instance.action('new');u.instance.input('title','交流背景');u.instance.input('body','这次由我手工整理');u.instance.input('person_kind','background');u.instance.input('confirmed',true);u.instance.action('save');
  const original=u.last('personal.context.memory');u.timers.at(-1)();u.instance.action('retry');
  const replay=u.last('personal.context.memory');assert.equal(replay.op_id,original.op_id);assert.deepEqual(replay.value,original.value);assert.equal(replay.value.person_id,'person-a');assert.equal(replay.value.person_kind,'background');
});
test('unverified quotation person imports and person metadata on ordinary memories are rejected at the display boundary',()=>{
  for(const memory of [
    {...personMemory('bad','person-a','不能冒充的原话'),source:{kind:'meeting',session_id:'s1',utterance_ids:['u1']}},
    item('memory','bad',1,{title:'普通记忆',body:'不能混入的人物记录',category:'fact',person_id:'person-a',person_name:'甲',person_kind:'fact'})
  ]){
    const u=ui();u.instance.action('refresh');u.read({memories:[memory]});u.instance.action('tab','memory');
    assert.match(u.html(),/无法核对/);assert.doesNotMatch(u.html(),/不能冒充的原话|不能混入的人物记录/);
  }
});
test('creating a manual person from an already written memory draft preserves its title and body',()=>{
  const u=ui();u.instance.action('new');u.instance.input('category','person');u.instance.input('title','已写的标题');u.instance.input('body','已写的手工内容');u.instance.input('person_name','新人物');u.instance.action('person-new');u.instance.input('confirmed',true);u.instance.action('save');
  const value=u.last('personal.context.memory').value;assert.equal(value.title,'已写的标题');assert.equal(value.body,'已写的手工内容');assert.equal(value.person_name,'新人物');assert.match(value.person_id,/^PERSON-/);
});
test('person drafts remain recoverable from the general list but never appear inside another persons filter',()=>{
  const u=ui();openPerson(u,{id:'person-a',name:'甲'},[],[{id:'person-a',name:'甲'},{id:'person-b',name:'乙'}]);u.instance.action('new');u.instance.input('title','甲的未保存草稿');u.instance.input('body','甲的未保存内容');
  u.instance.action('all-memories');assert.match(u.html(),/未保存的修改稿/);assert.match(u.html(),/甲的未保存内容/);
  u.instance.action('person-select','person-b');assert.doesNotMatch(u.html(),/甲的未保存草稿|甲的未保存内容/);
  u.instance.action('all-memories');u.instance.action('person-select','person-a');assert.match(u.html(),/甲的未保存内容/);
  const draftId=u.html().match(/data-pa-action="draft-open" data-id="([^"]+)"/)[1];u.instance.action('draft-open',draftId);u.instance.input('confirmed',true);u.instance.action('save');assert.equal(u.last('personal.context.memory').value.body,'甲的未保存内容');
});
test('person deletion conflicts preserve the correct draft and delete only the reviewed revision after explicit comparison',()=>{
  const u=ui(),original=personMemory('memory-a','person-a','甲的原记录','甲');openPerson(u,{id:'person-a',name:'甲'},[original]);u.instance.action('edit','memory-a');u.instance.input('body','本人修改待核对');u.instance.input('confirmed',true);u.instance.action('delete');
  const first=u.last('personal.context.delete');assert.equal(first.expected_revision,1);
  u.receive({httpStatus:409,code:'PERSONAL_CONTEXT_REVISION_CONFLICT',message:'其他设备已更新'},'error');assert.match(u.html(),/本人修改待核对/);
  u.instance.action('refresh');u.read({context_revision:2,memories:[{...original,revision:2,value:{...original.value,body:'另一设备更新'}}]});assert.match(u.html(),/另一设备更新/);assert.match(u.html(),/本人修改待核对/);
  u.instance.action('rebase');u.instance.input('confirmed',true);u.instance.action('delete');const second=u.last('personal.context.delete');assert.equal(second.expected_revision,2);assert.equal(second.memory_id,'memory-a');assert.notEqual(second.op_id,first.op_id);
  u.receive({identity_revision:1,context_revision:3,item:{kind:'memory',id:'memory-a',revision:3,status:'deleted',confirmed:false,value:null,source:null},operation_revision:3});assert.doesNotMatch(u.html(),/本人修改待核对|甲的原记录|另一设备更新/);
});
test('another persons preference is a private person memory and never backfills the current users assistant preferences',()=>{
  const u=ui();u.instance.open({memory:true});u.bind();u.read({context_revision:2,preferences:item('preferences','current',1,{enabled:true,tone:'本人先结论',answer_length:'简短',focus:'本人的目标',avoid:'',context:'我的工作',scenarios:['通用']}),memories:[personMemory('other-pref','person-a','对方喜欢详细材料','甲','preference')]});
  u.instance.action('person-select','person-a');assert.match(u.html(),/对方喜欢详细材料/);
  assert.equal(u.last('personal.context.preferences'),undefined);
  u.instance.action('tab','preferences');assert.match(u.html(),/本人先结论/);assert.doesNotMatch(u.html(),/对方喜欢详细材料/);
  u.instance.input('confirmed',true);u.instance.action('save');const value=u.last('personal.context.preferences').value;assert.equal(value.tone,'本人先结论');assert.equal(value.focus,'本人的目标');assert.equal(Object.hasOwn(value,'person_id'),false);
});
test('a general memory source withdrawal clears a dirty draft and its retained-draft entry instead of reclassifying old text as manual',()=>{
  const u=ui(),memory={...item('memory','source-memory',1,{title:'原话资料',body:'旧来源正文',category:'fact',scenarios:['通用']}),source:{kind:'meeting',session_id:'s1',utterance_ids:['u1']}};
  u.instance.action('refresh');u.read({memories:[memory]});u.instance.action('edit','source-memory');u.instance.input('body','旧来源正文与尚未确认的修改');
  u.instance.action('refresh');u.read({context_revision:2,memories:[{...memory,revision:2,status:'needs_review',confirmed:false,value:null,source:null}]});
  assert.doesNotMatch(u.html(),/旧来源正文|尚未确认的修改/);assert.match(u.html(),/修改稿已清除/);
  u.instance.input('confirmed',true);u.instance.action('rebase');u.instance.action('save');assert.equal(u.last('personal.context.memory'),undefined);
  u.instance.action('all-memories');assert.doesNotMatch(u.html(),/旧来源正文|尚未确认的修改/);
});
test('source withdrawal also scrubs an unknown write journal while retaining its operation ID without resending stale content',()=>{
  const u=ui(),memory={...item('memory','source-memory',1,{title:'原话资料',body:'原来源敏感正文',category:'fact',scenarios:['通用']}),source:{kind:'meeting',session_id:'s1',utterance_ids:['u1']}};
  u.instance.action('refresh');u.read({memories:[memory]});u.instance.action('edit','source-memory');u.instance.input('body','原来源敏感正文与修改');u.instance.input('confirmed',true);u.instance.action('save');const original=u.last('personal.context.memory');u.timers.at(-1)();
  u.instance.action('refresh');u.read({context_revision:2,memories:[{...memory,revision:2,status:'needs_review',confirmed:false,value:null,source:null}]});
  assert.doesNotMatch(JSON.stringify([...u.saved.values.values()]),/原来源敏感正文/);assert.match(JSON.stringify([...u.saved.values.values()]),new RegExp(original.op_id));
  u.instance.action('retry');assert.equal(u.messages.filter(message=>message.type==='personal.context.memory').length,1);assert.match(u.html(),/原请求正文已清除/);
});
test('the isolated mock preserves person fields and requires explicit matching person selection in snapshots',()=>{
  const context={window:{},location:{search:'?preview=1'},URLSearchParams,crypto:{randomUUID:(()=>{let n=0;return()=>String(++n);})()},performance:{now:()=>0},Date,console,
    localStorage:{getItem:()=>null,setItem(){}},queueMicrotask:fn=>fn(),setTimeout:fn=>{fn();return 1;},clearTimeout(){},setInterval:()=>1,clearInterval(){}};
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../main/assets/web/bridge-mock.js'),'utf8'),context);
  const events=[],native=context.window.OopsNative;native.onmessage=event=>events.push(JSON.parse(event.data));
  const send=(type,payload={})=>native.postMessage(JSON.stringify({type,payload}));const last=type=>events.filter(event=>event.type===type).at(-1)?.payload;
  send('feishu.connect');send('personal.context.preferences',{requestId:'prefs',op_id:'prefs-op',expected_revision:0,confirmed:true,value:{enabled:true,scenarios:['通用']}});
  send('personal.context.memory',{requestId:'person',op_id:'person-op',expected_revision:0,confirmed:true,memory_id:'person-memory',value:personMemory('person-memory','person-a','私人内容').value,source:{kind:'manual'}});
  assert.equal(last('personal.context').item.value.person_id,'person-a');
  send('personal.context.snapshot',{memory_ids:['person-memory']});assert.deepEqual(last('personal.context').context.memories,[]);assert.equal(last('personal.context').excluded[0].status,'person_selection_required');
  send('personal.context.snapshot',{memory_ids:['person-memory'],person_id:'person-b'});assert.equal(last('error').code,'PERSONAL_CONTEXT_PERSON_MISMATCH');
  send('personal.context.snapshot',{memory_ids:['person-memory'],person_id:'person-a'});assert.equal(last('personal.context').context.memories[0].person_id,'person-a');
});

function appUI() {
  const elements=new Map(),messages=[],errors=[],saved=storage();
  const el=id=>{if(!elements.has(id))elements.set(id,{id,dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},setAttribute(){},appendChild(){},insertBefore(){},querySelectorAll:()=>[],listeners:{},addEventListener(type,fn){(this.listeners[type] ||= []).push(fn);}});return elements.get(id);};
  const native={postMessage:raw=>messages.push(JSON.parse(raw))},window={OopsNative:native,localStorage:saved,addEventListener(){}};
  const environment={window,location:{search:''},URLSearchParams,document:{addEventListener(){},getElementById:el,createElement:()=>el(Symbol()),querySelectorAll:()=>[],documentElement:{dataset:{}}},setTimeout(){},clearTimeout(){},console:{...console,error:err=>errors.push(err)}};
  const context=vm.createContext(environment);vm.runInContext(source,context);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../main/assets/web/app.js'),'utf8'),context);
  const receive=(type,payload)=>native.onmessage({data:JSON.stringify({type,payload})});
  const click=(act,data={})=>el('sheet').listeners.click.forEach(fn=>fn({stopPropagation(){},target:{closest:()=>({dataset:{act,...data}})}}));
  const input=(field,value,type='textarea')=>el('sheet').listeners[type==='checkbox'?'change':'input'].forEach(fn=>fn({target:{id:'',type,dataset:{paField:field},value,checked:value===true}}));
  const last=type=>messages.filter(message=>message.type===type).at(-1)?.payload;
  receive('snapshot',{state:{capturing:false,selfName:'本人',backend:'http',backendUrl:'https://example.test'},team:[],transcript:[]});
  click('personal-open');receive('feishu.status',{requestId:last('feishu.status').requestId,status:'bound',binding_revision:1,account:{name:'本人',open_id:'ou_self',tenant_key:'t1'}});
  receive('personal.context',{requestId:last('personal.context.read').requestId,identity_revision:1,context_revision:0,profile:null,preferences:null,memories:[],backendUrl:'https://example.test'});
  return {el,messages,errors,last,click,input,receive};
}
test('the real app settings event routes a confirmed private form through the native personal-context channel',()=>{
  const u=appUI();assert.match(u.el('sheet').innerHTML,/我的档案/);
  u.input('name','真实入口的本人稿');u.input('confirmed',true,'checkbox');u.click('personal-context',{paAction:'save'});
  const write=u.last('personal.context.profile');assert.equal(write.value.name,'真实入口的本人稿');assert.equal(write.confirmed,true);assert.ok(write.op_id);assert.equal(u.errors.length,0);
});
test('the app clears personal context on a backend change and ignores the old native response',()=>{
  const u=appUI();u.input('name','不能跨服务复活');u.input('confirmed',true,'checkbox');u.click('personal-context',{paAction:'save'});const request=u.last('personal.context.profile');
  u.receive('backend.changed',{backend:'http',backendUrl:'https://other.test',serviceEpoch:2});
  u.receive('personal.context',{requestId:request.requestId,identity_revision:1,context_revision:1,item:item('profile','current',1,request.value),operation_revision:1,backendUrl:'https://example.test',serviceEpoch:1});
  u.click('personal-open');assert.doesNotMatch(u.el('sheet').innerHTML,/不能跨服务复活/);assert.equal(u.errors.length,0);
});
test('the actual memory people entry opens the selected stable person and a name-only catalog stays unbound',()=>{
  const u=appUI();u.receive('state',{voiceprint:{phase:'idle',catalog:{people:[{id:'person-a',name:'同名'},{id:'person-b',name:'同名'}]}}});u.click('go',{route:'memory'});u.click('memory-tab',{value:'people'});
  assert.match(u.el('screen').innerHTML,/data-act="person-memory-open" data-person-id="person-a"/);
  u.click('person-memory-open',{personId:'person-a',personLabel:'同名'});
  u.receive('feishu.status',{requestId:u.last('feishu.status').requestId,status:'bound',binding_revision:1,account:{name:'本人',open_id:'ou_self',tenant_key:'t1'}});
  u.receive('personal.context',{requestId:u.last('personal.context.read').requestId,identity_revision:1,context_revision:1,profile:null,preferences:null,memories:[personMemory('a','person-a','甲的内容'),personMemory('b','person-b','乙的内容')]});
  assert.match(u.el('sheet').innerHTML,/甲的内容/);assert.doesNotMatch(u.el('sheet').innerHTML,/乙的内容/);
  u.click('person-memory-open',{personLabel:'同名'});u.receive('feishu.status',{requestId:u.last('feishu.status').requestId,status:'bound',binding_revision:1,account:{name:'本人',open_id:'ou_self',tenant_key:'t1'}});
  u.receive('personal.context',{requestId:u.last('personal.context.read').requestId,identity_revision:1,context_revision:1,profile:null,preferences:null,memories:[]});
  assert.match(u.el('sheet').innerHTML,/尚无稳定人物编号/);assert.equal(u.errors.length,0);
});
