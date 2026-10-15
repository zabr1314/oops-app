# Agent 原成果交付与恢复

本轮仅在 `codex/backend-personal-reliability` 隔离工作树实施，未部署、安装、调用 Claude 或真实飞书，也未产生模型费用。旧共享身份卡片仍拒绝研究、报告、PPT提交与发送；本轮不恢复旧自动外发。

## 生成与传输

`Jobs` 分开保存 `generation_status` 和 `delivery_status`。生成成功先原子固定 `结果.md`、原文件清单、大小与 SHA256、`result_revision`，再返回内部执行器回执。上传分片及结果回执可重复读取同一结果；不能替换已固定文件。失去生成回执或执行租约不自动重新生成，同一请求 key 也不因 failed 换新 job。重新生成需另行明确授权的新请求。

Mac 执行器用后端地址指纹与完整 job ID 定位受管目录，生成前保存开始标记，成功后先保存正文再渲染与传输。PPT渲染、上传或回包失败只恢复同一成果；本地持久输出已存在就不再运行模型。后台仅恢复已有输出，不能触发新生成；未获服务端确认的输出不被30天例行清理删掉。旧时间命名目录保留，不推测导入其他服务。

## 本人核对与发送

`AgentDelivery` 使用独立目录复用 `MinutesDelivery` 的核对稿、绑定版本、跨进程锁、发送 journal 及后台 worker。调用方必须核实 job 与来源会议归属；`requesters`、姓名或共享服务凭据不能证明本人。旧成果没有明确归属或有效生成来源快照时默认拒绝，不自动认领。来源当前有效、原文件一致也不代表内容已经人工验收。

核对稿绑定 job、生成版本、来源快照、所有原文件的哈希、当前本人账号与绑定版本。默认收件人、原文件选择均为空，文档权限默认查看。手改正文不改原文件；文件需明确选择，并确认“原文件是可下载副本，不受文档查看/编辑权限控制”。正文、收件人、权限、附件选择变化都会增加核对稿版本。

本人确认后创建和写入文档、核对隐私、授权所选人、发送正文链接；所选PPTX等原文件按原字节上传，再逐收件人发送文件。每次外写前核对来源、文件、账号和收件人；绝不使用机器人或服务器CLI兜底。

每个文档步骤、文件上传和收件人消息均先保存 pending，再记录真实回执。确定失败恢复原 op 的未完成步骤，不重建已有文档、重上传已确认的原文件或重发已成功的消息。超时、网络未知及进程在 pending 时中断保留 unknown，只核对原操作，不能换 op 或新核对版本绕过。来源或绑定撤回阻止后续交付，历史回执保留。

## 官方文件协议与权限

本轮只读核对[飞书官方 Go SDK 的 File.Create](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/resource.go#L1068)：`POST /open-apis/im/v1/files` 同时支持 User/Tenant；本实现只用本人 user token。官方[结构定义](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/model.go#L13356)是 multipart `file_type/file_name/file`，返回 `file_key`；本实现以 `stream` 保留PPTX原字节，不做格式转换，单文件限制20MiB，低于官方30MB上限。

随后调用[官方 Message.Create](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)，`msg_type=file`，正文只含真实 `file_key`；消息 UUID 绑定原 op、文件版本与收件人。发送需要本人 `im:message` 和 `im:message.send_as_user`，上传需要 `im:resource` 或 `im:resource:upload`。Accounts分别报告 `files_upload` 和 `agent_file_delivery` 能力，缺权明确失败；应用机器人能力、管理员批准、可用范围及真实个人发送仍需部署后验收，SDK支持不能代替官方服务真实回执。

## 接口协作

`AgentDelivery(directory, auth, jobs, owner_fn(job, principal), source_fn(job))`。`source_fn` 只核对来源，不生成内容；`owner_fn` 由个人会话和服务端归属实现。外层个人接口使用 `prepare/save_review/confirm_async/status`，`confirm_async`必须带 `confirmed:true`；执行器仍使用独立 `/v1/agent/*`，不把执行器凭据给App。

`save_review`使用 `revision/title/content/recipients/permission/attachments:[name]/attachment_copies_confirmed:true`。`artifact(token, job_id, name)`只返回本人当前有效原成果，HTTP层须使用鉴权及 `no-store`，不能拼造公开文件URL。个人派发与手机入口由同一隔离任务的接口/Android改动接入。

## 验证边界

新增测试使用临时目录、合成PPT字节、真实本地加密和 fake HTTP。覆盖原成果先保存、分片/结果回执丢失、租约未知、进程恢复、逐收件人确定失败、文件上传未知、账号/来源/文件变化、旧成果归属、文件副本确认和无权失败。原 `MinutesDelivery` 模块未改，既有纪要发送回归继续运行。具体最终测试数量由主任务统一记录，不能把离线测试写成真实发送、完整PPT人工审查或生产部署完成。
