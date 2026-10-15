# 本人日程确认与可靠回执

本轮是隔离工作区中的代码实现和假服务验证，未连接真实飞书、部署后端、安装手机或创建日程。原共享机器人卡片继续关闭日程创建；个人流程使用已有 `Accounts.user_request_for_principal`，不回退 CLI 或机器人身份。

## 接入契约

`CalendarDelivery(directory, auth, meeting_loader, source_fingerprint_fn, owner_fn)` 复用个人账号、会议归属与当前纪要来源指纹。`meeting_loader` 返回会议及 `delivery_analysis.follow_ups`。已有后续安排从明确原句 IDs（旧数据可匹配精确短引文）生成稳定 `fu-…` 编号；参会人名字仅是线索，不变成预选账号。手工安排使用 `followup_id=manual`，仍绑定本人会议。

建议手机路由如下，均需既有服务鉴权和原生 `X-Oops-User-Token`：

| 请求 | 模块调用与结果 |
| --- | --- |
| GET `/v1/meetings/{id}/calendar?followup_id=manual` | `prepare(token, sid, followup_id)`；只准备私有草稿及建议，不创建日程 |
| POST `…/calendar/save?followup_id=…` | `save_review(token, sid, body, followup_id)`；保存人工核对版本 |
| POST `…/calendar/confirm?followup_id=…` | `confirm_async(token, sid, body, followup_id)`；先持久化操作，再异步执行，直接返回操作对象 |
| GET `…/calendar/status?followup_id=…` | `status(token, sid, followup_id)`；只读本地回执，不等待外部网络，不重新创建 |

prepare/save/status 返回 `{session_id, followup_id, suggestions, draft, calendar}`。dispatcher 将 confirm 返回值包为 `calendar`。异常 `CalendarError` 具有 `status/code/message`。

save 必须携带当前 `revision`、`title`（100字内）、`description`（2000字内）、带 UTC offset 的完整 ISO `start/end`、IANA `time_zone` 及显式 `attendees` open_id 数组。时间与时区必须匹配、结束晚于开始、时长不超过7天。仅本人日程选 `attendees: []`，也必须先保存再独立确认；不从发言人或纪要建议中自动邀请。

confirm 必须携带 `confirmed: true`、保存后的 `revision`、稳定 `op_id`。服务端只执行冻结稿，不接受 confirm 夹带的新正文、时间或名单。账号、绑定版本、来源、名单或显示姓名变化须重新核对。所选账号来自本人当前可见的飞书官方姓名搜索核验结果或同组织已绑定目录；保存时冻结服务端核实的 `attendee_names`，不接受客户端指定姓名。每步请求由账号模块在同一绑定锁内重核当前搜索证据和冻结姓名；搜索/刷新令牌之后、实际 HTTP 之前再检查来源指纹，不在等待期间沿用旧许可。

## 成功与恢复

每个本人身份和安排使用持久日志、原子替换、文件与目录 fsync、跨线程/进程文件锁；Opaque 手机会话与飞书令牌不写入日志。操作在排队和任何外部写入之前保存。相同版本更换 op_id 仍返回原操作；相同 op_id 不能换安排或版本。已提交安排不能通过编辑再造第二份日程。

创建只使用本人主日历。提交还携带稳定 provider `idempotency_key` 作为额外防重。创建回包的 `event_id` 立即落盘；随后必须 GET 同一个日程，匹配事件 ID、日历、标题及起止时间，才证明日程存在。即使创建回包已有链接，也必须回读。链接仅采用官方域名 HTTPS 的显式回包，没有就保留为空，不拼造地址。

参与人另一步添加：创建时不带参与人并关闭通知；日程已回读后，才按确认的账号名单添加并核对参与人列表。没有明确名单就不调用邀请接口，不额外添加录音人。来源或账号在两步之间变化，停止未执行的邀请，保留已存在日程的真实 ID。

| 状态 | 含义与允许恢复 |
| --- | --- |
| queued / creating / inviting | 原请求正在处理；重复点击返回原回执 |
| created_unverified | 已有日程 ID，但回读未确认；再次明确确认原请求只 GET 该 ID |
| invitation_unknown | 日程已存在，但邀请结果待核；恢复只读取原参与人列表，不重发未知邀请；明确拒绝且确定未提交的邀请可在原操作中恢复 |
| unknown | 创建可能已发生但无可靠 ID；不重新 POST，需核实本人日历 |
| created | 日程已回读；选定邀请如有也已回读，整条流程才显示成功 |
| failed / invalidated | 明确失败或来源/授权已撤回；保留原回执，不把队列接收当成功 |

进程在写请求后中断，持久 pending 不当作“没创建”。已有 event_id 只读恢复；没有 ID 则转未知。普通状态读取不会自动调用飞书。`invalidate(sid, reason, purge_content)` 供来源修订、删除和 TTL 清理调用；到期清除草稿与冻结稿文字，保留历史 ID 和成功/未知事实，不声称自动撤回第三方日程。

## 能力与官方接口

`calendar_create` 只表示创建权限；`calendar_read` 表示本人主日历查询与日程回读能力；`calendar_delivery` 要求二者同时具备。单独创建 scope 不能宣称整条流程已就绪。邀请另看 `calendar_invite`，仅本人安排可以在没有邀请能力时进行。当前识别既有宽权限 `calendar:calendar`，以及创建、只读、更新能力的组合；不代用户申请或扩大授权。

API 依据：[本人主日历查询](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/primary)、[创建日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create)、[回读日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/get)、[添加参与人](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event-attendee/create)。请求字段和 user-token 支持另核对官方 [Python SDK 创建请求](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/api/calendar/v4/model/create_calendar_event_request.py) 与 [事件模型](https://github.com/larksuite/oapi-sdk-python/blob/v2_main/lark_oapi/api/calendar/v4/model/calendar_event.py)。

## 本地验证

`cd scripts && python3 -m unittest test_calendar_delivery -v`：41 项通过，全部使用临时日志和假 API。覆盖本人归属、显式确认、时间与名单、夏令时 offset/不存在时间、权限、写前持久化、缺 ID、回读不匹配、已知 ID 恢复、未知写不重放、重复点击、换操作号、重启、跨实例锁、邀请明确拒绝与未知的分别恢复、官方目录核验姓名快照、来源/账号变化、等账号锁期间来源撤回、快速状态读取及到期文字清理。真实 OAuth scope、线上配置、飞书日程与手机交互仍需后续独立验收。
