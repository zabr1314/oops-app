import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=readFileSync(new URL('../src/store.tsx',import.meta.url),'utf8');
const {initialData}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source.slice(source.indexOf('export function initialData')),{mode:'strip'})).toString('base64'));
const {PRIVACY_NOTICE_VERSION,privacyNoticeAccepted,privacyNoticeAcceptedAt,confirmPrivacyNotice,saveWelcomeChoices}=await import('../src/privacyNoticeLogic.ts');
const now=new Date('2026-10-12T06:00:00Z');
const choices={name:'  新称呼  ',role:'  设计师 ',cloud:false,memory:true};

test('first use is unconfirmed; browsing or an unchecked submission does not write acknowledgement',()=>{
  const data=initialData(), before=structuredClone(data);
  assert.equal(privacyNoticeAccepted(data),false);
  assert.equal(confirmPrivacyNotice(data,false,now),data);
  assert.equal(privacyNoticeAcceptedAt(data),undefined);
  assert.deepEqual(data,before);
});
test('acknowledgement records exact notice version and time without authorizing optional capabilities',()=>{
  const data=initialData(),before=structuredClone(data);
  const result=confirmPrivacyNotice(data,true,now);
  assert.equal(privacyNoticeAccepted(result),true);
  assert.equal(result.settings.retention['privacy-notice-version'],PRIVACY_NOTICE_VERSION);
  assert.equal(privacyNoticeAcceptedAt(result),now.toISOString());
  assert.deepEqual(result.settings.toggles,before.settings.toggles);
  assert.deepEqual(result.settings.connections,before.settings.connections);
  assert.deepEqual(result.people,before.people);
  assert.deepEqual(data,before);
});
test('welcome settings cannot be saved before current acknowledgement or with a blank name',()=>{
  const data=initialData();
  assert.equal(saveWelcomeChoices(data,choices),data);
  const accepted=confirmPrivacyNotice(data,true,now);
  assert.equal(saveWelcomeChoices(accepted,{...choices,name:'  '}),accepted);
});
test('welcome saves only explicit choices after acknowledgement, preserving voice and sharing permission',()=>{
  const accepted=confirmPrivacyNotice(initialData(),true,now);
  accepted.settings.toggles.ownVoiceShare=false;
  const before=structuredClone(accepted);
  const result=saveWelcomeChoices(accepted,choices,now);
  assert.equal(result.settings.name,'新称呼');assert.equal(result.settings.role,'设计师');
  assert.equal(result.settings.toggles.cloud,false);assert.equal(result.settings.toggles.memory,true);
  assert.deepEqual(result.settings.toggles,{...before.settings.toggles,cloud:false,memory:true});
  assert.deepEqual(result.settings.retention,{...before.settings.retention,'identity-updated-at':now.toISOString()});
  assert.deepEqual(accepted,before);
});
test('an old notice version or invalid confirmation timestamp requires a fresh acknowledgement',()=>{
  let data=confirmPrivacyNotice(initialData(),true,now);
  data.settings.retention['privacy-notice-version']='prototype-old';
  assert.equal(privacyNoticeAccepted(data),false);assert.equal(saveWelcomeChoices(data,choices),data);
  data=confirmPrivacyNotice(data,true,now);
  data.settings.retention['privacy-notice-accepted-at']='not a date';
  assert.equal(privacyNoticeAccepted(data),false);assert.equal(privacyNoticeAcceptedAt(data),undefined);
  assert.equal(confirmPrivacyNotice(data,true,new Date('invalid')),data);
});
