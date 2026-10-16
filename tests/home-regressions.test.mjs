import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {registerHooks,stripTypeScriptTypes} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:')){const url=new URL(specifier,context.parentURL);if(!/\.[a-z]+$/i.test(url.pathname))for(const ext of ['.ts','.tsx'])if(existsSync(new URL(url.href+ext)))return next(url.href+ext,context);}return next(specifier,context);}});
const url=p=>new URL(p,import.meta.url).href;
async function load(code){return import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(code,{mode:'strip'})).toString('base64'));}
const store=readFileSync(new URL('../src/store.tsx',import.meta.url),'utf8');
const {initialData}=await load(store.slice(store.indexOf('export function initialData')));
const home=readFileSync(new URL('../src/features/Home.tsx',import.meta.url),'utf8');
const imports=`import { buildPersonalContext } from '${url('../src/personalAssistant.ts')}';import {sharedMemoryEligible} from '${url('../src/memoryAccess.ts')}';import {makeSourceReference,materialVisible,provenanceAvailable,sourceAvailable,taskSourceAvailable,taskVisible as scopedTaskVisible,sessionVisible as scopedSessionVisible} from '${url('../src/sourceAccess.ts')}';import {taskIsMyAttention,taskBelongsToMe} from '${url('../src/taskWorkflow.ts')}';`;
const model=await load(imports+home.slice(home.indexOf('export function homeTitle'),home.indexOf('export function Home()'))+home.slice(home.indexOf('type LocalAnswer'),home.indexOf('function referenceRoute'))+home.slice(home.indexOf('export function notificationVisible'),home.indexOf('export function Notifications')));
const {provenanceAvailable:awaitableProvenance}=await import('../src/sourceAccess.ts');
const {migrateStoredData}=await import('../src/stateMigrations.ts');
test('native home names only the connected real source and marks test services explicitly',()=>{
 assert.match(model.nativeHomeDeviceSummary({source:'mic',capturing:true,sourceReady:true},true),/手机麦克风.*正在收音/);
 assert.match(model.nativeHomeDeviceSummary({source:'bean',capturing:true,sourceReady:false},true),/录音豆.*等待音源/);
 assert.match(model.nativeHomeDeviceSummary({source:'wav',backend:'mock'},true),/测试音频.*测试服务/);
 assert.doesNotMatch(model.nativeHomeDeviceSummary({source:'bean'},false),/已连接|正在收音|示例/);
});
function stock(){const d=initialData(),t=d.tasks.find(t=>t.id==='TASK-032');t.needsReview=false;t.sourceNeedsReview=false;t.results=['旧库存999件'];t.artifacts=[{id:'old',kind:'资料',title:'旧库存',version:1,created:'昨天',body:['旧库存999件'],reviewedAt:'昨天',needsReview:false,sourceNeedsReview:true},{id:'new',kind:'资料',title:'已核对库存',version:2,created:'今天',body:['新库存18件'],reviewedAt:'今天',needsReview:false}];return d;}
test('revalidated task cannot reuse invalid retained artifact or legacy result',()=>{const d=stock();d.tasks.find(t=>t.id==='TASK-032').artifacts=d.tasks.find(t=>t.id==='TASK-032').artifacts.slice(0,1);assert.doesNotMatch(model.buildLocalAnswer('椅子库存',d,true).text,/999/);assert.equal(model.buildLocalAnswer('椅子库存',d,true).sources.length,0);});
test('inventory answer uses only a reviewed current-source artifact',()=>{const d=stock(),a=model.buildLocalAnswer('椅子库存',d,true);assert.match(a.text,/18件/);assert.doesNotMatch(a.text,/999/);d.tasks.find(t=>t.id==='TASK-032').artifacts[1].needsReview=true;assert.doesNotMatch(model.buildLocalAnswer('椅子库存',d,true).text,/18件/);});
test('raw words absent from summary are searchable and route to the exact turn',()=>{const d=initialData();d.sessions[0].transcript.push({id:'specific',time:'00:21:00',speaker:'我',text:'独特检索词 nebula42'});const rows=model.searchSavedContent(d,'NEBULA42','会话');assert.equal(rows.length,1);assert.equal(rows[0].route.mode,'specific');});
test('shared search cannot expose a private raw turn',()=>{const d=initialData();d.settings.space='Oops 产品团队';d.settings.toggles['shared-session-001']=true;d.sessions[0].transcript.push({id:'secret',time:'00:21:00',speaker:'我',text:'privateNeedle',private:true});assert.deepEqual(model.searchSavedContent(d,'privateNeedle'),[]);});
test('an unrelated question cannot cite an arbitrary first conversation',()=>{const a=model.buildLocalAnswer('想讨论银河旅行',initialData(),true);assert.equal(a.sources.length,0);assert.match(a.text,/哪段会话/);});
test('resolved memory and cancelled-task notifications are not active reminders',()=>{const d=initialData();d.memories.find(m=>m.id==='MEM-003').confirmed=true;assert.equal(model.notificationVisible(d,{view:'memory-conflict',id:'MEM-003'}),false);d.tasks[0].status='已取消';assert.equal(model.notificationVisible(d,{view:'task-detail',id:d.tasks[0].id}),false);});
test('migration binds only verified exact turns and archives stale completion',()=>{const d=initialData();delete d.sessions[0].transcript[1].personId;d.sessions[0].transcript.push({id:'same',time:'00:24:00',speaker:'Alex',text:'尚未核对'});d.tasks[0].completion={summary:'旧完成',date:'昨天',remaining:'',actor:'我'};d.tasks[0].due='2026/10/09 17:00';const m=migrateStoredData(d);assert.equal(m.sessions[0].transcript[1].personId,'p2');assert.equal(m.sessions[0].transcript.at(-1).personId,undefined);assert.equal(m.tasks[0].completion,undefined);assert.equal(m.tasks[0].completionHistory[0].summary,'旧完成');assert.equal(m.tasks[0].due,'2026-10-09T17:00');});


test('my todo answers exclude other owners and namesakes while project queries retain visible work',()=>{
 const data=initialData();data.tasks=data.tasks.slice(0,1);data.tasks[0].sourceSession=undefined;data.tasks[0].sourceTime=undefined;
 const other={...data.tasks[0],id:'other',title:'另一位同名联系人的工作',owner:data.settings.name,ownerPersonId:'namesake',sourceId:undefined,sources:[]};data.tasks.push(other);
 const personal=model.buildLocalAnswer('我的待办有哪些？',data,true);assert.equal(personal.sources.length,1);assert.doesNotMatch(personal.text,/另一位同名联系人的工作/);
 assert.equal(model.buildLocalAnswer('项目所有人的任务有哪些？',data,true).sources.length,2);
});


test('request-specific exclusions and disabling personalization stop applying private style', async()=>{
 const {setPersonalizationEnabled}=await import('../src/personalAssistant.ts');
 const data=initialData();data.settings.tone='逐步说明操作';
 assert.match(model.buildLocalAnswer('项目预算是多少？',data,true).text,/^1\./);
 assert.doesNotMatch(model.buildLocalAnswer('项目预算是多少？',data,true,{excludeIds:['my-profile:preferences']}).text,/^1\./);
 assert.doesNotMatch(model.buildLocalAnswer('项目预算是多少？',setPersonalizationEnabled(data,false),true).text,/^1\./);
 assert.equal(model.buildLocalAnswer('我是谁？',setPersonalizationEnabled(data,false),true).sources.length,0);
});

test('preference scenarios and changed boundaries are part of answer provenance',()=>{
 const data=initialData();data.settings.tone='逐步说明操作';data.settings.retention.preferenceContext='汇报';
 assert.doesNotMatch(model.buildLocalAnswer('项目预算是多少？',data,true,{scenario:'研究'}).text,/^1\./);
 const answer=model.buildLocalAnswer('项目预算是多少？',data,true,{scenario:'汇报'});
 assert.match(answer.text,/^1\./);
 data.settings.retention.avoid='不要引用未确认的数据';
 assert.equal(model.buildLocalAnswer('项目预算是多少？',data,true,{scenario:'汇报'}).sources.some(ref=>ref.kind==='profile'),true);
 assert.equal((awaitableProvenance(data,answer.sources)),false);
});


test('explicit person selection uses only their confirmed memories and keeps namesakes separate', async()=>{
 const {savePersonMemory,reviewPersonMemory,deletePersonMemory}=await import('../src/personMemory.ts');
 let data=initialData();
 data.people.push({id:'same-name',name:'王宁',role:'另一组织',company:'另一组织',note:'',voice:false,shared:false});
 const save=(personId,text)=>{const saved=savePersonMemory(data,{personId,kind:'commitment',text});assert.equal(saved.error,undefined);data=reviewPersonMemory(saved.data,saved.id,'confirm').data;return saved.id;};
 const ownId=save('p1','我答应周四发送预算明细。');save('same-name','另一位人物的秘密暗号。');
 const answer=model.buildLocalAnswer('帮我准备沟通',data,true,{personId:'p1'});
 const taskAnswer=model.buildLocalAnswer('今天需要跟进哪些待办？',data,true,{personId:'p1'});
 assert.ok(taskAnswer.sources.some(ref=>ref.kind==='task'));
 assert.match(answer.text,/周四发送预算/);assert.doesNotMatch(answer.text,/秘密暗号/);
 assert.doesNotMatch(model.buildLocalAnswer('帮我准备沟通',data,true).text,/周四发送预算/);
 assert.doesNotMatch(model.buildLocalAnswer('帮我准备沟通',data,true,{personId:'p1',excludeIds:[ownId]}).text,/周四发送预算/);
 assert.equal(awaitableProvenance(data,answer.sources),true);
 const removed=deletePersonMemory(data,ownId).data;
 assert.equal(awaitableProvenance(removed,answer.sources),false);
 data.settings.space='Oops 产品团队';
 assert.doesNotMatch(model.buildLocalAnswer('帮我准备沟通',data,true,{personId:'p1'}).text,/周四发送预算/);
});
