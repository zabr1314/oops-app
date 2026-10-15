# 个人权限与可靠回执：部署门禁

本轮只交付升级脚本及离线门禁，没有操作生产服务器、OAuth、手机或真实飞书。当前其他会话正在进行个人纪要联调，因此不能把旧部署 manifest、历史健康结果或本地通过当作本轮线上兼容证明。

## 发布范围

`deploy/personal-reliability-upgrade.py` 自包含运行。只有明确带 `--apply` 才允许停服务或替换文件，默认只预检。目标服务必须仍为 `oops-backend`、以 `oops` 运行且原个人纪要确认链已存在。

固定替换九个文件：`local_backend.py`、`feishu_actions.py`、`feishu_accounts.py`、`feishu_mobile.py`、`minutes_delivery.py`、`calendar_delivery.py`、`agent_delivery.py`、`meeting_features.py`、`minutes_quality.py`。只有最后新增的日程/助手投递模块允许原位置不存在；其他基线源码必须真实存在。额外文件、软链接、校验不符和重复发布均拒绝。

生产其他 `.py`（包括 `asr_review.py`、`processing_trace.py` 和 `recordings.py`）单独固定当时 hash，不从本地覆盖。隔离回归按“候选九文件 + 生产未变依赖”导入，不假设旧 manifest 与当前生产依赖兼容；缺依赖、接口不匹配或测试跳过都会阻止安装。未来若要发布这些依赖，需要另列范围，不能偷偷扩大本脚本白名单。

## 新鲜基线与数据保护

在已核实的生产主机上重新运行 `baseline`，其 schema2 含 UTC 采集时间、九文件 hash、其余源码 hash、保护配置/加密账号文件 hash，以及 owner 库逻辑快照。采集时间超过15分钟或在未来即拒绝，必须重新采集并构建。脚本在预检、隔离测试后、备份后和实际替换前重新读取实际文件；任何漂移都停止，不能用历史健康记录绕过。

现有 env、Jev env、个人 OAuth env、systemd 主单元及全部 drop-in、people/voiceprints、保存策略和 `mobile-feishu/feishu-accounts` 文件保持字节不变。不打印配置值、令牌或账号行。原配置保存在权限0700的备份目录中，文件权限0600；脚本从不改授权范围、key、账号 JSON 或本人绑定。

owner SQLite 使用只读事务生成一致逻辑快照，逐表核对精确 DDL 和全部原行的稳定 hash，不以 SQLite 物理页 hash 误判新增空表。允许且仅允许在停服后事务新增以下缺失表：

- `voice_owners(name TEXT PRIMARY KEY, principal TEXT NOT NULL, account TEXT NOT NULL, verified_by TEXT NOT NULL)`
- `read_grants(kind TEXT NOT NULL, object_id TEXT NOT NULL, principal TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at REAL NOT NULL, PRIMARY KEY(kind,object_id,principal))`

新增表必须为空，不从姓名、说话人、任务负责人或旧标注数据推导任何 grant；原 owners、receipts 及已有 ACL 行/schema 必须逐项保持。其他表、索引、触发器、定义或业务行漂移均拒绝。迁移前另存一致 SQLite 备份，仅作审查及人工恢复依据；自动回滚从不覆盖账号或 owner 用户数据。

## 活动工作与隔离回归

升级前、测试后、停服后、启动后均检查活动会议、待纪要/台账、问题研究、Mac jobs、任务 operations。个人 `deliveries`、`calendars`、`assistant-deliveries` 及兼容命名 `agent-deliveries` 的排队、写入中、部分完成、未知和待回读均阻升级；即使外层标成失败/失效，内部仍有 pending 外写也拒绝。脚本只读取这些状态，不执行恢复、重试、模型或投递。

真实主机上的候选回归由 root 新建 `unshare --net` 网络命名空间，仅启用 loopback；永久降为 `oops` 后导入候选与生产依赖。清空继承的提供方环境，额外拦截外部 TCP/UDP/DNS；加密依赖必须存在，测试不能跳过。源码包固定八个假服务测试文件，覆盖账号、手机边界、纪要发送、共享旧入口关闭、日程、原文件投递、个人对象权限及纪要来源。

`test_minutes_quality` 的转换夹具另需 `label_minutes_import.py`、`label_items.py`、`label_workflow.py`。它们作为三个 **test-only helpers** 进入独立 manifest 字段并逐个校验 hash、语法及 stage 导入路径，不能从生产缺失依赖静默跳过测试。导入不会触发生成/CLI/模型；实际转换只使用已有纯函数，仍在同一无外网命名空间执行。发布包因此是九个候选源码、八个测试、三个测试辅助模块；helpers 不进入九文件 live 白名单，不复制到生产，也不覆盖生产已有同名模块。额外 helper、hash 漂移或把 helper 塞进 live 清单都会拒绝。

## 健康与回滚

安装后保持原健康字段及其类型（Jev统计与执行器在线状态是显式波动项），同时要求以下新能力：

- `personal_object_permissions_version=1`
- `calendar_confirmation_required=true`
- `agent_delivery_confirmation_required=true`
- `minutes_topic_sources_version=1`

原 `feishu_mobile_version=1` 与 `minutes_delivery_confirmation_required=true` 也必须保持。认证健康请求只能发往字面量 loopback `/healthz`，禁止代理和跳转；不会把服务凭据发往公网。

失败时只恢复本次九文件及原服务运行状态，保留生产其他依赖、加密账号、owner 业务行和历史回执。已新增的空 ACL 表向后兼容，回滚不删除。若并发管理员编辑了源码、配置或业务行，保留其内容并报告需人工处理，不拿备份强行覆盖，也不冒充回滚成功。

## 本地验证

`python3 -m unittest deploy/test_personal_reliability_upgrade.py -v`：36 项通过，均为临时目录、假 systemctl/health/test runner，socket 外连被禁止。包括九文件精确发布、漂移、过期基线、生产依赖保留、账号字节保护、空 ACL 事务及原行保护、未知 schema、并发用户数据保留、日程/助手在途门禁、假测试隔离参数、类型化健康标记、失败回滚及五项测试 helper 校验/不安装/安全导入门禁。

这证明脚本门禁的本地行为；不证明实际 Linux netns 权限、生产依赖、线上回滚、真实日程或手机联调已经验收。实际应用前仍须重新采集当前主机基线、构建并转移候选、完成现场预检，再按已批准的发布流程执行。
