import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(url.pathname)) for (const ext of ['.ts', '.tsx']) if (existsSync(new URL(url.href + ext))) return next(url.href + ext, context);
  }
  return next(specifier, context);
} });
const store = readFileSync(new URL('../src/store.tsx', import.meta.url), 'utf8');
const { initialData } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(store.slice(store.indexOf('export function initialData')), { mode:'strip' })).toString('base64'));
const { personContentTopics, profileUpdatedAt, profileUpdateLabel, understandingEvidence } = await import('../src/memoryPeoplePresentation.ts');
const access = await import('../src/sourceAccess.ts');
const memorySource = readFileSync(new URL('../src/features/MemorySettings.tsx', import.meta.url), 'utf8');
const base = new URL('../', import.meta.url);
const dependency = `import { sharedMemoryEligible } from '${new URL('src/memoryAccess.ts', base)}';\nimport { sourceAvailable, sourceTurn, taskVisible, findSourceTask, invalidateSessionSources, makeSourceReference, provenanceAvailable } from '${new URL('src/sourceAccess.ts', base)}';\n`;
const memory = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(dependency + memorySource.slice(memorySource.indexOf('const PERSONAL'), memorySource.indexOf('function Download')), {mode:'strip'})).toString('base64'));
const TEAM = 'Oops 产品团队';
const now = new Date('2026-10-12T08:25:00.000Z');
const exact = (id, text, fields = {}) => ({id,personId:'p1',speaker:'王宁',time:'00:01:00',text,...fields});
function conversationData() {
  const data = initialData();
  data.sessions[0].title = '招聘预算项目';
  data.sessions[0].project = '合同采购项目';
  data.sessions[0].kind = '会议';
  data.sessions[0].transcript = [exact('checked','先确认预算，再整理资料卡和 PPT。'),exact('unchecked','库存还需要核对。'),exact('other','招聘计划。',{personId:'p2'}),exact('namesake','合同细节。',{personId:undefined})];
  data.settings.toggles['speaker-confirmed:session-001:checked'] = true;
  data.settings.toggles['speaker-confirmed:session-001:other'] = true;
  data.settings.toggles['speaker-confirmed:session-001:namesake'] = true;
  return data;
}

test('contact content labels use exact checked IDs and quote content instead of title, project or namesakes',()=>{
  const data = conversationData(), before = structuredClone(data);
  const topics = personContentTopics(data,'p1');
  assert.deepEqual(topics.map(topic=>topic.label),['预算','资料卡','PPT']);
  assert.equal(topics.every(topic=>topic.turn.id==='checked'),true);
  assert.deepEqual(topics[0].route,{view:'session-transcript',id:'session-001',mode:'checked'});
  assert.deepEqual(data,before);
  data.people[0].name = '待确认';
  assert.deepEqual(personContentTopics(data,'p1'),[]);
  assert.deepEqual(personContentTopics(data,'missing'),[]);
});

test('editing, removing or unchecking a passage immediately changes its topic labels and source routes',()=>{
  const data = conversationData();
  data.sessions[0].transcript[0].text = '我们继续研发设计。';
  assert.deepEqual(personContentTopics(data,'p1').map(topic=>topic.label),['研发','设计']);
  data.settings.toggles['speaker-confirmed:session-001:checked'] = false;
  assert.deepEqual(personContentTopics(data,'p1'),[]);
  data.settings.toggles['speaker-confirmed:session-001:checked'] = true;
  data.sessions[0].transcript.splice(0,1);
  assert.deepEqual(personContentTopics(data,'p1'),[]);
});

test('private contact words stay personal; team visibility needs both a shared identity and the matching shared session',()=>{
  const data = conversationData();
  data.sessions[0].transcript[0].private = true;
  assert.equal(personContentTopics(data,'p1')[0].turn.private,true);
  data.settings.space = TEAM;
  data.settings.toggles['shared-session-001'] = true;
  assert.deepEqual(personContentTopics(data,'p1'),[]);
  data.sessions[0].transcript[0].private = false;
  assert.equal(personContentTopics(data,'p1').length,3);
  data.settings.retention['session-space:session-001'] = '别的团队';
  assert.deepEqual(personContentTopics(data,'p1'),[]);
  delete data.settings.retention['session-space:session-001'];
  data.people[0].shared = false;
  assert.deepEqual(personContentTopics(data,'p1'),[]);
});

test('duplicate exact source IDs and a planned conversation cannot produce source-backed topic labels',()=>{
  const data = conversationData();
  data.sessions[0].transcript.push(exact('checked','成本指标。'));
  assert.deepEqual(personContentTopics(data,'p1'),[]);
  data.sessions[0].transcript.pop();
  data.sessions[0].status = '待开始';
  assert.deepEqual(personContentTopics(data,'p1'),[]);
});

test('repeated content labels prefer the latest visible conversation passed by the reader',()=>{
  const data = conversationData();
  data.sessions.push({...data.sessions[0],id:'newest',transcript:[exact('new','预算要继续跟进。')]});
  data.settings.toggles['speaker-confirmed:newest:new'] = true;
  const topics = personContentTopics(data,'p1',['newest','session-001']);
  assert.equal(topics.find(topic=>topic.label==='预算').session.id,'newest');
  assert.equal(topics.find(topic=>topic.label==='资料卡').session.id,'session-001');
});

test('legacy or malformed profile times remain unknown rather than becoming today or a source meeting date',()=>{
  const data = initialData(), before = structuredClone(data);
  assert.equal(profileUpdatedAt(data,'identity'),undefined);
  assert.equal(profileUpdateLabel(data,'preferences'),'更新时间未记录');
  assert.deepEqual(data,before);
  for (const invalid of ['今天','2026-10-12','not a date','2026-10-12T08:25:00']) {
    data.settings.retention['identity-updated-at'] = invalid;
    assert.equal(profileUpdatedAt(data,'identity'),undefined);
  }
});

test('saving identity records the real confirmation time and scene while preserving the old confirmed background and permissions',()=>{
  const data = initialData(), before = structuredClone(data);
  const result = memory.saveIdentityBackground(data,{name:'林',role:'设计师',roles:'产品协作',context:'用户访谈',plannedCandidateId:'role-new'},now);
  assert.equal(result.error,undefined);
  assert.equal(profileUpdatedAt(result.data,'identity'),now.toISOString());
  assert.match(profileUpdateLabel(result.data,'identity'),/2026.*10.*12/);
  assert.equal(result.data.settings.retention.roleContext,'用户访谈');
  assert.equal(result.data.memories.find(item=>item.id==='MEM-001').body,before.memories.find(item=>item.id==='MEM-001').body);
  assert.equal(result.data.memories.find(item=>item.id==='role-new').confirmed,false);
  assert.deepEqual(result.data.settings.toggles,before.settings.toggles);
  assert.deepEqual(data,before);
  assert.equal(memory.saveIdentityBackground(data,{name:'',role:'设计师',roles:'',context:''},now).data,data);
});

test('saving preferences records its own time and explicit scene without changing identity or any permission',()=>{
  const data = initialData(), before = structuredClone(data);
  const result = memory.savePersonalPreferences(data,{tone:'先问清楚',answerLength:'简短',focus:'产品体验',avoid:'频繁打断',context:' 项目复盘 '},now);
  assert.equal(profileUpdatedAt(result,'preferences'),now.toISOString());
  assert.equal(profileUpdatedAt(result,'identity'),undefined);
  assert.equal(result.settings.retention.preferenceContext,'项目复盘');
  assert.equal(result.settings.role,before.settings.role);
  assert.deepEqual(result.settings.toggles,before.settings.toggles);
  assert.deepEqual(data,before);
  assert.equal(memory.savePersonalPreferences(data,{tone:'先问清楚',answerLength:'简短',focus:'',avoid:'',context:''},new Date('invalid')),data);
});

test('understanding includes confirmed goals and backgrounds while leaving pending, stopped and historical records out',()=>{
  const data = initialData(), before = structuredClone(data);
  const read = understandingEvidence(data);
  assert.deepEqual(read.backgrounds.map(item=>item.id),['MEM-001']);
  assert.deepEqual(read.goals.map(item=>item.id),['MEM-004']);
  assert.deepEqual(data,before);
  for (const fields of [{confirmed:false},{needsReview:true},{deleted:true},{tags:['已停用']},{tags:['修订历史']},{tags:['待复核']}]) {
    const changed = structuredClone(data);
    Object.assign(changed.memories.find(item=>item.id==='MEM-004'),fields);
    assert.deepEqual(understandingEvidence(changed).goals,[]);
  }
});

test('understanding removes goals and backgrounds with missing or changed evidence instead of silently finding a similar source',()=>{
  const data = initialData();
  const goal = data.memories.find(item=>item.id==='MEM-004');
  Object.assign(goal,{sourceSession:'session-001',sourceId:'tr4',sources:[access.makeSourceReference(data,{kind:'session',id:'session-001',sourceId:'tr4'})]});
  assert.equal(understandingEvidence(data).goals.length,1);
  data.sessions[0].transcript.find(turn=>turn.id==='tr4').text = '已修改的目标依据。';
  assert.deepEqual(understandingEvidence(data).goals,[]);
  delete goal.sources;
  goal.sourceId = 'missing';
  assert.deepEqual(understandingEvidence(data).goals,[]);
  data.sessions = [];
  assert.deepEqual(understandingEvidence(data).backgrounds,[]);
});

test('understanding is personal even when individual identity and memory cards are shared',()=>{
  const data = initialData();
  data.settings.toggles.publicIdentity = true;
  data.memories.forEach(item=>item.visibility='项目共享');
  data.settings.space = TEAM;
  assert.deepEqual(understandingEvidence(data),{backgrounds:[],goals:[]});
});
