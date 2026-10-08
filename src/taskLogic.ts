import type { AppData, Task, TaskArtifact } from './store';
import { generationCanComplete, provenanceAvailable, selectedTaskMaterials, taskSourceAvailable } from './sourceAccess';
import { taskArtifacts, taskOutputMode } from './taskWorkflow';
export { taskArtifacts } from './taskWorkflow';

export type TaskDetails = Task;
const stamp = () => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
const artifactId = () => `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export function buildTaskArtifacts(task: Task): TaskArtifact[] {
  const mode = taskOutputMode(task);
  const materials = selectedTaskMaterials(task).map(material => `${material.title}${material.body ? '：' + material.body : '（附件正文尚未提供，不代表已解析）'}${material.note?.trim() ? '\n本人补充说明：' + material.note.trim() : ''}`);
  const evidence = { sourceSession: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime, sources: task.generationSources || task.sources, needsReview: true };
  const make = (kind: TaskArtifact['kind'], title: string, body: string[]): TaskArtifact => ({ ...evidence, id: artifactId(), kind, title, version: task.version, created: stamp(), body });
  const materialText = materials.length ? materials.join('\n') : '这次未选择可读取的资料。具体事实与执行结果仍需本人提供。';
  const criteria = task.criteria?.length ? task.criteria : ['内容与依据已核对', '完成范围与遗留事项已说明'];
  const openQuestions = (task.inquiries ? task.inquiries.filter(inquiry => inquiry.status !== '已解决').map(inquiry => inquiry.question) : task.questions || []).join('\n');
  const common = ['目标与要求\n' + task.description, '本次允许的资料\n' + materialText, '验收清单\n' + criteria.map(item => '□ ' + item).join('\n'), '待核对内容\n' + (openQuestions || '实际事实、执行结果与尚未确认的信息由本人补充。'), '推进安排\n负责人：' + task.owner + '；期限：' + (task.due || '待确认')];
  if (mode === '资料整理') return [make('资料', `${task.title} · 资料整理`, ['整理目标\n' + task.description, '已选资料摘录\n' + materialText, '需要继续核实\n' + (openQuestions || '补齐资料时间、统计口径与任务要求。'), '这份草稿仅整理已允许的本地资料，不代表实时查询或事实确认。'])];
  if (mode === '回复草稿') return [make('文档', `${task.title} · 回复草稿`, ['你好，关于「' + task.title + '」，需要先确认以下事项：\n' + task.description, '可供核对的本地材料：\n' + materialText, '需要你帮助确认：\n' + (openQuestions || '事实依据、时间与下一步安排。'), '谢谢。\n这是一份可修改正文，收件对象、附件和发送须另外核对。'])];
  if (mode === '行动清单') return [make('文档', `${task.title} · 行动清单`, ['□ 核对目标：' + task.description, '□ 查看允许的材料：\n' + materialText, '□ 确认待回答问题：\n' + (openQuestions || '缺口与依赖由本人补充。'), ...criteria.map(item => '□ ' + item), '□ 由' + task.owner + '记录实际执行结果；期限：' + (task.due || '待补充'), '这份清单不是已执行的证明。'])];
  if (task.id === 'TASK-021' && /KPI/i.test(task.title)) {
    const doc = make('文档', '第三季度 KPI 复盘框架', [...common, '结构：目标、实际、差异、原因、风险和行动。尚未填写业务数字，需本人核对。']);
    const pages = ['目标与范围\n' + task.description, '实际表现\n' + materialText + '\n实际值与统计口径待补。', '差异分析\n比较目标与实际；实际数据待核对。', '原因与证据\n区分已确认原因与待验证假设。', '风险与应对\n列出影响与需要协调的支持。', '下一步行动\n' + criteria.join('\n') + '\n负责人：' + task.owner + '；期限：' + (task.due || '待补充')];
    return mode === '文档与PPT' ? [doc, make('PPT', '第三季度 KPI 复盘', pages)] : [doc];
  }
  const doc = make('文档', `${task.title} · 工作草稿`, common);
  if (mode !== '文档与PPT') return [doc];
  return [doc, make('PPT', `${task.title} · 汇报提纲`, ['本次目标\n' + task.description, '已提供的依据\n' + materialText, '工作内容\n按要求填写实际进展，不预写已完成结论。', '尚未确认的问题\n' + (openQuestions || '事实、数据和依赖需本人核对。'), '验收标准\n' + criteria.join('\n'), '下一步\n' + task.owner + '负责；期限：' + (task.due || '待补充')])];
}

export function finishLocalGeneration(current: AppData, id: string, token: string, _legacyCost?: number): AppData {
  return { ...current, tasks: current.tasks.map(task => {
    if (task.id !== id || task.generationToken !== token || task.aiStatus !== '准备中') return task;
    const snapshot = task.generationSnapshot;
    const actorData = { ...current, settings: { ...current.settings, space: snapshot?.space || task.generationSpace || task.scope?.space || current.settings.retention['task-space:' + task.id] || '我的空间' } };
    if (!snapshot || !generationCanComplete(actorData, task, token)) return { ...task, generationToken: undefined, generationSnapshot: undefined, authorized: false, aiStatus: '待授权' as const, needsReview: taskArtifacts(task).some(artifact => !!artifact.needsReview), sourceNeedsReview: !taskSourceAvailable(actorData, task, new Set(), true) || !provenanceAvailable(actorData, snapshot?.sourceRefs || task.generationSources), activities: [...task.activities, `${stamp()} · 准备范围、额度或来源已变化，原成果保留，请重新允许`] };
    // Output is built from the immutable authorized request, never from later UI edits.
    const fixedTask: Task = { ...task, ...snapshot.task, version: snapshot.version, outputMode: snapshot.mode, scope: snapshot.scope, materialRefs: snapshot.materials, generationSources: snapshot.sourceRefs, questions: snapshot.task.questions, inquiries: undefined, sourceSession: snapshot.task.sourceSession, sourceId: snapshot.task.sourceId, sourceTime: snapshot.task.sourceTime };
    const generated = buildTaskArtifacts(fixedTask), existing = taskArtifacts(task);
    return { ...task, status: snapshot.businessStatus, aiStatus: '草稿完成' as const, generationToken: undefined, generationSnapshot: undefined, artifacts: [...existing, ...generated], results: task.results, used: (task.used ?? 0) + snapshot.cost, needsReview: true, retryMissing: false, failure: undefined, activities: [...task.activities, `${stamp()} · 新草稿 v${snapshot.version}已保存，等待本人核对；工作尚未完成`] };
  }) };
}
