# 按当前真机源码合并后端来源合同

本轮后端以真机对应的干净源码 `c1ef1560a5bac7fbe2b29c14b83bc542d142909e` 为兼容基线，路径 `/Users/a1234/.codex/worktrees/pr10-device-deploy/oops`。这里只说明源码合并与本地回归，不代表已经更新服务器、安装 APK 或完成真实飞书授权。

## 合并证据与可恢复原稿

修改前将工作目录 `scripts/` 与 `tests/` 的 179 个源文件完整复制到 `build/feishu-server-port-backup-20261014`，共 2,290,910 字节。`manifest.json` 逐文件记录原 SHA256，保留用户已有 WIP、个人 OAuth/owner/receipt 边界、纪要核对发送和关闭自动外发的实现。

三方合并使用 base=`c3d1f7e2c12cdd4a5d366d7cbe7f2b98ded291bc`、ours=上述原稿、theirs=真机基线 `c1ef156...`。备份的 `merge/` 保留各文件 `.base/.ours/.theirs`、原始合并冲突与 `.resolved`。`port-final-record.json` 记录逐项冲突选择及最终 SHA256。

## 必须保留的真机合同

- `action_sources.py` 使用完整真机版本。服务器签名的 `source_binding` 包含来源 ID、原话 hash、revision、说话人、人工核对及 `context_sources`；不能用手机提供的 hash 或旧原话拼造合同。修订再撤销也增加 generation，旧授权不复活。日常短依据同时绑定上下文、五分钟范围、280字及短时 receipt。
- `meeting_features.py` 使用完整真机版本。每次写入刷新来源 generation；自然到期的已独立确认短依据保留 `source_text_hash/source_revision/source_board_hash`。重新确认短依据使用 `_action_rebind`，保留与到期分开。
- `task_board.py` 保留真机的 `board_source_hash`；全文到期仅允许可用的独立短依据继续支撑旧任务板。GET board 同时给 ready tasks 与 review queue 加签名合同，`/healthz` 保留 `action_source_binding_version:1`。
- `local_backend.py` 保留起草前后来源核对、确认及实际写入前复验、source lock→ops lock 顺序、写前持久标记，以及 `source_invalidated/no_external_write` 错误语义。兼容 `external_write_attempted` 与旧 `external_attempted` 两代日志；未知结果不能变成可自动重试的失败。

这些字段是当前真机 `TaskSourceBinding.kt` 和 `RetainedTaskEvidence.kt` 的依赖；只更新手机而继续使用旧后端会让来源任务不可用，或丢掉来源撤回保护。

## 本轮个人授权与发送边界

20 处 `local_backend.py` 冲突逐项处理，保留真机来源合同，同时保留 `MobileFeishu` 初始化、本人任务绑定、owner/receipt 归属、来源撤回/删除/TTL 的纪要稿失效钩子、账号隔离的列表与状态读取、个人 Feishu API 创建/回读及 OAuth callback。不恢复服务器共享个人 CLI 代写。

`feishu_actions.py` 的台账冲突选择本轮实现：后台只存私有纪要，不自动建文档、授权、私聊或写台账。旧 calendar/research/ppt/report 卡片要求回 Oops 重新核对，旧排队成果仅私有保存；历史文档与已发回执保留。新纪要只通过个人 `minutes_delivery` 确认流程发送。具体接口、官方依据与恢复规则见 `minutes-delivery-contract-20261014.md`。

## 本地验证

以下均使用示例与 fake/dry-run，不写真实飞书，不调用模型：

| 测试 | 项数 |
|---|---:|
| 真机 action_sources | 32 |
| 保存策略 / 后端只读路由 / 任务板 | 21 / 7 / 12 |
| 个人 OAuth / 手机归属与签名来源组合 / 纪要发送 | 31 / 9 / 25 |
| 旧机器人流程 / 纪要来源失效 | 14 / 13 |
| 后端 HTTP / 会话与提醒 / 核对队列 | 2 / 15 / 6 |

合计 187 项回归通过，另通过 `local_backend.py --self-test` 与受影响 Python 编译。OAuth 31 项使用已存在的临时依赖目录 `/tmp/oops-feishu-account-test-deps`，没有跳过加密测试，也没有更改系统 Python 环境。106项来源/保存/路由/个人手机/发送组合与65项 OAuth/手机/发送组合有重叠，未重复计数。

没有改原生或 H5 界面，没有改真机基线 worktree，没有部署或安装；源码通过不等同当前服务器已支持个人 OAuth。
