import { initialData, type AppData, type Memory, type Task, type TaskArtifact } from './store';
import { buildCommunicationDraft, buildCommunicationReview, submitCommunication } from './communicationLogic';
import { acceptTask, archiveTaskCompletion, beginGeneration, beginTransfer, taskArtifacts } from './taskWorkflow';
import { invalidateSessionSources, makeSourceReference } from './sourceAccess';
import { sharedMemoryEligible } from './memoryAccess';
import { setSessionShared, type SessionReviewItem } from './sessionLogic';
import { refreshTaskSuggestions } from './taskSuggestionsLogic';
import { refreshSessionIntelligence, saveNoticePlan, readSessionIntelligence, updateIntelligenceItem } from './sessionIntelligenceLogic';
import { SELF_VOICE_ID, addVoiceSample, bindVoiceSample, runVoiceMatch } from './voiceIdentityLogic';

const PERSONAL = '我的空间';
const TEAM = 'Oops 产品团队';
const CREATED = '10月8日 10:35';
const DOC = 'board-kpi-doc-v2';
const PPT = 'board-kpi-ppt-v2';
const STOCK = 'board-stock-v2';

function replaceTask(data: AppData, id: string, patch: Partial<Task>): AppData {
  return { ...data, tasks: data.tasks.map(task => task.id === id ? { ...task, ...patch } : task) };
}

function artifact(data: AppData, task: Task, values: Pick<TaskArtifact, 'id' | 'kind' | 'title' | 'body' | 'version'>, reviewed = false): TaskArtifact {
  return { ...values, created: CREATED, needsReview: !reviewed, reviewedAt: reviewed ? CREATED : undefined, sourceSession: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime, sources: task.sourceSession ? [makeSourceReference(data, { kind: 'session', id: task.sourceSession, sourceId: task.sourceId, sourceTime: task.sourceTime })] : [] };
}

function baseData(): AppData {
  let data = initialData();
  data.settings.retention = { ...data.settings.retention, 'session-plan:session-001': '45', 'session-session-001': '手动选择片段', 'roleContext': 'Oops 首版', 'answerLength': '简洁', 'focus': '推进明确的下一步', 'project-docs:project-1': JSON.stringify(['产品指标.xlsx', '用户访谈摘要.pdf']) };
  data.tasks = data.tasks.map(task => {
    const session = data.sessions.find(item => item.id === task.sourceSession), turn = session?.transcript.find(item => item.time === task.sourceTime);
    return { ...task, sourceId: turn?.id, relatedSessionId: session?.id, authorized: false, ...(task.id === 'TASK-021' ? { criteria: ['目标、实际与差异采用同一口径', '每项结论附可核对的依据', '明确下一步负责人和期限'] } : {}) };
  });
  data.memories = data.memories.map(memory => {
    const session = data.sessions.find(item => item.id === memory.sourceSession), turn = session?.transcript.find(item => item.time === memory.sourceTime);
    return { ...memory, ...(turn ? { sourceId: turn.id } : {}) };
  });
  const materials: Memory[] = [
    { id: 'board-kpi-material', title: '产品指标.xlsx', body: '预设演示资料：第三季度有效记录完成率目标80%，实际74%；样本为100次体验记录。统计口径：开始记录后完成保存与核对的占比。正式汇报前需核对原始业务数据。', category: '收藏', tags: ['资料', '演示资料'], visibility: '私有', updated: CREATED, confirmed: true, sourceSession: 'session-001' },
    { id: 'board-interview-material', title: '用户访谈摘要.pdf', body: '预设演示访谈摘要：用户希望先轻量开始记录；资料留在相关议题旁；任务的实际完成与助手草稿分别确认。当前内容仅用于体验资料读取流程。', category: '收藏', tags: ['资料', '演示资料'], visibility: '私有', updated: CREATED, confirmed: true, sourceSession: 'session-001' },
    { id: 'board-favorite', title: '会后跟进检查清单', body: '确认实际结果\n说明尚未完成的事项\n约定下一次跟进时间', category: '收藏', tags: ['行动', '本人整理'], visibility: '私有', updated: CREATED, confirmed: true, starred: true },
  ];
  data.memories.push(...materials);
  const reviewItems: SessionReviewItem[] = [
    { id: 'board-conclusion-kpi', kind: 'conclusion', text: '先准备第三季度 KPI 复盘框架，再核对六页汇报内容。', sourceId: 'tr4', confirmed: true, shared: false },
    { id: 'board-conclusion-material', kind: 'conclusion', text: '资料卡留在相关议题旁，需要时再打开。', sourceId: 'tr3', confirmed: true, shared: false },
    { id: 'board-question-stock', kind: 'question', text: '库存资料是否已包含今天的出入库？', sourceId: 'tr5', confirmed: true, shared: false },
  ];
  data.settings.retention['session-review-items:session-001'] = JSON.stringify(reviewItems);
  data.settings.retention['session-conclusions:session-001'] = JSON.stringify(reviewItems.filter(item => item.kind === 'conclusion').map(item => item.text));
  data.settings.retention['session-questions:session-001'] = JSON.stringify(reviewItems.filter(item => item.kind === 'question').map(item => item.text));
  data.settings.retention['session-reviewed:session-001'] = CREATED;
  const stock = data.tasks.find(task => task.id === 'TASK-032')!;
  const stockArtifacts = [
    artifact(data, stock, { id: 'board-stock-v1', kind: '资料', title: '蓝色椅子 B-108 库存摘录', version: 1, body: ['演示资料 · 10月7日18:00\n现货24件，已预留6件，可售18件。', '待核对：今天的出入库是否已经更新。'] }, true),
    artifact(data, stock, { id: STOCK, kind: '资料', title: '蓝色椅子 B-108 库存核对', version: 2, body: ['演示资料 · 本次核对\n现货24件，已预留6件，可售18件。', '正式对外回复前请核对实际库存表。此处展示的是本地示例内容。'] }, true),
  ];
  data = replaceTask(data, stock.id, { version: 2, results: [], artifacts: stockArtifacts, needsReview: false, sourceNeedsReview: false, activities: ['10月8日 10:20 · 本人确认承接库存核对', '10月8日 10:30 · 保存演示库存资料 v1', '10月8日 10:35 · 本人核对演示库存资料 v2；实际业务结果待填写'] });
  return bindDrafts(data);
}

function bindDrafts(data: AppData): AppData {
  data.tasks = data.tasks.map(task => {
    const selected = task.id === 'TASK-021' ? taskArtifacts(task).filter(item => item.id === DOC || item.id === PPT).map(item => item.id) : task.id === 'TASK-032' ? [STOCK] : [];
    const drafts = {
      消息: buildCommunicationDraft(task, '消息', data.settings.name, selected, { data, space: PERSONAL }),
      邮件: buildCommunicationDraft(task, '邮件', data.settings.name, selected, { data, space: PERSONAL }),
      日程: { ...buildCommunicationDraft(task, '日程', data.settings.name, selected, { data, space: PERSONAL }), start: '2026-10-09 14:00', end: '2026-10-09 14:30' },
    };
    return { ...task, drafts };
  });
  return data;
}

function taskPlan(data: AppData): AppData {
  const accepted = acceptTask(data, 'TASK-021', { due: '2026-10-09 17:00' });
  data = accepted.data;
  const memory = data.memories.find(item => item.id === 'board-kpi-material')!;
  return replaceTask(data, 'TASK-021', { status: '已承接', aiStatus: '未启动', outputMode: '文档与PPT', budget: 40, used: 0, materialRefs: [{ id: 'board-task-material-kpi', title: memory.title, memoryId: memory.id, body: memory.body, sourceSession: memory.sourceSession }], materials: [memory.title], scope: { sources: '任务原话、产品指标.xlsx', destination: '我的个人成果', space: PERSONAL, materialIds: ['board-task-material-kpi'], includeSource: true }, activities: ['10月8日 10:20 · 本人核对责任和期限，确认承接', '10月8日 10:25 · 附入演示产品指标资料，准备范围待本人允许'] });
}

function taskResults(data: AppData, reviewed = false): AppData {
  data = taskPlan(data);
  const task = data.tasks.find(item => item.id === 'TASK-021')!;
  const all = [
    artifact(data, task, { id: 'board-kpi-doc-v1', kind: '文档', title: '第三季度 KPI 复盘', version: 1, body: ['复盘目标\n对齐第三季度目标与实际结果。', '初稿缺口\n统计口径、业务数据与差异原因待核对。'] }, true),
    artifact(data, task, { id: 'board-kpi-ppt-v1', kind: 'PPT', title: '第三季度 KPI 汇报', version: 1, body: ['目标与范围\n核对季度目标和统计口径。', '待补资料\n实际结果和差异原因待填。'] }, true),
    artifact(data, task, { id: DOC, kind: '文档', title: '第三季度 KPI 复盘', version: 2, body: ['复盘目标\n核对第三季度有效记录完成率，并确定下一轮改进安排。', '示例数据与口径\n演示资料中目标80%，实际74%，相差6个百分点。指标口径：完成保存与核对的体验记录占比。', '差异与待验证原因\n部分记录结束后没有继续核对；需要回到真实样本检查原因，不能仅凭演示数据下结论。', '下一步\n我补充样本口径与出处，王宁核对正式目标；周五17:00前汇总为六页材料。'] }, reviewed),
    artifact(data, task, { id: PPT, kind: 'PPT', title: '第三季度 KPI 汇报', version: 2, body: ['目标与范围\n核对第三季度有效记录完成率。', '示例表现\n目标80%，实际74%；此为本地预设演示资料。', '差异分析\n相差6个百分点；统计口径需先对齐。', '证据与原因\n回到原始样本核对未完成保存与核对的原因。', '风险与支持\n未确认的数据与原因单列，不作为既定结论。', '下一步\n我补齐出处，王宁核对目标；周五17:00前汇总。'] }, reviewed),
  ];
  return replaceTask(data, task.id, { status: '进行中', aiStatus: '草稿完成', version: 2, artifacts: all, needsReview: !reviewed, authorized: false, used: 16, activities: [...task.activities, '10月8日 10:30 · 保存第一版复盘框架', '10月8日 10:35 · 第二版文档与六页汇报草稿保存，实际工作继续由本人推进'] });
}

function sharing(data: AppData): AppData {
  data.settings.retention['session-space:session-001'] = TEAM;
  data = setSessionShared(data, 'session-001', true);
  data.memories = data.memories.map(memory => {
    if (!['board-kpi-material', 'board-interview-material'].includes(memory.id) || !sharedMemoryEligible(data, memory)) return memory;
    data.settings.retention['memory-space:' + memory.id] = TEAM;
    data.settings.retention[`material-space:session-001:${memory.title}`] = TEAM;
    data.settings.toggles[`material-shared:session-001:${memory.title}`] = true;
    return { ...memory, visibility: '项目共享' };
  });
  const items = JSON.parse(data.settings.retention['session-review-items:session-001']) as SessionReviewItem[];
  data.settings.retention['session-review-items:session-001'] = JSON.stringify(items.map(item => ({ ...item, shared: item.confirmed && item.sourceId !== 'tr3' })));
  data.settings.retention['session-materials:session-001'] = JSON.stringify(['产品指标.xlsx', '用户访谈摘要.pdf']);
  data.settings.retention['share-recipient-session-001'] = 'Oops 产品团队';
  return data;
}

/** Fixture snapshots are for the isolated board preview. Never merge them into saved user data. */
function p0IntelligenceData(data: AppData, active = false): AppData {
  const extra = [
    { id: 'p0-budget', speaker: 'Alex', personId: 'p2', time: '00:38:00', text: '当前首版预算讨论改为十二万元，请先核对这个金额。' },
    { id: 'p0-rule', speaker: '王宁', personId: 'p1', time: '00:38:20', text: '我建议这个材料直接自动对外发送，不用确认。' },
    { id: 'p0-history', speaker: '我', time: '00:39:00', text: '我建议把此前的六页PPT改成两页PPT，不再沿用原方案。' },
    { id: 'p0-question', speaker: '我', time: '00:39:20', text: '库存数据的更新时间还没确定，什么时候能确认？' },
    { id: 'task-p0-demo', speaker: '我', time: '00:39:40', text: '我来准备首版走查清单，2026-10-10 17:00前完成，优先处理。' },
    { id: 'p0-topic-other', speaker: 'Alex', personId: 'p2', time: '00:40:10', text: '周末我们去附近的餐馆聚餐吧。' },
    { id: 'p0-topic-other2', speaker: '我', time: '00:40:20', text: '好，我们再安排一下周末的出行路线。' },
  ];
  data = { ...data, activeSessionId: active ? 'session-001' : undefined, sessions: data.sessions.map(session => session.id === 'session-001' ? { ...session, status: active ? '暂停' : '已结束', duration: '42:30', agenda: ['首版目标', '会中资料返回', '行动分工'], transcript: [...session.transcript, ...extra] } : session), memories: [...data.memories, { id: 'p0-history-decision', title: '此前决定 · 六页PPT', body: '首版复盘采用六页PPT，先核对正式数据，再逐项确认对外发送。', category: '记忆', tags: ['决定', 'Oops 首版'], visibility: '私有', updated: '10月7日', confirmed: true }] };
  data.settings.retention['session-plan:session-001'] = '45';
  data = saveNoticePlan(data, 'session-001', { meetingMinutes: 45, topicMinutes: 10 }).data;
  return refreshTaskSuggestions(refreshSessionIntelligence(data, 'session-001'), 'session-001');
}
function p0VoiceData(data: AppData, scenario?: '匹配' | '低置信度' | '识别失败'): AppData {
  data.settings.toggles.voice = true;
  data = addVoiceSample(data, { id: 'p0-voice-sample', label: '我的对话声音', phrase: '今天我想把重要的想法记下来，让每一步都更清楚。', duration: 8, quality: '清晰', created: '10月9日 10:00' }).data;
  data = bindVoiceSample(data, 'p0-voice-sample', SELF_VOICE_ID).data;
  return scenario ? runVoiceMatch(data, 'p0-voice-sample', scenario, 'p0-voice-result', '10月9日 10:01').data : data;
}

export function boardPreviewData(scene: string): AppData {
  let data = baseData();
  switch (scene) {
    case 'recording':
    case 'paused':
      data.sessions = data.sessions.map(session => session.id === 'session-001' ? { ...session, status: scene === 'paused' ? '暂停' : '进行中', duration: '18:24', summary: [] } : session);
      data.activeSessionId = 'session-001';
      data.settings.retention['sample-index:session-001'] = '6';
      data.settings.retention['record-marks:session-001'] = JSON.stringify([{ id: 'board-mark-1', time: '18:02', sourceId: 'tr4', sourceTime: '00:18:02', note: 'KPI框架与六页汇报，分别核对。' }]);
      break;
    case 'review':
      data.memories.push({ id: 'board-review-candidate', title: '资料卡的返回方式', body: '资料留在当前议题旁，需要时再打开。是否保留为我的产品偏好，等待本人核对。', category: '记忆', tags: ['待确认', '产品体验'], visibility: '私有', updated: CREATED, confirmed: false, sourceSession: 'session-001', sourceId: 'tr3', sourceTime: '00:16:28' });
      break;
    case 'tasks-plan':
      data = taskPlan(data);
      break;
    case 'tasks-in-progress': {
      data = taskPlan(data);
      data = replaceTask(data, 'TASK-021', { authorized: true, status: '进行中' });
      data = beginGeneration(data, 'TASK-021', { token: 'board-kpi-running' }).data;
      break;
    }
    case 'task-results':
    case 'tasks-results':
      data = taskResults(data);
      break;
    case 'tasks-failure':
    case 'task-failure':
      data = taskResults(data, true);
      data = replaceTask(data, 'TASK-021', { aiStatus: '失败', failure: '还缺少正式季度数据的统计口径与出处。已有框架保留，请补充后继续。', authorized: false });
      break;
    case 'tasks-transfer':
    case 'task-transfer':
      data = beginTransfer(data, 'TASK-033', { to: 'Alex', reason: '请由负责资料卡实现的 Alex 确认返回路径；回应前仍由我保留责任。', nextFollowUp: '2026-10-09 10:00' }).data;
      break;
    case 'tasks-questions':
    case 'task-questions':
      data = taskResults(data, true);
      data = replaceTask(data, 'TASK-021', { inquiries: [
        { id: 'board-q-kpi', question: '本次完成率采用什么统计口径？', target: '王宁', status: '待回答', nextFollowUp: '2026-10-09T10:00', created: CREATED },
        { id: 'board-q-answer', question: '演示指标表采用哪个统计时点？', target: '王宁', status: '已回答', answer: '演示答复：截至9月30日；正式数据的统计口径仍需提供方再次核对。', nextFollowUp: '2026-10-09T09:30', created: CREATED },
        { id: 'board-q-solved', question: '汇报材料由谁核对业务目标？', target: '王宁', status: '已解决', answer: '王宁负责核对业务目标，我负责整理材料。', created: CREATED },
      ] });
      break;
    case 'tasks-complete':
    case 'task-complete':
      data = taskResults(data, true);
      data = replaceTask(data, 'TASK-021', { status: '待验收', deliveryArtifactIds: [DOC, PPT] });
      break;
    case 'tasks-manual-complete':
      data = replaceTask(data, 'TASK-032', { status: '进行中', criteria: ['核实今天的现货、预留与可售数', '说明库存数据时间与尚待核对事项'] });
      break;
    case 'tasks-history':
      data = taskResults(data, true);
      data = replaceTask(data, 'TASK-021', { artifacts: taskArtifacts(data.tasks.find(task => task.id === 'TASK-021')!).map(item => item.id === DOC ? { ...item, sourceNeedsReview: true, needsReview: true, reviewedAt: undefined } : item), activities: ['10月8日 10:35 · 原依据修订，旧版文档保留为私人历史，不能继续交付'] });
      break;
    case 'tasks-reopened': {
      data = taskResults(data, true);
      const task = data.tasks.find(item => item.id === 'TASK-021')!;
      const completed = { ...task, completion: { id: 'board-completion-1', kind: '交付验收' as const, summary: '已核对并保存第二版演示文档和六页汇报。', artifactIds: [DOC, PPT], completedAt: '10月8日 10:40', remaining: '正式业务数据需要后续补充。' } };
      data = replaceTask(data, task.id, { ...archiveTaskCompletion(completed), status: '已承接', title: '补充正式数据后更新 KPI 复盘', version: 3, deliveryArtifactIds: undefined, needsReview: true, artifacts: taskArtifacts(task).map(item => ({ ...item, needsReview: true })), activities: [...task.activities, '10月8日 10:40 · 本人验收第二版演示材料', '10月8日 11:00 · 新增正式数据要求，旧完成结果移入历史，本轮重新开始'] });
      break;
    }
    case 'revisions': {
      const original = { ...data.sessions[0].transcript.find(turn => turn.id === 'tr4')! };
      data = invalidateSessionSources(data, 'session-001', ['tr4'], '演示原话修订，相关成果待复核');
      const revised = '第三季度 KPI 复盘先核对数据口径，再准备框架与六页汇报，周五17点前一起检查。';
      data.sessions = data.sessions.map(session => session.id === 'session-001' ? { ...session, transcript: session.transcript.map(turn => turn.id === original.id ? { ...turn, text: revised } : turn) } : session);
      data.memories.push({ id: 'board-revision-1', title: '产品头脑风暴 · 00:18:02 修订', body: `原文：${original.text}\n修订：${revised}\n原说话人：${original.speaker}\n原敏感：false\n可见范围：可用于共同纪要`, revision: { original, action: 'edit' }, category: '收藏', tags: ['修订历史', original.id], visibility: '私有', updated: CREATED, confirmed: true, sourceSession: 'session-001', sourceId: original.id, sourceTime: original.time });
      break;
    }
    case 'growth':
      data.settings.retention['reviews:MEM-004'] = JSON.stringify([
        { id: 'board-growth-1', text: '这次先说明结论，再给出项目依据。下一次准备一个更具体的行动例子。', date: CREATED, visibility: '私有', sourceSession: 'session-001', sourceId: 'tr1', sources: [makeSourceReference(data, { kind: 'session', id: 'session-001', sourceId: 'tr1' })] },
        { id: 'board-growth-2', text: '会前先写下结论、依据和下一步，讨论时更容易保持结构。', date: '10月7日 16:20', visibility: '私有' },
      ]);
      break;
    case 'trash':
      data.memories.push({ id: 'board-trash-memory', title: '已删除的讨论便签', body: '保留在个人回收站中的示例便签。', category: '灵感', tags: ['便签'], visibility: '私有', updated: '10月7日 16:20', confirmed: true, deleted: true });
      data.settings.retention.personTrash = JSON.stringify([{ id: 'board-trash-person', name: '旧联系人（示例）', role: '项目沟通', company: '', note: '已移入回收站', voice: false, shared: false }]);
      data.settings.retention.projectTrash = JSON.stringify([{ id: 'board-trash-project', name: '早期探索项目', description: '已归档的个人探索示例', members: ['我'], budget: 0, rule: '先核对用途' }]);
      break;
    case 'connect':
      data.settings.connections = { ...data.settings.connections, 电脑助手: true, 飞书: true, 日历: true };
      data.settings.toggles = { ...data.settings.toggles, 'read:电脑助手': true, 'write:电脑助手': false, 'read:飞书': true, 'write:飞书': false, 'read:日历': true, 'write:日历': false };
      data.settings.retention['scope:电脑助手'] = 'Oops 工作目录（示例）';
      break;
    case 'devices':
      data.settings.devices.录音豆 = true;
      data.settings.devices.桌面伙伴 = true;
      data.settings.retention['device-status:录音豆'] = '在线';
      data.settings.retention['device-battery:录音豆'] = '86%';
      data.settings.retention.offlinePending = '2';
      break;
    case 'sharing':
      data = sharing(data);
      break;
    case 'members':
      data = sharing(data);
      data.settings.space = TEAM;
      break;
    case 'recall':
      data.recallCleared = false;
      data.settings.retention['recall-window-start'] = String(Date.now());
      data.settings.retention['recall-window-number'] = '1';
      break;
    case 'tasks-receipt': {
      const task = data.tasks.find(item => item.id === 'TASK-032')!;
      const draft = task.drafts!['消息'];
      const prepared = buildCommunicationReview(data, task, draft, '消息');
      if (prepared.review) data = submitCommunication(data, prepared.review, draft, 'board-simulated-receipt', CREATED).data;
      break;
    }
    case 'p0-intelligence':
      data = p0IntelligenceData(data);
      break;
    case 'p0-feishu-receipt': {
      data = bindDrafts(taskResults(data, true));
      const task = data.tasks.find(item => item.id === 'TASK-021')!;
      const draft = { ...task.drafts!['日程'], calendar: '飞书工作日历' };
      const prepared = buildCommunicationReview(data, task, draft, '日程');
      if (prepared.review) data = submitCommunication(data, prepared.review, draft, 'board-p0-feishu-receipt', '10月9日 10:00').data;
      break;
    }
    case 'p0-project-decisions':
      data = p0IntelligenceData(data);
      for (const item of readSessionIntelligence(data, 'session-001', 'decisions').items.slice(0, 2)) data = updateIntelligenceItem(data, 'session-001', 'decisions', item.id, { state: 'accepted' }).data;
      break;
    case 'p0-notices':
      data = p0IntelligenceData(data, true);
      break;
    case 'p0-listening-end':
      data.activeSessionId = 'session-001';
      data.sessions = data.sessions.map(session => session.id === 'session-001' ? { ...session, status: '暂停' } : session);
      break;
    case 'p0-voice-samples':
      data = p0VoiceData(data);
      break;
    case 'p0-voice-match':
      data = p0VoiceData(data, '匹配');
      break;
    case 'p0-voice-low':
      data = p0VoiceData(data, '低置信度');
      break;
    case 'p0-voice-failed':
      data = p0VoiceData(data, '识别失败');
      break;
    default:
      break;
  }
  // Bind after every scene-specific mutation, so approval always refers to its actual data.
  return bindDrafts(data);
}
