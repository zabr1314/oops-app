# Apple Watch → iPhone → 现有会议后端

当前状态：用户已明确要求新场改用 Oops 后端 ASR。香港独立8799服务已升级，复用主版火山流式协议并独立承接既有 Jev 处理；Phone/Watch 新版签名构建、安装及启动成功。一个已有28.924秒片段的真实验证已完成：服务器与iPhone读回同一job的 `ready/acknowledged`，4句152字、136个词时间项，4项processing均ready，服务器确认引擎为 `jev-1.13.0`；job_count为1，临时PCM已清理。新的整场、后台与连续WebSocket仍未验收，不把单片段通过扩大为这些结果。新接口、部署与详细回执见[后端 ASR 接入记录](apple-backend-asr-20261016.md)。

旧版本历史：本人 iPhone 已完成配对并将移动身份保存在 Keychain，Watch 连接就绪已确认；首场89.392秒/4段原音上传及整文件校验完成。本机识别20字、收尾 `incomplete`，会后接口返回 `ready` 但摘要、决定和行动为空。该真实历史保留，本次旧片段验证不覆盖原文字、closure或纪要。

`scripts/apple_mobile_gateway.py` 已部署为可信服务器内的窄权限网关，完成直接相关的服务、配置和健康核验。代码准备阶段完成源码阅读和 Python 3.10 AST 语法解析；初始部署阶段未运行测试套件、模型、录音、真实会议写接口或纪要生成。首次本机识别联调随后完成了真实录音和业务同步，当时没有为验收手动触发模型或重发未知请求；本次新获授权的后端 ASR 验证另见上述接入记录。

当前 Watch 负责本人明确开始的录音；iPhone 接收后转换音频格式，经手机网关提交主版同协议的火山 ASR，并承接既有会话/会后结果。网关仅在显式分段登记后运行一次受限 ASR，再独立调用既有原句 Jev 处理；不录音、不创建飞书任务/文档，不新建另一套纪要执行器。正式会议结束后是否生成和交付，继续由既有后端与其原授权规则决定。Watch 不持有移动 token、后端 token 或火山凭据。下文原会议/录音接口与初始部署记录保留；新增 ASR 合同见上述接入记录。

## 身份、范围与运行方式

- 只监听 `127.0.0.1`；HTTPS 使用现有可信反代。无 CORS 放行、任意 URL、任意路径代理或重定向转发。
- 后端 Bearer 只从可信服务端环境变量或权限为 0600 的独立文件读取。CLI 参数只填写变量名/文件路径；不从手机接收、不写入 App、不打印。
- CLI 生成 10 分钟单次配对码。SQLite 只存配对码哈希；成功兑换立即消耗。移动 token 默认 30 天，CLI 可选择 1–365 天，只存哈希，可按 grant 撤回。
- 手机 token 只能新建和访问本 grant 通过本网关登记的会话。新会话 ID 由服务器生成 UUID，手机不能提交任意旧会话 ID 或把其他会议认领进来。新 grant 也不会继承旧 grant 的会话。
- SQLite 使用专用 0700 目录、0600 文件，原身份/会议/请求表保留，新增独立 ASR job 和请求关联表；ASR 结果与受管临时 PCM 继承 grant 及原音/全文中较短期限，撤回/到期/来源失效时清理。读取响应不缓存。到期写回执正文每 5 秒以及每次请求清理，保留无正文的请求状态防止重发。
- iPhone 将 mobile token 存入按规范化服务地址隔离的 Keychain；不要发给 Watch、URL 查询参数、日志或分享页。退出连接先清空两端可见快照，再撤回 grant。撤回阻止新请求，不追溯撤销已经发生的上游写入或自动停止正在进行的硬件录音。

以下保留初始部署的 systemd 启动参数历史；当前 ASR 升级增加私人配置与独立依赖，实际新启动参数见[后端 ASR 接入记录](apple-backend-asr-20261016.md)，仍由 systemd 管理：

```sh
/usr/bin/python3 -B -u /opt/oops/apple-mobile/apple_mobile_gateway.py \
  --db /var/lib/oops-apple-mobile/gateway.sqlite serve \
  --port 8799 --url-prefix /oops-meeting/apple-mobile \
  --upstream-url http://127.0.0.1:8787 \
  --upstream-token-file /var/lib/oops-apple-mobile/backend-token
```

8787 为本次已核对的原后端端口。专用 0600 文件只含从原运行进程中选择的现有 token，不是整份 `.env`。程序也支持通过 `--upstream-token-env` 指定可信环境变量名，但本次安装采用上述独立文件；不把 token 值放到命令行。

以下为可信服务端的身份维护接口；CLI 回包中的配对码须私下保存，不写共享日志。本次已签发一次，并通过批准的敏感传输通道写入本机 0600 文件，未输出码值：

```sh
python3 scripts/apple_mobile_gateway.py \
  --db /var/lib/oops-apple-mobile/gateway.sqlite pair-code \
  --label '本人 iPhone' --token-days 30

python3 scripts/apple_mobile_gateway.py \
  --db /var/lib/oops-apple-mobile/gateway.sqlite grants

python3 scripts/apple_mobile_gateway.py \
  --db /var/lib/oops-apple-mobile/gateway.sqlite revoke --grant-id GRANT_UUID
```

`grants` 只输出 grant 元数据，不输出 code/token/hash。配对兑换回包丢失后旧码不能再用；由可信端撤回该 grant 并生成新码，不能假定未兑换。

## 移动接口合同 v1

下文路径相对部署前缀，例如 `/oops-meeting/apple-mobile`。除 `/healthz` 和 `/pair` 外都要求 `Authorization: Bearer <mobile_token>`。所有 POST 使用 `Content-Type: application/json`；不接受未知方法、额外路径或任意查询参数。

### 配对

`POST /pair`：

```json
{"code":"本次单次配对码"}
```

返回 `api_version:1`、`mobile_token`、`grant_id`、`expires_at`。不返回后端 Bearer。`GET /healthz` 只返回网关版本、首版 `meeting` 能力与 `upstream_checked:false`，不表示已连接业务或开始录音。

### 新建仅属于本连接的会话

`POST /sessions`：

```json
{
  "request_id":"独立 UUID",
  "started_at":"2026-10-16T10:00:00Z",
  "time_zone":"Asia/Shanghai",
  "recording_mode":"meeting",
  "cloud_save_confirmed":true,
  "audio_retention_days":30,
  "transcript_retention_days":30
}
```

这里只登记本机网关合同，不会触发上游会议写入、录音或 ASR。`started_at` 为本场真实开始时间且必须含时区，不得晚于服务器 5 分钟；两项天数分别限 7/30/90，省略默认 30。首版不支持日常临时记录或未确认云保存的会议。可提供 `archive_started_at`，但必须与 `started_at` 为同一时刻。

返回 HTTP 201：

```json
{
  "session_id":"服务器生成的 UUID",
  "started_at":"规范化的 UTC 开始时间",
  "time_zone":"Asia/Shanghai",
  "storage_policy":{
    "version":1,
    "recording_mode":"meeting",
    "cloud_save_confirmed":true,
    "archive_started_at":"与 started_at 相同的规范化 UTC 时间",
    "audio_retention_days":30,
    "transcript_retention_days":30,
    "audio_expires_at":"按原开始时间计算",
    "transcript_expires_at":"按原开始时间计算"
  }
}
```

iPhone 冻结这个回包。后续 `sync` 和 `manifest` 原样携带五项合同字段（不自行增加 `version/*_expires_at` 到正文）；重试、离线恢复或改全局偏好不延长期限。`GET /sessions` 只列当前 grant 的登记元数据，最多最近 100 条；不请求全量会议列表，不触发自动命名模型。已登记不等于已上传或上游已建会话。

### 转写与结束同步

`POST /sessions/{id}/sync` → 既有 `POST /v1/meetings/sync`。

每次独立写操作使用新的 UUID `X-Request-ID` 请求头；第一次发送前保留原 ID 和冻结正文，普通回包丢失只用原 ID 查询/回读。正文直接使用既有接口结构，**没有 `payload` 包裹**：

```json
{
  "session_id":"本 grant 返回的 session_id",
  "started_at":"新建回包的 started_at",
  "time_zone":"Asia/Shanghai",
  "recording_mode":"meeting",
  "cloud_save_confirmed":true,
  "archive_started_at":"原 storage_policy.archive_started_at",
  "audio_retention_days":30,
  "transcript_retention_days":30,
  "utterances":[{"id":"u1","start_ms":0,"end_ms":1800,"speaker":null,"text":"实际识别到的原话"}],
  "notices":[]
}
```

每批最多 500 句、100 条提醒，JSON 最多 2,000,000 字节。可选 `ended_at/agenda/asr_closure/asr_error_code/asr_error` 沿用原后端规则；`asr_closure` 只能反映实际识别器的收尾结果，不由网关补成成功。网关不补造标签、身份、纪要或时间。会话 ID、原开始时间、时区和合同不得变化；原话/提醒内容仍由既有后端校验。

首次和后续 `sync/manifest` 写前会读取既有 `/healthz` 并要求 `archive_policy_version >= 1`；检查失败不发送业务写请求。成功回包还须确认同一 `session_id` 与完全一致的 `storage_policy`；不匹配属于写结果未知，停止后续写入。

### 原始录音上传

完全复用 [既有录音接口](api.md) 的清单、断点、分块哈希与整文件校验：

| 移动路由 | 原后端路由 | 正文 |
| --- | --- | --- |
| `POST /sessions/{id}/recordings/manifest` | `POST /v1/recordings/{id}/manifest` | `files/meta` 与同一份五项保存合同 |
| `PUT /sessions/{id}/recordings/{name}?offset=N` | `PUT /v1/recordings/{id}/{name}?offset=N` | 原始字节，最多 1,100,000 字节；`X-Content-SHA256` 必须匹配本块 |
| `POST /sessions/{id}/recordings/complete` | `POST /v1/recordings/{id}/complete` | 空对象 `{}`；原后端执行整文件哈希核验 |
| `GET /sessions/{id}/recordings` | `GET /v1/recordings/{id}` | 读取服务器当前字节数、完整性和分项期限 |

每个写操作同样带独立 `X-Request-ID`。文件名只接受 `audio.pcm/finals.jsonl/asr.jsonl/timing.jsonl/meta.json`，大小上限与原后端一致；清单必须包含偶数字节的 `audio.pcm`。清单中每项仅 `name/size/sha256`；`meta` 最多 20 个简单键值，每项值最多 200 字。

**Watch 的 WAV 文件不能原封不动当作 `audio.pcm`。** iPhone 须先解码/去容器并转换成 **16 kHz、单声道、16 位有符号小端 PCM**，再计算转换后整文件与分块哈希。网关只接受 `application/octet-stream` 或 `audio/pcm`，并拒绝音频第一个分块的 WAV 容器头；不会在服务器另造转码/识别链路。WAV 的格式/完整性及本地转换结果仍需 iPhone 实现与真实验证。

录音状态的 `complete:true` 是校验历史；可用性按 `assets.audio/transcript` 分别判断。只有取得明确完整校验成功且相应资产仍可用，iPhone 才能按既定规则清理本地待上传副本。过期返回 410，终止该类别上传并按合同清理。

### 读取详情与已有会后结果

| 移动路由 | 原后端路由 |
| --- | --- |
| `GET /sessions/{id}` | `GET /v1/meetings/{id}` |
| `GET /sessions/{id}/minutes` | `GET /v1/meetings/{id}/minutes` |
| `GET /requests/{request_id}` | 仅本 grant 的网关写请求状态 |

详情/纪要/录音读取返回原后端 HTTP 状态与 JSON，不生成替代数据。`ready/pending/unavailable` 和 `source_changed` 等原因原样传递；没有结束回包不能单凭列表或最后同步时间认定硬件正在录音。网络失败返回 `UPSTREAM_READ_FAILED`，不继续展示旧缓存。源头删除、全文到期或无权限时，两端均须撤下旧正文，不把历史文档当作当前结果。

`GET /requests/{id}` 返回 `request_id/session_id/state/method/route/upstream_http_status/attempted_at`，不返回请求正文、后端凭据或伪造业务结果。`POST /sessions` 的状态只是网关登记成功，不能解释成上游业务完成。

## 幂等、未知送达与恢复边界

SQLite 在每次上游写入前持久记录该 grant、request ID、方法/固定路径、正文 SHA-256 与 `attempted`。同 ID 同内容的已完成请求回读原回执，不再次写上游；同 ID 换方法、路径或正文返回 409 `REQUEST_ID_CONFLICT`。JSON 指纹基于规范化后的 JSON，字段顺序不同不造成新操作。

无完整可校验回包、网络断开、超时、成功回包的会话/合同不匹配，或 HTTP 5xx，都不证明未写入。请求保持 `attempted/unknown`，该会话后续写操作返回 `SESSION_OUTCOME_UNKNOWN`；相同请求返回 `OUTCOME_UNKNOWN`。首个已收到的上游 HTTP 5xx 原样返回，但持久状态仍标为 unknown。iPhone 遇到写 5xx 也必须查询原 request ID，不换新 ID 掩盖未知结果。

允许读取原请求状态、该会话详情和录音状态。此版**没有自动重发，也没有自动根据读回猜测/改写成功的恢复器**；需要可信管理员核对原回执与源存储后再安排明确的恢复流程。CLI 当前只管理身份，没有把 unknown 强行改成未发送或清空防重记录的入口。服务在上游已成功、保存回执前崩溃，也保守保留 unknown/attempted，不声称失败。

上游明确 4xx 回包按原样保存回读；请求修正是另一次显式操作。上游能力 GET 失败发生在业务写入前，不保留业务尝试，可在恢复后以原请求重试。每场写操作串行领取，未决写入期间拒绝另起并行写入。

## 已完成的服务交付与真机验收边界

独立服务、香港反代新前缀和私有运行凭据已安装，生产上游认证健康核对、新回环与公网健康均成功；本人 iPhone 已完成单次码兑换及 Keychain 身份保存。Watch 就绪、真实音频接收/转换、原音上传与校验已有真实回执；本场转写不完整，会后接口虽就绪但没有可整理的摘要、决定或行动。不得把当前空结果补成生成成功，也未验收向他人发送/分享。本场已在同步前排除自动公开历史，其他历史范围保留。

## 已部署的独立服务与安装边界

已批准并执行的材料在 `deploy/apple-mobile/`：独立 systemd unit、香港新前缀 include、全新安装器、固定代码哈希清单和本机压缩包。本次已安装新服务、专用状态目录与单值凭据文件，并只向香港原 locations 增加新前缀 include；随后私下签发手机专用配对码。初始部署阶段未执行真实上传，后续首场真机原音上传结果另记于文末。

安装前已核对原后端 `127.0.0.1:8787`、系统与现有 venv Python 3.10.12、独立历史/标注 8797/8798；安装器再次确认原后端 active/PID、保存能力及 8799 空闲后完成安装。8799 现由新服务使用，不能继续描述为空闲。

| 新对象 | 目标 |
| --- | --- |
| 网关代码 | `/opt/oops/apple-mobile/apple_mobile_gateway.py`，root:oops，0640 |
| 状态目录 | `/var/lib/oops-apple-mobile`，oops:oops，0700 |
| 移动数据库 | 该目录的 `gateway.sqlite`，0600 |
| 独立上游 token | 该目录的 `backend-token`，oops:oops，0600 |
| 服务 | `/etc/systemd/system/oops-apple-mobile.service`，User=oops，仅允许写新状态目录 |
| 香港 location | `/etc/oops-meeting/apple-mobile-locations.conf`，仅 `/oops-meeting/apple-mobile/` |
| 备份/结果 | `/var/backups/oops-apple-mobile/<UTC时间>/`，root 私有 |

安装器在任何安装改动前要求：root/Linux；包哈希正确且 stage/file 为 root 拥有、不可由他人写；原 `oops-backend` active、原脚本进程和 PID 明确；仅从该 PID 的 `/proc/PID/environ` 内存选取 `OOPS_API_TOKEN`，认证读取 8787 healthz 确认保存合同能力；新服务目录、unit、include、启用链接和端口都不存在；当前 Nginx 配置没有冲突前缀。不会输出环境正文或 token，也不把整份原 env 加入新服务。

随后保存原 locations 的完整字节、模式和属主，记录新文件不存在的基线；只安装新脚本/unit/include、私有状态目录及单值 token 文件，并给原 locations 追加一条 include。`nginx -t` 成功后才启用/启动新服务、核对新回环 healthz 并 reload Nginx。最后再次确认原后端 PID 与保存能力未变；**不会 restart 原后端，也不会替换其源码、env、unit、会议、声纹或其他业务数据**。

失败时只停止/禁用本轮新服务、恢复原 locations、撤下本轮新文件并重新加载原路由。若有并行操作者改变被管理文件，会报告备份和未完成回退，停止覆盖该改动；不以强行回滚覆盖队友。已存在的新目录、unit 或前缀属于冲突，不能静默更新。

香港新 `proxy_pass http://127.0.0.1:8799;` 不加尾部 `/`，保留前缀供网关剥离；写请求禁止 proxy_next_upstream 重试，体积 2m、读取 60 秒。新服务实际回环健康地址是 `http://127.0.0.1:8799/oops-meeting/apple-mobile/healthz`。日本目前沿用既有通用转发，本包不改日本；原模板的 15 秒预算仍可能提前中断，不能宣称全链路已有 60 秒。日本专用入口须实际核对配置后再准备与授权，不能猜路径直接覆盖。

本次实际安装命令、备份与传输授权边界见 `deploy/apple-mobile/README.md`。初始远程 push/exec、独立服务/路由安装和直接相关核验均已按用户确切授权完成；后续单场公开历史排除另获用户明确批准，不由初始部署授权推导。未改其他服务或日本配置。

兼容性静态收尾：移动文件清单现在要求**每项非空**，未产生的 `asr.jsonl` 等文件应省略，避免既有录音后端在 `complete` 时尝试校验从未创建的 0 字节占位文件。只上传真实 PCM 就仅声明该非空文件；不能用空音频冒充完成。另保留录音状态的独立只读查询，即使原音先到期也继续返回原后端的分项 `assets/expired` 元数据；这不返回过期音频。清单的会话/开始时间及 meta 同名字段必须指向本场冻结身份。`manifest/sync` 成功回包验证原 `storage_policy`，`complete` 按原接口没有该字段的实际回包处理，不补造合同或完成结果。

## 实际独立部署回执（2026-10-16）

用户已明确允许经配对 Mac mini 的严格 SSH 通道部署香港原服务器，仅新增独立网关和该新前缀。部署前只读核对实际生产 `feishu_actions.py`：SHA-256 为 `2beedf2471e4ae18f0ccdd5225a79a0711df2ecd0608d1413a398c3965d33de6`。自动 `after_meeting` 仅将分发状态设为 `needs_review`，`ledger_pending=False`，没有自动文档/分享/私信/团队台账调用；纪要生成与发送确认保持分离。本网关不暴露既有任务创建的私信路径。未以仓库旧版自动分发逻辑覆盖生产源码。

已批准代码包 SHA-256 `7ba779a27acb1a22adeedd4cedd67012bc583040d1d84c3b9c272ad734033682` 在本机、传输后及服务器解包前分别核对。原 backend PID 与认证 healthz 保存能力在安装前后保持；新服务 `oops-apple-mobile.service` 在回环 8799 启用，香港只新增 `/oops-meeting/apple-mobile/` include 后 reload Nginx。实际生产发送保护源码哈希未变，原 backend 源码、env、unit 与业务数据未替换，未 restart 原服务，未改日本配置。

新回环健康及 `https://giftedprofessor.xyz/oops-meeting/apple-mobile/healthz` 均返回 `api_version:1/status:ok`。该公网响应本身的 `upstream_checked:false` 不替代安装器已执行的认证后端能力核对。备份为 `/var/backups/oops-apple-mobile/20261016T102856499627Z`，本机无凭据回执为已忽略且 0600 的 `build/apple-platforms/mobile-deployment-receipt.json`。

部署阶段只执行直接相关的服务安装、配置与健康核验；未运行测试套件、模型、录音或真实会议写请求。随后已签发本人 iPhone 的 10 分钟单次码，经批准的敏感传输通道写入本机 `build/apple-platforms/mobile-pairing.json`（0600，仅 endpoint/code，不进入 Git 或输出）；grant 元数据另记无凭据部署回执。

用户进一步明确要求直接 USB 控制，根任务已通过 DEBUG 显式配对入口完成兑换，并回读同一 grant、HTTPS endpoint 与 2026-11-15 的身份到期日；Keychain 保存先于手机配置写入。Watch 连接就绪现已确认。原一次性码的三个可信主机私人临时明文副本均已按确切路径清理，服务运行 token、移动数据库、active grant 和 iPhone Keychain 身份保留，未撤回身份。日本超时未现场核对且未更改，不能据香港配置宣称全链路已有 60 秒。

## 首场真实录音与只读结果（2026-10-16）

用户原先准备一次短测试，实际随后在 Watch UI 新开本场并选择原音/全文各 30 天，明确结束后确认按此合同继续。iPhone 共收到 4 段、89.392 秒真实音频，4 段 PCM 转换均完成。`sync`、`manifest`、3 块音频上传和 `complete` 均取得 `done` 回执，手机 `audioUploaded=true`；没有以新请求 ID 重发未知结果。

只读 `GET /v1/recordings/{本场ID}` 于 2026-10-16 10:53:41 UTC 返回 HTTP 200、`complete:true`，已校验的 `audio.pcm` 为 2,860,544 字节，SHA-256 为 `4fcc8c4432b2a173dbe71d1b59e36880c16ba8cc497992cd70dda82465aa89dd`。`assets.audio=available`、`assets.transcript=pending`；本次 manifest 仅声明 PCM，未上传 `finals.jsonl/asr.jsonl` 等转写存档文件，因此后者不是那段文字同步失败的证明。此核对只读取状态元数据，未下载原音或打印正文。

本机识别为 1 段真实中文 20 字、2 段无文字、1 个末短段错误 1110；结束状态冻结为 `incomplete`，没有补成识别收尾成功。iPhone 已读取既有纪要接口的 `ready` 回包且含 `minutes` 字典，但 `overview/decisions/actions` 均为空，界面显示本场没有可整理的会后内容；其他结果类别未另行盘点，不推断其数量。此结论依据手机实际回读，没有手动调用模型、补写摘要或向他人交付。

本场云同步前另获明确授权：仅把本次 canonical UUID 追加到 `/var/lib/oops-history/open-access.json` 的 `auto_meetings.excluded_meetings`。工具为 `deploy/apple-mobile/exclude-private-check.py`；先检查该 ID 不在固定列表或个人访问 scope，再备份到 `/var/backups/oops-apple-mobile/PRIVATE_CHECK_20261016T105012401690Z`，原子追加并读回确认。原 `root:oops/0640`、其他字段和自动范围保持，个人访问数据库只读，无重启。后续公网 history 列表 39 条不含本场；前一仅空元数据的尝试没有扩大排除。无凭据本机回执为已忽略的 `build/apple-platforms/private-check-exclusion-receipt.json`（0600）。
