import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const plan=load('screenshots/capture-plan.json'),captures=load('screenshots/capture-results.json'),mapping=load('public/board-routes.json'),manifest=load('public/board-manifest.json');
const htmlData=path=>JSON.parse(readFileSync(path,'utf8').match(/<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
test('all current states have the recorded real screenshot, route and DOM evidence',()=>{assert.ok(plan.length>=108);assert.equal(new Set(plan.map(p=>p.key)).size,plan.length);for(const p of plan){const c=captures.find(c=>c.key===p.key);assert.equal(c?.status,'captured',p.key);assert.ok(c.snapshot.includes('main'),p.key);assert.equal(c.route.view,p.route.view);const jpg=readFileSync('public/board-shots/'+p.key+'.jpg');assert.equal(jpg.length,c.bytes,p.key);assert.equal(createHash('sha256').update(jpg).digest('hex'),c.sha256,p.key);assert.ok(jpg.length>2000,'Blank screenshot '+p.key);}});
test('the real board uses current screenshot routes including task tabs',()=>{const data=htmlData('public/board.html');assert.deepEqual(data.pages.map(p=>p.key),plan.map(p=>p.key));assert.equal(data.metadata.revision,manifest.metadata.revision);for(const tab of ['资料','成果','记录'])assert.ok(data.pages.some(p=>p.route.view==='task-detail'&&p.route.mode===tab));});
test('the expanded board preserves original coverage and every image can be viewed offline',()=>{const data=htmlData('public/interactive-board.html');assert.equal(mapping.filter(p=>/^[HCTMU]\d+$/.test(p.id)).length,131);assert.equal(new Set(mapping.map(p=>p.id)).size,mapping.length);assert.deepEqual(data.pages.map(p=>p.key),mapping.map(p=>p.id));for(const p of data.pages){assert.ok(p.route.view);assert.ok(data.shots[p.shot]?.startsWith('data:image/jpeg;base64,'),p.key);assert.ok(existsSync('public/board-shots/'+p.shot+'.jpg'));if(p.merged)assert.ok(p.note,p.key);}assert.deepEqual(data.metadata,manifest.metadata);});
test('review, transfer, completion and historical export states have actual interactive-screen evidence',()=>{for(const key of ['c26-session-review-queue','t06-task-transfer-response','t28-task-history-tab','t29-task-answer','t31-task-history-backup','t32-task-manual-complete'])assert.ok(captures.find(c=>c.key===key)?.snapshot.length>500,key);assert.match(captures.find(c=>c.key==='t31-task-history-backup').snapshot,/dialog|确认/);assert.match(captures.find(c=>c.key==='t28-task-history-tab').snapshot,/历史|原有|完成/);});

test('all 15 P0 capabilities retain frontend-only coverage with matching current board entries',()=>{
  const coverage=load('public/p0-coverage.json');
  assert.deepEqual(coverage.items.map(item=>item.id),Array.from({length:15},(_,index)=>index+1));
  assert.equal(coverage.frontendCoveredCount,15);
  assert.match(coverage.serviceBoundary,/未连接真实/);
  for(const item of coverage.items){assert.equal(item.covered,'frontend');assert.ok(item.inputs.length&&item.results.length&&item.states.length&&item.acceptance.length);assert.ok(item.routes.some(route=>plan.some(page=>page.route.view===route)),item.name);}
  for(const entry of mapping.filter(page=>/^P\d+$/.test(page.id))){const shot=plan.find(page=>page.key===entry.shot);assert.ok(shot,entry.id);assert.equal(shot.route.view,entry.route.view,entry.id);assert.ok(captures.some(capture=>capture.key===entry.shot&&capture.status==='captured'),entry.id);}
  const reminderCapture=captures.find(page=>page.key==='p21-session-notices-21');
  for(const label of ['议题偏离','会议时间','议题超时','未讨论','预算冲突','规则冲突','历史决定','结论遗漏'])assert.ok(reminderCapture.snapshot.includes(label),label);
  assert.ok(captures.find(page=>page.key==='p39-session-task-suggestions-39').snapshot.includes('待承接'));
  assert.ok(captures.find(page=>page.key==='p41-task-receipt-feishu').snapshot.includes('飞书工作日历'));
});
