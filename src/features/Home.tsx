import { useEffect, useRef, useState } from 'react';
import { KeyboardTextarea, useKeyboard } from '../mobile';
import { useOops, type AppData, type Route, type Task, type SourceReference, type AssistantMessage } from '../store';
import { sharedMemoryEligible } from '../memoryAccess';
import { makeSourceReference, materialVisible, messageAvailable, provenanceAvailable, sourceAvailable, taskSourceAvailable, taskVisible as scopedTaskVisible, sessionVisible as scopedSessionVisible } from '../sourceAccess';
import { Badge, Button, Card, Chips, Empty, Field, Icon, Notice, Row, Search, SectionTitle, Source, Toggle, SelectField, isTextEntryTarget } from '../ui';
import { taskAttentionReason, taskBelongsToMe, taskIsMyAttention, taskPrimaryAction } from '../taskWorkflow';
import { assistantQuestion, unansweredAssistantQuestion } from '../assistantLogic';
import { activeHomeRecording, recordingPeople, homeAssistantWork, assistantStage, homeDeviceSummary } from '../feedbackPresentation';
import { PrivacyNoticeCard } from './PrivacyNotice';
import { privacyNoticeAccepted, saveWelcomeChoices } from '../privacyNoticeLogic';
import { buildPersonalContext, type PersonalScenario } from '../personalAssistant';
import { PersonalContextPicker, PERSONAL_SCENARIOS } from './PersonalAssistant';
import './Home.css';
export function homeTitle(r:Route){return ({home:'首页',assistant:'问 Oops',voice:'说给 Oops 听',search:'搜索',notifications:'通知',welcome:'你好，我是 Oops'} as Record<string,string>)[r.view]||'Oops'}
export function sessionVisible(d:AppData,id:string){return scopedSessionVisible(d,id)}
export function memoryVisible(d:AppData,id:string,shared:boolean){if(d.settings.space==='我的空间')return true;const memory=d.memories.find(m=>m.id===id);return !!memory&&shared&&sharedMemoryEligible(d,memory)&&provenanceAvailable(d,memory.sources)&&sourceAvailable(d,memory,{publicOnly:true,requireShared:true})&&(d.settings.retention['memory-space:'+id]||'Oops 产品团队')===d.settings.space}
export function taskVisible(d:AppData,t:Task){return scopedTaskVisible(d,t)}
function scopeData(d:AppData):AppData {
  const personal=d.settings.space==='我的空间';
  const sessions=d.sessions.filter(s=>!s.archived&&sessionVisible(d,s.id)).map(s=>{
    if(personal)return s;
    const transcript=s.transcript.filter(t=>!t.private);
    return {...s,transcript,privateNotes:[],summary:transcript.slice(-5).map(t=>`原话摘录 · ${t.time} ${t.speaker}：${t.text}`),attachments:s.attachments.filter(title=>materialVisible(d,s.id,title))};
  });
  return {...d,tasks:d.tasks.filter(t=>taskVisible(d,t)),sessions,memories:d.memories.filter(m=>!m.deleted&&m.confirmed&&!m.needsReview&&!m.tags.some(tag=>['已停用','待复核','待确认','修订历史'].includes(tag))&&provenanceAvailable(d,m.sources)&&sourceAvailable(d,m)&&memoryVisible(d,m.id,m.visibility==='项目共享')),projects:d.projects.filter(p=>personal||(d.settings.retention['project-space:'+p.id]||'Oops 产品团队')===d.settings.space)};
}
export function homeTaskAttentionQueue(data:AppData,now:number|Date=Date.now()):Task[] {
  return data.tasks.filter(task=>taskVisible(data,task)&&taskIsMyAttention(data,task,now));
}
export function searchSavedContent(data:AppData,query:string,kind='全部') {
  const scoped=scopeData(data),q=query.trim().toLocaleLowerCase();
  const sessions=scoped.sessions.flatMap(session=>[
    {kind:'会话',title:session.title,body:session.summary.join(' '),icon:'chat-circle',route:{view:'session-detail',id:session.id} as Route},
    ...(q?session.transcript.map(turn=>({kind:'会话',title:`${session.title} · ${turn.time}`,body:`${turn.speaker}：${turn.text}`,icon:'chat-circle',route:{view:'session-transcript',id:session.id,mode:turn.id} as Route})):[])
  ]);
  return [...sessions,...scoped.tasks.map(task=>({kind:'任务',title:task.title,body:task.description,icon:'check-square',route:{view:'task-detail',id:task.id} as Route})),...data.memories.filter(m=>!m.deleted&&memoryVisible(data,m.id,m.visibility==='项目共享')).map(m=>({kind:'记忆',title:m.title,body:m.body,icon:'bookmark-simple',route:{view:'memory-detail',id:m.id} as Route})),...data.people.filter(p=>data.settings.space==='我的空间'||p.shared&&(data.settings.retention['person-space:'+p.id]||'Oops 产品团队')===data.settings.space).map(p=>({kind:'人物',title:p.name,body:p.role,icon:'user',route:{view:'memory-person',id:p.id} as Route}))].filter(result=>(kind==='全部'||result.kind===kind)&&(!q||`${result.title} ${result.body}`.toLocaleLowerCase().includes(q)));
}
export function Home() {
  const {data,navigate,update,requestEnd}=useOops(); const keyboard=useKeyboard(); const [prompt,setPrompt]=useState('');
  const queue=homeTaskAttentionQueue(data); const recording=activeHomeRecording(data);
  const otherRecording=!recording&&data.sessions.some(session=>session.id===data.activeSessionId&&!session.archived&&['进行中','暂停'].includes(session.status));
  const people=recording?recordingPeople(data,recording):undefined;
  const work=homeAssistantWork(data); const pendingMemory=data.memories.filter(m=>!m.deleted&&!m.tags.includes('修订历史')&&(!m.confirmed||m.needsReview||m.tags.some(tag=>['待确认','待复核'].includes(tag))||!provenanceAvailable(data,m.sources)||!sourceAvailable(data,m))&&memoryVisible(data,m.id,m.visibility==='项目共享')).length;
  const mascot = homeMascotPresentation(data, pendingMemory);
  const submit=()=>{if(prompt.trim()){navigate({view:'assistant',mode:prompt.trim()});setPrompt('')}};
  const nextRoute=(t:Task):Route=>{const action=taskBelongsToMe(data,t)?taskPrimaryAction(t):null;return {...(action||{view:'task-detail'}),id:t.id}};
  const nextLabel=(t:Task)=>taskBelongsToMe(data,t)?taskAttentionReason(t)||'查看下一步':'到时间跟进这项工作';
  const toggleRecording=()=>{if(!recording)return;update(current=>{const latest=activeHomeRecording(current);return latest?.id===recording.id?{...current,sessions:current.sessions.map(session=>session.id===latest.id?{...session,status:latest.status==='暂停'?'进行中':'暂停'}:session)}:current})};
  const today=new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',weekday:'long'}).format(new Date());
  return <div className="home-content home-feedback">
    <div className="home-date">{today}</div><p className="home-positioning">记住对话里的重点，陪你把下一步做好。</p>
    {recording?<Card className={`home-record-card ${recording.status==='暂停'?'is-paused':''}`}><div className="home-record-head"><Badge tone={recording.status==='暂停'?'gray':'purple'}>{recording.status==='暂停'?'记录已暂停':'示例记录中'}</Badge><time>{recording.duration||'00:00'}</time></div><div className="home-record-title"><div><h1>{recording.title}</h1><p>{recording.status==='暂停'?'随时继续，已记录内容保留':'正在留下这段对话的重要信息'}</p></div><HomeMascot presentation={mascot} /></div><div className="home-record-signal" aria-hidden="true">{[8,15,24,17,29,35,21,13,25,31,19,12,27,34,20,11,19,28,16,9].map((height,index)=><i key={index} style={{height}}/>)}</div><p className="home-record-people">{people?.count?`${people.count} 位发言者 · ${people.names.join('、')||'身份待核对'}${people.unknown?` · ${people.unknown} 位待确认`:''}`:'等待新的对话片段'}</p><Button icon="arrow-right" onClick={()=>navigate({view:'session-detail',id:recording.id,mode:'现场'})}>回到记录现场</Button><div className="home-record-actions"><Button tone="quiet" icon={recording.status==='暂停'?'play':'pause'} onClick={toggleRecording}>{recording.status==='暂停'?'继续记录':'暂停记录'}</Button><Button tone="quiet" icon="stop" onClick={()=>requestEnd(recording.id)}>结束并整理</Button></div></Card>:otherRecording?<Card className="home-record-card"><Badge tone="gray">另一空间有活动记录</Badge><h2>继续已有记录</h2><p>切回个人空间，查看当前记录与控制。</p><Button onClick={()=>{update(current=>({...current,settings:{...current.settings,space:'我的空间'}}));navigate({view:'home'})}}>查看当前记录</Button></Card>:<Card className="home-record-card home-start-card"><div className="home-record-title"><div><p className="home-eyebrow">从这一刻开始</p><h1>重要的话，<br/>交给 Oops 记住。</h1></div><HomeMascot presentation={mascot} /></div><Button icon="microphone" onClick={()=>navigate({view:'session-mode'})}>开始记录</Button><div className="home-start-secondary"><span>会议 · 日常 · 灵感</span><button onClick={()=>navigate({view:'session-import'})}><Icon name="upload-simple" size={16}/>导入内容</button></div></Card>}
    <button className="home-device-summary" onClick={()=>navigate({view:'settings-devices'})}><Icon name="bluetooth" size={14}/><span>{homeDeviceSummary(data)}</span><Icon name="caret-right" size={13}/></button>
    <div className="home-ask-heading"><strong>问 Oops</strong><span>从已有记录中找答案</span></div><div className="ask-card home-ask-card"><KeyboardTextarea aria-label="想问 Oops 的问题" placeholder="刚才决定了什么？我接下来要做什么？" value={prompt} onChange={e=>setPrompt(e.target.value)} onBlur={event=>{if(!isTextEntryTarget(event.relatedTarget))keyboard.hide()}} rows={2}/><div className="ask-footer"><small><Icon name="lock-key" size={13}/>私人提问</small><button className="input-text" onClick={()=>navigate({view:'assistant'})}>打开问答</button><button className="mic-button" aria-label={prompt.trim()?'发送问题':'语音提问'} onClick={prompt.trim()?submit:()=>navigate({view:'voice'})}><Icon name={prompt.trim()?'arrow-up':'microphone'} size={23}/></button></div></div>
    <SectionTitle action={queue.length ? `${queue.length}项任务` : pendingMemory ? `${pendingMemory}条记忆` : undefined} onAction={()=>navigate(queue.length ? {view:'tasks',mode:'待我处理'} : {view:'memory-candidate'})}>需要你确认与推进</SectionTitle><Card className="home-attention-card">{queue.slice(0,2).map(t=><Row key={t.id} title={t.title} subtitle={nextLabel(t)} icon={t.needsReview?'warning-circle':t.status==='待验收'?'files':'check-square'} onClick={()=>navigate(nextRoute(t))}/>)}{pendingMemory>0&&<Row title={`${pendingMemory}条新信息待核对`} subtitle="确认后才用于之后的建议" icon="bookmark-simple" onClick={()=>navigate({view:'memory-candidate'})}/>} {!queue.length&&!pendingMemory&&<Row title="暂时没有需要确认的事项" subtitle="查看已承接的工作，继续下一步" icon="check-circle" onClick={()=>navigate({view:'tasks',mode:'我的待办'})}/>}</Card>
    <SectionTitle action="全部" onAction={()=>navigate({view:'tasks',mode:'助手工作'})}>Oops 正在帮你做</SectionTitle>{work.length?<Card className="home-work-card">{work.slice(0,2).map(task=><Row key={task.id} title={task.title} subtitle={assistantStage(task)} icon={task.aiStatus==='准备中'?'sparkle':task.aiStatus==='草稿完成'?'files':'clock'} badge={task.aiStatus==='草稿完成'?'查看草稿':task.aiStatus} onClick={()=>navigate({view:task.aiStatus==='准备中'?'task-progress':task.sourceNeedsReview?'task-edit':task.aiStatus==='草稿完成'?'task-result':'task-detail',id:task.id})}/>)}</Card>:<p className="home-empty-work">任务确认后，可以让 Oops 整理资料或准备初稿。</p>}
    <SectionTitle action="全部记录" onAction={()=>navigate({view:'sessions'})}>接着上次的话题</SectionTitle><Card className="home-recent">{data.sessions.filter(s=>!s.archived&&s.id!==recording?.id&&s.status!=='待开始'&&sessionVisible(data,s.id)).slice(0,2).map(s=><Row key={s.id} title={s.title} subtitle={`${s.date} · ${s.kind}`} icon={s.kind==='灵感'?'lightbulb':'chat-circle'} onClick={()=>navigate({view:'session-detail',id:s.id})}/>)}</Card>
    <Card className="home-recall-card"><Row title="找回最近 5 分钟" subtitle="已取得的片段，选中后再保存" icon="clock-counter-clockwise" onClick={()=>navigate({view:'session-recall'})}/><Row title="智能聆听与设备" subtitle="设置对话检测、唤醒和自动起止" icon="waveform" onClick={()=>navigate({view:'session-listening'})}/></Card><div className="home-footer-links"><button onClick={()=>navigate({view:'welcome'})}>第一次使用</button><button onClick={()=>navigate({view:'settings-privacy'})}><Icon name="shield-check" size={14}/>隐私与记录范围</button></div>
  </div>;
}

export function homeMascotPresentation(data: AppData, pendingMemory = 0) {
  const recording = activeHomeRecording(data);
  if (recording) return recording.status === '进行中' ? { state: 'listening', label: '示例记录中' } : { state: 'idle', label: '记录已暂停' };
  const work = homeAssistantWork(data);
  const current = work.filter(task => !task.sourceNeedsReview && taskSourceAvailable(data, task));
  if (current.some(task => task.aiStatus === '准备中')) return { state: 'thinking', label: '草稿准备中' };
  if (current.some(task => task.aiStatus === '失败')) return { state: 'failed', label: '有准备任务待重试' };
  if (pendingMemory > 0 || work.some(task => task.needsReview || task.sourceNeedsReview || task.status === '待验收') || data.tasks.some(task => taskVisible(data, task) && taskBelongsToMe(data, task) && !['已完成', '已拒绝', '已取消'].includes(task.status) && (task.needsReview || task.sourceNeedsReview || task.status === '待验收'))) return { state: 'review', label: '有内容等你核对' };
  return { state: 'idle', label: '随时开始' };
}

function HomeMascot({ presentation }: { presentation: ReturnType<typeof homeMascotPresentation> }) {
  return <div className="home-mascot" data-state={presentation.state}><img src="/brand/mascot.png" alt="Oops 伙伴" draggable={false} /><span className="home-mascot-caption" role="status">{presentation.label}</span></div>;
}

type LocalAnswer = { text: string; sources: SourceReference[] };
function localAnswer(q:string,all:AppData,context:boolean):LocalAnswer {
  const d=scopeData(all); const empty=(text:string):LocalAnswer=>({text,sources:[]});
  const ref=(source:SourceReference)=>makeSourceReference(all,source);
  if(!context)return empty('我记下了你的问题。打开「使用我的已保存背景」，再一起整理已有内容。');
  if(/预算|费用/.test(q)) {
    const project=d.projects.find(p=>q.includes(p.name))||d.projects[0];
    return project?{text:`「${project.name}」当前保存的预算基准是 ${project.budget.toLocaleString()} 元。新增支出和范围变化需另行核对。`,sources:[ref({kind:'project',id:project.id})]}:empty('当前空间没有可引用的项目预算。');
  }
  if(/库存|椅子/.test(q)) {
    const task=d.tasks.find(t=>/库存|椅子/.test(t.title+t.description)&&taskSourceAvailable(all,t)&&!t.needsReview);
    if(!task)return empty('当前没有已核对且来源有效的库存资料。先核对原任务中的来源与数据时间。');
    const publicOnly=all.settings.space!=='我的空间';
    const result=task.artifacts?.filter(a=>a.kind==='资料'&&!a.needsReview&&!a.sourceNeedsReview&&!!a.reviewedAt&&provenanceAvailable(all,a.sources)&&sourceAvailable(all,{sourceSession:a.sourceSession||task.sourceSession,...(a.sourceId!==undefined?{sourceId:a.sourceId}:task.sourceId!==undefined?{sourceId:task.sourceId}:{}),sourceTime:a.sourceTime||task.sourceTime},{publicOnly,requireShared:publicOnly})).sort((a,b)=>b.version-a.version)[0];
    const text=result?.body.join('\n');
    return text?{text:`「${task.title}」中保存的资料：\n${text}\n这不是实时查询，今日变化仍需确认。`,sources:[ref({kind:'task',id:task.id,version:task.version})]}:empty('这项工作还没有保存可引用的库存结果。');
  }
  if(/任务|待办|下一步/.test(q)) {
    const mine = /我的|我需要|我负责|我今天/.test(q) || all.settings.space === '我的空间' && !/项目|团队|大家|所有人/.test(q);
    const tasks=d.tasks.filter(t=>(!mine||taskBelongsToMe(all,t))&&taskSourceAvailable(all,t)&&!['已完成','已取消','已拒绝'].includes(t.status));
    if(!tasks.length)return empty('当前没有来源有效的待推进工作。需要重新核对的内容仍留在任务页。');
    return {text:`当前有 ${tasks.length} 项可继续推进的工作：\n${tasks.map(t=>`· ${t.title} — ${t.status}${t.due?`，${t.due.replace('T',' ')}`:'，期限待补充'}`).join('\n')}\n先核对责任与期限，再决定是否允许助手准备。`,sources:tasks.map(t=>ref({kind:'task',id:t.id,version:t.version}))};
  }
  if(/角色|我是谁|偏好/.test(q)) {
    const memory=d.memories.find(m=>m.tags.some(tag=>/身份|角色|偏好/.test(tag)));
    const personal=all.settings.space==='我的空间';
    if(/偏好/.test(q)) {
      if(!personal)return empty('助理偏好仅在我的空间使用。团队回答只引用明确共享的身份与资料。');
      const focus=all.settings.retention.focus?.trim();
      return {text:`你当前设置的助理偏好：\n· 回答方式：${all.settings.tone}\n· 详细程度：${all.settings.retention.answerLength||'适中'}${focus?`\n· 关注重点：${focus}`:''}\n这些设置用于当前本地建议；尚未接入真实执行策略。`,sources:[ref({kind:'profile',id:'my-profile',profileScope:'preferences'})]};
    }
    const publicIdentity=personal||all.settings.toggles.publicIdentity===true;
    const sources:SourceReference[]=[];const paragraphs:string[]=[];
    if(publicIdentity) {
      const scene=all.settings.retention.roleContext?.trim();
      paragraphs.push(`当前档案：${all.settings.name||'我'}，${all.settings.role?.trim()||'角色尚未填写'}${scene?`。适用场景：${scene}`:''}。这是你手动设置的当前身份。`);
      sources.push(ref({kind:'profile',id:'my-profile',profileScope:'identity'}));
    }
    if(memory){paragraphs.push(`已核对的历史背景（单独保留）：\n${memory.body}`);sources.push(ref({kind:'memory',id:memory.id}));}
    if(!paragraphs.length)return empty('当前身份尚未公开，也没有当前空间可引用的历史角色背景。');
    if(!publicIdentity)paragraphs.unshift('当前档案身份未公开，以下只整理已共享且核对过的历史背景。');
    return {text:paragraphs.join('\n\n'),sources};
  }
  const idea=/灵感|桌面|桌宠/.test(q);
  const named=d.sessions.find(s=>q.includes(s.title));
  const keywords=q.replace(/帮我|请|整理一下|整理|告诉我|是什么|怎么样|的|一下|？|\?/g,' ').split(/\s+/).filter(x=>x.length>1);
  const matched=d.sessions.flatMap(s=>s.transcript.filter(t=>keywords.some(word=>(t.text+' '+t.speaker).includes(word))).map(t=>({session:s,turn:t})));
  const session=named||(idea?d.sessions.find(s=>s.kind==='灵感'&&s.transcript.length):matched[0]?.session);
  if(!session)return empty('请告诉我想整理哪段会话，或用原话里的关键词搜索。我会从选定的记录中找依据。');
  const turns=named?session.transcript.slice(-3):matched.filter(item=>item.session.id===session.id).map(item=>item.turn).slice(0,3);
  if(idea&&!turns.length)turns.push(...session.transcript.slice(0,2));
  if(!turns.length)return empty('这段记录还没有可引用的原话，不能据此生成结论。');
  return {text:`「${session.title}」里保留了这些原话：\n${turns.map(t=>`${t.speaker}：${t.text}`).join('\n')}\n可据此整理待验证的下一步，原话本身不代表已经确认的结论。`,sources:turns.map(t=>ref({kind:'session',id:session.id,sourceId:t.id,sourceTime:t.time}))};
}

export function buildLocalAnswer(q:string,all:AppData,context:boolean,options:{scenario?:PersonalScenario;excludeIds?:string[]}={}):LocalAnswer {
  const snapshot=buildPersonalContext(all,{scenario:options.scenario||'通用',query:q,excludeIds:options.excludeIds});
  let result=localAnswer(q,all,context);
  if(!context||all.settings.space!=='我的空间')return result;
  if(/角色|我是谁|偏好/.test(q)) {
    const entries=snapshot.entries.filter(entry=>/偏好/.test(q)?['preference','habit'].includes(entry.kind):['identity','background'].includes(entry.kind));
    return entries.length?{text:entries.map(entry=>entry.kind==='identity'?'当前档案：'+entry.text.replace('适用背景：','适用场景：'):entry.kind==='background'?'已核对的历史背景（单独保留）：\n'+(all.memories.find(memory=>memory.id===entry.id)?.body||entry.text):entry.text).join('\n\n'),sources:[...new Map(entries.flatMap(entry=>entry.sources).map(ref=>[JSON.stringify(ref),ref])).values()]}:{text:snapshot.enabled?'当前场景没有选用这类个人背景，可以在个性化助理里补充。':'个性化已暂停，开启后再使用你的个人背景。',sources:[]};
  }
  if(!snapshot.enabled)return result;
  const preferences=snapshot.preferences,habits=snapshot.entries.filter(entry=>entry.kind==='habit');
  const instruction=[preferences?.tone||'',...habits.map(entry=>entry.text)].join('；');
  const length=preferences?.answerLength||'适中',tone=preferences?.tone||'',focus=preferences?.focus;
  const customLength=length.startsWith('自定义：')?length.slice(4):'',customTone=tone.startsWith('自定义：')?tone.slice(4):'';
  const requestedLimit=customLength.match(/(\d{2,4})\s*字/);const limit=requestedLimit?Math.max(40,Math.min(2000,Number(requestedLimit[1]))):220;
  let text=result.text,usesPreferences=false;
  if(/探索|一起讨论/.test(instruction)){text='先核对已有信息：\n'+text;usesPreferences=true;}
  else if(/逐步|步骤|分步/.test(instruction)){text='1. 查看已有内容\n'+text+'\n2. 打开来源核对\n3. 决定是否整理待办或候选记忆';usesPreferences=true;}
  if(length==='详细'||/详细|充分展开/.test(customLength)){text+='\n核对时分别确认：哪些已有依据、哪些仍缺资料、下一步由谁负责。';usesPreferences=true;}
  if(focus){text+='\n你当前希望关注：'+focus;usesPreferences=true;}
  if(/优先|安排|建议|我接下来/.test(q)) {
    const goals=snapshot.entries.filter(entry=>entry.kind==='goal').slice(0,2);
    if(goals.length){text+='\n已确认目标：'+goals.map(entry=>entry.text).join('；');result={...result,sources:[...result.sources,...goals.flatMap(entry=>entry.sources)]};}
  }
  if(length==='简短'||/简短|精简/.test(instruction)||!!requestedLimit){const suffix='…（完整依据见来源）';if(text.length>limit)text=text.slice(0,limit-suffix.length)+suffix;usesPreferences=true;}
  const used=usesPreferences?[...snapshot.entries.filter(entry=>entry.kind==='preference'),...habits]:[];
  const sources=[...new Map([...result.sources,...used.flatMap(entry=>entry.sources)].map(ref=>[JSON.stringify(ref),ref])).values()];
  return {...result,text,sources};
}

function referenceRoute(ref:SourceReference):Route {
  return ref.kind==='profile'?{view:ref.profileScope==='preferences'?'settings-preferences':'settings-identity'}:ref.kind==='session'?{view:'session-transcript',id:ref.id,mode:ref.sourceId||ref.sourceTime}:ref.kind==='task'?{view:'task-detail',id:ref.id}:ref.kind==='memory'?{view:'memory-detail',id:ref.id}:{view:'memory-project',id:ref.id};
}
function referenceTitle(data:AppData,ref:SourceReference):string {
  return ref.kind==='profile'?(ref.profileScope==='preferences'?'私人助理偏好':'当前身份'):ref.kind==='session'?data.sessions.find(s=>s.id===ref.id)?.title||'引用会话':ref.kind==='task'?data.tasks.find(t=>t.id===ref.id)?.title||'引用任务':ref.kind==='memory'?data.memories.find(m=>m.id===ref.id)?.title||'引用记忆':data.projects.find(p=>p.id===ref.id)?.name||'引用项目';
}
export function Assistant() {
  const {data,update,navigate,route,toast}=useOops(); const [input,setInput]=useState(''),[context,setContext]=useState(true),[pending,setPending]=useState(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),once=useRef(false);
  const [scenario,setScenario]=useState<PersonalScenario>('通用'),[excludedIds,setExcludedIds]=useState<string[]>([]);
  function send(q:string,retryId?:string) {
    if(!q.trim()||pending)return;
    const text=q.trim(),space=data.settings.space,useBackground=context,questionId=retryId||`u${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    if(retryId&&!data.messages.some(message=>message.id===retryId&&message.role==='user'&&(message.space||'我的空间')===space))return;
    if(!retryId)update(d=>({...d,messages:[...d.messages,{id:questionId,role:'user',text,space}]}));setInput('');setPending(true);
    const answer=buildLocalAnswer(text,data,useBackground,{scenario,excludeIds:excludedIds});
    timer.current=setTimeout(()=>{update(d=>{if(d.settings.space!==space)return d;const valid=provenanceAvailable(d,answer.sources);return {...d,messages:[...d.messages,{id:`a${Date.now()}`,role:'assistant',text:valid?answer.text:'背景或来源已变化，请重新提问。',invalidated:!valid,space,sources:answer.sources,replyToId:questionId}]}});setPending(false)},700);
  }
  useEffect(()=>{if(route.mode&&!once.current){once.current=true;send(route.mode);window.history.replaceState(null,'','#assistant')}return()=>{if(timer.current)clearTimeout(timer.current)}},[]);
  const messages=data.messages.filter(m=>(m.space||'我的空间')===data.settings.space);
  const unanswered=unansweredAssistantQuestion(messages);
  const latest=[...messages].reverse().find(m=>m.role==='assistant');
  const last=!unanswered&&latest&&messageAvailable(data,latest)?latest:undefined;
  function currentAnswer():AssistantMessage|undefined {const current=data.messages.find(m=>m.id===last?.id);if(!current||!messageAvailable(data,current)){toast('回答的来源已变化，请重新提问');return undefined}return current;}
  function derivedSource(message:AssistantMessage) {const first=message.sources?.find(s=>s.kind==='session');return first?{sourceSession:first.id,sourceId:first.sourceId,sourceTime:first.sourceTime,relatedSessionId:first.id}:message.sourceSession?{sourceSession:message.sourceSession,relatedSessionId:message.sourceSession}:{};}
  function draft() {
    const answer=currentAnswer();if(!answer)return;
    const existing=data.tasks.find(t=>t.sourceMessageId===answer.id&&!['已取消','已拒绝'].includes(t.status));if(existing){toast('这条回答已有关联待办');navigate({view:'task-detail',id:existing.id});return;}
    const question=assistantQuestion(messages,answer)?.text||'验证这条建议';
    const task:Task={id:`TASK-${Date.now().toString(36)}`,title:question.slice(0,32),description:answer.text,owner:'我',requester:'我',due:'',priority:'中',status:'待承接',aiStatus:'未启动',activities:['从资料回答整理草稿，引用保留；尚未承接与授权'],results:[],version:1,sourceMessageId:answer.id,sources:answer.sources,...derivedSource(answer)};
    update(d=>({...d,tasks:[task,...d.tasks],settings:{...d.settings,retention:{...d.settings.retention,['task-space:'+task.id]:d.settings.space}}}));navigate({view:'task-edit',id:task.id});
  }
  function remember() {
    const answer=currentAnswer();if(!answer)return;
    const id=`MEM-${Date.now().toString(36)}`;
    update(d=>({...d,memories:[{id,title:'提问中的待验证建议',body:answer.text,category:'记忆',tags:['待确认'],visibility:'私有',updated:'今天',confirmed:false,sources:answer.sources,...derivedSource(answer)},...d.memories],settings:{...d.settings,space:'我的空间'}}));toast('引用已保留，确认后才可使用');navigate({view:'memory-candidate',id});
  }
  return <div className="stack"><div className="private-caption"><Icon name="lock-key" size={14}/>私人提问<Badge>本地资料整理</Badge></div>{messages.length===0?<><div className="assistant-welcome"><img src="/brand/mascot.png" alt="Oops"/><h2>从一个问题开始</h2><p>一起回想、整理，再找到下一步。</p></div><div className="suggestion-grid">{['今天有哪些待办？','帮我整理桌面伙伴的灵感','项目预算是多少？'].map(q=><button key={q} onClick={()=>send(q)}>{q}<Icon name="arrow-up-left" size={16}/></button>)}</div></>:messages.map(m=>{const available=messageAvailable(data,m);return <div key={m.id} className={`chat-bubble ${m.role}`}><small>{m.role==='user'?'我':'Oops'}</small><p>{available?m.text:'这条回答的来源已变化或撤回，请重新提问。'}</p>{available&&m.role==='assistant'&&(m.sources?.map((ref,i)=><Source key={`${ref.kind}:${ref.id}:${i}`} title={referenceTitle(data,ref)} time={ref.sourceTime} onClick={()=>navigate(referenceRoute(ref))}/>)||m.sourceSession&&<Source title={data.sessions.find(s=>s.id===m.sourceSession)?.title||'相关会话'} onClick={()=>navigate({view:'session-detail',id:m.sourceSession})}/>)}</div>})}{pending&&<div className="chat-bubble assistant" role="status">正在整理可引用的本地资料…</div>}{unanswered&&!pending&&<Card><Notice>刚才的问题还没有整理完成，可以从这里继续。</Notice><Button tone="secondary" onClick={()=>send(unanswered.text,unanswered.id)}>继续整理这个问题</Button></Card>}{last&&!pending&&<div className="action-grid"><Button tone="secondary" icon="check-square" onClick={draft}>形成待办</Button><Button tone="secondary" icon="bookmark-simple" onClick={remember}>留下候选</Button></div>}<SelectField label="本次场景" value={scenario} options={PERSONAL_SCENARIOS} onChange={value=>{setScenario(value as PersonalScenario);setExcludedIds([])}}/>{context&&<PersonalContextPicker scenario={scenario} query={input} excludedIds={excludedIds} onChange={setExcludedIds}/>}<Toggle label="使用我的已保存背景" value={context} onChange={setContext} hint="仅引用当前可查看、来源仍有效的内容"/><Field label="继续问 Oops" value={input} onChange={setInput} placeholder="输入问题…" multiline/><Button onClick={()=>send(input)} disabled={!input.trim()||pending} icon="arrow-up">发送</Button><Button tone="quiet" icon="microphone" onClick={()=>navigate({view:'voice'})}>改用语音</Button></div>;
}
export function Voice(){const {navigate}=useOops();const [stage,setStage]=useState<'idle'|'listening'|'review'>('idle');const [text,setText]=useState('');useEffect(()=>{if(stage!=='listening')return;const steps=['帮我整理…','帮我整理桌面伙伴…','帮我整理桌面伙伴的想法，形成一个待验证的产品故事。'];let i=0;const timer=setInterval(()=>{setText(steps[i++]);if(i===steps.length){clearInterval(timer);setStage('review')}},1000);return()=>clearInterval(timer)},[stage]);return <div className="stack"><div className="voice-stage"><img src="/brand/mascot.png" className={stage==='listening'?'home-mascot-listening':stage==='review'?'home-mascot-ready':''} alt="Oops正在听"/><h2>{stage==='listening'?'正在听你的想法':stage==='review'?'核对刚才说的话':'把想法说给 Oops'}</h2><p>用一段示例语音体验流程</p><button className={`voice-record ${stage==='listening'?'listening':''}`} aria-label={stage==='listening'?'停止语音输入':'体验语音输入'} onClick={()=>{if(stage==='listening')setStage('review');else{setText('');setStage('listening')}}}><Icon name={stage==='listening'?'stop':'microphone'} size={32}/></button></div>{text&&<Field label={stage==='listening'?'正在识别':'确认后的文字'} value={text} onChange={setText} multiline/>}{stage==='review'&&<><Notice>可以修改文字后再提交。</Notice><Button disabled={!text.trim()} onClick={()=>navigate({view:'assistant',mode:text})}>确认并提问</Button></>}<Button tone="secondary" onClick={()=>navigate({view:'assistant'})}>改用文字输入</Button></div>}
export function SearchScreen(){const {data,navigate}=useOops();const [q,setQ]=useState('');const [kind,setKind]=useState('全部');const results=searchSavedContent(data,q,kind);return <div className="stack"><Search value={q} onChange={setQ} placeholder="搜索原话、会话、任务、记忆…"/><Chips items={['全部','会话','任务','记忆','人物']} value={kind} onChange={setKind}/>{!q&&<div className="search-hints">{['KPI','资料卡','预算','王宁'].map(x=><button className="chip" onClick={()=>setQ(x)} key={x}>{x}</button>)}</div>}<p className="meta">{data.settings.space} · {results.length}项结果</p>{results.length?results.map((r,i)=><Row key={`${r.title}${i}`} title={r.title} subtitle={`${r.kind} · ${r.body.slice(0,65)}`} icon={r.icon} onClick={()=>navigate(r.route)}/>):<Empty title="没有找到相关内容" body="换一个原话关键词，或清除当前筛选。" action="清除筛选" onAction={()=>{setQ('');setKind('全部')}}/>}</div>}
export function notificationVisible(d:AppData,r:Route){if(r.view.startsWith('task')&&!d.tasks.some(t=>t.id===r.id&&!['已完成','已取消','已拒绝'].includes(t.status)))return false;if(r.view.startsWith('session')&&!d.sessions.some(s=>s.id===r.id&&!s.archived))return false;if(r.view.startsWith('memory')&&!d.memories.some(m=>m.id===r.id&&!m.deleted&&(!['memory-candidate','memory-conflict'].includes(r.view)||!m.confirmed)))return false;if(d.settings.space==='我的空间')return true;if(r.view.startsWith('task'))return d.tasks.some(t=>t.id===r.id&&taskVisible(d,t));if(r.view.startsWith('session'))return !!r.id&&sessionVisible(d,r.id);if(r.view.startsWith('memory'))return d.memories.some(m=>m.id===r.id&&memoryVisible(d,m.id,m.visibility==='项目共享'));return true}
export function Notifications(){const {data,update,navigate}=useOops();const [filter,setFilter]=useState('全部');const items=data.notifications.filter(n=>notificationVisible(data,n.route)&&(filter==='全部'||!n.read));return <div className="stack"><div className="section-title"><Chips items={['全部','未读']} value={filter} onChange={setFilter}/><button className="text-action" onClick={()=>update(d=>({...d,notifications:d.notifications.map(n=>notificationVisible(d,n.route)?{...n,read:true}:n)}))}>全部已读</button></div>{items.length?items.map(n=><Card key={n.id} className={`notification-card ${!n.read?'unread':''}`} onClick={()=>{update(d=>({...d,notifications:d.notifications.map(x=>x.id===n.id?{...x,read:true}:x)}));navigate(n.route)}}><div><Icon name="bell"/><Badge tone={n.read?'muted':'purple'}>{n.read?'已读':'未读'}</Badge></div><h3>{n.title}</h3><p>{n.body}</p></Card>):<Empty title="都看过了" body="有新的结果和需要确认的内容时会出现在这里。" icon="bell"/>}<Row title="提醒与打扰方式" subtitle="决定哪些提醒需要即时出现" icon="sliders-horizontal" onClick={()=>navigate({view:'settings-notifications'})}/></div>}
export function Welcome() {
  const {data,update,navigate}=useOops();
  const [step,setStep]=useState(0);
  const heading=useRef<HTMLDivElement>(null);
  useEffect(()=>{heading.current?.closest('[data-testid="mobile-scroll"]')?.scrollTo({top:0});},[step]);
  const [name,setName]=useState(data.settings.name);
  const [role,setRole]=useState(data.settings.role);
  const [memory,setMemory]=useState(() => privacyNoticeAccepted(data) && data.settings.toggles.memory);
  const [cloud,setCloud]=useState(() => privacyNoticeAccepted(data) && data.settings.toggles.cloud);
  const save=()=>{
    if(!privacyNoticeAccepted(data)||!name.trim())return;
    update(current=>saveWelcomeChoices(current,{name,role,cloud,memory}));
    setStep(2);
  };
  return <div className="stack welcome-onboarding">
    <div className="onboarding-head" ref={heading}>{step!==1&&<img src="/brand/mascot.png" alt="Oops"/>}<Badge>第{step+1}步 / 共3步</Badge>
      <h2>{['先了解信息怎么用','认识你，按你的选择记住','准备好了'][step]}</h2>
      <p>{['读完说明后，由你确认是否继续设置。','称呼、角色和可选能力分别由你决定。','选一个场景体验 Oops。'][step]}</p>
    </div>
    {step===0?<PrivacyNoticeCard onConfirmed={()=>setStep(1)}/>:step===1?<>
      <Field label="怎么称呼你" value={name} onChange={setName}/>
      <Field label="我的角色" value={role} onChange={setRole}/>
      <Toggle label="允许云端处理" value={cloud} onChange={setCloud} hint="原型设置；接入真实服务时另行说明与授权"/>
      <Toggle label="保存确认后的长期记忆" value={memory} onChange={setMemory}/>
      <Notice>这些选项不会开启声音身份或团队共享。记录、私人便签和外部操作仍需分别确认。</Notice>
      <Button disabled={!name.trim()||!privacyNoticeAccepted(data)} onClick={save}>保存选择</Button>
      <Button tone="quiet" onClick={()=>setStep(0)}>返回阅读说明</Button>
    </>:<>
      <Row title="开始一段记录" subtitle="先记下来，名称和项目之后再补" icon="microphone" onClick={()=>navigate({view:'session-mode'})}/>
      <Row title="导入已有记录" subtitle="粘贴转写，或查看本地录音" icon="upload-simple" onClick={()=>navigate({view:'session-import'})}/>
      <Row title="先问 Oops 一个问题" subtitle="仅自己可见" icon="chat-circle" onClick={()=>navigate({view:'assistant'})}/>
      <Row title="快速设置助理偏好" subtitle="可跳过，用两句话描述你的习惯" icon="sliders-horizontal" onClick={()=>navigate({view:'settings-preferences'})}/>
      <Button onClick={()=>navigate({view:'home'})}>去首页看看</Button>
    </>}
    <Button tone="quiet" onClick={()=>navigate({view:'home'})}>{step===0?'仅浏览示例，稍后设置':'稍后再设置'}</Button>
  </div>;
}
