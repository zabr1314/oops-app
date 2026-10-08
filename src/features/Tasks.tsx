import { useState } from 'react';
import { useOops, type AppData, type Route, type Task } from '../store';
import { taskVisible } from './Home';
import { Badge, Button, Card, Check, Chips, Empty, Field, Icon, Notice, Row, Search, SectionTitle, SelectField, Sheet, Source, Tabs } from '../ui';

type Artifact = { id: string; kind: '文档'|'PPT'|'资料'; title: string; version: number; body: string[]; created: string };
type Draft = { target: string; body: string; attachments: string; subject?: string; cc?: string; account?: string; start?: string; end?: string; calendar?: string };
type TaskRecord = Task & { criteria?: string[]; materials?: string[]; questions?: string[]; artifacts?: Artifact[]; drafts?: Record<string,Draft>; scope?: { sources: string; destination: string }; budget?: number; used?: number; outputMode?: string; generationToken?: string; failure?: string; needsReview?: boolean; transferFrom?: string; retryMissing?: boolean };
const titles: Record<string,string> = {
  tasks:'任务', 'task-detail':'任务详情', 'task-accept':'核对承接', 'task-reject':'婉拒任务', 'task-transfer':'建议转交', 'task-transfer-response':'转交进展',
  'task-edit':'任务要求', 'task-create':'新建任务', 'task-plan':'助手计划', 'task-authorize':'允许助手准备', 'task-progress':'助手工作', 'task-failure':'处理未完成项',
  'task-budget':'额度与产出', 'task-change':'修改要求', 'task-result':'成果', 'task-versions':'版本记录', 'task-preview':'成果预览', 'task-artifact-edit':'编辑成果',
  'task-send':'跟进消息', 'task-send-confirm':'核对消息', 'task-email':'审阅邮件', 'task-calendar':'审阅日程', 'task-receipt':'操作回执', 'task-history':'任务活动',
  'task-complete':'检查交付', 'task-ask':'补充问题', 'task-attachment':'补充资料',
};
export function taskTitle(route: Route): string { return route.view === 'task-edit' && !route.id ? '新建任务' : titles[route.view] || '任务'; }
const stamp = () => new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date());
const artifactId = () => `artifact-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
const closed = (t: Task) => ['已完成','已取消','已拒绝'].includes(t.status);
const accepted = (t: Task) => ['已承接','进行中','待验收'].includes(t.status);
function dueText(value: string) { return value ? value.replace('T',' ').replace(/^2026-/,'').replace('-', '月').replace(' ', '日 ') : '期限待补充'; }
function validMoment(value: string): number | undefined {
  const m = value.trim().match(/^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})(?:日)?[ T]*(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const [year,month,day,hour,minute] = [Number(m[1] || 2026),Number(m[2]),Number(m[3]),Number(m[4]),Number(m[5])];
  const date = new Date(year,month-1,day,hour,minute);
  if (year < 2020 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || date.getFullYear() !== year || date.getMonth() !== month-1 || date.getDate() !== day) return undefined;
  return date.getTime();
}
const usable = (v:string) => !!v.trim() && !/待选择|请选择|未设置|待确认|^未知$/.test(v.trim());
function artifacts(t: TaskRecord): Artifact[] {
  if(t.artifacts?.length) return t.artifacts;
  return t.results.length ? [{id:`seed-${t.id}`,kind:t.id==='TASK-032'?'资料':'文档',title:t.id==='TASK-032'?'蓝色椅子库存摘录':'工作摘要',version:t.version,body:t.results,created:'已有成果'}] : [];
}
function buildArtifacts(t: TaskRecord): Artifact[] {
  if(t.id==='TASK-032') return [{id:artifactId(),kind:'资料',title:'蓝色椅子库存摘录',version:t.version,created:stamp(),body:['SKU B-108 · 蓝色椅子','在库24件，已预留6件，可用18件。','资料时间：10月7日18:00；当前库存变化尚需王宁确认。','下一步：确认今日出入库变化及需求数量。']}];
  if(t.id==='TASK-033') return [{id:artifactId(),kind:'文档',title:'会中资料卡验证方案',version:t.version,created:stamp(),body:['目标：资料留在当前议题旁，减少主动打断。','验证：用同一段会议对比主动播报与静默资料卡。','记录：打断次数、找资料用时、成员对上下文的理解。','验收：能够按来源定位资料，并在需要时主动打开。']}];
  const pages=['目标与范围\n第三季度 KPI 复盘；目标值和统计口径等待确认。','实际表现\n按指标表补齐实际值；保留资料来源与时间。','差异分析\n比较目标与实际，标注显著变化；当前不填造数字。','原因与证据\n区分已确认原因与待验证假设。','风险与应对\n列出风险、影响与需协调的支持。','下一步行动\n确认负责人、期限与验收口径。'];
  const doc:Artifact={id:artifactId(),kind:'文档',title:'第三季度 KPI 复盘框架',version:t.version,created:stamp(),body:['结论：先核对指标口径，再解释差异。','范围：目标、实际、差异、原因、风险和行动。','待补资料：完整指标表与一份附件。','本稿仅是可修改框架，未将示例数字写成业务事实。']};
  return t.outputMode==='仅提纲'?[doc]:[doc,{id:artifactId(),kind:'PPT',title:'第三季度 KPI 复盘',version:t.version,created:stamp(),body:pages}];
}
function useTaskActions(t:TaskRecord) {
  const { update, navigate, toast } = useOops();
  function patch(change: Partial<TaskRecord>, activity?: string) {
    update(current=>({...current,tasks:current.tasks.map(x=>x.id===t.id?{...x,...change,activities:activity?[...x.activities,`${stamp()} · ${activity}`]:x.activities}:x)}));
  }
  function go(view:string,mode?:string) { navigate({view,id:t.id,mode}); }
  function start(retry=false) {
    retry = retry === true;
    if(!accepted(t)) return toast('先确认由谁承接这项工作');
    if(!t.authorized || !t.scope) return go('task-authorize');
    if(t.aiStatus==='准备中') return toast('助手正在准备，没有重复创建');
    const cost=retry?3:t.outputMode==='仅提纲'?6:16;
    if((t.budget??40)-(t.used??0)<cost) return go('task-budget');
    const token=artifactId();
    patch({aiStatus:'准备中',status:'进行中',generationToken:token,failure:undefined,retryMissing:retry},retry?'仅重试未完成步骤，成功成果保留':'助手开始准备已允许的草稿');
    setTimeout(()=>update((current:AppData)=>({...current,tasks:current.tasks.map(item=>{
      const latest=item as TaskRecord;
      if(latest.id!==t.id || latest.generationToken!==token || latest.aiStatus!=='准备中' || closed(latest)) return item;
      const existing=artifacts(latest),candidates=buildArtifacts(latest);
      const generated=latest.retryMissing?candidates.filter(a=>!existing.some(b=>b.kind===a.kind&&b.version===a.version)):candidates;
      return {...latest,status:'待验收' as const,aiStatus:'草稿完成' as const,artifacts:[...existing,...generated],results:generated.length?[...latest.results,...generated.map(x=>`${x.title} · v${x.version}`)]:latest.results,used:(latest.used??0)+cost,needsReview:true,retryMissing:false,activities:[...latest.activities,`${stamp()} · ${latest.retryMissing?'未完成步骤已处理，成功成果保留':'草稿已保存'}，等待本人审阅`]};
    })})),2400);
    go('task-progress');
  }
  return { patch, go, start };
}
function TaskSource({task}:{task:TaskRecord}) {
  const { data,navigate }=useOops();
  const session=data.sessions.find(x=>x.id===task.sourceSession);
  return task.sourceSession?<Source title={session?.title||'来源记录'} time={task.sourceTime} onClick={()=>navigate({view:'session-transcript',id:task.sourceSession,mode:task.sourceTime})}/>:null;
}
function TaskCard({task}:{task:TaskRecord}) {
  const {navigate}=useOops();
  return <Card className="task-card" onClick={()=>navigate({view:'task-detail',id:task.id})}><div className="section-title"><span className="row-icon"><Icon name={task.aiStatus==='准备中'?'sparkle':'check-square'}/></span><Badge tone={task.priority==='高'?'rose':'purple'}>{task.priority==='高'?'优先':'常规'}</Badge></div><h3>{task.title}</h3><p className="meta">{task.requester}提出 · {dueText(task.due)}</p><div className="divider"/><div className="section-title"><Badge tone={closed(task)?'gray':'purple'}>{task.status}</Badge><span className="meta">助手 · {task.aiStatus}</span></div></Card>;
}
function TaskList() {
  const { data,route,navigate }=useOops();
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('全部');
  const mode=route.mode||'待我处理';
  const all=data.tasks.filter(t=>taskVisible(data,t)) as TaskRecord[];
  const mine=(t:Task)=>['我',data.settings.name].includes(t.owner);
  const list=all.filter(t=>mode==='待我处理'?(mine(t)&&['待承接','待转交','待验收'].includes(t.status)) : mode==='助手工作'?t.aiStatus!=='未启动':mine(t)&&t.status!=='已拒绝')
    .filter(t=>filter==='全部'||(filter==='未结束'?!closed(t):filter==='已结束'?closed(t):t.priority==='高'))
    .filter(t=>`${t.title}${t.description}${t.requester}`.includes(query)).sort((a,b)=>({高:0,中:1,低:2}[a.priority]-{高:0,中:1,低:2}[b.priority]));
  return <div className="stack"><div><h1 className="title">一起推进重要的事</h1><p className="meta">{all.filter(t=>!closed(t)).length}项进行中的工作</p></div><Tabs items={['待我处理','我的待办','助手工作']} value={mode} onChange={value=>navigate({view:'tasks',mode:value})}/><Search value={query} onChange={setQuery} placeholder="搜索任务或提出者"/><Chips items={['全部','未结束','优先','已结束']} value={filter} onChange={setFilter}/>{list.length?list.map(t=><TaskCard key={t.id} task={t}/>):<Empty title="这里暂时没有任务" body={query?'换个关键词试试':'新的工作会出现在这里'} icon="check-circle" action="新建任务" onAction={()=>navigate({view:'task-edit'})}/>}{list.length>0&&<Button tone="secondary" icon="plus" onClick={()=>navigate({view:'task-edit'})}>新建任务</Button>}</div>;
}
function Detail({task:t}:{task:TaskRecord}) {
  const {go}=useTaskActions(t);
  const {navigate}=useOops();
  return <div className="stack"><Card className="task-card"><div className="section-title"><Badge>{t.status}</Badge><Badge tone="gray">{t.priority}优先级</Badge></div><h1 className="title">{t.title}</h1><p>{t.description}</p><div className="stat-grid"><div className="stat"><small>负责人</small><strong>{t.owner}</strong></div><div className="stat"><small>截止</small><strong>{dueText(t.due)}</strong></div></div><TaskSource task={t}/></Card>{t.status==='待承接'?<div className="action-grid"><Button onClick={()=>go('task-accept')}>核对并承接</Button><Button tone="secondary" onClick={()=>go('task-transfer')}>建议转交</Button><Button tone="quiet" onClick={()=>go('task-reject')}>婉拒这项工作</Button></div>:t.status==='待转交'?<Notice>已向{t.transferTo}发出承接请求。<Button tone="quiet" onClick={()=>go('task-transfer-response')}>查看回应</Button></Notice>:null}<SectionTitle>助手工作</SectionTitle><Card><Row icon="sparkle" title={t.aiStatus==='未启动'?(t.authorized?'范围已允许，准备开始':'让助手帮我准备'):t.aiStatus} subtitle={t.authorized?'已允许的个人草稿，不会自动外发':'先核对资料和产出范围'} onClick={()=>go(t.aiStatus==='未启动'&&!t.authorized?'task-plan':'task-progress')}/></Card><SectionTitle>继续处理</SectionTitle><Card><Row title="成果与版本" subtitle={`${artifacts(t).length}份已保存成果`} icon="files" onClick={()=>go('task-result')}/><Row title="工作要求与验收" subtitle="目标、资料、负责人和期限" icon="list-checks" onClick={()=>go('task-edit')}/><Row title="缺少资料，提出问题" subtitle={t.questions?.length?`${t.questions.length}个已记录问题`:'先核实，再补齐'} icon="chat-circle-text" onClick={()=>go('task-ask')}/><Row title="活动记录" icon="clock-counter-clockwise" onClick={()=>go('task-history')}/></Card>{!closed(t)&&<Button tone="secondary" onClick={()=>go('task-complete')}>检查交付并完成</Button>}{t.id==='TASK-033'&&<Button tone="quiet" onClick={()=>navigate({view:'memory-detail',id:'MEM-024'})}>查看保存的建议</Button>}{t.sourceSession&&<Button tone="quiet" onClick={()=>navigate({view:'session-detail',id:t.sourceSession})}>回到相关会话</Button>}</div>;
}
function Accept({task:t}:{task:TaskRecord}) {
  const {data,toast}=useOops(),{patch,go}=useTaskActions(t);
  const [due,setDue]=useState(t.due.replace('T',' ')),[noDue,setNoDue]=useState(t.due==='无固定期限'),[checked,setChecked]=useState(false),[error,setError]=useState('');
  function accept(){if(!checked)return setError('请核对目标与本人责任');if(!noDue&&validMoment(due)===undefined)return setError('补充有效日期与时间，或明确没有固定期限');if(!t.description.trim())return setError('先补充工作目标');patch({owner:'我',due:noDue?'无固定期限':due,status:'已承接'},'本人核对目标与期限，接受工作');toast('已承接，助手尚未启动');go('task-detail');}
  return <div className="stack"><Card><Badge>来自{t.requester}</Badge><h2>{t.title}</h2><p>{t.description}</p><p className="meta">由我（{data.settings.name}）承接</p><TaskSource task={t}/></Card><Field label="期限" value={due} onChange={setDue} placeholder="2026-10-09 17:00"/><Check label="这项工作没有固定期限" value={noDue} onChange={setNoDue}/><Check label="已核对目标，我负责这项工作" value={checked} onChange={setChecked}/>{error&&<p className="error-text">{error}</p>}<Button onClick={accept}>确认承接</Button><Button tone="quiet" onClick={()=>go('task-edit')}>补充目标与验收</Button></div>;
}
function Reject({task:t}:{task:TaskRecord}) {
  const {toast}=useOops(),{patch,go}=useTaskActions(t);const [reason,setReason]=useState(''),[error,setError]=useState('');
  return <div className="stack"><Card><h2>{t.title}</h2><p className="meta">给{t.requester}一个明确的回应</p></Card><Field label="原因" value={reason} onChange={setReason} multiline placeholder="时间冲突、资料权限或其他原因"/>{error&&<p className="error-text">{error}</p>}<Button tone="danger" onClick={()=>{if(!reason.trim())return setError('请补充拒绝原因');patch({status:'已拒绝',aiStatus:'已停止',generationToken:undefined},`婉拒：${reason}`);toast('已保存回应');go('task-detail');}}>确认婉拒</Button><Button tone="secondary" onClick={()=>go('task-transfer')}>改为建议转交</Button></div>;
}
function Transfer({task:t,response=false}:{task:TaskRecord;response?:boolean}) {
  const {data,toast}=useOops(),{patch,go}=useTaskActions(t);const [person,setPerson]=useState(t.transferTo||data.people.find(x=>x.name!=='待确认')?.name||''),[reason,setReason]=useState(''),[error,setError]=useState('');
  if(response)return <div className="stack"><Card><Badge>等待回应</Badge><h2>{t.title}</h2><p>建议由{t.transferTo}接手</p><p className="meta">收到确认前，原责任不会自动消失。</p></Card><Button onClick={()=>{patch({owner:t.transferTo||t.owner,status:'已承接',aiStatus:'未启动',authorized:false,transferTo:undefined},`${t.transferTo}接受转交（演示回应）`);toast('已收到演示回应');go('task-detail');}}>演示接收人同意</Button><Button tone="secondary" onClick={()=>{patch({owner:t.transferFrom||'我',status:'已承接',transferTo:undefined},'接收人婉拒转交，保留原责任');go('task-detail');}}>演示接收人婉拒</Button><Button tone="quiet" onClick={()=>{patch({status:t.authorized?'已承接':'待承接',transferTo:undefined},'撤回转交请求');go('task-detail');}}>撤回请求</Button></div>;
  return <div className="stack"><Card><h2>{t.title}</h2><p className="meta">原负责人：{t.owner}</p></Card><SelectField label="建议接收人" value={person} onChange={setPerson} options={data.people.filter(p=>p.name!=='待确认').map(p=>p.name)}/><Field label="转交说明" value={reason} onChange={setReason} multiline placeholder="为什么更适合由对方处理？"/>{error&&<p className="error-text">{error}</p>}<Button onClick={()=>{if(!usable(person)||person===t.owner||person===data.settings.name)return setError('请选择另一位明确的接收人');if(!reason.trim())return setError('补充转交说明');patch({status:'待转交',transferTo:person,transferFrom:t.owner},`建议转交给${person}：${reason}`);go('task-transfer-response');}}>发出承接请求</Button><Notice>这次只记录转交请求，不替对方确认承接。</Notice></div>;
}
function Requirements({task}:{task?:TaskRecord}) {
  const {data,update,navigate,toast}=useOops();const [title,setTitle]=useState(task?.title||''),[goal,setGoal]=useState(task?.description||''),[due,setDue]=useState(task?.due.replace('T',' ')||''),[noDue,setNoDue]=useState(task?.due==='无固定期限'),[priority,setPriority]=useState<string>(task?.priority||'中'),[criteria,setCriteria]=useState(task?.criteria?.join('\n')||'内容与来源已核对\n所有必须附件已补齐\n交付版本已审阅'),[error,setError]=useState('');
  function save(){if(!title.trim()||!goal.trim()||!criteria.trim())return setError('补齐任务名称、目标和验收');if(!noDue&&validMoment(due)===undefined)return setError('填写有效日期时间，或选择无固定期限');const change={title:title.trim(),description:goal.trim(),due:noDue?'无固定期限':due,priority:priority as Task['priority'],criteria:criteria.split('\n').filter(x=>x.trim()),...(task&&goal.trim()!==task.description.trim()?{version:task.version+1,needsReview:true,authorized:false,aiStatus:'待授权' as const,generationToken:undefined,status:accepted(task)?'已承接' as const:task.status}:{})};let id=task?.id||`TASK-${Date.now().toString().slice(-6)}`;update(current=>({...current,tasks:task?current.tasks.map(x=>x.id===id?{...x,...change,activities:[...x.activities,`${stamp()} · 更新工作字段与验收`]}:x):[...current.tasks,{...change,id,owner:'我',requester:data.settings.name,status:'待承接',aiStatus:'未启动',activities:[`${stamp()} · 新建待办草稿`],results:[],version:1}],settings:!task&&current.settings.space!=='我的空间'?{...current.settings,retention:{...current.settings.retention,['task-space:'+id]:current.settings.space}}:current.settings}));toast(task?'要求已保存':'草稿已保存，等待核对承接');navigate({view:task?'task-detail':'task-accept',id});}
  return <div className="stack"><Field label="任务名称" value={title} onChange={setTitle} placeholder="想推进什么？"/><Field label="目标与要求" value={goal} onChange={setGoal} multiline placeholder="产出、受众和要确认的内容"/><Field label="期限" value={due} onChange={setDue} placeholder="2026-10-09 17:00"/><Check label="无固定期限" value={noDue} onChange={setNoDue}/><SelectField label="优先级" value={priority} onChange={setPriority} options={['高','中','低']}/><Field label="验收标准" value={criteria} onChange={setCriteria} multiline hint="每行一项，交付时逐项核对"/>{error&&<p className="error-text">{error}</p>}<Button onClick={save}>保存{task?'要求':'草稿'}</Button></div>;
}
function Plan({task:t}:{task:TaskRecord}) {
  const {go}=useTaskActions(t);const steps=t.id==='TASK-032'?['读取指定库存资料','对照数量与资料时间','准备向王宁核实的消息']:t.id==='TASK-033'?['整理资料卡需求','设计两种返回方式','准备验证清单']:['核对允许的指标资料','先搭可修改的复盘框架','制作6页提纲','保留缺资料问题供确认'];
  return <div className="stack"><Card><div className="section-title"><h2>这次帮你准备</h2><Badge>仅个人草稿</Badge></div><p>{t.title}</p></Card><Card>{steps.map((s,i)=><Row key={s} title={s} icon={i?'arrow-down':'books'} subtitle={i?'依赖上一步结果':'只读已允许资料'} trailing={<Badge tone="gray">{i?'随后':'先做'}</Badge>}/>)}</Card><div className="stat-grid"><Card><small className="meta">预计额度</small><h2>{t.outputMode==='仅提纲'?6:16}点</h2></Card><Card><small className="meta">保存位置</small><h2>个人成果</h2></Card></div><Button onClick={()=>go(accepted(t)?'task-authorize':'task-accept')}>{accepted(t)?'核对范围并准备':'先核对承接'}</Button><Button tone="secondary" onClick={()=>go('task-budget')}>调整产出与额度</Button><Button tone="quiet" onClick={()=>go('task-ask')}>先提出缺资料问题</Button></div>;
}
function Authorize({task:t}:{task:TaskRecord}) {
  const {toast}=useOops(),{patch,go}=useTaskActions(t);const [sources,setSources]=useState(t.scope?.sources||(t.id==='TASK-032'?'蓝色椅子 B-108 指定库存资料':t.id==='TASK-033'?'已保存的会中资料卡建议与来源片段':'本次会议转写、指定指标表与用户汇总')),[destination,setDestination]=useState(t.scope?.destination||'我的个人成果'),[read,setRead]=useState(false),[draft,setDraft]=useState(false),[error,setError]=useState('');
  function allow(){if(!accepted(t))return go('task-accept');if(!usable(sources)||!usable(destination)||!read||!draft)return setError('明确资料、保存位置并勾选这两项允许');patch({authorized:true,scope:{sources,destination},aiStatus:'未启动'},'允许指定资料读取与个人草稿准备');toast('范围已保存，点击开始准备');go('task-progress');}
  return <div className="stack"><Card><h2>{t.title}</h2><Badge>个人范围</Badge></Card><Field label="允许使用的资料" value={sources} onChange={setSources} multiline/><Field label="成果保存位置" value={destination} onChange={setDestination}/><Check label="允许读取这些资料" value={read} onChange={setRead}/><Check label="允许生成个人草稿" value={draft} onChange={setDraft}/><Notice>消息、邮件、共享与日历需要在具体内容旁另行确认。</Notice>{error&&<p className="error-text">{error}</p>}<Button onClick={allow}>{accepted(t)?'保存允许范围':'先核对承接'}</Button></div>;
}
function Progress({task:t}:{task:TaskRecord}) {
  const {patch,go,start}=useTaskActions(t);const ready=t.aiStatus==='草稿完成';
  return <div className="stack"><Card className="task-card"><div className="section-title"><Icon name="sparkle" size={30}/><Badge>{t.aiStatus}</Badge></div><h2>{ready?'草稿准备好了':t.aiStatus==='准备中'?'正在为你整理':t.aiStatus==='已暂停'?'已保留当前进度':'按你的范围继续'}</h2><p className="meta">{t.title}</p></Card><Card><Row title="资料范围" subtitle={t.scope?.sources||'尚未允许'} icon="books" trailing={<Badge tone="gray">{t.authorized?'已允许':'待确认'}</Badge>}/><Row title="框架与内容" subtitle={ready?'已保存，等待核对':t.aiStatus==='准备中'?'正在生成本地草稿':'尚未完成'} icon="file-text" trailing={<Badge>{ready?'已保存':'待处理'}</Badge>}/><Row title="对外动作" subtitle="没有自动发送消息或创建日程" icon="shield-check" trailing={<Badge tone="gray">需另确认</Badge>}/></Card>{t.failure&&<Notice tone="danger">{t.failure}</Notice>}{ready?<Button onClick={()=>go('task-result')}>打开成果</Button>:<Button onClick={()=>start()} disabled={t.aiStatus==='准备中'}>{t.authorized?'开始 / 继续准备':'核对允许范围'}</Button>}{t.aiStatus==='准备中'&&<Button tone="secondary" icon="pause" onClick={()=>patch({aiStatus:'已暂停',generationToken:undefined},'暂停助手，保留已有成果')}>暂停准备</Button>}<div className="action-grid"><Button tone="quiet" onClick={()=>{patch({aiStatus:'已停止',generationToken:undefined},'停止助手，工作责任仍保留');go('task-detail');}}>停止助手</Button><Button tone="quiet" onClick={()=>go('task-change')}>修改要求</Button></div><Button tone="quiet" onClick={()=>{patch({aiStatus:'失败',failure:'缺少完整指标附件，已保存内容保留',generationToken:undefined},'附件检查未通过');go('task-failure');}}>查看缺附件的处理示例</Button></div>;
}
function Failure({task:t}:{task:TaskRecord}) {
  const {go,start,patch}=useTaskActions(t);return <div className="stack"><Notice tone="danger">{t.failure||'还有需要补充的资料'}</Notice><Card><h2>保留已做好的部分</h2><p className="meta">{artifacts(t).length}份成果仍在原任务中</p><Row title="现有成果" icon="files" onClick={()=>go('task-result')}/><Row title="补充缺少的附件" icon="paperclip" onClick={()=>go('task-attachment')}/><Row title="向提出者核实" icon="chat-circle-text" onClick={()=>go('task-ask')}/></Card><Button onClick={()=>{if(!t.materials?.length)return go('task-attachment');start(true);}}>仅重试未完成步骤</Button><Button tone="secondary" onClick={()=>{patch({aiStatus:'已停止',generationToken:undefined},'停止失败步骤，保留成功结果');go('task-result');}}>保留成果，停止这一步</Button></div>;
}
function Budget({task:t}:{task:TaskRecord}) {
  const {patch,go}=useTaskActions(t);const [limit,setLimit]=useState(String(t.budget??40)),[mode,setMode]=useState(t.outputMode||'完整框架与PPT'),[error,setError]=useState('');
  return <div className="stack"><div className="stat-grid"><Card><small className="meta">本任务已用</small><h2>{t.used??0}点</h2></Card><Card><small className="meta">预计本次</small><h2>{mode==='仅提纲'?6:16}点</h2></Card></div><Field label="本任务上限" value={limit} onChange={setLimit} type="number"/><SelectField label="准备范围" value={mode} onChange={setMode} options={['完整框架与PPT','仅提纲']}/>{error&&<p className="error-text">{error}</p>}<Button onClick={()=>{const amount=Number(limit);if(!Number.isFinite(amount)||amount<(t.used??0)+(mode==='仅提纲'?6:16))return setError('上限需覆盖已用额度和本次准备');patch({budget:amount,outputMode:mode},`调整本任务上限为${amount}点，范围：${mode}`);go('task-plan');}}>保存范围与上限</Button><Notice>这里调整的是本地演示额度，项目预算保持不变。</Notice></div>;
}
function Change({task:t}:{task:TaskRecord}) {
  const {patch,go}=useTaskActions(t);const [goal,setGoal]=useState(t.description),[error,setError]=useState('');
  return <div className="stack"><Card><Badge tone="gray">当前 v{t.version}</Badge><p>{t.description}</p></Card><Field label="新的工作要求" value={goal} onChange={setGoal} multiline/>{error&&<p className="error-text">{error}</p>}<Notice>保存新要求后先复核资料和计划；旧成果与发送回执会保留。</Notice><Button onClick={()=>{if(!goal.trim()||goal.trim()===t.description.trim())return setError('请填写具体变更');patch({description:goal,version:t.version+1,authorized:false,aiStatus:'待授权',generationToken:undefined,needsReview:true,status:accepted(t)?'已承接':t.status},'需求更新，旧成果待复核');go('task-plan');}}>保存新要求</Button><Button tone="secondary" onClick={()=>go('task-versions')}>查看已有版本</Button></div>;
}
function Result({task:t}:{task:TaskRecord}) {
  const {go}=useTaskActions(t);const {data,update,navigate,toast}=useOops();const list=artifacts(t),latest=list.filter(a=>a.version===Math.max(...list.filter(b=>b.kind===a.kind).map(b=>b.version)));
  function returnToSession() {
    const session=data.sessions.find(s=>s.id===t.sourceSession),result=latest.find(a=>a.kind==='资料');
    if(!session)return toast('来源会话已经移除，成果仍保留在这项任务');
    if(!result)return toast('先准备一份资料结果，再带回会话');
    const materialId=`material-${t.id}-${result.id}`,name=`${result.title} · v${result.version}`;
    const visibility=data.settings.space==='我的空间'?'私有' as const:'项目共享' as const;
    update(current=>({...current,
      sessions:current.sessions.map(s=>s.id===session.id?{...s,attachments:[...new Set([...s.attachments,name])]}:s),
      memories:current.memories.some(m=>m.id===materialId)?current.memories.map(m=>m.id===materialId?{...m,body:result.body.join('\n'),visibility,deleted:false}:m):[...current.memories,{id:materialId,title:name,body:result.body.join('\n'),category:'收藏' as const,tags:['资料','任务成果',t.id],visibility,confirmed:true,updated:'今天',sourceSession:session.id,sourceTime:t.sourceTime}],
      settings:visibility==='项目共享'?{...current.settings,retention:{...current.settings.retention,['memory-space:'+materialId]:current.settings.space}}:current.settings,
    }));
    toast('已把这份成果加入会话资料，没有重新查询');
    navigate({view:'session-detail',id:session.id,mode:'资料'});
  }
  return <div className="stack"><div><h1 className="title">这次准备的成果</h1><p className="meta">{t.title} · 仅本人可见</p></div>{t.needsReview&&<Notice>当前成果需要本人复核，再继续交付。</Notice>}{list.length?<Card>{latest.map(a=><Row key={a.id} icon={a.kind==='PPT'?'presentation-chart':a.kind==='资料'?'books':'file-text'} title={a.title} subtitle={`${a.kind} · v${a.version} · ${a.created}`} badge={t.status==='已完成'?'已验收':'待核对'} onClick={()=>go('task-preview',a.id)}/>)}</Card>:<Empty title="还没有保存的成果" body="先让助手准备可修改的草稿" action="准备草稿" onAction={()=>go('task-plan')}/>}<TaskSource task={t}/><SectionTitle>下一步</SectionTitle><Card><Row title="起草跟进消息" icon="chat-circle-text" onClick={()=>go('task-send')}/><Row title="邮件请人审阅" icon="envelope-simple" onClick={()=>go('task-email')}/><Row title="安排审阅日程" icon="calendar-blank" onClick={()=>go('task-calendar')}/><Row title="比较历史版本" icon="clock-counter-clockwise" onClick={()=>go('task-versions')}/></Card>{t.id==='TASK-032'&&<Button tone="secondary" onClick={returnToSession}>带回会中资料</Button>}</div>;
}
function Versions({task:t}:{task:TaskRecord}) {
  const {go}=useTaskActions(t);const all=[...artifacts(t)].reverse();return <div className="stack"><p className="meta">旧稿保留，可以打开比较。</p>{all.length?<Card>{all.map(a=><Row key={a.id} title={a.title} subtitle={`${a.kind} · v${a.version} · ${a.created}`} icon="clock-counter-clockwise" onClick={()=>go('task-preview',a.id)}/>)}</Card>:<Empty title="暂无版本" body="生成或保存第一份草稿后，这里会出现历史"/>}</div>;
}
function Preview({task:t,edit=false}:{task:TaskRecord;edit?:boolean}) {
  const {route,toast}=useOops(),{patch,go}=useTaskActions(t);const all=artifacts(t),a=all.find(x=>x.id===route.mode)||all[all.length-1];const [page,setPage]=useState(0),[body,setBody]=useState(a?.body||[]),[title,setTitle]=useState(a?.title||'');
  if(!a)return <Empty title="还没有成果" body="先准备草稿，再预览或编辑" action="准备草稿" onAction={()=>go('task-plan')}/>;
  function save(){if(!title.trim()||body.some(s=>!s.trim()))return toast('标题和每页内容都需要填写');const v=Math.max(t.version,...all.map(x=>x.version))+1;const newer:Artifact={...a!,id:artifactId(),title,body,version:v,created:stamp()};patch({artifacts:[...all,newer],version:v,needsReview:true},`保存${a!.kind}新版本v${v}`);go('task-preview',newer.id);}
  return <div className="stack"><div className="section-title"><Badge>{a.kind}</Badge><Badge tone="gray">v{a.version}</Badge></div>{a.kind==='PPT'&&<Chips items={body.map((_,i)=>`第${i+1}页`)} value={`第${page+1}页`} onChange={s=>setPage(Number(s.replace(/\D/g,''))-1)}/>} {edit?<><Field label="成果标题" value={title} onChange={setTitle}/><Field label={a.kind==='PPT'?'当前页内容':'正文'} value={a.kind==='PPT'?body[page]||'':body.join('\n\n')} onChange={s=>setBody(a.kind==='PPT'?body.map((x,i)=>i===page?s:x):s.split('\n\n'))} multiline/><Button onClick={save}>另存新版本</Button></>:<><Card className={a.kind==='PPT'?'presentation-card':'document-card'}><p className="meta">{a.kind==='PPT'?`${page+1} / ${body.length}`:'个人草稿'}</p><h2>{a.title}</h2>{(a.kind==='PPT'?[body[page]]:body).map((p,i)=><p key={i} style={{whiteSpace:'pre-line'}}>{p}</p>)}</Card><Button onClick={()=>go('task-artifact-edit',a.id)}>编辑这份成果</Button><Button tone="secondary" onClick={()=>go('task-email')}>准备审阅邮件</Button><Button tone="quiet" icon="download-simple" onClick={()=>{const url=URL.createObjectURL(new Blob([a.title+'\n\n'+body.join('\n\n')],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=a.title+'-v'+a.version+'.txt';link.click();URL.revokeObjectURL(url);toast('已导出当前文本提纲');}}>导出文本提纲</Button></>}<TaskSource task={t}/></div>;
}
function initialDraft(t:TaskRecord,kind:string):Draft {
  const saved=t.drafts?.[kind];if(saved)return saved;
  const inventory=t.id==='TASK-032';
  return {target:kind==='消息'?'王宁':kind==='邮件'?'李晴 · liqing@example.test':'我、王宁、李晴',body:inventory?'王宁你好，蓝色椅子 B-108 的资料记录为在库24件、预留6件、可用18件。请帮忙核实今天是否有出入库变化，以及是否满足本次需求，谢谢。':kind==='日程'?'核对资料口径，审阅复盘框架，明确差异原因和下一步行动。':'李晴你好，第三季度 KPI 复盘框架与6页提纲已整理。请重点审阅统计口径和差异原因，缺少的指标还需确认，谢谢。',attachments:kind==='日程'?'':artifacts(t).map(a=>`${a.title} v${a.version}`).join('、'),subject:`请审阅：${t.title}`,account:'我的演示账号',cc:'',start:'2026-10-09 14:00',end:'2026-10-09 14:30',calendar:'我的工作日历'};
}
function Communication({task:t,kind}:{task:TaskRecord;kind:'消息'|'邮件'|'日程'}) {
  const {data,update,navigate,toast}=useOops(),{patch}=useTaskActions(t);const [draft,setDraft]=useState(()=>initialDraft(t,kind)),[checked,setChecked]=useState(false),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[conflictChecked,setConflictChecked]=useState(false);
  const proposedStart=validMoment(draft.start||''),proposedEnd=validMoment(draft.end||'');
  const conflicts=kind==='日程'&&proposedStart!==undefined&&proposedEnd!==undefined?data.receipts.filter(r=>{if(r.kind!=='日程')return false;const m=r.body.match(/时间：(.+) — (.+)/);if(!m)return false;const start=validMoment(m[1]),end=validMoment(m[2]);return start!==undefined&&end!==undefined&&proposedStart<end&&proposedEnd>start&&!(r.taskId===t.id&&r.target===`${draft.target} · ${draft.calendar}`&&r.body.includes(`主题：${draft.subject}\n${draft.body}\n`)&&r.body.includes(`时间：${draft.start} — ${draft.end}`));}):[];
  function edit(key:keyof Draft,value:string){setDraft(d=>({...d,[key]:value}));setChecked(false);setConflictChecked(false);setError('');}
  function save(){patch({drafts:{...t.drafts,[kind]:draft}},`保存${kind}草稿，尚未外部提交`);toast('已保存草稿');}
  function review(){if(!usable(draft.target)||!draft.body.trim())return setError('明确对象与完整正文');if(kind!=='日程'&&!usable(draft.account||''))return setError('请选择明确的发送账号');if(kind==='邮件'&&!draft.subject?.trim())return setError('补充邮件主题');if(kind==='日程'){const start=validMoment(draft.start||''),end=validMoment(draft.end||'');if(!draft.subject?.trim()||!draft.calendar?.trim()||!/^\d{4}[-/年]/.test(draft.start||'')||!/^\d{4}[-/年]/.test(draft.end||'')||start===undefined||end===undefined||end<=start||new Date(start).toDateString()!==new Date(end).toDateString())return setError('填写有效的同日日期时间，结束需晚于开始');}if(!checked)return setError('请勾选本次内容核对');if(conflicts.length&&!conflictChecked)return setError('当前时段已有安排，请先确认冲突');setConfirm(true);}
  function submit(){const target=kind==='日程'?`${draft.target} · ${draft.calendar}`:draft.target;const body=`${kind!=='日程'?`账号：${draft.account}\n`:''}${kind!=='消息'&&draft.subject?`主题：${draft.subject}\n`:''}${draft.body}\n附件：${draft.attachments||'无'}${draft.cc?`\n抄送：${draft.cc}`:''}${kind==='日程'?`\n时间：${draft.start} — ${draft.end}`:''}`;const old=data.receipts.find(r=>r.taskId===t.id&&r.kind===kind&&r.target===target&&r.body===body);if(old){setConfirm(false);toast('已存在同一模拟回执，没有重复提交');return navigate({view:'task-receipt',id:t.id,mode:old.id});}const receipt={id:`receipt-${Date.now()}`,taskId:t.id,kind,target,body,date:stamp()};update(current=>({...current,receipts:current.receipts.some(r=>r.taskId===t.id&&r.kind===kind&&r.target===target&&r.body===body)?current.receipts:[...current.receipts,receipt],tasks:current.tasks.map(x=>x.id===t.id?{...x,drafts:{...(x as TaskRecord).drafts,[kind]:draft},activities:[...x.activities,`${stamp()} · 已记录${kind}模拟回执`]}:x)}));setConfirm(false);toast('已生成本地模拟回执，未对外提交');navigate({view:'task-receipt',id:t.id,mode:receipt.id});}
  const connection=kind==='消息'?'飞书':kind==='邮件'?'邮箱':'日历';
  return <div className="stack"><div className="section-title"><Badge>待本人确认</Badge><Badge tone="gray">{connection} · {data.settings.connections[connection]?'已选账号':'演示账号'}</Badge></div>{kind!=='日程'&&<Field label="发送账号" value={draft.account||''} onChange={s=>edit('account',s)}/>}<Field label={kind==='日程'?'参与人':'收件对象'} value={draft.target} onChange={s=>edit('target',s)} placeholder="明确选择一个对象"/>{kind==='邮件'&&<Field label="抄送" value={draft.cc||''} onChange={s=>edit('cc',s)}/>} {kind!=='消息'&&<Field label={kind==='日程'?'日程标题':'邮件主题'} value={draft.subject||''} onChange={s=>edit('subject',s)}/>} {kind==='日程'&&<><Field label="开始时间" value={draft.start||''} onChange={s=>edit('start',s)} placeholder="2026-10-09 14:00"/><Field label="结束时间" value={draft.end||''} onChange={s=>edit('end',s)} placeholder="2026-10-09 14:30"/><SelectField label="目标日历" value={draft.calendar||'我的工作日历'} onChange={s=>edit('calendar',s)} options={['我的工作日历','个人日历']}/></>}<Field label={kind==='日程'?'议程':'完整正文'} value={draft.body} onChange={s=>edit('body',s)} multiline/>{kind!=='日程'&&<Field label="附件与版本" value={draft.attachments} onChange={s=>edit('attachments',s)} placeholder="可留空，也可指定成果版本"/>}{conflicts.length>0&&<Notice>这个时段已有{conflicts.length}条安排，请调整时间或明确确认。<Check label="已处理同一时段的冲突" value={conflictChecked} onChange={setConflictChecked}/></Notice>}<Check label={kind==='日程'?'已核对参与人、起止时间与日历':'已核对收件对象、正文和附件'} value={checked} onChange={setChecked}/>{error&&<p className="error-text">{error}</p>}<Button onClick={review}>{kind==='日程'?'核对并创建':'核对并发送'}</Button><Button tone="secondary" onClick={save}>保存草稿</Button>{kind==='消息'&&<Button tone="quiet" icon="copy" onClick={()=>{navigator.clipboard?.writeText(draft.body).then(()=>toast('正文已复制，尚未发送')).catch(()=>toast('当前环境暂不允许复制'));}}>复制正文</Button>}<p className="meta">仅在本机演示，不会发送到真实账号。</p><Sheet open={confirm} onClose={()=>setConfirm(false)} title={kind==='日程'?'确认这条日程':'确认这次发送'}><div className="stack"><Card><Badge>{kind}</Badge><h3>{draft.target}</h3>{kind!=='日程'&&<p className="meta">发送账号：{draft.account}</p>}{kind==='邮件'&&draft.cc&&<p className="meta">抄送：{draft.cc}</p>}{kind!=='消息'&&draft.subject&&<strong>{draft.subject}</strong>}{kind==='日程'&&<p>{draft.start} — {draft.end}<br/>{draft.calendar}</p>}<p style={{whiteSpace:'pre-line'}}>{draft.body}</p>{draft.attachments&&<p className="meta">附件：{draft.attachments}</p>}</Card><Button onClick={submit}>{kind==='日程'?'确认模拟创建':'确认模拟发送'}</Button><Button tone="quiet" onClick={()=>setConfirm(false)}>继续修改</Button></div></Sheet></div>;
}
function Receipts({task:t}:{task:TaskRecord}) {
  const {data,route}=useOops(),{go}=useTaskActions(t);const list=data.receipts.filter(x=>x.taskId===t.id),selected=list.find(r=>r.id===route.mode);const shown=selected?[selected]:[...list].reverse();return <div className="stack"><Notice>以下为本地模拟记录，没有真实发送或日历写入。</Notice>{shown.length?shown.map(r=><Card key={r.id}><div className="section-title"><Badge>{r.kind}</Badge><Badge tone="green">模拟完成</Badge></div><h3>{r.target}</h3><p style={{whiteSpace:'pre-line'}}>{r.body}</p><p className="meta">{r.date}</p></Card>):<Empty title="还没有操作回执" body="具体内容确认后，记录会保存在这里"/>}<Button tone="secondary" onClick={()=>go('task-result')}>回到成果</Button></div>;
}
function History({task:t}:{task:TaskRecord}) {
  const {go}=useTaskActions(t);return <div className="stack"><Card><div className="timeline">{[...t.activities].reverse().map((s,i)=><div key={i} className="timeline-item"><Icon name="check-circle" size={18}/><p>{s}</p></div>)}</div></Card><Row title="查看外部操作模拟记录" icon="paper-plane-tilt" onClick={()=>go('task-receipt')}/></div>;
}
function Complete({task:t}:{task:TaskRecord}) {
  const {toast}=useOops(),{patch,go}=useTaskActions(t);const criteria=t.criteria||['内容与来源已核对','所有必须附件已补齐','交付版本已审阅'];const [checks,setChecks]=useState<Record<string,boolean>>({}),[note,setNote]=useState(''),[cancel,setCancel]=useState(false),[error,setError]=useState('');
  function finish(){if(!accepted(t))return setError('请先确认承接，再完成交付');if(!artifacts(t).length)return setError('还没有交付成果');if(!criteria.every(c=>checks[c]))return setError('完成前需要逐项验收');patch({status:'已完成',needsReview:false,generationToken:undefined,aiStatus:t.aiStatus==='准备中'?'已停止':t.aiStatus},`本人验收完成${note?`：${note}`:''}`);toast('工作已完成');go('task-detail');}
  return <div className="stack"><Card><h2>{t.title}</h2><p className="meta">{artifacts(t).length}份已保存成果 · {t.status}</p></Card>{criteria.map(c=><Check key={c} label={c} value={!!checks[c]} onChange={v=>setChecks(x=>({...x,[c]:v}))}/>)}<Field label="交付说明" value={note} onChange={setNote} multiline placeholder="补充验收范围或遗留事项"/>{error&&<p className="error-text">{error}</p>}<Button onClick={finish} disabled={closed(t)}>验收完成</Button><Button tone="secondary" onClick={()=>go('task-attachment')}>继续补充资料</Button><Button tone="danger" onClick={()=>setCancel(true)} disabled={closed(t)}>取消这项工作</Button><Sheet open={cancel} onClose={()=>setCancel(false)} title="取消工作？"><div className="stack"><p>未完成的助手准备会停止，已有成果和回执保留。</p><Field label="取消原因" value={note} onChange={setNote} multiline/><Button tone="danger" onClick={()=>{if(!note.trim())return toast('请填写取消原因');patch({status:'已取消',aiStatus:'已停止',generationToken:undefined},`取消工作：${note}`);setCancel(false);go('task-detail');}}>确认取消</Button></div></Sheet></div>;
}
function Supplement({task:t,question=false}:{task:TaskRecord;question?:boolean}) {
  const {data,toast}=useOops(),{patch,go}=useTaskActions(t);const [text,setText]=useState(''),[choice,setChoice]=useState(''),[error,setError]=useState('');const options=['选择已有资料',...new Set(data.sessions.flatMap(s=>s.attachments))];
  return <div className="stack"><Card><h2>{question?'先把缺口问清楚':'补齐继续所需的资料'}</h2><p className="meta">{t.title}</p></Card>{!question&&<SelectField label="已有资料" value={choice||options[0]} onChange={setChoice} options={options}/>}<Field label={question?'要确认的问题':'资料名称或补充说明'} value={text} onChange={setText} multiline placeholder={question?'需要确认哪个指标、口径或附件？':'例如：更新后的完整指标表，10月8日版'}/>{error&&<p className="error-text">{error}</p>}<Button onClick={()=>{const content=(text||choice).trim();if(!content||content===options[0])return setError(question?'先写明具体问题':'填写或选择一份资料');if(question){patch({questions:[...(t.questions||[]),content],drafts:{...t.drafts,'邮件':{...initialDraft(t,'邮件'),target:t.requester,subject:`请确认：${t.title}`,body:`${t.requester}你好，推进这项工作前，需要你帮忙确认：\n${content}\n谢谢。`}}},`记录待确认问题：${content}`);toast('问题已记录，发送需另行确认');go('task-email');}else{patch({materials:[...(t.materials||[]),content],failure:undefined},`补充资料：${content}`);toast('资料已附到原任务');go(t.aiStatus==='失败'?'task-failure':'task-detail');}}}>{question?'保存问题，准备询问':'保存到这项任务'}</Button>{(question?t.questions:t.materials)?.length?<Card>{(question?t.questions:t.materials)?.map(s=><p key={s}>{s}</p>)}</Card>:null}</div>;
}
export default function Tasks() {
  const {data,route,navigate}=useOops();
  if(route.view==='tasks')return <TaskList/>;
  if((route.view==='task-edit'&&!route.id)||route.view==='task-create')return <Requirements key="new"/>;
  const t=data.tasks.find(x=>x.id===route.id) as TaskRecord|undefined;
  if(!t)return <Empty title="没有找到这项任务" body="任务可能已移除，返回列表继续查看" action="返回任务" onAction={()=>navigate({view:'tasks'})}/>;
  if(!taskVisible(data,t))return <Empty title="这项任务不在当前空间" body="切回个人空间，或查看当前团队已共享的工作。" action="返回当前任务列表" onAction={()=>navigate({view:'tasks'})} icon="lock-key"/>;
  const key=`${route.view}:${t.id}:${route.mode||''}`;
  switch(route.view){
    case 'task-detail': return <Detail key={key} task={t}/>;
    case 'task-accept': return <Accept key={key} task={t}/>;
    case 'task-reject': return <Reject key={key} task={t}/>;
    case 'task-transfer': return <Transfer key={key} task={t}/>;
    case 'task-transfer-response': return <Transfer key={key} task={t} response/>;
    case 'task-edit': return <Requirements key={key} task={t}/>;
    case 'task-plan': return <Plan key={key} task={t}/>;
    case 'task-authorize': return <Authorize key={key} task={t}/>;
    case 'task-progress': return <Progress key={key} task={t}/>;
    case 'task-failure': return <Failure key={key} task={t}/>;
    case 'task-budget': return <Budget key={key} task={t}/>;
    case 'task-change': return <Change key={key} task={t}/>;
    case 'task-result': return <Result key={key} task={t}/>;
    case 'task-versions': return <Versions key={key} task={t}/>;
    case 'task-preview': return <Preview key={key} task={t}/>;
    case 'task-artifact-edit': return <Preview key={key} task={t} edit/>;
    case 'task-send': case 'task-send-confirm': return <Communication key={key} task={t} kind="消息"/>;
    case 'task-email': return <Communication key={key} task={t} kind="邮件"/>;
    case 'task-calendar': return <Communication key={key} task={t} kind="日程"/>;
    case 'task-receipt': return <Receipts key={key} task={t}/>;
    case 'task-history': return <History key={key} task={t}/>;
    case 'task-complete': return <Complete key={key} task={t}/>;
    case 'task-ask': return <Supplement key={key} task={t} question/>;
    case 'task-attachment': return <Supplement key={key} task={t}/>;
    default:return <Empty title="这个入口暂时不可用" body="返回这项任务，选择下一步" action="返回任务详情" onAction={()=>navigate({view:'task-detail',id:t.id})}/>;
  }
}
