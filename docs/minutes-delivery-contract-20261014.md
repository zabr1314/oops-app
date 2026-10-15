# 个人飞书纪要发送契约

2026-10-14 按用户授权改为：手机绑定本人的飞书，先核对正文、账号和收件人，再确认发送。后台整理仍复用已有纪要，新增核对和发送不调用模型。

`scripts/minutes_delivery.py` 从服务端用户会话解析 principal，使用 `Accounts.user_request_for_principal(principal, method, path, body, params, expected_binding, expected_recipients)`。在同一账号事务锁内核对绑定版本、账号、租户及所选收件人后提交，防止核对与提交之间更换账号。不读取服务器个人 CLI 登录，不使用机器人兜底。官方 API 的令牌类型已与飞书官方 SDK 对照：发送消息接口同时支持 tenant/user token；本次只用个人 user token。实际授权范围、应用可用范围、管理员批准和官方回执仍需部署后真实联调。

## 接口与身份

- `MinutesDelivery(directory, auth, meeting_loader, source_fingerprint_fn, markdown_fn, owner_fn)`；owner 默认拒绝。HTTP 层必须根据服务端用户会话给新会议写入归属，不能接受客户端自行认领旧记录。
- `prepare(token, sid)` / `status(token, sid)` 返回 `{session_id,draft,delivery}`；prepare 读取当前已存纪要生成私有核对稿，默认收件人空、权限 view。status 直接读取原子 journal 与账号身份只读快照，不获取发送线程持有的长锁，不发消息；来源失效时仍保留历史发送回执。调用方的 owner registry 也须提供不等待外部网络锁的归属快照。
- `save_review(token, sid, {revision,title,content,recipients:[open_id],permission})` 保存编辑稿，revision 增一。收件人须通过当前已绑定且同租户的账号目录校验，权限仅 view/edit。
- HTTP 使用 `confirm_async(token, sid, {revision,op_id})`，排队前同步核对 owner、revision、来源及账号绑定，先持久化 sending 回执再启动后台线程，立即返回；重复操作查询同一回执。worker 使用内部 `confirm` 执行并持久化结果，连排队后再次预验失败也会记录 failed/invalidated，不留永久 sending。不采用客户端附带的正文、收件人或摘要。状态为 sending/sent/failed/partial/unknown/invalidated；未知写入不能换 op_id 绕过。
- `invalidate(sid, reason, purge_content=False)` 撤回派生发送许可，供原话修订、删除和到期清理调用。全文到期/删除用 `purge_content=True` 清掉本地核对稿正文副本；已发送历史回执保留。

## 发送步骤与恢复

创建本人根目录空文档 → 关闭链接分享与组织外分享，并只准管理者再分享 → 回读权限 → 写入核对稿正文 → 查询官方文档实际 URL → 仅对所选人授予 view/edit → 向所选人发送已核对纪要卡片。不自动添加本人、推断参会人或写团队台账。正文按行写成原样文本块，避免把手工输入的 Markdown 链接/提及当成外部操作。

每次外部写入前持久保存 pending，成功保存对应回执；跨线程/进程文件锁防并发。重复点击及换新 op_id 不重复发送同一 revision。明确失败可继续原 op 的剩余步骤，不重建已有文档、重写已完成正文或重发已确认消息。超时、网络未知或写后崩溃保留 unknown，停止自动重放和新 op 绕过；需要人工核实官方结果后再处理。来源或账号撤回后停止剩余步骤，历史回执保留。

旧共享身份卡片的 calendar/research/ppt/report 动作只提示回 Oops 绑定本人账号并核对，不继续提交日程、查询或外发成果。旧队列可以回收已有任务结果到私有文件，状态明确为 needs_personal_review；不自动建文档、授权、发卡、发文件或发失败通知。历史文档地址、sent 回执和已完成记录保留，不能通过旧卡再次发送。

## 官方依据

本轮访问官方文档，并在页面正文无法被文本工具读取时直接核对官方维护的 OpenAPI SDK 源码，未用第三方教程决定 API 契约：

- [创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create)、[创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create)。
- [协作者授权](https://open.feishu.cn/document/server-docs/docs/permission/permission-member/create)、[权限设置](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/patch)、[文件元数据](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/batch_query)。
- [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)。用户发送需要对应用户消息权限（含 `im:message`、`im:message.send_as_user`）且应用启用机器人能力和合适的可用范围，缺权限应失败，不切换别人的身份。
- [飞书官方 CLI 用户消息说明](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md)明确列出 `im:message.send_as_user`（点分隔）与 `im:message`；[飞书官方接入治理说明](https://www.feishu.cn/content/article/7615520954977881029)说明用户发送可支持文本、图片、文件和卡片。
- [飞书官方 SDK 消息接口](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/resource.go#L1143-L1155)：`POST /open-apis/im/v1/messages` 支持 `AccessTokenTypeUser` 和 `AccessTokenTypeTenant`；[消息类型定义](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/im/v1/model.go#L12743) 支持 interactive。
- [官方 SDK 权限 GET/PATCH](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/drive/v1/resource.go#L1481-L1513)：本次沿用仍受支持的 v1 路径，并非 v2 字段混用。v1 `type=docx`、`external_access=false`、`link_share_entity=closed`、`share_entity=only_full_access` 与[官方枚举](https://github.com/larksuite/oapi-sdk-go/blob/v3_main/service/drive/v1/model.go#L603-L645)一致。官方推荐的新项目使用 v2；本轮 v1 可后续迁移，不影响失败关闭原则。

## 本轮验证边界

只运行 fake transport、本地状态和来源失效测试，没有向飞书创建真实文档、授权、发送消息或调用收费模型。真实 OAuth 配置、批准 scopes 与手机回调须单独验收，测试通过不表示外部服务已部署。
