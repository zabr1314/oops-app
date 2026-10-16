import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMinutesSections, nativeSourceFocus } from '../src/native/presentation.ts';

test('ready minutes render human sections without treating owner hints as confirmed owners', () => {
 const result=nativeMinutesSections({status:'ready',minutes:{theme:'方案核对',overview:'保留两种方案',actions:[{task:'补预算',owner_hint:'小林'}],decisions:[{text:'先做小范围验证'}],undecided:[{topic:'设备选择',views:'仍有不同意见'}],topics:[{topic:'预算',points:['口径未定','周五确认']}],open_questions:[{question:'谁负责验收？'}]}});
 assert.equal(result[0].title,'方案核对');
 assert.match(result.find(row=>row.title==='待办').lines[0],/^负责人待确认/);
 assert.equal(result.find(row=>row.title==='还没定的事').lines[0],'设备选择：仍有不同意见');
 assert.ok(!JSON.stringify(result).includes('owner_hint'));
});
test('pending and withdrawn minutes never expose a retained old body', () => {
 for(const status of ['pending','unavailable','source_changed','failed'])assert.deepEqual(nativeMinutesSections({status,minutes:{overview:'旧私密正文'}}),[]);
});
test('source jumps use exact utterance IDs and do not guess among duplicate timestamps', () => {
 const turns=[{id:'u1',time:'00:01:00'},{id:'u2',time:'00:01:00'},{id:'u3',time:'00:02:00'}];
 assert.equal(nativeSourceFocus(turns,'u2'),'u2');assert.equal(nativeSourceFocus(turns,'00:01:00'),undefined);
 assert.equal(nativeSourceFocus(turns,'00:02:00'),'u3');assert.equal(nativeSourceFocus(turns,'missing'),undefined);
});
