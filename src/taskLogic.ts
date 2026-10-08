import type { AppData, Task, TaskArtifact, SourceReference } from './store';
import { generationCanComplete, provenanceAvailable, taskSourceAvailable } from './sourceAccess';

export type TaskDetails = Task & { criteria?: string[]; materials?: string[]; questions?: string[]; scope?: { sources: string; destination: string; space?: string }; budget?: number; used?: number; outputMode?: string; failure?: string; retryMissing?: boolean; generationSources?: SourceReference[]; generationSpace?: string };
type TaskRecord = TaskDetails;
type Artifact = TaskArtifact;
const stamp = () => new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date());
const artifactId = () => `artifact-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

export function taskArtifacts(t: TaskRecord): Artifact[] {
  if(t.artifacts?.length)return t.artifacts;
  return t.results.length?[{id:`seed-${t.id}`,kind:t.id==='TASK-032'?'资料':'文档',title:t.id==='TASK-032'?'蓝色椅子库存摘录':`${t.title} · 已有内容`,version:t.version,body:t.results,created:'已有成果',needsReview:t.needsReview!==false,sourceSession:t.sourceSession,sourceId:t.sourceId,sourceTime:t.sourceTime,sources:t.sources}]:[];
}

export function buildTaskArtifacts(t:TaskRecord):Artifact[] {
  const evidence={sourceSession:t.sourceSession,sourceId:t.sourceId,sourceTime:t.sourceTime,sources:t.generationSources||t.sources,needsReview:true};
  const make=(kind:Artifact['kind'],title:string,body:string[]):Artifact=>({...evidence,id:artifactId(),kind,title,version:t.version,created:stamp(),body});
  if(t.id==='TASK-021'&&/KPI/i.test(t.title)) {
    const doc=make('文档','第三季度 KPI 复盘框架',['目标：'+t.description,'待补资料：完整指标表与统计口径。','结构：目标、实际、差异、原因、风险和行动。','尚未填写业务数字与事实结论，需本人补充核对。']);
    const pages=['目标与范围\n'+t.description,'实际表现\n按指标表补齐实际值，保留资料来源与时间。','差异分析\n比较目标与实际；实际数据待补充。','原因与证据\n区分已确认原因与待验证假设。','风险与应对\n列出影响与需要协调的支持。','下一步行动\n确认负责人、期限与验收口径。'];
    return t.outputMode==='仅提纲'?[doc]:[doc,make('PPT','第三季度 KPI 复盘',pages)];
  }
  if(t.id==='TASK-032'&&t.results.length)return [make('资料','蓝色椅子库存摘录',[...t.results,'核对要求：'+t.description,'这份保存资料不代表实时查询，今日变化仍需确认。'])];
  const materials=t.materialRefs?.map(m=>`${m.title}${m.body?'：'+m.body:''}`)||t.materials||[];
  const criteria=t.criteria?.length?t.criteria:['目标与原话已核对','所需资料已补齐','当前交付版本已审阅'];
  const doc=make('文档',`${t.title} · 工作草稿`,['目标与要求\n'+t.description,'已提供资料\n'+(materials.length?materials.join('\n'):'尚未附入资料，需确认所需材料。'),'验收清单\n'+criteria.map(c=>'□ '+c).join('\n'),'待补内容\n具体依据、执行结果与尚未确认的信息由本人补充。','推进安排\n负责人：'+t.owner+'；期限：'+(t.due||'待确认')]);
  const ppt=make('PPT',`${t.title} · 汇报提纲`,['本次目标\n'+t.description,'已提供的依据\n'+(materials.length?materials.join('\n'):'资料待补充。'),'工作内容\n按要求填写实际进展，不预写已完成结论。','尚未确认的问题\n'+(t.questions?.join('\n')||'事实、数据和依赖需本人核对。'),'验收标准\n'+criteria.join('\n'),'下一步\n'+t.owner+'负责；期限：'+(t.due||'待补充')]);
  return t.outputMode==='仅提纲'?[doc]:[doc,ppt];
}


export function finishLocalGeneration(current:AppData,id:string,token:string,cost:number):AppData {
  return {...current,tasks:current.tasks.map(item=>{
    const latest=item as TaskRecord;
    if(latest.id!==id||latest.generationToken!==token||latest.aiStatus!=='准备中')return item;
    const actorData={...current,settings:{...current.settings,space:latest.generationSpace||latest.scope?.space||current.settings.retention['task-space:'+latest.id]||'我的空间'}};
    const valid=generationCanComplete(actorData,latest,token);
    if(!valid)return {...latest,generationToken:undefined,authorized:false,aiStatus:'待授权' as const,needsReview:true,sourceNeedsReview:!taskSourceAvailable(actorData,latest)||!provenanceAvailable(actorData,latest.generationSources),activities:[...latest.activities,`${stamp()} · 授权或来源已变化，准备停止，原成果保留`]};
    const existing=taskArtifacts(latest),nextVersion=latest.retryMissing?latest.version:Math.max(latest.version,...existing.map(a=>a.version),0);
    const candidates=buildTaskArtifacts({...latest,version:nextVersion});
    const generated=latest.retryMissing?candidates.filter(a=>!existing.some(b=>b.kind===a.kind&&b.version===a.version)):candidates;
    return {...latest,status:'待验收' as const,aiStatus:'草稿完成' as const,generationToken:undefined,artifacts:[...existing,...generated],results:generated.length?[...latest.results,...generated.map(a=>`${a.title} · v${a.version}`)]:latest.results,used:(latest.used??0)+(generated.length?cost:0),needsReview:true,retryMissing:false,activities:[...latest.activities,`${stamp()} · ${latest.retryMissing?'未完成步骤已处理，成功成果保留':'草稿已保存'}，等待本人审阅`]};
  })};
}
