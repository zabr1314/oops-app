# Oops Apple Watch / iPhone 业务联动首版

当前：用户已明确要求新场改用 Oops 后端转写，与主版使用同一火山 ASR 协议及既有 Jev 处理。独立8799服务升级成功，Phone/Watch 新版签名构建、安装与启动成功。一个已有28.924秒片段的真实验证已完成：服务器与iPhone读回同一job的 `ready/acknowledged`，4句152字、136个词时间项，4项processing均ready，服务器确认引擎为 `jev-1.13.0`；只有1个job，临时PCM已清理。本次不写回旧会议文字、closure或纪要，原89.392秒记录仍为20字且冻结incomplete。新的整场、后台与连续WebSocket仍未验收。新链路与详细回执见[后端 ASR 接入记录](apple-backend-asr-20261016.md)。

以下保留本机识别首版历史：用户选择手表录音、iPhone承接识别和会后结果；实际89.392秒/4段原音已通过云端完整性校验，本机识别20字并同步，末尾短段1110导致收尾 `incomplete`。旧会后接口返回ready但没有可整理的内容，不作为实质纪要验收通过，也不因本次ASR接入改写该历史。

## 首版本机识别链路（历史）

1. iPhone 使用一次性配对码连接独立手机网关，并由用户开启中文本机识别。手机凭据保存在 Keychain，Watch 只得到有期限的就绪状态。
2. Watch 选择原音/全文各 7/30/90 天（默认30），未预选地确认本次录音与云保存，再申请手表麦克风权限。首版仅正式会议。
3. Watch 真实录音；约29秒一段，同一场支持暂停/继续。分段文件带会话ID、序号、真实时间区间、大小和SHA-256，手机校验并持久保存后回执；音频与状态允许系统后台传送，录音控制不排队。
4. iPhone 前台逐段做中文本机识别，将音频转为真实16kHz单声道s16le，沿用既有会议sync和原音manifest/分块/complete接口。手机进程退出或后台暂停本机处理，返回后按原会话和回执恢复。
5. Watch明确结束、全部段齐且识别结束后分别确认文字同步、原音完整性和会后结果，手机只读取本场已有纪要。既有后端发送确认保护核对后再接云端业务；本次保存不代表扩大外部发送或团队共享。

首版手机单场接收30分钟音频，超限给出原因，不把不完整原音标为归档成功；手表不会因此擅自停止或清掉仍有效原音。中文本机识别依赖实际iPhone权限与语言资源，缺失明确失败，不静默改云ASR。本首版尚不支持日常五分钟模式或身份识别。

## 工程

- `apple/OopsApple.xcodeproj`：OopsPhone / OopsWatch 两个业务App，使用独立开发Bundle ID，不覆盖已有连接检查与Android主版。
- `apple/Business/`：录音、文件校验、传输清单、手机转写、保存合同、回执与原生界面。
- `scripts/apple_mobile_gateway.py`：可信服务器上的窄权限移动接口；服务器生成会话ID，仅授权该手机新建的会话。
- `deploy/apple-mobile/`：独立服务/8799/新前缀的可审阅部署材料，原后端不覆盖或重启。
- `docs/apple-mobile-gateway.md`：接口合同、只读结果与未知回执边界。

## 首版本机识别验证状态（历史）

- 项目、Info.plist及Python源码完成必要静态核对。
- 两个业务 target 的真机签名构建成功，严格签名校验均通过，profile 分别确认包含实际 iPhone/S9；最终 iPhone 包内嵌 Watch App。
- 已核对打包 Watch Info.plist 的 `UIBackgroundModes` 确为 `["audio"]`，麦克风说明存在；iPhone 含语音识别说明。
- 两个 App 实际安装成功。iPhone CLI 启动成功；S9 首次 CLI 启动返回 Locked，用户随后确认两端均已打开、本机转写就绪。
- 首次编译修正了录音回调 `@objc nonisolated` 属性顺序；后续源码无编译警告，只有系统 AppIntents 元数据/已签名嵌入二进制 strip 提示。
- 仓库要求的28个受保护文件运行时完整性检查通过。未运行新增单元测试、React/Android构建或全量检查。
- 用户明确授权经 Mac mini 管理通道部署到香港指定新目录/服务/路由并签发本手机配对码；已完成独立服务与路由安装。此前的一次只读盘点未先取此项确认，现已如实说明并获得后续确切授权。
- 接入前已核对生产会后处理代码：自动生成后设为 needs_review，不自动执行文档/DM/团队台账发送；原服务的发送确认保护保留。
- 本轮真实录音、传输、格式转换、文字同步和原音归档已有独立回执；完整转写和有实质内容的纪要仍未验收，不以先前固定ping/pong代替业务验收。

## 本机日志

构建与设备操作日志在已忽略的 `apple/.build/`。业务正文保存在设备私有容器及本人授权的服务器存储；本机只保留无正文的状态/计数/哈希回执。为定位解码问题曾在0700临时目录读取首段音频，仅运行系统afinfo检查格式，随后自动删除，未播放或另发模型。

远程部署包与确切安装命令见 [部署说明](../deploy/apple-mobile/README.md)。后续管理通道调用受 [Mac mini SSH 指南](/Users/gpfs/.codex/skills/tailscale-remote/references/macmini-control-bridge/guide.md) 的确切目标/命令授权要求约束，用户已明确批准本次确切范围，后续按该范围执行，不覆盖或重启原后端。

## 独立网关实际部署

- 新服务 `oops-apple-mobile.service` 仅回环8799，新香港路由 `/oops-meeting/apple-mobile/`；公网HTTPS健康回读为API v1/status ok。
- 原 `oops-backend` PID与认证健康能力保持不变，原生产发送保护源码哈希未变，未替换原后端源码/env/unit，未改日本入口。
- 生产备份 `/var/backups/oops-apple-mobile/20261016T102856499627Z`。无凭据回执在已忽略的 `build/apple-platforms/mobile-deployment-receipt.json`。
- 一次性手机配对信息经私人通道送入本人iPhone开发App容器，不含上游Bearer；移动token由App兑换后仅进Keychain，Watch不持token。用户要求USB直接操作后，已由显式DEBUG单次启动入口完成兑换，成功后从手机删除准备文件，本机明文临时码已清理。
- 已补充失败段的明确incomplete收尾、冻结终止回执，以及原音/全文410分别清理；最终必要Phone重新签名构建、覆盖安装和启动均通过，既有语音识别授权保留。

## USB业务连接续验

- iPhone已保存本次专用grant；Keychain写入成功后才持久化配置。S9实际收到相同grant，后续ready=true、中文本机识别授权/支持/可用均为true。
- 最初通用“转写未就绪”不能区分原因；现复用同一中文识别实例，按[Apple的availability回调](https://developer.apple.com/documentation/speech/sfspeechrecognizerdelegate/speechrecognizer(_:availabilitydidchange:))观察服务变化。USB纯元数据诊断显示新Oops最初为notDetermined；用户在iPhone点允许后已就绪。
- 用户另行明确批准一次约20秒的S9真录音、原音/全文各7天云保存、只回手机不外发。DEBUG命令需显式启动参数、有效期、相同grant和前台就绪；消费UUID后不重复执行，结束只针对该会话ID，不从重连自动录音。
- 发现既有免邀请蜘蛛页会自动发现新的正式云会议，本次先hold正文/原音提交。用户另行明确批准单ID排除：只在open-access.json追加本场ID，备份PRIVATE_CHECK_20261016T105012401690Z，原root:oops/0640、fixed与personal范围保持。云保存前完成排除；公网列表回读不含本场。此前空元数据尝试不含音频/全文，不扩大排除范围。
- USB CLI不能代点iOS/watchOS系统权限弹窗，也不能令未在前台的Watch绕过前台开录条件。7天单次尝试等待权限后已开始，我在再次启动前未先核对活动状态，导致该段中断且没有封口回执；已向用户说明，不算通过，不自动重录。

## 真实业务回执

用户随后在Watch界面确认新场原音/全文各30天，并明确回复“已结束并保存，按30天继续”。沿用本场原音修复处理，没有再开新场：

| 环节 | 本次实际结果 |
| --- | --- |
| S9采集与iPhone接收 | 89.392秒，4段，大小与SHA-256校验后持久回执；最终更新后S9的4条outbox均acknowledged=true |
| AAC转换 | 首次因尾部读取越过EOF失败；修复为剩余帧有界读取、合法尾缓冲排空、完整帧数核对，原4段全部转成PCM |
| 中文本机识别 | 2段未识别到文字，1段20字，2.620秒尾段返回kAFAssistantErrorDomain/1110；无云ASR回退 |
| 文字保存 | 本场sync已回执；ASR收尾冻结incomplete，后续结果不得改成完整转写 |
| 原音归档 | manifest、3块PUT、complete全部done；服务器只读回查complete=true、2,860,544字节 |
| 原音SHA-256 | 4fcc8c4432b2a173dbe71d1b59e36880c16ba8cc497992cd70dda82465aa89dd |
| 会后读取 | iPhone收到ready+minutes，overview/decisions/actions无可显示内容，显示“本场没有可整理的会后内容”；不虚构摘要/待办 |
| 外部范围 | 本场公开蜘蛛页排除已生效，生产会后发送确认保护保留，未创建或发送飞书文档/任务 |

recordings的audio资产available，transcript文件资产pending：本次只上传audio.pcm，20字正文由会议sync保存，没有生成finals/asr文件；这两个接口的资产状态分别报告。公开范围排除、原音服务回查和手机元数据回执在build/apple-platforms私有忽略目录。三处已兑换配对码明文已清理，保留有效Keychain身份与网关数据库。

两端界面独立显示“不完整转写”，不因原音完整或会后回包而盖掉。未新增或运行单元测试；按既有Apple真机授权只做相关签名构建、安装、必要静态核对与上述实际业务联调。长时间后台录音、断网补传、同场暂停/继续及有实质会议内容的纪要质量尚未真机验收。

最后两端签名、覆盖安装和启动均返回成功；再读手机确认本场30/30合同、4段PCM、20字、全部写回执done及已结束状态保留。S9读回同一会话已停止、4段传输均已收到手机确认、手机ready=true。云原音complete之后再读公开列表，仍不包含本场。最终无正文回执为build/apple-platforms/business-final-phone-receipt.json、business-watch-metadata.json与private-check-public-readback.json；此目录不进Git。
