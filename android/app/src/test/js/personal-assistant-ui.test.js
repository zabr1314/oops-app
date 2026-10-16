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
