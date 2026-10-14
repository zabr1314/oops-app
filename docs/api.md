# Oops App ↔ 后端接口契约

后端负责人：洪玉麟。Android 已实现 HTTP 客户端；未填写地址时使用 App 内 Mock。
所有业务接口使用 JSON，字段名 snake_case；Android 整次 HTTP 请求超时 10 秒。时间窗口、原声起止、`now_ms` 都是**当前会话音频时间轴的毫秒**，不是 Unix 时间戳。

音频坐标统一约定：ASR 返回连接内时间，App 先加该连接的 `baseMs`；App 内部及所有 HTTP 音频时间字段均为会话坐标。`clip_start_ms` 是上传 PCM 第一个样本的会话时间。后端只在模型计算中使用 `t - clip_start_ms`，响应再加回。草稿的 `reference_time` 仍是 ISO 8601 绝对时间。

候选、草稿原话及上下文可增加 `tag`、`words:[{text,start_ms,end_ms}]`、`segments:[{start_ms,end_ms,text,speaker,score,source,approx,confidence,tier,overlap,candidates}]`；旧后端可忽略这些分段扩展字段。此兼容不包括下文保存授权/期限合同：新模式须核对 `/healthz.archive_policy_version >= 1`，不能让旧后端静默忽略保存策略。当前可用原文的分段拼接须等于 ASR 定稿全文，起草和保存按原句 ID 取最新信息；全文到期后不再冒充完整来源。

## 服务地址与鉴权

当前部署 base URL：`https://giftedprofessor.xyz/oops-meeting`，例如确认地址为 `/oops-meeting/v1/actions/confirm`。部署后端监听回环，由 HTTPS 入口转发；`OOPS_API_TOKEN` 设置后所有接口（含 GET `/healthz`）要求 `Authorization: Bearer <服务访问凭据>`，鉴权失败返回 401 `UNAUTHORIZED`，不会触发飞书调用。

Android 设置按规范化 base URL 保存访问凭据；恢复旧操作时使用该操作原地址的凭据。客户端仅通过 HTTPS 或本机回环发送凭据；H5 状态只暴露 `hasBackendToken`，不返回凭据。`GET /healthz` 返回 `status/jev/voiceprint/feishu/segments_validated/strict_a_enabled/self_owner_enabled/named_owner_enabled`，不返回飞书授权或密钥。四个归属门禁首发全部关闭。

服务器 `--state-dir /var/lib/oops/backend` 持久化映射与确认操作。新 Oops 组织的四人名单为黄丽萍、江古月、洪玉麟、林春源，Lydia 是黄丽萍的别名。`OOPS_STRICT_PEOPLE=1` 时未配置负责人会明确报错。

## 1. POST /v1/recall

后端只选择请求中的候选编号，App 的文字和回听时间始终取自原始候选。

请求：
```json
{
  "session_id": "session-example",
  "trigger": "button",
  "query": "把刚才那个方案留下来",
  "now_ms": 25000,
  "candidates": [
    {"id":"u1","start_ms":5000,"end_ms":10400,"speaker":null,"text":"我觉得可以先做一个找回想法的功能，预算控制在十万以内。"},
    {"id":"u2","start_ms":11700,"end_ms":16100,"speaker":null,"text":"我周五前把方案发给你。"}
  ]
}
```
响应：
```json
{"picks":[{"id":"u1","prob":0.82},{"id":"u2","prob":0.12}],"engine":"jev-1.13.0"}
```
无匹配：
```json
{"picks":[],"engine":"jev-1.13.0"}
```

`trigger` 为 button / notification / double_tap / voice / ask。`query` 可以为 null；ask 要求非空问题。
App 先请求最近 2 分钟；有效候选最高概率不足 0.3 时扩到 5 分钟。低于 0.1 不展示，前两项差距至少 0.2 显示单卡，否则最多显示 3 条。不存在的编号、重复编号、非法概率和原声已覆盖的候选会先过滤，再判断是否扩窗。

Jev 适配建议（已核对 [官方 Choice 文档](https://docs.typesafe.ai/primitives/choice) 与 [HTTP API](https://docs.typesafe.ai/api)）：把候选编号作为 Choice 选项，**另外提供 `no_match` 选项**，避免所有内容都无关时仍强制挑一句。`no_match` 占优则返回空 picks；其余选项直接使用 Jev `probabilities` 对应值，不要把剔除 no_match 后的概率重新归一化，也不要把整体 confidence 当作某句的概率。Choice 最多 255 选项，因此单次候选最多 254 条；更多时先分组缩小。中文对话和阈值要用真人样本验证。固定模型版本并记录真实返回版本。

## 2. POST /v1/actions/draft

只生成草稿，不创建任何任务。`reference_time` 为 ISO 8601 绝对时间，`time_zone` 为 IANA 时区，用于解析“明天／周五前”。测试预录音频时应以录制时刻为参考，正式录音用当前时刻；App 当前默认发送草稿创建时刻与手机时区。

请求：
```json
{
  "session_id":"session-example",
  "reference_time":"2026-10-06T10:00:00Z",
  "time_zone":"Asia/Shanghai",
  "utterances":[{"id":"u2","start_ms":11700,"end_ms":16100,"speaker":null,"text":"我周五前把方案发给你。"}],
  "context":[{"id":"u1","start_ms":5000,"end_ms":10400,"speaker":null,"text":"预算控制在十万以内。"}]
}
```
响应：
```json
{
  "who":null,
  "owner":null,
  "suggested_owner":null,
  "owner_source":"none",
  "owner_confidence":null,
  "tier":"C",
  "reason":"承诺短语的说话人未知",
  "owner_candidates":[],
  "what":"把方案发给对方",
  "when":{"iso":"2026-10-09","raw":"周五前"},
  "constraint":"预算控制在十万以内",
  "assignee_candidates":["黄丽萍","江古月","洪玉麟","林春源"]
}
```
无法解析时间时 `when` 可以为 null，或 `{ "iso":null, "raw":"原始时间措辞" }`。负责人不确定时返回 null，让用户选择。Jev 负责选择／判断；自由文本草稿提取需要独立 LLM 或规则实现。

`who` 兼容字段等于 `owner`。只有共同严格门禁及对应本人/点名门禁通过，才返回 A 档非空 `owner`；一键人工确认后才调用 confirm。B 仅返回 `suggested_owner`，界面可点选且不预填；C 留空。`owner_source` 为 `named/self/none`，`owner_confidence` 是独立校准的承诺短语/行动绑定正确概率，未拟合为 null。候选最多两人、分数降序，仅表示相似度。多承诺返回 `commitments` 中的原句 ID、字区间和类型，并提示拆成独立行动。晚到模型结果不得覆盖用户编辑的负责人、事项、日期、约束或已提交确认快照。

## 3. POST /v1/actions/confirm

只有用户明确点确认后调用。后端需预配置上述显示名到飞书 `open_id` / `user_id` 的映射；不根据显示名盲目创建负责人。截止日期按请求时区转换，不能默认服务器时区。

请求：
```json
{
  "op_id":"op-example-001",
  "session_id":"session-example",
  "draft":{"who":"林春源","what":"把方案发给对方","when":{"iso":"2026-10-09","raw":"周五前"},"constraint":"预算控制在十万以内"},
  "evidence":{"utterance_ids":["u2"],"quote":"我周五前把方案发给你。","clip_start_ms":11700,"clip_end_ms":16100}
}
```
接受并处理中：
```json
{"op_id":"op-example-001","status":"pending","feishu_task":null,"message":null}
```
直接完成：
```json
{"op_id":"op-example-001","status":"created","feishu_task":{"guid":"feishu-task-guid","url":"https://applink.feishu.cn/client/todo/detail?guid=feishu-task-guid"},"message":null}
```

**幂等规则**：先持久化 op_id 与确认内容，再执行飞书写入；同一 op_id 的重试、连点、网络断开或进程重启都至多建一条任务。同 op_id 不同 payload 返回 409 `OP_PAYLOAD_CONFLICT`，不得静默使用新内容。飞书调用成功但客户端响应丢失时保留可查询结果。服务端实现应覆盖调用超时但飞书已写入的恢复路径，不能仅依靠内存字典或防连点。

### 来源核对合同 version 1（2026-10-13）

`GET /healthz.action_source_binding_version` 为1。带会话来源的草稿响应新增 `source_binding` 与 `source_error`；任务板每项同样提供这两项。会议合同来自服务端当前原文或独立确认短依据，客户端不得按本地文本自行补造。来源不同步或已撤回时返回 `source_binding:null` 和可读原因；仍可编辑草稿，但不能创建带来源的任务。日常无整场存档时仅使用下述经认证提交的必要短依据限时合同，receipt或本地哈希不能单独代替合同，也不能偷偷改成手工任务。

```json
{
  "version": 1,
  "proof": "<服务端HMAC签名，客户端原样冻结，不得自行生成>",
  "session_id": "session-example",
  "sources": [{
    "id": "u2", "kind": "transcript",
    "text_hash": "<服务端完整当前原话UTF-8的SHA-256小写64位hex>",
    "source_revision": "<服务端原样返回的不透明非空版本字符串>",
    "quote": "我周五前把方案发给你。",
    "speaker": "林春源", "review": {}
  }]
}
```

`kind` 为 `transcript` 或 `saved_excerpt`，每条 `quote` 非空且最多280字；`speaker` 是核对后有效说话人或null，`review`仅包括已设置的 `speaker/owner/verdict`。起草会核对请求原话全文与显式说话人，且在模型工作前后各读取一次，途中改变则不签发合同。每条来源分别计版本，文本、身份、核对或既有独立短依据改写/删除会递增；改回旧内容不会复活旧合同，追加无关句和自然全文到期不会改变原版本。

起草实际用到的 `context` 原话另放合同内可选的 `context_sources` 数组（与 `sources` 相同字段），防止预算/指代上下文变化后仍执行旧草稿；它不扩大主选 `evidence.utterance_ids` 或展示原话正文，客户端仍原样冻结整个合同。服务端对主选与这些上下文依赖共同核验。每组最多20条，重复或未保存上下文不签发合同。

整个合同由服务端HMAC签名为 `proof`，防止客户端删除上下文或篡改核对范围；即使签名有效，执行前仍从当前受信来源重新核验。密钥位于服务私有 `<state-dir>/operations/.action-source-key`，32字节随机值、文件0600，重启沿用，不进入App、公开网站或日志；部署迁移须保留这个文件。它不包含全文，也不替代用户权限隔离。无有效签名的旧来源草稿需重新起草，已created历史不追溯补签。

确认时将整个回包原样冻结在 `evidence.source_binding`；`evidence.utterance_ids`须按 `sources` 顺序完全一致，`evidence.quote`须严格等于各条 `quote` 用一个空格连接。任何带 `session_id` 或 `evidence` 的确认均视为带来源；缺合同返回409 `SOURCE_BINDING_REQUIRED`，格式不一致为 `ACTION_SOURCE_INVALID`，来源变化/撤回为 `ACTION_SOURCE_CHANGED`，会议不可用为 `ACTION_SOURCE_UNAVAILABLE`，不得降级成手工。上述409错误附 `no_external_write:true`，表示本操作尚未尝试外部创建，客户端可明确提示重新起草；普通HTTP错误或网络失败不能据此认定未创建。真正的无来源手工任务同时省略 `session_id` 和 `evidence`。

服务端提交前、操作恢复后和实际飞书创建前都会重新读取受信来源，重算文本hash、核验版本与短原话；来源校验和飞书写入持有同一会议锁，修订/删除不能插入最后核验与创建之间。自然全文到期后，只能用已独立确认、仍有效且确实覆盖所引短原话的依据接续原合同；不会恢复全文。也可重新从独立短依据起草，此时 `kind:saved_excerpt`。

已 `created` 的同payload操作保留历史回执，即使来源之后变化、删除或旧操作没有新合同，也不重新创建。尚未外部写入的失效操作为failed；若旧pending已经尝试过外部创建而结果不明，保留pending并返回 `source_blocked:true`、`error_code`和可读原因，停止自动再次写入，不把未知结果说成确定未创建。此类操作需核实原飞书结果；不能换操作编号绕过失效来源。

worker恢复时发现来源失效且确定未尝试外部写入，failed回包同时提供 `source_invalidated:true`，客户端直接回到重新核对，不重试旧依据。真实任务板的清理先后顺序也遵循此边界：自然TTL保留的独立短依据带不可逆原来源hash，用于匹配原候选；只保留全部来源均有效保留的候选，当前合同重签为 `saved_excerpt`，重启不会丢失。没有独立依据、来源修订/撤回/删除仍移除；不会把旧全文放回任务板。上线前已到期且缺原来源hash的旧短依据不推测补造匹配。

相关升级包须同时包含 `scripts/action_sources.py` 和本轮 `scripts/task_board.py`。review/live-speed构建器对旧基线中不存在的新依赖记录显式null并在目标要求确实不存在；旧模块仍逐个校验原hash，新增文件回滚时会删除。其他历史升级脚本的固定旧baseline门禁保留；模块清单修正不表示旧发布包可直接用于当前服务，更不表示本轮已部署真实后端。

Android 在发请求前保存原操作及冻结的草稿。响应丢失／10 次轮询后仍 pending 时显示“查询创建结果”，继续 GET 原 op_id。不会因 HTTP 超时更换 op_id，也不会将结果未知宣称为创建失败。

2026-10-14：首次确认及实际外部写入前校验当前来源。保留version1会议合同与上下文校验；删除、主动修订、排除或撤回共享后旧许可失效，按上述来源错误返回409，并仅在明确未尝试外部创建时附 `no_external_write:true`。全文自然到期仅可继续引用已经独立确认保留的短依据。既有 `created` 回执优先返回，不据此重新创建。

日常记录的草稿请求须明确 `recording_mode=daily`；所选原句及必要上下文合计不超过280字/20句，位于同一五分钟窗口，引用保持完整句。服务端同时签发 `source_binding{version:1,scope:daily,session_id,sources,context_sources,proof}` 和opaque `source_receipt`；各行kind为 `daily_excerpt`，仍有text_hash/source_revision/quote/speaker/review。确认冻结合同到 `evidence.source_binding`，receipt放请求顶层；两者必须一起有效。凭据只在服务器有界内存保存哈希/ID及合同哈希，最长5分钟，不保存完整日常原文，也不证明原话是独立核验真值；停止、到期、来源变化或服务切换后App撤回未提交草稿。进程重启后未提交草稿需重新起草；日常合同不能代替已归档会议的合同。签名无效仍用 `ACTION_SOURCE_INVALID`，日常receipt失效为409 `SOURCE_CHANGED`，附明确未外写标记。

已经尝试外部写入但结果未知的操作继续为 `pending`，可带 `source_blocked` 及具体提示；来源失效不证明飞书创建失败。GET查询不会重新启动创建；有原GUID时只回读原任务，没有可靠查询键则保留待人工核实状态。不得因此换op_id重复创建。

## 4. GET /v1/actions/{op_id}

无请求体。返回同一个操作的当前状态；created 必须有任务 guid。
```json
{"op_id":"op-example-001","status":"created","feishu_task":{"guid":"feishu-task-guid","url":"https://applink.feishu.cn/client/todo/detail?guid=feishu-task-guid"},"message":null}
```
明确业务失败：
```json
{"op_id":"op-example-001","status":"failed","feishu_task":null,"message":"飞书授权已失效，请重新授权"}
```
未知操作：HTTP 404，使用统一错误格式，不能伪造已创建状态。

状态：pending / created / failed。App 会对 created 再 GET 一次；只有回读出同一任务 guid 才标记“已回读确认”。回读失败仍保留后端的 created 声明，同时显示“尚未回读核验”。

## 错误格式与时限

```json
{"error":{"code":"FEISHU_AUTH_EXPIRED","message":"飞书授权已失效，请重新授权"}}
```

推荐 HTTP 状态：400 参数错误；401/403 授权失效；404 操作不存在；409 同 op_id 内容冲突；429 限流；500/502 服务错误。错误信息应可显示，且不带密钥或底层凭据。长任务尽早返回 pending，App 的整次调用时限为 10 秒。流式 ASR 使用独立 WebSocket，持续静音时不设读取超时。

## P1 预留（尚未接入）

- `POST /v1/conversations/{id}/end`：携带最后 sequence，后端确认之前定稿已收齐再返回承诺列表。
- 当事人确认需版本化扩展状态，例如 awaiting_confirmation / accepted / rejected；当前 P0 App 不接受这些状态。
- 长对话中承诺原声应在初步发现时暂存；不能等对话结束后才从已覆盖的 5 分钟缓冲中取回。

## 5. POST /v1/utterances（已接入）

```json
{
  "session_id":"session-example", "utterance_id":"u2",
  "start_ms":11700, "end_ms":16100, "text":"我周五前把方案发给你。", "speaker":null,
  "context":[{"text":"我们还需要一个新方案。","speaker":null}]
}
```
```json
{"utterance_id":"u2","tag":"commitment","prob":0.91,"engine":"jev-1.13.0"}
```

标签枚举：`commitment / decision / idea / constraint / chitchat / uncertain`。Jev 所选项概率低于 0.5 时返回 `uncertain`，不算寒暄、不计承诺，召回加权视为无标签。规则兜底只输出明确的 `commitment`、`constraint` 或 `uncertain`，`prob:null, engine:rules`；它没有可校准的模型概率。仅出现日期、人名、收件人、否定、疑问、引用、假设或已完成事项不判为新的承诺。

标签在定稿时独立发出，不等待声纹。`context` 最多前 4 句，固定发送时的快照。成功结果按 `(session_id, utterance_id)` 缓存，重复请求直接返回首次结果，context 的变化不触发重算。成功的规则兜底结果也缓存；真正失败、没有结果的请求不缓存。当前原型最多缓存 20,000 个结果。

App 可选接口重试策略：IO、429、5xx 最多重试 2 次，间隔 1、3 秒；400、401、403 等不重试。404/501 表示不支持，本场停用对应接口。标签和声纹各限 2 个并行请求、最多 8 项运行或排队；超限标签计入分析失败、超限声纹跳过，不标为不支持。排队声纹不复制 PCM，得到执行名额后核对 session 再复制音频。单次网络调用 10 秒超时。停止收音保留进行中请求，后续结果仍更新本场；下一场开始后丢弃旧场结果，旧场的停用状态不影响新场。

## 6. POST /v1/speaker（整句已接入，句内拆分待人工验收）

```json
{
  "session_id":"session-example", "utterance_id":"u2", "sample_rate":16000,
  "pcm_base64":"<16 kHz mono s16le>", "clip_start_ms":11700,
  "text":"我周五前把方案发给你。",
  "words":[{"text":"我","start_ms":11700,"end_ms":11900}], "context":[]
}
```
```json
{
  "utterance_id":"u2", "speaker":"洪玉麟", "score":0.81, "runner_up":0.42,
  "engine":"campplus-zh", "segments_validated":true,
  "segments":[{"start_ms":11700,"end_ms":16100,"text":"我周五前把方案发给你。",
    "speaker":"洪玉麟","score":0.81,"source":"voiceprint","approx":false,
    "confidence":null,"tier":"B","overlap":false,
    "candidates":[{"name":"洪玉麟","score":0.81},{"name":"林春源","score":0.42}]}]
}
```

示例只展示格式，不是实际验收结果。PCM 长度允许 0.5–30 秒；JSON 请求体上限 2 MB，容纳 base64 编码后的 30 秒 PCM。`text` 是二遍识别后的定稿全文，作为 words 对齐目标。缺字段的旧请求继续整句识别，旧响应可以没有 segments。

`source` 为 `voiceprint`（达到普通/短段对应阈值，先锁定，Jev 不可改）、`voiceprint+context`（未锁定段，经 Jev 概率 ≥0.7 且声纹前两名守卫通过）、或 null（未知）。`approx` 表示词/原文时间映射是否近似，不能用近似切字自动解析“我”的负责人。Jev 批量裁决只包含未锁定段，故障保持未知。

`confidence` 是段内非重叠可辨认字中至少 90% 归属预测说话人的校准概率，不等于整段所有字正确；未拟合为 null。余弦 `score/runner_up/candidates.score` 与 Jev 原始概率都不能替代。有效名字可为 B+null，A 必须具备校准概率。重叠字固定 `overlap=true,speaker=null,tier=C`，给出最多两名候选；近似、未知不能进入 A。

后端默认关闭拆分显示、严格 A、本人和点名预填。开发集冻结后，完整保留集只做一次最终判定；精确单侧 95% 错名上界在段和含 A 段的句两个单位均 ≤2% 才可启用严格 A。本人和点名的行动绑定准确率下界各需 ≥95%，本人覆盖率还需 ≥60%。20 条零错的错率上界约 13.9%，只能返回证据不足。拆分最低线通过而严格证据不足时，只显示建议。未通过显示门禁时返回 `segments:[],segments_validated:false`。

schema 2 验收核对判定代码及依赖、两种模型、校准器、线上实际生效声纹和冻结/消费证据。重新录入声纹会清空缓存、先验并关闭归属开关；不能复用旧验收。线上验收元数据由 Mac 完整核验后签名，服务器固定可信签名并再次检查当前指纹；音频与人工标注保持本机。旧 schema 报告不会启用 v2。

负责人先区分明确点名/self/未知；点名须有指派关系，“发给某人”不算。self 必须只有一个明确的第一人称承诺，承诺短语完整位于一个非重叠、非近似的 A 段中，且独立 owner 概率及门禁通过。集体承诺、跨段、多个承诺、重叠、近似和未知留空，交由用户选择。模型 A 显示“高可信”，人工核对才显示“已确认”。

### 句内拆分延后返回与 `POST /v1/speaker/split`（2026-10-08）

句内拆分（试验）在服务器上要几秒，整句名字不应等它。请求带 `"split":"deferred"` 时，`/v1/speaker` 只做整句识别就返回，响应加 `"split_pending":true`（句子不足 `OOPS_SPLIT_MIN_MS`，默认 3000 毫秒，则不拆分、不带该字段）；拆分交给服务器后台单线程计算。不带 `split` 的旧请求保持同步行为，响应里直接带 `trial_segments`，所以新旧 App 与新旧服务器可任意搭配。

```json
POST /v1/speaker/split   {"session_id":"session-example","utterance_id":"u2"}
→ {"utterance_id":"u2","status":"done|pending|unavailable","trial_segments":[...],
   "timing_ms":{"split_queue_ms":12,"split_ms":3900}}
```

不重传音频。服务器最多等 8 秒：算完返回 `done`；仍在算返回 `pending`，App 再问一次（最多 3 次）；从未提交、已被淘汰（最近 256 条）、计算失败或排队超过 16 条返回 `unavailable`，App 保留整句标签。`trial_segments` 与同步模式逐字段相同。App 收到后只更新这一行的拆分字段，不改整句名字，也不同步、不进入负责人判断。

`/v1/speaker` 响应另带 `timing_ms`（`identify_ms`，同步模式还有 `split_ms`）。相同的 `session_id + utterance_id + 音频哈希 + 模式` 重试直接命中服务器缓存，不重新计算。`/v1/utterances` 的响应带 `timing_ms.jev_ms/clause_ms`，`/v1/actions/draft` 带 `timing_ms.deepseek_ms`；这些字段仅供量延迟，App 不依赖。`/healthz` 另带 `jev_stats`（自进程启动：`calls/retries/failures/tag_fallbacks`），打标签时 Jev 失败会在 7 秒总预算内重试一次（超时、429、5xx 才重试，4xx 不重试），仍失败才退回关键词规则并计入 `tag_fallbacks`。

## 本场承诺索引

正式会议索引的文字、字时间戳、标签和说话人信息在内存中保留至下次开始收音，上限 20,000 句；达到上限移出最早条目并提示。日常模式的完整原声/临时全文只滚动保留5分钟，停止后清除，不建立全场索引、录音文件或会议同步队列；私人未确认候选最多50条，每条最多280字，不携带原声和全量字时间戳。会议中暂存原声最多50段/16 MiB；回听仅在实际覆盖范围可用，不拼补缺失音频。

停止后显示承诺数、待分析句数和分析失败句数，结果到达实时更新。承诺列表可打开现有召回卡片、回听、保存和起草；未支持分析的后端明确显示不支持。本轮不落盘，进程退出会丢失本场索引；只有用户点“保存”才写入长期记忆。

## 联调验收

先用 `scripts/api_smoke.sh BACKEND_URL` 核对召回、草稿；确认环境是飞书测试环境后设置 `OOPS_SMOKE_CONFIRM=1` 才执行确认与重复确认。随后在 App 调试设置关闭 Mock，填写同一地址。

需覆盖：未确认不写入；无匹配返回空 picks；非法编号不会阻止扩窗；草稿字段与证据一致；真实创建并回读；重复确认只建一条；延迟 pending、HTTP 超时和授权失效可恢复。


## 自助声纹录入（2026-10-07）

`GET /v1/voiceprints` 返回 `people:[{name,registered,seconds,source,updated_at,sample_id,profile_revision}]`、`revision`、`accept`、`required_margin`。不返回声纹向量。App 服务凭据可查看四人；个人邀请凭据只返回本人及 `person` 字段。

`POST /v1/voiceprints/enroll` 输入：

```json
{"name":"林春源","source":"mic","consent":true,"single_speaker":true,
 "sample_rate":16000,"pcm_base64":"<16 kHz 单声道 s16le>",
 "sample_id":"<冻结录音的 UUID>","expected_revision":"<目录版本>",
 "expected_profile_revision":"<可选：本人声纹版本>"}
```

只允许团队成员及 `mic/remote` 现场音源。录音须 15–30 秒，有效音量片段至少 8 秒，削波比例不超过 1%；3 秒片段声纹向量的中位一致性须 ≥0.6，最弱片段 ≥0.35。以上为试用质量检查，不能验证本人身份。模型提取归一化特征后，原子替换所选成员；其他人的声纹保留。运行时文件 `<state-dir>/voiceprints.json` 为 0600，不保存 PCM 文件。

重复提交同一成员的 `sample_id` 返回原保存结果，不重复更新；版本不符拒绝。网页使用本人 `profile_revision`，不同成员可从同一次目录读取结果分别保存；同一人的过期版本仍拒绝覆盖。App 继续支持全局 `revision`。保存/删除使已有拆分及 self 自动填人验收失效；不能用历史 DJI 验收打开新注册声纹的闸门。

`POST /v1/voiceprints/test` 输入 `sample_rate:16000/pcm_base64`（0.5–30 秒），只返回 `speaker/closest/score/margin/reason/scores/accept/required_margin/quality`，不更改声纹。`quality` 含 `seconds/active_seconds/clipped_ratio`。整句匹配门槛自 2026-10-09 起默认 0.42（`OOPS_SPEAKER_ACCEPT` 可改），前两名差距仍要求 ≥0.05；依据是一场人工标注会议（Mac 收音，77 句单人说话）上覆盖率从 59% 升到 81%，错名数不变，暂定，待保留场次确认。

`POST /v1/voiceprints/delete` 输入 `name/confirm:true/expected_revision`，App 服务凭据才允许删除。删除后重启不会恢复 seed 声纹；全部删除后仍可再次录入。

### 网页与个人邀请

公开静态页为 `GET /voiceprint/`，JS/CSS 同源，无第三方脚本；配置 CSP、no-store、no-referrer。业务接口仍鉴权。部署前缀下的分享链接形如 `https://giftedprofessor.xyz/oops-meeting/voiceprint/#invite=<个人邀请>`。邀请放在 fragment，浏览器通过 `Authorization: Bearer <邀请>` 调用 API，不把 App 全权限凭据传给网页。专用 `OOPS_ENROLL_SECRET` 生成 HMAC 签名，包含成员和到期时间；更换该 secret 可撤销全部旧邀请。

个人邀请只允许 GET 本人目录、POST 本人 enroll、POST test；其他成员 enroll、delete、飞书和其他业务接口均 403，过期/篡改邀请 401。页面不存 localStorage；暂存录音在内存中，离开前台时中止正在录音，保存/放弃后清除临时音频。浏览器须支持 HTTPS getUserMedia/Web Audio，页面自己把 44.1/48 kHz 录音转为 16 kHz PCM。Web 请求客户端预算 40 秒，现有代理预算 15 秒；超时保存保留同一 sample_id 供重试。


## 试验：POST /v1/speaker-preview（2026-10-07）

仅完整 App 服务凭据可调用；个人录入邀请无此权限。服务器须安装 ONNX Runtime，并显式设置 `OOPS_SPEAKER_PREVIEW=1`。未启用返回 501。请求沿用 `/v1/speaker` 的 16 kHz mono s16le PCM、`clip_start_ms`、`text/words/context`；滚动窗口限 3–10 秒，带定稿原文时限 0.5–30 秒，可给 `clip_end_ms` 处理 ASR 末端最多 100 ms 的取整差。

返回 `experimental:true/start_ms/end_ms/activities/segments/coverage/jev_used/compute_ms/engine`。activities 的 kind 为 speech/silence/overlap；overlap 不指定姓名。segments 只按 ASR 已提供的字词时间切分，拼接必须逐字等于原文；无可靠词时间只返回整句 unknown。Jev 仅辅助声纹支持的候选、可保留 unknown，不能改写原文或补出重叠中未识别的另一人的话。

pyannote 3.0 局部编号不作为身份，不跨不连续发言共用声纹判断；连续单人活动按至多 3.2 秒独立比对，短于 1.6 秒保持未知。10 秒窗口每 5 秒移动，边缘裁剪后查询注册声纹。试验有漏报和误报；重叠活动只能视为疑似提示。

`/v1/speaker` 请求带 `preview:true` 时也可附带相同结构的 `preview` 字段。原 `speaker/segments/segments_validated` 及负责人验收闸门继续独立工作。App 将 preview 保存在单独展示字段；Candidate、召回证据、负责人解析与飞书任务不接收此字段。App 默认关闭开关，每次至多一个滚动请求，约两秒请求一次，过期、换音源或换会话结果丢弃。

## 2026-10-07：本场问答、提醒和会议文字（本地待部署）

`recall.trigger` 新增 `ask/voice`。问答从全场索引预选最多 120 句，排除口令与过短句，优先标签、字面重合与时间；Jev 只选择最能回答问题的原话，提供 `no_match`。问答校验原话编号与概率，不因原声已过期而丢弃文字。原声状态由 App 提供。规则问答无字面匹配时返回空 picks。

### POST /v1/notices

可选接口：404/501 后 App 停用此场的判断请求，仅保留规则时间提醒。全部文字明确作为数据处理；App 丢弃跨会话或旧议程 revision 的 topic/resolution 结果。

| kind | 请求字段（另含 session_id） | 响应 |
|---|---|---|
| topic | agenda: {goal,items:[{id,title,planned_ms?}],planned_ms?}, utterances: 定稿句，最多 40 句/4000 字 | {topic: 议程 id 或 on_topic/off_topic/unclear,prob,probabilities?,engine} |
| resolution | item:{id,title}, utterances: 最多 60 句 | {resolved:true/false/null,prob,engine} |
| conflict | utterance: 当前句, previous: 本场先前决定/约束，最多 30 句 | {conflict,with: 原话或 null,prob,engine} |

只有目标没有议程时 topic 可返回 `on_topic`；有议程时必须返回所发送的 id 或 `off_topic/unclear`。prob 必须为 0–1 有限数或规则的 null。跑题 ≥0.6 连续两次才提醒，5 分钟去重。缺结论 ≥0.6 才提醒，规则 resolution 返回 null，规则 topic 只做标题字面重合，从不判跑题。

冲突 Jev 选项为 p0..pn/none，≥0.6 且非 none 才提示“可能冲突”。规则仅比较明确金额上限与超限金额；提问、假设和新上限不触发。服务器补入最近 10 场的决定/约束，按字面重合取前 10 条。历史 with 增加 `id:"h:<session>:<uid>"/session_id/started_at`；本场文字仍从本地发送的原话取，历史原话来自受鉴权服务器。

### 会议文字接口

全部要求 App 全权限凭据，声纹邀请凭据返回 403；没有有效凭据返回 401。公网部署仍需设置 `OOPS_API_TOKEN`。文件存于 `<state-dir>/meetings/<session_id>.json`，目录 0700、文件 0600，带锁、原子写入。2026-10-12起，新会议须携带下文明确云保存合同，全文默认30天；已存在且没有合同的旧会议保持原策略，不追溯套新默认。旧管理员 `OOPS_MEETING_RETENTION_DAYS` 只作用于旧记录；保持0不会删除历史。删除编号保留无文字标记，阻止迟到请求重建。

| 接口 | 请求/响应 |
|---|---|
| POST /v1/meetings/sync | {session_id,started_at,time_zone,ended_at?,agenda?,utterances:[最多500句],notices:[最多100条],保存合同字段} → {session_id,utterance_count,notice_count,storage_policy,transcript_status} |
| GET /v1/meetings?limit=30 | limit 1–100 → {count,items:[session_id,started_at,ended_at,goal,utterance_count,digest_counts]} |
| GET /v1/meetings/{id} | 元数据、按时间排列的 utterances、notices、digest 四类原话、按 operations.request.session_id 关联的 tasks |
| GET /v1/meetings/{id}/minutes | {session_id,status,reason?,message?,minutes?,sources?,doc_url?,historical_doc_url?}；飞书机器人写好的 AI 纪要，只读，见下 |
| GET /v1/meetings/{id}/board | {session_id,tasks:[{id,what,owner,priority:P0–P3,status:open/done/dropped,sources,reason}],updated_at,pending}；本场实时任务清单（2026-10-12），只读，见下 |
| POST /v1/meetings/search | {query:1–500字} → {items:[id,text,start_ms,end_ms,speaker,tag,session_id,started_at,prob],engine} |
| POST /v1/meetings/delete | {session_id,confirm:true} → {deleted:true}；重复删除幂等，迟到同步返回 400 |
| POST /v1/meetings/rename | {session_id,title:0–40字} → {session_id,title,title_source}；空字符串恢复自动名称 |
| POST /v1/meetings/project | {session_id,project:0–30字} → {session_id,project}；空字符串移出项目。存在会议文件 `project`，同步不覆盖 |
| GET /v1/projects | {items:[{name,meeting_count,confirmed_decisions,last_started_at}]}，最近有会的在前 |
| GET /v1/projects/{名称，URL 编码} | {name,meetings,decisions:[已确认的决定/约束，带 session_id、started_at、meeting_title、speaker],unreviewed_decisions,tasks}；tasks 同 `/v1/tasks` 的条目，限这个项目的会议 |
| POST /v1/meetings/review | {session_id,utterance_id,speaker?,verdict?,owner?,by?} → {session_id,utterance_id,review}；人工核对，见下 |
| POST /v1/meetings/retain | {session_id,confirm:true,evidence:[{id,quote,expected_text_hash}],summaries:[{id,text,source_ids}]} → {session_id,retained_evidence,retained_summaries}；明确独立保留，至少1条、最多50条280字原话/20条2000字摘要。`expected_text_hash`为核对时完整原话原始UTF-8的SHA-256小写64位hex，不规范化空白/标点；锁内与当前全文核对，原话变化返回409 `ARCHIVE_POLICY,asset:"transcript"`，缺失/格式错400。短引文仍包含但整段已变也须重新核对；摘要只绑定本次已选且校验过的短依据，不自动确认模型结论。相同ID重试不追加副本，摘要的新保存动作应使用新ID以保留版本 |

**AI 纪要（2026-10-11）**：`GET /v1/meetings/{id}/minutes` 返回机器人会后写的纪要，给 App 和网页原型用。只读已存结果，不会为此调用模型。`status`：
- `ready`：`minutes` 为 `{version,substantive,overview,decisions:[{text,ids}],actions:[{owner,task,due,ids}],topics:[{topic,points}],open_questions:[{question,quote,id}],follow_ups:[{title,start,minutes,attendees,quote}]}`，每条都回指真实存在的句子；`sources` 是决定、待办、待查问题引用到的句子 `{id:{text,start_ms,end_ms,speaker}}`（说话人以人工核对为准，之后被删的句子不出现）；`doc_url` 是飞书纪要文档，没发文档时为 null。`substantive:false` 表示会议没有值得整理的内容（不足 5 句也是这样）。
- `pending`：`reason` 为 `in_progress`（会议未结束）或 `writing`（已结束，机器人会在结束 90 秒后写，失败按 2、4、8… 分钟重试）。
- `unavailable`：`reason` 为 `bot_off`（服务器未开 `OOPS_FEISHU_BOT=1`）、`before_bot`（会议在机器人启用前结束，不补写）、`no_end`（旧记录既没有结束时间也没有同步时间，判断不出已结束，机器人不会处理）或 `failed`（连续 6 次失败）。

**核对后的来源一致性（2026-10-12）**：实际修改说话人、负责人、决定核对或来源文字后，旧纪要返回 `status:unavailable, reason:source_changed`，附 `message`；已创建的旧文档仅以 `historical_doc_url` 保留历史入口，不再返回可作为当前结果使用的旧正文。无实质变化的重复核对不使纪要失效。已有发送、日程和工作记录继续保留；不会自动重生成、重发或覆盖外部文档。使用旧纪要的日程、资料整理和 Mac 工作在开始、接收结果及交付前检查来源，变化后停止继续使用；已经完成的外部操作仍显示其历史回执。

会议不存在或已删除返回 404，`id` 不合法返回 400；凭据要求同其他会议接口。

2026-10-12：Android 已接入上述只读纪要接口，区分未完成、不可用、来源变化和读取失败；不补写或重发。详情路由按解析后的完整路径匹配，`GET /v1/meetings/{id}?refresh=1` 正常读取该场会议，额外的子路径不会误当会议 ID；`/minutes` 独立路由保持优先。

**人工核对（2026-10-09）**：`speaker` ∈ 团队成员或 `other`/`multi`/`unclear`，`owner` ∈ 团队成员，`verdict` ∈ `confirmed`/`rejected`；只改请求里出现的字段，传 `null` 清除该字段，全部清空则删除这条核对。核对单独存在会议文件的 `reviews` 里，重复同步不覆盖人工说话人/负责人；原话正文发生实质变化时撤回旧 `confirmed`，防止旧确认变成新内容的证明。确认记录绑定原文哈希；全文到期时最多留下50条280字确认摘录。`GET /v1/meetings/{id}` 把核对叠加为每句的 `review`，模型 `speaker` 原样保留。会议不存在/已删除返回404。进行中改说话人后草稿优先采用人工说话人，但仍只是建议，不越过负责人验收开关；这些核对不是盲标，不能当验收集。

**项目与跨会议冲突（2026-10-09）**：`POST /v1/notices` 的 conflict 判断，本场会议有项目时，取同一项目其他会议里人工确认过的决定和约束（最多 30 条，新会议在前）全部交给 Jev，不再按关键词预选，所以说法不同的矛盾也能找到；项目里还没有确认过的，退回原来的做法（最近 10 场会议、字面相近、未被驳回）。返回的 `with` 增加 `meeting_title` 和 `confirmed`，手机据此显示"可能与已确认的决定冲突""MM/dd《会议名》已确认"或"（未核对）"。

2026-10-12：会议列表的公开 `limit` 仍为 1–100；项目汇总、指定项目详情及跨会议历史先读取完整存档，再按项目和历史规则筛选，不再先截全局最近100场而遗漏老项目。

**会议名称（2026-10-09）**：`GET /v1/meetings/{id}` 返回 `display_title` 和 `title_source`，列表每项返回 `title`/`title_source`。优先级：手动改名（`manual`，存在会议文件 `title`，同步不覆盖）→ 议程目标（`agenda`）→ AI 概括（`generated`）→ 不足 5 句时显示"简短会议"（`short`）→ 按原话自动取（`auto`：第一条未被驳回的决定/待办/约束，人工确认过的优先，去掉"那、就是、嗯"等开头，截 18 字；都没有时取最长一句）→ 无（`none`）。AI 概括：会议有 `ended_at` 或开始超过 3 小时、至少 5 句、没有手动名称和议程目标时，打开会议列表会在后台逐场请求 DeepSeek（整场文字最多 6000 字，标出未驳回的决定/待办/约束），回答 2–16 字才采用，连同当时句数存在会议文件 `auto_title`；句数变化后重新生成，生成期间文字变了则丢弃。没有 DeepSeek 时只用按原话自动取。

**会后核对队列**：`GET /v1/meetings/{id}` 另返回 `review_queue: [{kind, id}]`，顺序为待办（`commitment` 且未核对、未建飞书任务）→ 决定（`decision` 且未核对）→ 说话人（没有说话人、未人工改过、去掉标点后至少 4 个字；待办和决定的句子排在前面）。会议列表每项加 `review_pending: {commitment, decision, speaker}`。被核对为 `rejected` 的句子不再出现在 `digest` 和跨会议冲突比对里，模型标签原样保留。`scripts/review_truth.py <会议文件>` 把核对结果转成 `task_eval.py` 的真值格式（标 `blind:false`、`scope:"model_candidates_only"`）：只问过模型标出的句子，模型漏掉的任务不在里面，所以只能看精确率和负责人，召回要用 `label_meeting.py` 的盲标。

句子/提醒按 id upsert；会议上限 20,000 句及 2,000 条提醒。同步字段采用白名单，仅文字、正式标签、说话人、提醒和议程；不保存音频、词时间戳、试验 preview 或额外上传字段。每句最多 2,000 字，编号 `[A-Za-z0-9_-]{1,100}`，开始日期必须含时区且创建后不可更改。历史待办另有 owner_hint/when_raw/task_status/task_url；self 仍不自动填负责人。搜索预选最多 120 句交给 Jev，失败时仅按字面重合找原话。历史打开与搜索在 App 中只读，不回听、不创建任务。

App 每场队列绑定开始时的后端；20 秒或累积 30 句发送，同一队列单请求，停止时标记 ended_at 并最终发送。失败指数退避，404/501 停用，不合法数据等永久错误停止队列。队列在内存中，进程被系统结束时尚未成功同步的文字可能丢失；已同步内容仍在服务器。`memorySync` 默认开，可关闭自动发送。部署/安装前须按本轮计划确认四位成员同意文字上传。

`healthz` 新增 `notices:true/meetings:true`，只表示接口存在，不表示 Jev 中文判断已验收。


## 任务列表 `GET /v1/tasks?assignee=<名>&status=open|done|all`（2026-10-09；2026-10-13扩展）

列出经确认已在飞书创建的任务，按创建时间倒序。仅 App 全权限凭据。每条含 `op_id、what、who`（飞书里的实际负责人，读不到时用草稿负责人）、`who_drafted、when、quote、utterance_ids、session_id、meeting{started_at,goal}、created_at、url、overdue`，以及 `feishu`：

- `state`：`open`／`done`／`deleted`（飞书里已删除）／`unknown`；另有 `due_ms`、`completed_at_ms`、`assignee`；
- 状态在有人请求时用 `lark-cli task tasks get` 回读，缓存 5 分钟，不做后台轮询；读取失败时返回上次的结果并标 `stale:true`，从没读到过则为 `unknown`；
- `status=open` 也包含 `unknown`，避免读不到时任务被悄悄藏起来；dry-run 创建的任务一律 `unknown`。

2026-10-09 在香港服务器实测：Oops 授权账号能回读它创建、指派给他人的任务（创建者不在成员里也可以），删除后返回 `not_found`（1470404）。

2026-10-13 增加独立的 `parsed_items` 与 `parsed_status`，原 `items` 仍只表示已创建的飞书任务。核对站三场 `0235/0236/0238` 的16个原始待办候选由服务端私有 `label-app-tasks.json` 显式授权并绑定事项指纹；不复制原会议、不生成模型结果、不写人工答案。已归档的操作回执不列入 `items`，原 `op_id` 防重记录保留。

- `parsed_items[]`：`id=label:<meeting>:<item_id>`、`item_id`、`source=label_review`、`kind=task`、`title/what/detail/due`、`source_meeting{id,title}`、`fingerprint`、`evidence[]`、`reviews[]`、`source_status=current`、`owner=null`、`owner_conflict/review_conflict`、`read_only=true`、`review_url`。`evidence` 带原句ID、文字、时间、当前一致姓名及各人的 `speaker_reviews`；说话人不转为负责人。
- `reviews[]`：每人一条，`by/verdict/updated_at/revision`；当前人工核对另有 `kind/title/detail/due/owner/into`。`verdict` 为 `unreviewed/confirmed/rejected/merged/source_changed`。确认可改类别；`owner=collective/unknown` 对应大家／尚未确定，不归入某个本人。核对确认不表示业务完成或飞书创建。
- `parsed_status`：`state=ready/partial/unavailable/disabled`、各场 `meetings{id,status,count,reason_code?}`、`counts.total` 及按人次计数的 `review_counts`。来源、盲测集合、授权指纹变化或读取不一致时，不返回该场旧正文；候选不受飞书业务 `status/assignee` 筛选，App 单独按明确人工负责人筛本人。

适配只访问固定 loopback 核对站，禁代理与重定向，全服务最多3个并行读取，单次4秒、整份快照6秒期限。App 请求的 `requestId` 在原生桥成功与失败事件中回传，用于隔离迟到响应；刷新失败清除候选缓存，正式飞书任务缓存仍按既有错误提示展示。

2026-10-14增加独立 `meeting_items`：读取App真实会议中当前有效、已人工确认的纪要待办，沿用原 `item_reviews`，不复制核对站答案、不调用模型。每条使用 `source=meeting_review`、真实 `session_id`、原话依据和人工负责人；归入本人仍须明确负责人，不从说话人推断。已经按同一依据创建正式任务时保留关联回执，避免在候选里重复展示。人工确认的纪要决定同样进入项目历史决定；无人工确认不以AI候选填充。

首页和记忆独立显示核对站候选与App会后已确认待办数量；从外部核对站返回会刷新当前状态。读取期间撤下旧候选正文，失败不能把旧缓存继续当当前依据。正式任务保留历史回执，来源失效会另带状态，不继续提供已失效引用作为当前原话。

## 原始录音与转写存档 `/v1/recordings/{session_id}`

只有明确选择云保存的正式会议才进入此链路；日常临时聆听不创建原始录音/全文归档。新会议原声和全文各默认30天，可分别选7/30/90天；沿用分块、断点续传和校验能力。已存旧资产不追溯修改，删除会议仍连同资产删除。仅 App 全权限凭据可用，声纹邀请凭据403，无凭据401；存于 `<state-dir>/recordings/<session_id>/`（0700/0600）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/manifest` | `{"files":[{"name","size","sha256"}],"meta":{},保存合同字段}`；`name` ∈ `audio.pcm`（16 kHz mono s16le，断流补静音）、`finals.jsonl`、`asr.jsonl`、`timing.jsonl`、`meta.json`。返回 `{"complete","received":{name:bytes},"storage_policy":{...}}`；清单变化时超出新大小的文件从零重传，合同不得延长期限 |
| PUT | `/{name}?offset=N` | 原始字节分块（≤1.1 MB），头 `X-Content-SHA256` 为本块哈希；`offset` 必须等于已收字节，否则 409 并返回 `received` |
| POST | `/complete` | 逐个整文件复算 SHA-256；不一致的文件删除并 409（`received:0`）；全部一致写 `complete.json` |
| GET | （无后缀） | 存档状态，另含 `assets:{audio,transcript}`（available/pending/expired）、`storage_policy` 和 `expires_at:{audio,transcript}`；`complete`是曾完成校验，是否仍可用以分项assets为准 |
| GET | `/clip?start_ms=A&end_ms=B` | 截取一段原声，返回 `audio/wav`（16 kHz 单声道），前后各多 300 ms；最长 30 秒。还没有录音 404，这一段还没传到 409，参数无效 400 |

已删除会议编号返回410，迟到重试不能重建。新会议原声或全文到期后，相关上传/回放返回410，并在 `error` 附 `asset:audio|transcript`、`expires_at`；客户端终止该类别重试并清理相应本机资产，不能因“尚未上传”无限保留。另一类别尚未到期时继续保留；旧资产沿用上传核验后7天/2GB的本机清理规则。Mac现有03:30 rsync继续镜像删除，新增镜像本地期限清理要求见下。

## 保存策略合同与实际清理（2026-10-12，本地验证，真实服务器待升级）

`GET /healthz` 返回 `archive_policy_version:1`。新App发送新模式正文前须核对该能力；公开网站不调用真实归档，也不包含服务凭据。日常可发送经授权的短时ASR/分析上下文，`recording_mode:"daily"` 不是会议云保存授权；服务器不把分析正文写入归档，相关内存缓存5分钟失效，常规HTTP日志只写接口、数量、状态和耗时。云端即时处理仍可能发送音频，不能称完全离线。

新 `sync` 和 `manifest` 顶层均携带以下同一会话快照，不读取重试时已改变的全局偏好：

```json
{"recording_mode":"meeting","cloud_save_confirmed":true,
 "archive_started_at":"2026-10-12T12:00:00Z",
 "audio_retention_days":30,"transcript_retention_days":30}
```

原声/全文期限分别允许7/30/90，省略分别默认30；模式、明确确认和开始时间不能省略。`archive_started_at`须与新会议`started_at`同一时刻，日常转会议使用新的session并从切换开始。服务端把时间规范化UTC、保留至微秒，返回 `storage_policy` 含两个独立 `*_expires_at`；按首次合同开始时间加天数计算。重复请求不续期，修改合同409；日常/未确认/新会话缺合同400，过期类别410。已存在且无合同的legacy会话继续原策略；本机旧记录从未到过服务器且无原授权快照时，不会用当前偏好补造授权。

到期全文变为 `utterances:[],notices:[],transcript_status:"expired"`，保留会议元数据、确认摘要、关联任务和独立短依据，后者放 `retained_summaries/retained_evidence`，不混回全文。项目、历史查询可使用明确标记 `source_kind:"saved_excerpt"/source_status:"expired"` 的确认短证据；不能据此承诺全文仍存在或原音仍能播放。原声到期删 `audio.pcm`；全文到期删 `finals.jsonl/asr.jsonl/timing.jsonl/meta.json`，留无正文的策略/校验元数据防重建。待执行助手输入中的全文、上下文和摘要一并移除，任务失效停止执行/交付；已完成的独立成果及外部回执保留为历史。已发布外部文档不由此自动删除，不能承诺替用户清除第三方副本。

真实后端的 `main()` 启动即清理，并每5秒执行一次；读写接口也执行到期检查。复用现有 `deploy/oops-backend.service` 启动入口，升级须同时发布 `archive_policy.py/cleanup_archives.py/meeting_features.py/recordings.py/local_backend.py/feishu_actions.py`，不能仅覆盖旧升级脚本列出的部分文件。离线清理或镜像安装使用管理员明确指定、已存在且包含`meetings/recordings`的本地目录：

```sh
python3 scripts/cleanup_archives.py --state-dir /var/lib/oops/backend
python3 scripts/cleanup_archives.py --state-dir /Volumes/GPFS/Users/a1234/oops-archive
```

脚本不连接远程URL、不推断镜像地址、不删除legacy内容。服务器进程停机期间可由systemd oneshot调用同一脚本，timer设置 `OnBootSec=1min/OnUnitActiveSec=1min`，运行用户与目录权限沿用`oops-backend.service`；不要与正在写入同一目录的服务并发执行离线脚本。

Mac沿用 `deploy/mac/oops-archive-pull.sh` 的既有03:30双向链路，默认镜像目录仍为队友Mac的`/Volumes/GPFS/Users/a1234/oops-archive`。更新脚本后，每次拉取在rsync前后执行TTL清理，即便拉取中途失败也清理已复制的过期资产。运行 `sh deploy/mac/oops-archive-pull.sh --install-cleanup` 会替换`~/.local/share/oops-archive/pull.sh`并安装每60秒的`local.oops.archive-cleanup` launchd任务，保留原夜间拉取任务；分钟任务仅本机清理、不连服务器。拉取与分钟清理共用`fcntl.flock`跨进程锁，进程退出自动释放，避免rsync和清理互相覆盖。依赖同一Mac上可用的Python3、当前仓库策略模块、GPFS卷和原SSH授权；非默认安装可显式配置`OOPS_ARCHIVE_DEST/REPO/HOST/PYTHON`，管理员须指定可信的已有本地目录。卷未挂载时跳过，不创建假镜像。夜间拉取仍会取得服务端尚未清理的文件，但本地后置清理立即删除过期类别；不能把03:30同步当全天到期清理。

本轮仅验证本机临时目录中的实际删除、Mac脚本入口、跨进程锁、失败拉取后清理及HTTP合同，没有部署服务器、在队友Mac安装调度任务或删除真实数据。当前开发Mac没有上述GPFS路径/已安装pull任务；香港SSH只读检查停在主机密钥验证，尚未验证当前机器的服务器登录权限，不能沿用另一台Mac的历史部署结果宣称已上线。

## 本场实时任务清单（2026-10-12）

`POST /v1/actions/draft` 可带 `"board": true`（App 只在后台取负责人提示时这样做）。服务器把这句补全出的任务交给 `scripts/task_board.py`：和本场已有任务合并、排 P0–P3，或丢弃举例、当场做完的事和空话；随后续对话调整优先级或作废。更新在后台进行，响应里的 `board` 是这句之前的清单，`pending: true` 表示还在整理，App 稍后读 `GET /v1/meetings/{id}/board`。清单存在 `<state>/boards/<session>.json`，重启不丢。

清单只用于展示和排序：建飞书任务仍要从原话生成草稿并由人确认（op_id 规则不变）。会上只请大家确认 P0，其余会后处理。每条任务带原话编号 `sources`；没有出处的任务、不是团队成员的负责人都会被丢掉。

## 会后事项核对 `items` 与 `POST /v1/meetings/items`（2026-10-13）

有纪要的会议，会后核对的对象从“句子”改为**纪要事项**。`GET /v1/meetings/{id}` 在纪要存在时多返回 `items`，`review_queue` 只列待核对事项 `{kind:"item", id, item_kind}`，不再列逐句的待办/决定/说话人；列表的 `review_pending` 按 `task/decision/open` 计数。没有纪要（会议进行中、机器人未启用）时保持原来的逐句队列。

`items[]`：`{id, kind: task|decision|open, title, ids, due?, owner_hint?, priority?, detail?, evidence:[{id,text,start_ms,end_ms,speaker}], fingerprint, review, stale_review, stale, task_status, task_url}`
- 由已存纪要即时派生（`scripts/minutes_items.py`），不调用模型：`actions`→待办（主线在前），`decisions`→决定，`undecided` 与 `open_questions`→待定。
- `owner_hint` 只是“原话里有人认领”的提示，App 不预选；负责人由人选（团队成员或“大家”）。
- `stale:true`：纪要依据已变化（与 `/minutes` 的 `source_changed` 同一判断），事项只读、不进队列。
- `review` 只在事项内容与依据原句未变时有效（`fingerprint`）；改写过的事项会以新事项出现，旧核对不沿用。

`POST /v1/meetings/items`：`{session_id, item_id, fingerprint, action, by?, kind?, title?, due?, owner?, into?}`
- `action`：`confirm`（待办必须带 `owner`；可同时改类别/标题/截止）、`reject`（不是事项）、`merge`（`into` 另一事项）、`reopen`（撤回）。
- 返回 `{session_id, items, review_queue}`。事项或依据已变化 409 `ITEM_CHANGED`；纪要已失效、负责人不在名单、缺负责人 400；会议不存在 404。
- 核对存于会议的 `item_reviews`，**不写句子核对**，因此不会让纪要失效。

纪要提示（`MINUTES_VERSION=5`）：有人反对、仍在争论或只是倾向的不算决定，写入新增的 `undecided:[{topic, views, ids}]`；`owner` 只在原话里本人认领或被点名时填写。已有纪要不重写。

Android：H5 发 `items.review`（`sessionId,itemId,fingerprint,action,…`），原生转发到上面的接口并回 `items.saved`；错误走 `error`，`scope:"items"`，409 带 `changed:true` 并重新打开会议。


## 2026-10-13 转写收尾与事项质量

`GET /healthz` 增加 `item_quality_version: 1`、`asr_closure_version: 1`。

末次 `POST /v1/meetings/sync` 可携带 `asr_closure`（`acknowledged` / `incomplete` / `cancelled`），只允许同时提供 `ended_at`；可选 `asr_error_code`（80字内）与已去凭据 `asr_error`（500字内）。状态随详情及列表回传，同场已保存的终止状态不能被不同状态的迟到同步覆盖。录音元数据恢复只补缺失状态，不覆盖已有结果。`acknowledged` 仅表示服务终止回执已收到。

任务板 `tasks` 只含通过来源检查的待办及已完成/作废历史；`review_queue` 保存待核对候选，状态为 `needs_review`，含 `quality: {status, reason, ids, issues?}`。待核对内容不计入可执行待办。草稿数字含混时 `what` 留空并通过 `task_context.missing` 请求核对，不能直接预填确定任务。

会后纪要与已有缓存共用质量检查：被拒动作保留在派生 `quality_rejected` 审计，含混动作转入 `undecided`；不修改原缓存、不触发模型重生成、不确认负责人。引用或来源变化继续遵循原有失效与人工核对规则。
