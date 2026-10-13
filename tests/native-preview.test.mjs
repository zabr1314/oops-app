import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';

const source=readFileSync('android/app/src/main/assets/web/bridge-mock.js','utf8');
function simulator(flow='normal', nativeAlready=false){
  const window=nativeAlready?{OopsNative:{native:true}}:{}; const emitted=[], timers=[];
  const storage={getItem(){throw Error('preview must not read persisted data')},setItem(){throw Error('preview must not write persisted data')}};
  runInNewContext(source,{window,location:{search:'?preview=1&flow='+flow},URLSearchParams,localStorage:storage,
    Audio:class{pause(){}play(){throw Error('unexpected audio')}},crypto:{randomUUID:()=> 'test'},Date,performance:{now:()=>0},
    setTimeout:fn=>{timers.push(fn);return timers.length},clearTimeout(){},setInterval(){},clearInterval(){},queueMicrotask:fn=>fn()});
  if(!nativeAlready)window.OopsNative.onmessage=event=>emitted.push(JSON.parse(event.data));
  const send=(type,payload={})=>{window.OopsNative.postMessage(JSON.stringify({type,payload}));while(timers.length)timers.shift()();return emitted.at(-1)};
  return{window,emitted,send};
}
test('preview keeps an existing native bridge and never reads browser saved clips',()=>{
  assert.equal(simulator('normal',true).window.OopsNative.native,true);
  const s=simulator();s.send('hello');assert.equal(s.emitted.at(-1).payload.state.selfName,'洪玉麟');
});
test('minutes reads are cached examples, source changes hide current content and correlate requests',()=>{
  const s=simulator();let r=s.send('history.minutes',{sessionId:'demo',requestId:'r1'});
  assert.equal(r.payload.status,'ready');assert.equal(r.payload.requestId,'r1');assert.ok(r.payload.minutes.overview);
  s.send('review.set',{sessionId:'demo',utteranceId:'u2',fields:{owner:'江古月'}});
  r=s.send('history.minutes',{sessionId:'demo',requestId:'r2'});
  assert.equal(r.payload.reason,'source_changed');assert.equal(r.payload.requestId,'r2');assert.equal(r.payload.minutes,undefined);
  assert.equal(r.payload.doc_url,undefined);assert.ok(r.payload.historical_doc_url);
});
test('failed review does not mutate the source, retry succeeds then invalidates minutes',()=>{
  const s=simulator('review-failure'), p={sessionId:'demo',utteranceId:'u2',fields:{owner:'江古月'}};
  let r=s.send('review.set',p);assert.equal(r.type,'error');assert.equal(r.payload.operation,'review.set');assert.equal(r.payload.utteranceId,'u2');
  assert.equal(s.send('history.minutes',{sessionId:'demo'}).payload.status,'ready');
  assert.equal(s.send('review.set',p).type,'review.saved');
  assert.equal(s.send('history.minutes',{sessionId:'demo'}).payload.reason,'source_changed');
});
test('each list can fail once and then recover with request context and exact mine status',()=>{
  const s=simulator('list-failure');
  for(const type of ['history.list','projects.list','project.open','tasks.list']){
    const p={name:'Oops 首版',mine:true,status:'open'};
    const first=s.send(type,p);assert.equal(first.type,'error');assert.equal(first.payload.operation,type);
    const next=s.send(type,p);assert.equal(next.type,type);assert.ok(next.payload.items||next.payload.meetings);
    if(type==='tasks.list'){assert.equal(next.payload.selfName,'洪玉麟');assert.equal(next.payload.mine,true);assert.equal(next.payload.status,'open');assert.ok(next.payload.items.every(item=>item.who==='洪玉麟'))}
  }
});
test('pending minutes stay pending and failed reads retry without generation or external open',()=>{
  const pending=simulator('minutes-pending');assert.equal(pending.send('history.minutes',{sessionId:'demo'}).payload.status,'pending');
  const s=simulator('minutes-failure');assert.equal(s.send('history.minutes',{sessionId:'demo',requestId:'x'}).type,'error');
  assert.equal(s.send('history.minutes',{sessionId:'demo',requestId:'y'}).payload.status,'ready');
  assert.equal(s.send('open.url',{url:'https://example.com/old'}).type,'toast');
});
test('isolated preview does not pretend to play an unbundled recording',()=>{
  const s=simulator();s.send('clip.play',{key:'u2',startMs:0,endMs:1000});
  assert.ok(s.emitted.some(event=>event.type==='clip.state'&&event.payload.state==='unavailable'));
  assert.ok(!s.emitted.some(event=>event.type==='clip.state'&&event.payload.state==='playing'));
});
test('published preview assets are exact current native H5 source, including bridge and minutes UI',()=>{
  const manifest=JSON.parse(readFileSync('public/native-preview/source-manifest.json','utf8'));
  assert.ok(manifest.files.some(file=>file.path==='app.js'));assert.ok(manifest.files.some(file=>file.path==='bridge-mock.js'));
  for(const file of manifest.files){
    const original=readFileSync('android/app/src/main/assets/web/'+file.path), copied=readFileSync('public/native-preview/'+file.path);
    assert.equal(createHash('sha256').update(copied).digest('hex'),file.sha256,file.path);assert.deepEqual(copied,original,file.path);
  }
  assert.match(readFileSync('public/native-flow.html','utf8'),/浏览器模拟/);
  assert.match(readFileSync('public/showcase.html','utf8'),/native-flow.html/);
});
