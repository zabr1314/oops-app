# Oops App P0 前端覆盖与验收

更新：2026-10-09。按用户原始 15 项 P0 核对当前页面、输入、结果和状态；15 项均有可操作的前端流程。

本清单只验收页面前端：声音、识别、理解和提醒使用示例输入或本地规则，内容保存于当前浏览器，未连接真实麦克风、模型、账号、日历或硬件服务。

## 验收方式

- 从页面入口连续操作，不把菜单名称或保存开关单独视为完成流程。
- 会话、人物、项目和任务详情需绑定实际对象 ID；示例可用 `session-001`、`p1`、`project-1`、`TASK-021`。新建对象以实际创建出的 ID 为准。
- Route 使用 `{ view, id?, mode? }`；例如 `{ view: "memory-project", id: "project-1", mode: "决定" }` 和 `{ view: "tasks", mode: "project:Oops 首版" }`。
- 在“我的空间”先核对完整流程，再验证明确共享与撤回后的团队可见范围。需要提醒情境时可用文字导入／修订设置实际原话、议程及项目规则。
- 状态直达示例及具体参数记录在 JSON 的 `routeExamples`；例如唤醒未匹配为 `{ view: "session-listening", mode: "wake-missed" }`。

## 逐项覆盖

### 1. Listen · 智能聆听（已覆盖）

**入口：** 首页“智能聆听”，或会话 → 开始记录 → 智能聆听；我的 → 聆听设置。  
**路由：** `session-mode`、`session-listening`、`settings-listening`、`session-detail`、`session-transcript`。

**输入：** 开始、暂停、继续、结束记录；示例声音输入；唤醒词、有效对话时长、静默时长、开始／结束方式、安静时段、保存范围。

**结果：** 连续出现带时间和发言标签的文字，形成独立会话；有效对话或唤醒后开始记录；静默后进入结束保存核对；选择原话及私人便签的保留范围。

**已覆盖状态：** 待机；检测中；有效对话；不确定待核对；环境声不保留；唤醒成功／不匹配；安静时段；进行中／暂停；静默结束建议；取消结束恢复原状态；会话已保存。

**建议验收操作：**

1. 体验有效对话、不确定对话和环境声；确认或丢弃，并纠正一次环境声判断。
2. 更换唤醒词后体验唤醒；取消一次唤醒。
3. 将开始方式设为自动，体验有效对话后检查当前会话；体验静默结束，先取消，再选择保留片段并保存。

**代码依据：** `src/features/Listening.tsx: ListeningExperience / ListeningSettings`；`src/listeningLogic.ts: judgeListeningSignal / startListeningSession`；`src/features/Sessions.tsx: useSessionRecorder`；`src/features/RecordingControls.tsx: RecordingControls / EndRecordingDialog`。

### 2. ID · 身份识别（已覆盖）

**入口：** 会话原文 → 选择发言 → 确认说话人；我的 → 我的声音身份；人物详情 → 管理声音样本与关联。  
**路由：** `session-transcript`、`session-identity`、`settings-voice`、`settings-voice-identities`、`settings-voice-match`、`memory-person`。

**输入：** 按带时间的发言标签选择片段或同一匿名标签，选择确切人物卡或填写姓名；本人知情登记、示例声音采集、身份关联；单独确认声音许可；识别场景、人工核对／改正目标、保持匿名、解绑或删除样本。

**结果：** 仅选定发言关联人物 ID，人物详情显示确切对话；声音样本关联本人或姓名已确认的联系人，输出匹配结果与置信度；纠正后使用新关联。

**已覆盖状态：** 姓名待核对／已确认；登记待确认／录入失败／已完成示例；样本待关联／已关联／许可需核对；已匹配／待确认／识别失败／已纠正／保持匿名；解绑后待核对；关闭声音许可保留姓名。

**建议验收操作：**

1. 确认一段匿名发言，检查同名的其他人物或未选择片段未被自动关联。
2. 完成本人登记，保存样本并明确关联；分别体验匹配、低置信度和识别失败。
3. 将一条识别结果改正为另一位已确认联系人，再解绑；关闭该人的声音许可，检查旧结果回到待核对。

**代码依据：** `src/features/Sessions.tsx: Identity`；`src/features/MemorySettings.tsx: VoiceEnrollment / PersonDetail`；`src/features/VoiceIdentity.tsx: VoiceIdentitySamples / VoiceIdentityMatch`；`src/voiceIdentityLogic.ts: bindVoiceSample / runVoiceMatch / resolveVoiceMatch / revokeContactVoice`。

### 3. Memory · 个人记忆（已覆盖）

**入口：** 我的 → 身份与角色／助理偏好；记忆 → 记忆／成长。  
**路由：** `settings-identity`、`settings-preferences`、`memory`、`memory-edit`、`memory-candidate`、`memory-conflict`、`memory-goals`、`memory-goal`。

**输入：** 称呼、当前职位／角色、其他角色、适用场景；回答方式、回答长度、关注重点和边界偏好；记忆标题／正文／标签、成长目标、私人复盘；逐条核对候选与来源。

**结果：** 保存当前身份和助理偏好；角色变动形成待核对背景；确认后的记忆可用于建议；明确更新旧角色时保留私有历史；目标保存状态和复盘。

**已覆盖状态：** 待核对／可用／已停用；角色变化待核对；冲突比较／保留旧版本；目标进行中／已暂停／已完成；私有／明确共享；回收站／恢复／永久删除。

**建议验收操作：**

1. 保存新角色并比较变化，先不确认，再明确更新旧背景，检查当前角色记忆与旧历史。
2. 新增目标和私人复盘；切换目标状态；修改偏好后打开问答或个人结果检查输出变化。
3. 从会话留一条候选，修改后确认；停用和删除一次，检查建议入口不再引用。

**代码依据：** `src/features/MemorySettings.tsx: Identity / Preferences / MemoryReview / GrowthDetail`；`src/features/MemorySettings.tsx: saveIdentityBackground / confirmMemoryReview`。

### 4. Memory · 项目记忆（已覆盖）

**入口：** 记忆 → 项目 → 项目详情 → 概览／决定／任务／会话。  
**路由：** `memory-projects`、`memory-project`、`memory-project-edit`、`sessions`、`tasks`、`session-review-edit`、`memory-detail`。

**输入：** 项目名称、背景、成员、预算与规则；关联项目的会话；会话决定采纳或人工确认；任务状态筛选；私人项目资料条目。

**结果：** 按真实项目关联汇总历史会话、确认决定、待推进任务和重要信息；决定可打开原话或会后结果；任务按钮仅显示该项目工作；当前空间只显示获准内容。

**已覆盖状态：** 概览／决定／任务／会话；已确认决定／无可汇总决定；任务进行中／已结束／全部；来源需核对；当前可见／已归档会话；无关联内容／不在当前空间。

**建议验收操作：**

1. 将会话关联项目并确认决定，回项目决定分栏查看内容与原话。
2. 打开项目待办并切换状态；新建另一个项目的任务，检查它不进入本项目列表。
3. 共享一段非敏感依据及决定，在团队空间查看；撤回共享或改动原话，检查旧内容不继续共同展示。

**代码依据：** `src/features/MemorySettings.tsx: ProjectDetail / ProjectEditor`；`src/projectMemoryLogic.ts: projectMemorySummary`；`src/features/Tasks.tsx: TaskList project filter`。

### 5. Reason · 对话理解（已覆盖）

**入口：** 会话现场／概览 → 对话理解。  
**路由：** `session-detail`、`session-understanding`、`session-transcript`。

**输入：** 本次有效原话、议程、项目上下文；更新整理；编辑理解内容。

**结果：** 分别显示当前议题、讨论人物、正在推进的事、表达意图和关联上下文；卡片可查看原话／项目依据，并保存本人修正。

**已覆盖状态：** 未有可用原话；已有整理结果；待核对；已修正；来源变化待重新整理。

**建议验收操作：**

1. 打开有原话的会话并更新整理，逐张打开议题、人物、事件、意图和上下文依据。
2. 修正一张卡片，再返回；改动它的来源原话，检查旧结果提示需要重新整理。

**代码依据：** `src/features/SessionIntelligence.tsx: SessionIntelligence understanding branch`；`src/sessionIntelligenceLogic.ts: understanding / intelligenceItemAvailable / updateIntelligenceItem`。

### 6. Reason · 任务识别（已覆盖）

**入口：** 会话 → 行动 → 识别到的任务建议；或对话理解 → 接着核对 → 任务建议；会话工具 → 任务建议。  
**路由：** `session-task-suggestions`、`session-detail`、`session-understanding`、`session-transcript`、`session-identity`、`task-detail`、`task-edit`、`task-accept`。

**输入：** 本次非敏感且来源有效的行动原话，连续记录时自动更新或手动更新建议；任务标题、确切负责人、截止时间和优先级；核对原话；保存修改、忽略或确认建立任务。

**结果：** 候选卡分别显示事项、负责人、截止／原话期限提示、优先级和原话依据；负责人未明确时保留待确认；逐条确认后建立私有待承接任务，保留确切来源；同一原话已有任务时直接打开现有任务。

**已覆盖状态：** 待确认／已整理／已忽略；已编辑 · 待确认；负责人待确认／姓名先核对；原话未给期限／日期待核对／有效日期／日期错误；高／中／低优先级；已有任务 · 需复核；旧原话变化后候选隐藏待重新整理；无待确认建议。

**建议验收操作：**

1. 在会话行动中打开任务建议，检查每张卡的事项、负责人、截止提示、优先级和原话；对来源明确的候选打开原文上下文。
2. 修改一项标题、负责人、日期和优先级，只保存修改后返回；另忽略一项并从已忽略分栏重新核对。
3. 对负责人未定的候选尝试确认，检查必须明确选择；填写无效日期后检查错误，再正确确认建立。
4. 对同一原话再次更新建议，检查已整理分栏直接打开现有任务；修改、设为敏感或删除来源后检查旧候选不再可用。

**代码依据：** `src/features/TaskSuggestions.tsx: TaskSuggestions`；`src/taskSuggestionsLogic.ts: refreshTaskSuggestions / readTaskSuggestions / saveTaskSuggestionDraft / createTaskFromSuggestion`；`src/features/Sessions.tsx: useSessionRecorder / Sessions / SessionExperience`；`src/features/SessionIntelligence.tsx: understanding task suggestion entry`。

### 7. Reason · 决策识别（已覆盖）

**入口：** 会话现场／概览 → 决定与结论。  
**路由：** `session-decisions`、`session-review-edit`、`session-transcript`、`memory-project`。

**输入：** 含决定、方案或结论的实际原话；采纳、修改、不采纳或手工补充。

**结果：** 分别显示决定建议、方案建议、结论建议；逐条采纳进入本次确认结论；修改后需重新确认；确认结果可在会话及对应项目汇总查看。

**已覆盖状态：** 待核对／已采纳／不采纳；已修正后重新待核对；无决定建议；来源变化待重新整理；未共享的确认结果。

**建议验收操作：**

1. 采纳一项、修改一项、不采纳一项，分别检查三个状态分栏。
2. 修改已采纳内容后重新确认；打开本次结论与项目决定核对一致性。

**代码依据：** `src/features/SessionIntelligence.tsx: decisions branch`；`src/sessionIntelligenceLogic.ts: decisions / updateIntelligenceItem / writeDecisionReview`。

### 8. Notice · 跑题提醒（已覆盖）

**入口：** 会话 → 会议提醒 → 议题偏离。  
**路由：** `session-notices`、`session-agenda`、`session-transcript`。

**输入：** 当前议题、最近讨论原话；重新检查、查看证据、处理或稍后。

**结果：** 当前讨论缺少议题匹配时显示可能偏离，附当前议题和最近原话；可返回议程调整当前议题，并记录本人处理决定。

**已覆盖状态：** 待处理／稍后／已处理／已忽略；移回待处理／重新打开；没有提醒；议题或原话变化后重新检查。

**建议验收操作：**

1. 使当前议题与最近讨论不同，重新检查并查看两侧证据。
2. 稍后处理一次，再移回待处理；标记已处理或忽略后重新打开。

**代码依据：** `src/sessionIntelligenceLogic.ts: notices off-topic / noticeBasis`；`src/features/SessionIntelligence.tsx: notices actions / evidence sheet`。

### 9. Notice · 时间提醒（已覆盖）

**入口：** 会话 → 会议提醒 → 时间与当前议题；议程页可推进议题。  
**路由：** `session-notices`、`session-agenda`。

**输入：** 会议计划时长、每个议题分配时间、当前议题、重新计时选择。

**结果：** 按记录时长显示临近结束／到达结束时间、当前议题超时和仍无讨论依据的事项；提醒可回到议程并标记处理；推进议题重设该议题计时起点。

**已覆盖状态：** 临近结束／已到计划时间；议题超时；仍有未讨论事项；待处理／稍后／已处理／已忽略；时长输入错误；当前无时间提醒。

**建议验收操作：**

1. 缩短计划时间和议题分配时间，重新检查对应时间提醒。
2. 在后段或结束的会议中保留未讨论议题，检查未讨论事项提醒。
3. 推进当前议题并重新计时，检查新议题不沿用上一议题的已用时间。

**代码依据：** `src/features/SessionIntelligence.tsx: meeting time configuration`；`src/sessionIntelligenceLogic.ts: readNoticePlan / saveNoticePlan / beginIntelligenceTopic / notices`。

### 10. Notice · 冲突提醒（已覆盖）

**入口：** 会话 → 会议提醒 → 预算冲突／规则冲突／历史决定。  
**路由：** `session-notices`、`session-reminders`、`session-decisions`、`memory-detail`、`memory-project`。

**输入：** 项目预算、对外操作规则、已确认历史决定；本次涉及金额、操作或变更的原话。

**结果：** 并列显示本次提议与预算／规则／历史决定依据；可进入金额核对或决定核对；更新项目预算基准需另行确认。

**已覆盖状态：** 预算／规则／历史决定冲突待核对；本次金额已核对；忽略本轮金额提醒；项目基准更新确认；待处理／稍后／已处理；历史来源变化待重新检查。

**建议验收操作：**

1. 输入超出项目预算的明确金额，查看提醒与金额原话；核对本次金额，再单独确认是否更新项目基准。
2. 用与对外确认规则相反的提议检查规则提醒；修改涉及已有决定的讨论后检查历史依据。

**代码依据：** `src/sessionIntelligenceLogic.ts: notices budget-conflict / rule-conflict / history-conflict`；`src/features/Sessions.tsx: MeetingTools session-reminders`。

### 11. Notice · 遗漏提醒（已覆盖）

**入口：** 会话 → 会议提醒 → 结论遗漏。  
**路由：** `session-notices`、`session-review-edit`、`task-detail`、`task-ask`。

**输入：** 含问题或待确认表达的原话；本次已确认结论；关联待办。

**结果：** 未有对应确认结论的问题形成提醒，保留原话和结论缺口证据；有有效关联任务时进入任务跟进，否则进入本次结论补充。

**已覆盖状态：** 重要问题仍无确认结论；待处理／稍后／已处理／已忽略；重新打开；补充结论后重新检查；关联内容变化需重新检查。

**建议验收操作：**

1. 留下带问号或待确认的原话且不确认结论，重新检查结论遗漏。
2. 进入补充结论或有效任务，完成核对后返回检查；将提醒标为已处理。

**代码依据：** `src/sessionIntelligenceLogic.ts: notices unresolved / intelligenceActionRoute`；`src/features/SessionIntelligence.tsx: evidence and action handling`。

### 12. Recall · AI 问答：当前与历史记忆（已覆盖）

**入口：** 首页“问 Oops”／“问已有记录”；会话历史查询；问答中可切换语音输入。  
**路由：** `assistant`、`voice`、`session-history`、`session-transcript`、`memory-detail`、`task-edit`、`memory-candidate`。

**输入：** 文字问题或核对后的示例语音文字；使用已保存背景开关；当前／历史会话名或原话关键词，以及任务、预算、角色、偏好等问题。

**结果：** 显示回答或匹配原话与可点击出处；找不到依据时显示空结果；回答可明确形成待办或留为私人候选；来源变化后旧回答不再提供内容。

**已覆盖状态：** 输入／示例语音识别／文字核对；正在整理；回答有来源／无可引用内容；已保存背景关闭；旧回答来源失效；已有同回答待办防重复。

**建议验收操作：**

1. 分别问当前会话、历史会话和已确认记忆中的关键词，打开回答来源。
2. 关闭背景开关后提问；搜索无匹配内容；修改回答来源后检查旧回答失效。
3. 把有依据的回答形成待办或留下候选，确认引用保留且候选没有直接成为事实。

**代码依据：** `src/features/Home.tsx: Assistant / Voice / buildLocalAnswer`；`src/features/Sessions.tsx: HistoryQuestion`；`src/sourceAccess.ts: messageAvailable`。

### 13. Action · 会议生成个人 Todo（已覆盖）

**入口：** 会议 → 行动 → 识别到的任务建议 → 核对并整理；确认本人负责后进入我的待办。  
**路由：** `session-task-suggestions`、`session-detail`、`session-transcript`、`task-detail`、`task-accept`、`task-edit`、`tasks`、`task-progress-note`、`task-complete`。

**输入：** 会议中持续出现的行动发言；自动候选或手动选择的实际原话；核对具体事项、本人负责人、截止和优先级，明确确认建立并承接。

**结果：** 会议原话自动整理为任务候选；选择本人并确认后建立私人待承接 Todo，保留精确原话及会话关联；承接后进入本人待办，后续记录实际进展和完成结果；助手授权单独处理，重复来源复用原任务。

**已覆盖状态：** 候选待确认／已整理／已忽略；负责人未定不能直接建立；待承接／已承接／进行中／已完成；已拒绝／已取消；来源变化待核对；同来源已有行动；本人创建免重复承接；助手未启动与业务状态分开。

**建议验收操作：**

1. 新建会议记录，等待行动发言并打开任务建议；核对后选择“我”为负责人，确认建立，再承接，检查我的待办与精确原话。
2. 再从同一发言核对建议，检查直接复用已有任务；忽略未采纳候选不会建立 Todo。
3. 记录进展，再填写实际完成结果；检查草稿或助手状态没有自动等同业务完成。
4. 修改原话并回到任务，检查来源复核和旧授权撤回。

**代码依据：** `src/features/Sessions.tsx: useSessionRecorder / SessionExperience task()`；`src/features/TaskSuggestions.tsx: TaskSuggestions`；`src/taskSuggestionsLogic.ts: createTaskFromSuggestion / existingTask`；`src/features/Tasks.tsx: TaskList / Accept / ProgressNote / Complete`；`src/taskWorkflow.ts: acceptTask / createManualCompletion`。

### 14. Action · 日程创建：Calendar／飞书（已覆盖）

**入口：** 任务详情 → 更多操作 → 安排跟进日程；我的 → 工具连接。  
**路由：** `task-calendar`、`task-receipt`、`task-detail`、`settings-tools`、`settings-tool`。

**输入：** 参与人、日程标题、开始／结束时间、目标日历（我的工作日历／个人日历／飞书工作日历）、完整议程；实际成果附件版本与本次内容核对；存在时段冲突时调整或明确已处理。

**结果：** 页面按选定目标显示 Calendar 或飞书日程；核对面板固定当次参与人、时间、正文和附件，确认后回执保存实际目标日历；草稿可保存和继续编辑；已有回执不会被后续草稿覆盖，相同确认复用原回执。

**已覆盖状态：** Calendar／飞书日程目标切换；草稿／待本人确认；日期无效或结束早于开始；当前空间时段冲突；附件未应用／草稿版本待核对；来源失效阻止确认；确认面板／模拟完成回执／无回执。

**建议验收操作：**

1. 分别选择“我的工作日历”和“飞书工作日历”，填写参与人、正文和同日有效起止时间，核对后确认创建，检查回执中的实际目标。
2. 再次安排重叠时段，检查冲突；修改正文或附件后检查需要重新核对。
3. 保存草稿后离开并返回；重复确认同一份内容，检查不重复产生回执。

**代码依据：** `src/features/TaskCommunication.tsx: TaskCommunication`；`src/communicationLogic.ts: buildCommunicationReview / visibleCalendarConflicts / submitCommunication`；`src/features/Tasks.tsx: Receipts`。

### 15. Personalization · 个性化 AI：同会议不同个人结果（已覆盖）

**入口：** 我的 → 身份／偏好；同一会话 → 我的结果 → 调整本次关注点。  
**路由：** `settings-identity`、`settings-preferences`、`memory-goal`、`session-personal`、`assistant`。

**输入：** 身份角色、回答方式／长度、关注目标；本次角色和关注重点；更新整理，修正重点／下一步／观察；可标记个人观察。

**结果：** 同一会议按本次角色和重点组织“我的重点、我的待办／下一步、我的观察”；个人问答按已保存偏好组织回答；个人结果独立于共同纪要，并能回到原话及关联任务。

**已覆盖状态：** 私人会后结果；默认档案／本次角色与关注点；输入为空需补充；更新后的不同视角；已修正／个人观察已标记／取消标记；来源或关注点变化需重整；团队入口提示返回个人核对。

**建议验收操作：**

1. 对同一会议先用“产品负责人／首版体验”，再用“项目协调者／预算跟进”保存本次关注点，比较重点及引用。
2. 改变回答方式和长度后提问，检查输出组织变化；修正个人观察并返回检查。
3. 切换团队空间，检查本人的角色偏好和个人复盘未混入共同纪要。

**代码依据：** `src/features/SessionIntelligence.tsx: personal branch / context configuration`；`src/sessionIntelligenceLogic.ts: readPersonalContext / savePersonalContext / personal`；`src/features/Home.tsx: buildLocalAnswer`；`src/features/MemorySettings.tsx: Identity / Preferences`。

## 回归入口

覆盖清单对应源码状态，不代替交互验收结果。可复用现有 `tests/listening-p0.test.mjs`、`tests/p0-intelligence.test.mjs`、`tests/p0-memory-voice.test.mjs`、`tests/memory-privacy.test.mjs`、`tests/session-regressions.test.mjs` 、`tests/task-flow-regressions.test.mjs` 和 `tests/p0-task-suggestions.test.mjs` 做逻辑回归。页面输入、返回、状态切换及键盘遮挡按上文操作检查。

机器可读清单：`public/p0-coverage.json`。
