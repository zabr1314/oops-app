# 原生 ↔ H5 消息协议

桥只对打包页面的来源 `https://appassets.androidplatform.net` 主框架开放。
H5 用 `window.OopsNative.postMessage(JSON.stringify({type,payload}))` 发送；通过 `OopsNative.onmessage` 接收同形 JSON。桥在 hello 后绑定，页面重载会重新绑定。

## H5 → 原生

| type | payload | 行为 |
|---|---|---|
| hello | {} | 请求完整 snapshot |
| capture.start | {source?:"mic"或"wav"或"remote"} | 请求权限并启动前台收音服务 |
| capture.stop | {} | 停止服务及收音 |
| recall.trigger | {query?:string} | 按钮召回 |
| clip.play | {key,startMs,endMs,sessionId?} | 回听缓存原声；key 标识按钮。带 sessionId 时，本机没有（或不是本场）就从服务器存档取 |
| clip.stop | {} | 停止回听 |
| clip.remote | {key,sessionId,startMs,endMs} | 从服务器存档取一句原声播放（往期会议，或本场录音上传后） |
| speaker.correct | {sessionId,utteranceId,speaker} | 人工改说话人：团队成员、`other`/`multi`/`unclear`，`null` 撤销。本场立即改显示，再写服务器（会议还没同步到服务器时每 25 秒重试，最多 3 次）；往期会议直接写服务器 |
| projects.list | {} | 项目列表 |
| project.open | {name} | 一个项目的会议、已确认决定、任务 |
| meeting.project | {sessionId,project} | 设所属项目，空字符串移出；本场会议还没同步到服务器时每 25 秒重试，最多 3 次 |
| history.rename | {sessionId,title} | 往期会议改名，空字符串恢复自动名称 |
| review.set | {sessionId,utteranceId,fields:{verdict?,owner?}} | 会后核对：是否待办/决定（confirmed/rejected）、负责人；null 清除 |
| tasks.list | {mine,status:"open"/"done"/"all"} | 读飞书任务列表；`mine` 需要设置里选了本人 |
| recall.save | {cardId,utteranceIds,startMs,endMs} | 明确保存原句及可用原声 |
| recall.dismiss | {cardId} | 丢弃卡片 |
| commitment.open | {utteranceId} | 从本场索引打开承诺，进入现有卡片流程 |
| saved.list | {} | 返回长期保存列表 |
| action.draft | {cardId,utteranceIds} | 请求行动草稿，不写入飞书 |
| action.confirm | {draftId,who,what,whenIso,whenRaw,constraint} | 冻结草稿、持久化 op_id、提交确认 |
| action.status | {draftId} | 查询原操作，不重新提交 |
| settings.set | {source,remoteAddress,mockBackend,backendBaseUrl,backendToken?,speakerInfo,selfName?} | 保存；收音中切换音源/远端音频地址立即生效，保留本场缓存 |
| testAudio.pick | {} | 系统文件选择器导入 WAV，持久保留读取权限 |
| testAudio.reset | {} | 恢复内置合成对话 |
| open.url | {url} | 系统打开 HTTP(S) 链接 |
| log | {message} | OopsWeb 调试日志 |

## 原生 → H5

| type | payload |
|---|---|
| snapshot | {state,transcript,summary,team,insets,pendingActions:[{draft,result}]} |
| state | {capturing,sessionId,source,sourceReady,sourceDetail,sessionMs,bufferedMs,retentionMs,asr,asrDetail,level,playing,savedCount,backend,backendUrl,speakerInfo,testWavName,asrGaps,commitmentCount,analysisPending,analysisFailed,tagsSupported,sessionTruncated} |
| insets | {top,bottom} CSS 像素 |
| asr.partial | {text,startMs,endMs} |
| asr.final | {id,text,startMs,endMs,speaker} |
| asr.tag | 定稿句完整记录，增加 tag/tagProb/tagEngine |
| asr.speaker | {id,speaker,score,segments} |
| session.summary | {sessionId,commitments:[定稿句完整记录 + audioExpired]} |
| transcript.pruned | {ids} |
| recall.pending | {trigger} |
| recall.card | {id,trigger,query,nowMs,single,engine,windowMs,latencyMs,items,pool} |
| recall.notFound | {reason} |
| clip.state | {key,state:"playing"/"stopped"/"ended"/"expired"/"loading"/"unavailable"} |
| speaker.corrected | {sessionId,utteranceId,speaker,status:"local"/"saved"}；local 是本机已改，saved 是服务器已保存 |
| tasks.list | `GET /v1/tasks` 的结果，另加 {mine,status} |
| projects.list | {items} |
| project.open | `GET /v1/projects/{名称}` 的结果 |
| meeting.project | {session_id,project} |
| history.renamed | {session_id,title,title_source} |
| review.saved | {sessionId,utteranceId,review} 服务器已保存的核对 |
| recall.saved | {cardId,savedCount} |
| action.draft | {draftId,cardId,who,what,whenIso,whenRaw,constraint,assigneeCandidates,evidence} |
| action.result | {draftId,opId,status,taskGuid,taskUrl,message,readBackConfirmed,polling,mock} |
| saved.items | {items} 元数据采用存储的 snake_case |
| latency | {recentMs,medianMs} |
| toast | {message} |
| error | {scope,message} |

items 含候选 id/text/startMs/endMs/speaker/prob；pool 含时间排序的候选及邻句。
evidence 为 {utteranceIds,quote,startMs,endMs}。所有时间是会话毫秒。

定稿句完整记录还包括 `words:[{text,startMs,endMs}]` 与 `segments:[{startMs,endMs,text,speaker,score,source,approx}]`；桥使用 camelCase，HTTP 使用 snake_case。segments 只接收经后端独立验收的结果，文字拼接必须等于原句，区间必须连续且覆盖原句。近似段在字幕中显示浅色提示，不能用于 self 自动填人。`tagsSupported=null` 表示尚未探明支持情况；false 表示本场已停用标签请求。停止收音后在途标签仍会更新汇总，开始新会话后旧结果丢弃。

`sessionId` 变化时清空字幕。snapshot 先清空再回填，防止重复字幕。pending 且 polling=true 表示正在查询；polling=false 表示结果仍未知，可继续查询。mock=true 的成功页明确标识没有真实创建飞书任务；readBackConfirmed 只表示后端查询出了同一 guid。

## 浏览器模拟

bridge-mock.js 只有在原生桥不存在时安装模拟桥，使用 dialog.wav 的句子时间轴，提供 partial/final、两种召回卡片、真实 WAV 回听、localStorage 保存、草稿和复用 op_id 的 pending→created。页面显示“浏览器模拟识别”，所有调用均留在本地。
启动 `python3 -m http.server 8765 --bind 127.0.0.1 --directory android/app/src/main/assets`，进入 `/web/index.html`；测试音频通过 `/test/dialog.wav` 提供。无需前端构建。

`sourceReady` 表示音源已经交付 PCM，且尚未断开。Mac 重连或切换音源时为 false，收到音频后为 true；UI 在 false 时显示「等待收音／等待音源」，不会只因 ASR socket 连接就宣称实时识别。旧音源的状态、音频、错误和标记回调均按具体音源实例过滤，不能影响已切换的新音源。


## App 自助声纹录入

- `voiceprint.list {}`：鉴权获取成员和目录版本。
- `voiceprint.record {name,consent:true,mode:"enroll"|"test"}`：本人同意后，冻结服务客户端与当前音源，录入最多 30 秒／测试最多 10 秒。若未收音，原生请求权限并启用手机麦克风。WAV 音源不能注册。
- `voiceprint.stop {}`：结束录音；录入达到 15 秒后先只读检查音量，测试录音自动匹配。
- `voiceprint.save {}`：质量通过后明确提交保存；保留 sample_id 实现响应丢失后的幂等重试。
- `voiceprint.cancel {}`：清除尚未提交的临时录音，日常收音继续。
- `voiceprint.delete {name,confirm:true}`：再次确认后按目录版本删除。

`state.voiceprint` 含 `phase/name/mode/elapsedMs/source/message/catalog/diagnosis/quality/qualityPassed`；阶段为 idle/loading/recording/checking/review/saving/testing。H5 不获得任何服务访问凭据或 PCM。浏览器 mock 明确不支持录入，不生成虚假声纹。关闭页、停止收音、切换音源或服务器均放弃临时录音；已经提交的保存可能在服务器完成，取消界面不能撤销在途写入。

原生临时声纹缓冲最多 30 秒；没有额外写录音文件。App 正常会话音频仍按既有环形缓存和明确保存规则处理。


### 每句声纹判断状态

定稿句、snapshot 和 asr.tag 增加 speakerState/speakerScore。asr.speaker 增加 speakerState；score 可为 null（没有完成模型计算）。状态有 pending/matched/unconfirmed/too_short/busy/audio_unavailable/unsupported/error。matched 显示已匹配姓名；unconfirmed 显示“声纹未确认”及最高相似度；其他状态显示对应原因。unknown 状态不填候选姓名，也不绕过负责人验收。标签异步更新和页面重载保留已完成的声纹状态。


## 说话人拆分试验（2026-10-07）

settings.set 增加 `speakerPreview`，默认 false；state 增加 `speakerPreviewEnabled/liveSpeakerStatus/liveSpeakers/liveOverlap`。定稿句及 asr.speaker 增加单独 `speakerPreview:{experimental,startMs,endMs,activities,segments,jevUsed}`，内部字段使用 camelCase。H5 开关显示「实时换人拆分与重叠提示（试验）」；滚动提示身份候选/待确认/疑似多人同时说话，定稿按原文词时间显示试验分段。Jev 辅助姓名标为待核对。刷新及开关切换保留试验数据并重新渲染，不写入正式 segments、Candidate 或行动草稿。

## 2026-10-07：纪要、问答、议程、提醒、往期会议

新增 H5 → 原生：

| type | payload | 行为 |
|---|---|---|
| digest.open | {utteranceId} | 打开本场纪要原话；commitment.open 保留为别名 |
| digest.openMany | {ids:[1–3个原话id]} | 冲突两句并列查看；含历史句时只读 |
| ask.session | {query:1–500字} | 全场原话问答，与召回共用在途锁 |
| agenda.set | {goal,items:[{title,minutes?:整数}],minutes?:整数} | 保存下一场议程，收音中更新本场；时长1–480分钟 |
| agenda.clear | {} | 清除本场及下次议程 |
| notice.dismiss | {id} | 收起提醒并同步该反馈 |
| notice.feedback | {id,useful:boolean} | 记录“有用/不准” |
| history.list | {} | 团队往期会议列表 |
| history.open | {sessionId} | 读取历史文字与纪要 |
| history.minutes | {sessionId,requestId?} | 只读服务器已存的 AI 会后纪要，不触发生成或发送；requestId 原样回传 |
| history.search | {query} | 搜索往期原话 |
| history.delete | {sessionId,confirm:true} | H5 二次确认后删除；本场收音中须先停止 |

`settings.set` 新增 voiceTrigger/noticeVibrate/memorySync，三个开关默认开。`state` 新增 digestCounts:{decision,commitment,constraint,idea}、agenda:{goal,items:[{id,title,plannedMs,coveredMs}],plannedMs,currentItemId,revision,tracking}、notices、voiceTrigger、noticeVibrate、memorySync、syncStatus（idle/off/pending/retrying/unsupported/failed/synced）、syncPending。tracking 为 waiting/supported/unsupported。

`session.summary` 保留 commitments，增加 decisions/constraints/ideas/notices；待办每句附 ownerHint（明确点名）、whenRaw、taskStatus、taskUrl。audioExpired 表示未暂存此原话。召回卡片 items 增加 audioAvailable；历史卡片增加 readOnly:true/startedAt，历史上下文按钮、回听、保存、起草均禁用。

原生 → H5 的 `notice` 为 {id,kind,title,detail,atMs,evidenceIds,itemId,history?,dismissed,useful}，横幅位于遮罩上方，最多两条，12 秒后收起到“提醒 N”。history 为历史原话的 snake_case 数据。`history.list/open/delete/search` 事件直接携带对应 API 响应，search 增加 query。snapshot/state/session.summary 均可恢复提醒记录；重新载入页面不会重新震动。

说 Oops 或欧普斯/哦普斯/奥普斯可触发，问句走本场问答，其他走召回；整句“把刚刚那个想法留下来”等指令也触发。开关关闭不触发，5秒内去重；语音口令仅在 ASR 定稿后响应，不是独立低功耗热词模型。

## 2026-10-12：读取状态、核对保存与服务切换

- `history.minutes` 回包沿用 `GET /v1/meetings/{id}/minutes`，加 `requestId`。H5 显示 ready/pending/unavailable/读取失败；`source_changed` 只显示失效原因与 `historical_doc_url`，不展示旧正文。404/501 表示此后端不支持，401/403 和网络错误保留失败语义。用户点「重新查询」才重读。
- `review.saved` 与 `speaker.corrected.status=saved` 才确认服务器保存并推进核对队列。`status=local` 只表示本机显示已改；失败保留当前选择，重试同一条。成功更新本地 `review_queue` 和列表数量；撤销人工说话人且模型仍未知时恢复身份待核对。
- `error` 可增加 `operation/sessionId/utteranceId/requestId/name/mine/status/selfName/serviceEpoch/backendUrl`，全部可选，旧桥仍兼容。H5 用上下文匹配具体读取或保存，关闭面板后迟到的打开结果不再强制跳转。`tasks.list` 回包增加冻结在请求时的 `selfName`，按 mine/status/selfName 区分缓存。
- 切换后端类型、规范化服务地址或该地址的访问凭据后，原生递增 `serviceEpoch`，发 `backend.changed {backend,backendUrl,serviceEpoch}`。远端读取与核对回包可附 `serviceEpoch/backendUrl`；原生丢弃旧代请求的成功和错误，H5 清除远端列表、详情、纪要与只读历史面板。改其他设置不递增版本，不中断有效读取。事件不包含访问凭据或其摘要。
- 已提交的行动沿用原操作的服务地址与 op_id，不因切换服务器改投新地址。收音保存规则继续沿用原设置。

公开站 `/native-flow.html` 从当前 Android H5 源文件生成隔离预览，`preview=1` 不读写浏览器保存记录，不连接真实后端，不创建飞书任务。它用于验证界面流程；不代表 APK 已构建或真机验收。


## 2026-10-12：本场任务清单

- 原生 → H5 `tasks.board`：`{session_id, tasks:[{id,what,owner,priority,status,sources,reason}], pending, updated_at}`，服务器的实时任务清单（见 api.md「本场实时任务清单」）。`snapshot` 也带 `board`（没有时为 null）。
- H5 在「行动」页按 P0–P3 分组显示；点任务打开它最后一句出处，沿用 `digest.open` → 生成行动 → `action.confirm`，不自动确认。浏览器模拟在出现待办时发送一份模拟清单。
## 2026-10-12：日常临时聆听与会议保存合同

此节替代上文旧的全场默认存盘/文字同步说明；旧记录不套新期限。新 `capture.start` 可带 `recordingMode:"daily"|"meeting"`、`cloudSaveConfirmed`、`audioRetentionDays`、`transcriptRetentionDays`，默认日常；正式会议必须本次明确确认，原音与全文分别7/30/90天、默认30天。`capture.meeting` 采用相同合同，把正在运行的日常结束并从切换时新建会议，不自动复制之前缓冲。真实后端能力不足或未确认时不能静默退回旧的全场归档。

- `state` 增加 `recordingMode/cloudSaveConfirmed/audioRetentionDays/transcriptRetentionDays/audioExpired/transcriptExpired`；`transcript.pruned {ids}` 清除对应原句、旧卡片、临时草稿与提醒。日常停止发 `capture.cleared {mode:"daily"}`，完整内容不能重新显示为已存会话。
- `daily.candidates {}` 读取私人待核对短依据，返回同名事件 `{items}`。`daily.candidate.confirm {sessionId,id,quote,confirmed:true}` 仅保存本次核对的短文字，不恢复原音/全文、不自动创建任务或共享。`daily.candidate.discard {sessionId,id}` 舍弃候选。
- `meeting.retain {sessionId,requestId,confirm:true,evidence:[{id,quote,sourceText}],summaries:[{id,text,source_ids}]}` 对应已有会议的独立保留接口。H5 本地桥接携带当前来源供原生计算 UTF-8 SHA256；HTTP 正文只发送短 quote 和 `expected_text_hash`，不发送 `sourceText`。短 quote 最多280字、摘要最多2000字，摘要只能引用本次选择的依据，默认不选、不勾确认。
- `meeting.retained` 回传 `sessionId/requestId/retained_evidence/retained_summaries`；只有匹配回执才显示已保留。普通错误在 `error.scope=retention` 保留选择并重试同一请求；409来源变化要求重新读取核对，不能重复提交旧确认。

公开安卓浏览器预览继续隔离示例，原生保存与服务端清理需新版后端和实际 APK 部署验证。代码测试、模拟回执不证明真机已经执行。

## 2026-10-16：共享 React 主界面与真实麦克风暂停

新版 Android 的 React 主界面通过 `src/nativeBridge.ts` 接收同一原生协议。实际 Android 入口即使桥尚未连接也使用空数据，不读取网站示例档案或网站本地缓存。真实历史会议及正式任务投影为只读，分别保留 `native-session:<id>` / `native-task:<id>` 来源标记；核对、账号记忆与外部交付沿用顶层原生工具页，不向 iframe 转交完整桥权限。

`state` / `snapshot.state` 新增 `serviceEpoch`、`capturePauseSupported`、`capturePaused`、`capturePauseDraining`。前者只含非凭据代次；服务/身份变化撤回旧读取与来源投影。刷新会议、纪要或任务时旧缓存先停止作为当前来源，只有本次匹配回包恢复；会议删除会取消该会议在途请求，迟到正文不能恢复已删对象。本机新建内容按服务与已核验本人账号隔离保存，不将远端正文、任务回执或其派生副本存为可离线复活的投影。

新增 `capture.pause {}` / `capture.resume {}`，目前仅手机麦克风宣告 `capturePauseSupported:true`。暂停真正停止并释放 `AudioRecord`，保持 `capturing:true,capturePaused:true`，同一 session、PCM 样本时轴、缓冲、保存合同和同步队列不变，不写会议结束标记。当前 ASR 尾句排空期间 `capturePauseDraining:true`，不能恢复；随后明确恢复才重新打开同一会话的麦克风与 ASR。暂停期间可以直接 `capture.stop`，日常清理及正式会议收尾规则不变。收音、暂停或 ASR 收尾期间，服务地址/访问凭据/Mock 变化在整次设置保存前拒绝，原设置、会话和缓冲保留；必须先明确结束并完成收尾。暂停期间也不能暗中切换音源。文件/回放音源、远端麦克风与录音豆未验证等价暂停合同，不能把停止或从头重放显示为暂停恢复。

实时 ASR 当前仍由原生 `Settings.volc` 读取构建时配置并直连现有服务。服务访问凭据与 ASR 配置互不替代；没有配置 ASR 的安装包显示 `asr:unconfigured`，不能宣称已经完成真实转写或真机验证。
