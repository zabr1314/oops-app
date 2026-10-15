# 手机个人飞书绑定与纪要确认发送

本轮用户授权：每个人在手机绑定本人的飞书；纪要先核对正文、收件人和权限，明确确认后再发送。随后用户要求以当前真机版为准，不自行改 UI。

## 真机基线

只读取出实际安装包，SHA256 为 `1a5f964c655c074e05e38bdbcc9069b48fcb547dfd5a103c70c6427d2e4883fa`。安装包内 `app.js`、`app.css`、`bridge-mock.js`、`index.html` 与现有 `pr10-device-deploy/oops` 目录逐字节相同，其当前 clean HEAD 为 c1ef1560。安装包没有嵌入源码提交号，因此不能把目录关联当作全部 DEX 的密码学来源证明。

保留这套 Pupu、字体、原配色、顶部设置、四导航和中心录音按钮及原生资源。原工作目录缺失的真机录音豆、TaskSourceBinding、短依据和旧操作保护一并保留，不能为适配旧后端而削弱它们。新功能使用现有设置、会议工具和纪要里的入口与原表单/底部面板样式。另写的 React 界面已撤出并存入忽略的 build 目录；原有工作区差异均先备份，没有修改另一个真机源码目录。

## 真实链路

1. App 以现有服务授权创建独立手机会话。服务凭据和本地显示名不再作为个人身份。手机会话凭据按服务地址隔离，并由 Android Keystore AES-GCM 加密保存，不传到 H5。
2. 设置 → 我的飞书，向后端申请一次性 OAuth state 和 PKCE S256 授权地址；原生打开飞书官方页面。固定 HTTPS 回调在后端交换 code 并查询本人身份。取消、失败、重放、过期或断开后的迟到回调不替换原绑定。
3. 飞书 access/refresh token 只在后端用 Fernet 加密保存，数据和锁文件权限 0600，应用密钥不进入 APK、H5 或公开预览。每次写操作核对本人身份与绑定版本，拒绝回退服务器共享 CLI 账号。
4. 新正式会议绑定到创建手机的服务端身份；旧会议缺可靠归属时禁止对外发送，不自动分配给下一个账号。已有会议和历史外部回执保留。
5. 会后后台只整理私有纪要。原自动建飞书文档、按发言标签共享、私聊卡片、写团队台账及问题研究间接发送均停止。旧卡片和旧待交付成果不能绕过本轮个人确认。
6. 用户核对/编辑标题和正文，明确选收件人，权限默认查看；保存稿后再单独确认。后台冻结草稿 revision、来源指纹、绑定版本、收件人、权限和唯一操作号。客户端追加正文或收件人不能替换已核对版本。
7. 确认后异步创建本人文档，先关闭链接/组织外分享并回读权限，再写正文、查询真实 URL、向选定人授权并通知。重复点击/换操作号不重复发送同一版本；超时未知只查原请求，明确失败只能恢复原操作剩余步骤。
8. 来源变化、到期、删除或账号变化停止旧稿继续外发。完整原文到期同时清理本地稿正文副本，历史发送回执仍保留；第三方已收到的副本不能被本地清理自动收回。

当前收件目录限定为同组织已经完成个人绑定的 Oops 账号，默认不选任何人，不扫描全公司文档或通讯录。未绑定同伴需先在其手机完成连接，不能手填任意 ID 绕过核验。

## 接口

既有服务 Bearer 认证保持；个人接口另需原生 `X-Oops-User-Token`。OAuth 回调仅凭一次性 state 校验，是唯一不要求 App Bearer 的新增回调。

| 方法/路径 | 行为 |
| --- | --- |
| POST `/v1/feishu/session` | 颁发独立手机会话，仅首次返回会话凭据 |
| GET `/v1/feishu/status` | 只返回本人账号、安全状态、绑定版本与实际能力，不返回飞书 token |
| POST `/v1/feishu/connect` | 申请一次性官方授权地址，客户端不能指定回调地址 |
| GET `/v1/feishu/callback` | 后端交换授权码，返回不含凭据的“返回 Oops”页面 |
| POST `/v1/feishu/disconnect` | 清除本地绑定与待处理授权；飞书服务端应用授权可在飞书内另外撤销 |
| GET `/v1/feishu/recipients?q=` | 当前同组织已绑定账号目录 |
| GET `/v1/meetings/{id}/delivery` | 读取/准备私有核对稿，不创建文档或发送 |
| POST `/v1/meetings/{id}/delivery/save` | 保存正文、明确名单与权限，核对稿版本递增 |
| POST `/v1/meetings/{id}/delivery/confirm` | 必须 `confirmed:true`、当前 revision 和稳定 op_id，快速回发送中 |
| GET `/v1/meetings/{id}/delivery/status` | 读取原发送记录，不重建、不重发，不等待外部网络锁 |

原手机任务确认同样使用本人飞书身份，按已核实账号选择负责人；源头绑定、原操作防重、明确失败与结果未知的区别继续沿用真机契约。

## 部署配置和验收边界

- 后端安装 `scripts/requirements-feishu.txt` 的加密依赖；无依赖或缺加密密钥时明确显示未配置，不落明文 token。
- 复用既有飞书应用的配置，按 `deploy/feishu-mobile.env.example` 提供 client ID、client secret、固定 HTTPS callback、外置 Fernet key 和获批的用户 scopes。不能将填好的配置提交代码库。
- 代码未配置 scope 时仅申请 `offline_access`。部署示例列出当前纪要链的最小细分用户权限及任务创建/回读权限；须在应用后台申请、发布生效，并由各用户明确同意。绑定成功不表示全部能力已开通。
- 两层 HTTPS 代理都需要精确 callback location 避免 code/state 被访问日志或错误日志保存，模板为 `deploy/nginx-feishu-mobile-example.conf`；原认证、TLS 验证及其他路由限制不降级。回调耗时预算与异步发送分别处理。
- 本轮没有向真实飞书发消息、创建文档/任务、扩大应用权限或调用收费模型。代码、假服务测试、安装包构建、后台部署、手机安装、真人授权与真实投递分别验收。

当前调用所需的用户权限如下。每行是这条链实际使用的能力，不要求申请整个云盘或通讯录范围。

| 操作 | 推荐细分 scope | 官方依据 |
| --- | --- | --- |
| 后台刷新本人令牌 | `offline_access` | [OAuth 授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code) |
| 创建本人纪要文档 | `docx:document:create` | [创建文档](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create) |
| 写入已核对正文 | `docx:document:write_only` | [创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create) |
| 回读链接/外部分享设置 | `docs:permission.setting:read` | [获取权限设置](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/get) |
| 关闭链接/外部分享 | `docs:permission.setting:write_only` | [更新权限设置](https://open.feishu.cn/document/server-docs/docs/permission/permission-public/patch) |
| 向选定人员授予查看/编辑 | `docs:permission.member:create` | [新增协作者](https://open.feishu.cn/document/server-docs/docs/permission/permission-member/create) |
| 查询真实文档 URL | `drive:drive.metadata:readonly` | [获取文件元数据](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/batch_query) |
| 以本人身份发送纪要卡片 | `im:message` **同时具备** `im:message.send_as_user` | [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) |
| 可选：任务创建及回读 | `task:task:write` | [创建任务](https://open.feishu.cn/document/server-docs/task-v2/task/create)、[获取任务](https://open.feishu.cn/document/server-docs/task-v2/task/get) |

基础本人信息 `name/open_id/tenant_key` 的[用户信息接口](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)无额外权限要求。当前收件人来自同组织已经绑定的 Oops 账号，因此不申请通讯录搜索、邮箱或手机号权限。飞书消息仍要求应用启用机器人能力，且发送双方满足应用可用范围；“以本人发送”不免除这些平台条件。

状态分别报告文档创建、正文写入、权限设置读写、协作者授权、元数据读取与本人消息能力；`minutes_delivery` 只有整条发送链所需能力都具备时才为真。`task_write` 只在任务创建及回读都具备权限时为真。不把 `docx:document:create` 误当正文写权限，也不把单独的协作者权限误当作能关闭外部分享。已获批的宽权限 `docx:document`、`drive:drive` 仍可覆盖相应操作，但不是本轮默认推荐。

官方 API 依据与发送步骤详见 [发送契约](minutes-delivery-contract-20261014.md)。本地假服务测试覆盖取消/重放/换号、跨人访问、空名单和未确认拒绝、来源失效、防重、异步状态读取与未知写不重放。

## 最终本地验证

- 真机基线 Android：212 项单测，0 失败/错误/跳过；debug APK 构建成功。
- Python 后端：187 项不重复计数的回归通过；OAuth 加密测试没有跳过，使用临时依赖目录，未更改系统 Python。详细分类见 [真机后端迁移记录](feishu-device-backend-port-20261014.md)。
- 原生 H5：87 项通过；既有 React 原型 326 项回归通过，没有加本轮 React 界面。
- 原生预览及部署资源：11 项通过；TypeScript/网页生产构建通过；28 个受保护移动运行时文件校验通过。
- 内置浏览器按真机 1220×2712/480dpi 对应约407×904逻辑尺寸检查，实际走通原设置绑定、纪要核对、空名单禁发、保存后单独勾选和同操作模拟回执；本轮纠正前的旧 React 热更新错误保留在浏览器历史，不作为当前安卓预览的新异常。
- 本地交付 `build/feishu-personal-20261014/Oops-feishu-personal-20261014-debug.apk`；SHA256 `ee7e48250355a72a4f405dec2e369c1713c097cf23293c67f64f4d89bf9f6996`。验证清单和界面截图在同目录。

2026-10-15 UTC 继续联调：已安装到原 Redmi，后端五模块已部署，服务端加密配置和两层 HTTPS 回调保护已完成；公网个人状态、鉴权、旧会议归属保护和无效回调检查通过。用户明确确认后，飞书后台的八项新增用户权限已显示“已开通”，固定回调已登记，当前修改均已发布；已通知用户在手机完成本人 OAuth。本人手机 OAuth 和真实纪要投递尚未验收。详见 [部署与真机记录](feishu-rollout-20261015.md)。
