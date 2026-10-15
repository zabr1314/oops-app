# 个人飞书绑定：部署与真机联调

用户授权继续完成飞书应用配置、后端部署和真机安装，保持当前真机 UI；需要本人授权时告知。此文记录截至 2026-10-15 05:36 UTC 的实际完成范围。

## 已完成

- 原 Redmi `W4W8Q8LVBQ8XZHLF` 保留数据覆盖安装成功。新旧包签名相同，包名、版本兼容；安装后的 APK SHA256 为 `ee7e48250355a72a4f405dec2e369c1713c097cf23293c67f64f4d89bf9f6996`，与本地已测试包一致。三份原设置文件逐字节不变，未卸载、清数据或额外授予系统权限。原 APK 和设置备份保存在忽略的私有 build 目录。
- 保持已核对的真机 Pupu、四导航、中心录音、顶部设置、字体与样式；本轮仅使用既有设置和纪要入口接个人授权/核对发送。安装验证不等于本人 OAuth 已完成。
- 香港原 Python 3.10 环境通过官方 PyPI wheel 安装 `cryptography==50.0.2`，加密往返通过。既有应用的 AppSecret 在同服务器内按官方 CLI 密钥存储格式解析，直接写入 root 0600 的 `/etc/oops/feishu-mobile.env`；没有输出秘密值、搬运共享用户 token 或改原 `backend.env`。Fernet key 在会议数据目录外保存，后续重启应复用。
- 原 systemd 服务增加独立环境 dropin。仅发布 `local_backend.py`、`feishu_actions.py`、`feishu_accounts.py`、`feishu_mobile.py`、`minutes_delivery.py` 五个模块，未全目录同步。保留线上 ASR 二次识别、三轮纪要提示、处理轨迹、历史查看及既有来源签名功能；未覆盖含额外到期清理的生产 `recordings.py`。
- 香港与公网入口都加入精确 OAuth callback 路径，关闭其访问/错误日志，设置 no-store/no-referrer 和 60 秒等待；普通请求保留 `X-Oops-User-Token`。原 TLS 验证、API Bearer、限流、历史窄路径及 cookie 规则保留。两端语法检查与 reload 通过。

## 发布证据与回退

最终 release ID：`d685101c625c95983584cbae3aad1ae1f4d8167a76c1548c49d5f4f23fc79536`。

- 发布包 `/opt/oops/releases/feishu-personal-d685101c625c/`。
- 源码和保密配置备份 `/var/backups/oops-feishu-mobile/d685101c625c95983584cbae3aad1ae1f4d8167a76c1548c49d5f4f23fc79536/`。
- 首次 OAuth 配置备份 `/var/backups/oops-meeting/feishu-config-20261015T052840Z/`。
- 香港代理备份 `/var/backups/oops-feishu-proxy/20261015T052916Z/`；公网入口代理备份为入口机上的 `/var/backups/oops-feishu-proxy/20261015T053108Z/`。

发布工具 `deploy/feishu-mobile-upgrade.py` 固定五文件清单与生产基线，在隔离网络命名空间中以 oops 用户运行假服务测试。它拒绝来源/配置漂移、进行中的会议和外部操作，失败恢复自己修改的源码与配置，保留个人账号数据。工具 19 项临时文件门禁测试通过。

第一次实际升级由健康比较发现本地缺失既有 ASR 初始化/健康字段，已自动恢复原服务并验证。随后按生产原文恢复该功能，完整限定名称 AST 与调用检查及 75 项定向回归通过，再发布上述最终版本。最终 `installed_verified`：既有健康字段与受保护配置保持，新增 `feishu_mobile_version=1`、`minutes_delivery_confirmation_required=true`。

## 线上验证

通过公网 HTTPS 实际验证：

- 认证 health 返回 ok，Jev、声纹、speaker preview、ASR review 和原 Feishu bot 保持；四个身份自动判定闸门保持关闭。
- 无 Bearer 的 health/session 请求返回 401。
- 新建一个未绑定的测试手机会话，跨两层代理读取本人状态成功，`unbound`、`capabilities.oauth=true`；缺个人凭据返回 401，未绑定不能取收件目录。
- 已有无归属会议返回 403 `MEETING_OWNER_UNVERIFIED`，不能被新测试账号认领发送。
- 未知 state/取消回调返回 400，页面不回显 state，包含 no-store/no-referrer。

这些检查不发起飞书用户授权、不创建文档/任务、不发送真实通知，也不请求模型。部署前持久队列检查的待生成纪要为 0。保留的原会议后台整理仍按既有授权在未来会议运行，不能将本次技术部署理解为批准额外收费重算。

本机补充的 100 项定向回归、生产兼容修复的 75 项定向回归存在重叠，不相加成总数。服务器发布工具另在无外网环境运行当前个人 OAuth、归属与投递假服务测试。原 Android 212 项、原生 H5 87 项的构建/回归证据保留；本次没有更改 APK。

## 飞书后台配置已生效；等待本人手机授权

飞书开发者后台已切换到 Oops 企业、核对目标应用。用户明确回复“允许，继续配置”后，已提交以下八项用户权限，界面逐项显示“已开通”：`docx:document:create`、`docx:document:write_only`、`docs:permission.setting:read`、`docs:permission.setting:write_only`、`docs:permission.member:create`、`drive:drive.metadata:readonly`、`im:message`、`im:message.send_as_user`。其中 `im:message` 官方要求与以用户身份发送配合，包含消息读取能力；代码不主动拉取消息。既有 offline_access/任务权限不因此扩大。

固定回调 `https://giftedprofessor.xyz/oops-meeting/v1/feishu/callback` 已提交，安全设置中出现已登记 URL 行；后台显示“当前修改均已发布”，无需另建版本。界面证据为忽略目录中的 `permissions-enabled.png` 和 `callback-registered.png`。

已通知用户在连接的 Redmi 上打开 Oops → 顶部设置 → 我的飞书 → 连接我的飞书，亲自核对官方授权页的本人账号与权限并返回 App。服务器只读状态仍为一个未绑定的技术测试会话、零个本人绑定、零个进行中的授权；此状态不代表用户操作失败，只表示尚未看到手机发起。后台开通权限不替代每个人的 OAuth。

本人 OAuth 成功、实际权限回读、真实纪要投递和同操作防重的现场验收仍待完成。旧会议不会自动迁移归属；当前收件目录只包含同组织已完成个人绑定的 Oops 账号。

## 配置输出失误

安装只读预检中，子任务曾误将既有 `android/local.properties` 的构建识别凭据输出到本次工具日志，已停止并报告；本轮没有将这些值写入新代码、部署文档或公开页面。后续配置核验仅输出字段、布尔与哈希，不复述值；未擅自轮换原凭据。
