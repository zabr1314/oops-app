# Oops 主动沟通 Raft：本机接入

用户授权尝试 Oops 主动向本机 Raft / Slock 发送消息或指令，随后明确允许创建独立身份、保存通信凭据及发送一条连通确认。首版链路为：Oops 本机页面/客户端 → 私人后端消息 API → SQLite outbox → 官方 Raft SDK → 指定 Raft Agent。

## 实施

- `scripts/raft_outbox.py`：独立消息、发送尝试、回复表；显式确认、目标白名单、请求幂等、租约与未知结果保护。不混入既有 Mac Jobs，不自动读取会议、任务或录音。
- `scripts/raft_api.py`、`scripts/local_backend.py`：沿用现有服务鉴权增加 API，App token 与 worker token 分开；默认关闭。
- `scripts/oops_raft.py`：本机私人服务与客户端，监听回环8798。一次点击本机连接只取得此消息库的令牌；令牌不通往生产数据。
- `scripts/raft-bridge/`：官方 SDK0.18.0/CLI0.0.26，核对独立 External Agent 与预期 server ID。发送前持久日志，不重发未知结果；只读取已发送消息的确切线程，不执行反向指令。
- `src/features/RaftConnection.tsx`：设置→工具连接→Raft沟通，支持手写消息/指令、确认、数据库回执、刷新回复及待发送取消；凭据只在页面内存。公开站与隔离示例不开放真实连接。修复热更新中旧异步请求可能锁住按钮的问题。

现有生产后端 `/healthz` 鉴权读取已成功，会议、录音、机器人、原 Mac 助手可用。新增 Raft API 尚未部署到生产服务器，本轮消息数据库在本机；真实 Android APK 未更新。

## 实际连接记录

- Raft server：`/yu-yuan`，ID `83138da0-afd5-4496-af30-b76bab71d1bc`。
- 专用发送身份：`@Oops`，External Agent ID `f3d35f4d-d323-43ee-9494-c5d59d00ecaa`；凭据核对成功。
- 首轮唯一收件人：本机 `dm:@剪辑组_Mb_Astra`。不改变其模型、运行状态、工作区或既有任务。
- 请求 `oops-raft-connect-20261016-01`，本机消息ID `510dba36f0414aba81d78564fe7c70a8`，发送尝试1次。
- Raft 真实送达ID `838ee97f-55a1-442d-b773-02a1c87bfa8e`，序号18005219。送达不是对方完成任务；仅要求在线程回复“连通确认收到”，不请求业务操作。
- 页面已实际连接数据库并显示“Raft桥接在线”“Raft已接收”；截至首次交付整理尚无对方回复，不把接收逻辑当作已收回复证明。

私有凭据在已忽略的 `.local-backend/raft-local.json`（0600）；消息数据库与 bridge 日志在 `/Users/gpfs/.local/share/oops-raft/yu-yuan/`，目录0700、数据库0600。运行数据移出开发仓库，避免 Vite 文件监听干扰页面。凭据没有进入 APK、公开网页、Git、日志或截图；生成时的临时剪贴板副本已清除。

本机服务及桥接由当前 Codex 执行会话启动，未安装开机常驻。以后部署现有后端时按 `docs/api.md` 启用配置，并将 worker 的 backendUrl 指向真实服务；不要把本机 API 令牌或 Raft 凭据塞进公开页面。

## a1234 通信目标（2026-10-16）

用户继续要求让 Oops 连接 a1234。已核对 Raft computer `93e2637f-3cdf-4e7f-8890-a532ecf4b716`，名称 `1234deMac-mini`、主机名 `1234deMac-mini.local`，在线。选取这台电脑上的 Codex Agent：显示名 `剪辑组_Sol_6.1`，实际账号 `@剪辑组_Astra`，稳定ID `a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7`。SDK再次核对其 computer ID/名称/主机名一致，lastRuntimeError为null。

在同一私有配置追加 `dm:@剪辑组_Astra`，仅重启8798本机消息host；旧数据库、MacBook目标和桥接日志保留，没有新建凭据或改动a1234的运行环境。Oops页面已读回2个获准收件人，并从页面向a1234提交1条只读连通确认。请求 `oops-raft-8afd5adf-d3a4-4fd5-a1d2-bea5bc9c5163`，消息ID `5028226ebe1e4cf88f47f528295c6ffd`，真实Raft送达ID `a1975a74-d5de-4d67-b1f5-cadab13608d9`，发送尝试1次。正文明确实际handle，要求只在线程确认接收和当前计算机，不授权文件、账号、服务或业务改动。

初次回读无回复；Raft只读mention投递查询为unknown，不把它说成对方已消费消息。接收Agent运行状态为working / Compacting context。首版仍须按真实线程回包确认回程，不能凭在线或消息sent冒称远端执行成功。本轮未运行测试，只做用户要求的连接尝试与实际回读。新增API仍未部署生产后端、未更新Android APK。

## 核对范围

未运行测试套件或构建。只做必要 Python AST/Node 语法核对、项目要求的28文件运行时完整性检查，以及用户明确授权的身份鉴权、实际消息发送、数据库/页面回读。截图位于被忽略的 `evidence/raft-20261016/`。没有生产发布、APK安装或真人任务执行验收。
