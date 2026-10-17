# Apple mobile 独立部署材料

当前：用户已要求新场改用 Oops 后端 ASR，香港独立8799服务已升级，使用主版火山协议与既有 Jev 处理；Phone/Watch 新版签名构建、安装、启动成功。一个已有28.924秒片段的真实验证已完成：服务器与iPhone读回同一job的 `ready/acknowledged`，4句152字、136个词时间项，4项processing均ready，服务器确认引擎为 `jev-1.13.0`；job_count为1，临时PCM已清理。新的整场、后台与连续WebSocket仍未验收。新部署材料、接口与详细回执见[后端 ASR 接入记录](../../docs/apple-backend-asr-20261016.md)。

下文保留初始独立部署及本机识别验收历史。本人 iPhone 已完成USB单次码兑换并将移动身份保存在 Keychain；旧首场89.392秒/4段原音归档成功，本机识别20字但收尾 `incomplete`，会后结果为空。本次旧片段ASR验证不覆盖原文字、closure或纪要。`manifest.json` 固定的是初始已批准包的四份执行/配置文件哈希，包内不含任何凭据或本机 Apple 签名文件，不能当作后续ASR升级版本的清单。

| 文件 | 用途 |
| --- | --- |
| `install.py` | 仅支持全新安装；缺少 `--confirm-install` 不执行安装 |
| `oops-apple-mobile.service` | 独立 `User=oops` 服务，监听回环 8799 |
| `nginx-hk-apple-mobile.conf` | 香港仅匹配 `/oops-meeting/apple-mobile/` 的 include |
| `manifest.json` | 网关脚本、安装器、unit 和新路由的 SHA-256 |
| `oops-apple-mobile-20261016.tar.gz` | 本次已批准并部署的代码包，被 Git 忽略；其中说明保留打包时快照 |
| `exclude-private-check.py` | 随后另获用户明确授权的单 UUID 公开历史排除工具；不在初始部署包内 |

安装器只有在原 `oops-backend` active、进程确为原脚本、认证 healthz 支持 `archive_policy_version >= 1`、新目录/unit/路由/端口不存在且没有前缀冲突时才继续。它从原进程环境内存中仅选出 `OOPS_API_TOKEN` 写入独立 0600 文件，不打印、不复制完整 env。所有原后端源码、unit、env、业务数据都不替换；不重启原后端。

已安装代码目录为 `/opt/oops/apple-mobile`，状态与专用 token 在 `/var/lib/oops-apple-mobile`，unit 为 `oops-apple-mobile.service`，路由 include 为 `/etc/oops-meeting/apple-mobile-locations.conf`。原 `/etc/oops-meeting/locations.conf` 只追加一条独立 include；本次备份为 `/var/backups/oops-apple-mobile/20261016T102856499627Z/`，保存原文件字节、属主/模式以及新文件不存在的基线。

`nginx -t` 失败会恢复原 locations 字节与元数据、撤下本轮新文件；启动/健康/reload/PID 核对失败也只回退新服务与路由。发现并行操作改动原 locations 或本轮文件时停止覆盖并报告私有备份位置，不强行覆盖队友改动。新目录或同名前缀已经存在时直接停止，不当作可覆盖旧版本。

本次已取得针对配对 Mac mini SSH 通道、香港目标和确切安装范围的用户授权。实际 stage 为全新、root 拥有且不可由其他用户写入的 `/var/lib/oops-deploy/apple-mobile-20261016-7ba779a27acb`。经哈希核对、安全解包后，已执行的安装命令为：

```sh
/usr/bin/python3 /var/lib/oops-deploy/apple-mobile-20261016-7ba779a27acb/deploy/apple-mobile/install.py \
  --stage /var/lib/oops-deploy/apple-mobile-20261016-7ba779a27acb --confirm-install
```

原后端 PID 和认证 healthz 的 `archive_policy_version:1` 在安装前后保持，新回环与公网 `/oops-meeting/apple-mobile/healthz` 均返回 `api_version:1/status:ok`；生产会后发送确认保护源码哈希未变。安装器本身不负责 SSH、上传、解包、开放防火墙、签发配对码或真实录音验收；配对码由随后获授权的独立步骤签发。安装器只支持 fresh install，当前目标已存在，再运行会按冲突停止。既有 Mac mini SSH 技能的 `exec/push` 授权边界继续适用；初始部署授权不扩展到其他远端目录或服务，后续单 ID 隐私排除按用户另一次明确批准执行。

日本已有通用入口可转发此前缀，但仓库模板的 15 秒读取预算短于网关 45 秒上游预算。此包**不改日本配置**；如要专用 60 秒入口，需要先核对实际日本 location/include，再另行准备只匹配同一新前缀的配置，保留原 TLS 主机名、证书校验及通用路由。香港本包中的 60 秒不能被描述为全链路 60 秒。

完整手机接口、实际部署回执和未知送达边界见 `docs/apple-mobile-gateway.md`；无凭据本机回执在已忽略的 `build/apple-platforms/mobile-deployment-receipt.json`（0600）。本次部署已实际运行安装器、必要 Nginx 配置校验和服务健康核验；初始部署阶段未运行测试套件、模型、录音或真实会议写请求。后续 USB 显式兑换已由根任务回读确认：Keychain 保存先于手机配置写入，移动身份有效至 2026-11-15。三台可信主机的一次性码临时明文均已清理，保留运行 token、移动数据库、active grant 和 iPhone Keychain 身份，未撤回身份。

后续真机首场：用户在 Watch UI 选择原音/全文各 30 天，明确确认结束并按此合同继续。4 段真实音频均已在 iPhone 转换为 PCM；`sync`、`manifest`、3 块上传、`complete` 均有完成回执，`audioUploaded=true`。服务器只读确认 `complete:true`、`audio.pcm` 为 2,860,544 字节，`assets.audio=available`；本次只上传 PCM，所以录音存档的 `assets.transcript=pending`，不等于已同步的文字丢失。转写为 1 段真实中文 20 字、2 段无文字、1 个末短段错误 1110，冻结 `incomplete`。手机读取的会后接口为 `ready`，但摘要、决定和行动为空，界面显示本场没有可整理的会后内容；没有补造摘要或手动触发模型。

本场云同步前，已按用户单独批准，仅将本次 canonical UUID 追加到 `/var/lib/oops-history/open-access.json` 的 `auto_meetings.excluded_meetings`。备份在 `/var/backups/oops-apple-mobile/PRIVATE_CHECK_20261016T105012401690Z`；原 owner/mode、固定列表、其他自动范围均保持，personal access DB 只读且未发现该 ID 冲突，无服务重启。后续公网 history 列表共 39 条，不含本场 ID；前一空元数据尝试未扩大排除。无凭据核对回执在本机已忽略的 `build/apple-platforms/private-check-exclusion-receipt.json`（0600）。
