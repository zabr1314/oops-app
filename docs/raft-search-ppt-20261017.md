# 手机 Oops → Raft 搜索与 PPT 实际联调

用户明确要求通过后端调试，在 Oops 手机端向 Raft 发送简单搜索、PPT 请求。本轮使用已连接的 Redmi 主版 `com.oops.app` 的真实原生 `raft.request` 桥，以专用 @Oops 身份通知私人 `#oops-collaboration` 群内 a1234 实际 Agent `a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7`（`@剪辑组_Astra`，显示「剪辑组_Sol_6.1」）。没有附入既有会议、录音、个人记忆或飞书任务资料。

## 请求与当前回执

任务要求实际检索国家能源局截至2024年底风电、太阳能发电累计装机容量，制作可编辑的3页16:9中文 PPTX，并在原线程返回检索说明、真实文件、页数和哈希。原任务与替代任务正文均来自手机原生桥，替代派工之前重新读取并核对当前群、稳定目标ID及原文。

| 对象 | 编号 |
| --- | --- |
| 实际执行 Oops 任务 | `raft-task:61f80ae1c7ec48b8858426e307f0d852` |
| 创建请求 | `oops-phone-search-ppt-recovery-9ddd994d-baaa-4dda-875a-a85833bd8417` |
| 派工请求 | `oops-phone-search-ppt-send-fece92de-d6b7-45a8-9b1b-faa436ac9c88` |
| 交接 | `689c4d85cf4c4c97aaed77b8bc881725` |
| outbox | `21cdf074d921461087e25b14be968028` |
| Raft 根消息 | `c5e1e54d-d865-486b-921f-cba3f4bfed13` |
| 实际线程 | `32a5aafb-40fa-47d7-a842-bc8e8f488b23` |
| 首条目标回复 | `3a8e6c75-4d14-485e-850b-e43a090e58ae` |

Raft 已实际接收一次消息，SDK回执、真实群与专用发送人UUID核对通过。a1234已在同线程回复「已收到。我现在检索官方数据，并在本机新建目录制作可编辑的3页PPTX和检索说明，完成后在本线程交付路径与校验信息。」手机 `task.get` 实际回读了该回复，真实sender_id与目标一致。

[原 Raft 线程](https://app.raft.build/s/yu-yuan/channel/9d83a076-b723-4743-b24d-3b945c73ad22?thread=9d83a076-b723-4743-b24d-3b945c73ad22:c5e1e54d-d865-486b-921f-cba3f4bfed13)

## 连接故障与失败登记保留

首次在手机任务页填写简报、选择a1234并点击一次保存派工后，发现本机桥接对后端反复 `BACKEND_REQUEST_UNKNOWN`。同一授权只读GET，curl正常，Node默认fetch及https在TLS建立前 `ECONNRESET`；限定X25519后仍使用TLS1.3即可成功。DNS当时返回当前TUN的IPv4 FakeIP；没有抓包证明具体中间件原因。

本机仅添加私有 `/Users/gpfs/.config/oops/raft-backend-transport.mjs`，通过LaunchAgent `--import` 给原桥接载入。只有 `https://giftedprofessor.xyz/oops-meeting/v1/raft/` 请求补 `undici.Agent({connect:{ecdhCurve:'X25519'}})` dispatcher；Raft SDK请求、证书校验、原method/body/headers/signal、单次发送防重、原journal及后端身份保持。原LaunchAgent备份于 `build/raft-search-ppt-20261017/raft-bridge-launchagent-before.plist`。未更改后端生产源码、Raft凭据、群成员、DNS或系统代理。

首次登记的 `raft-task:4caf9bb872574af8aa6f25a70d890c90`、handoff `aae97b387e00403f8945d5e9730a1ce7`、outbox `a1b8d8155b5b4b9997859473d48aabe8` 保留。它被冻结于群版本101，连接故障期间群状态失效并恢复，后端poll内部校验以 `GROUP_CHANGED` 明确失败，返回job为空；无Raft消息ID、无该job的bridge journal，实际网络发送0次。没有改旧SQLite、版本或journal，也没有把unknown当失败重发。

现有接口没有failed的重新核对/重入队入口，同一任务不能再开根。因而在当前群重新核实后，创建同范围替代手写任务并注明旧任务发送前失败；新派工冻结群版本104。两笔根登记总计一次真实Raft根消息发送。替代任务若出现unknown，仅查询原请求，不自动再发。

## 成果与范围

搜索已完成，国家能源局原表的风电52068万千瓦（520.68GW）、太阳能发电88666万千瓦（886.66GW）与独立官方核对一致，口径为2024年底累计装机。a1234首轮因缺少技能指定运行库而明确报告PPT未生成；随后由手机原生桥在同一根线程补充允许现有Python标准库制作，不安装依赖。

补充请求 `oops-phone-search-ppt-follow-52046fc0-01eb-417a-8440-727b02990681`，communication `b5acfa46ad79423caabb1b8197cf4d5f`、outbox `ab1b51514290427794ce350487807d67`，沿用原handoff。a1234已在回复 `145bf2a3-2e0e-47b7-8b8a-d80e7b80625c` 确认继续制作并上传原线程。此为一条明确补充，不是重复根任务。

a1234在 `e356f305-7965-4b0a-8a12-62de7334dfb9` 回报3页PPTX已生成，文字、图表可编辑且包含数据工作簿；随后 `7031275e-b1c7-478d-87f1-30165985a503` 明确回报Raft附件上传失败：`FILE_UPLOAD_QUOTA_EXCEEDED`，本月免费上传额度已用尽。手机原任务API及实际页面都已读回这些真实回复，截图 `build/raft-search-ppt-20261017/phone-execution-status.png` 已保全。

没有购买额度、创建公开分享或绕过附件限制。配对a1234的原SSH probe两次均为 `SSH operation timed out after 20s`，未改用其他身份/主机密钥/来源IP；读取通道已停止。原Raft精确线程当前没有附件，`attachment-manifest.json`为空，本机没有取回PPTX，因此没有在本机打开PPT或独立验证它的页数、内容与哈希，远端结构/预览检查只记为目标Agent回报。

目前已完成真实发令、目标Agent公开数据搜索及执行文字回流；PPT制作由目标Agent回报，文件交付受限，不能称手机附件闭环完成。任务仍保持open；未代替本人保存人工成果确认或完成业务。

### 最终回报

目标Agent最终回复 `4b699f00-9c89-4e57-a12c-1993d31a1c0f`（2026-10-17 11:29，上海时间），主机 `1234deMac-mini.local`，报告PPT为3页、16:9，文字及条形图可编辑并附数据工作簿，已查看系统Quick Look转换预览，未在PowerPoint内测试编辑。这些文件仍在a1234，未取回本机：

| 文件 | 远端绝对路径 | 字节数 | 远端回报SHA256 |
| --- | --- | ---: | --- |
| PPTX | `/Users/a1234/.slock/agents/a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7/oops-energy-2024-kiyy19f8/中国风电与太阳能装机_2024年底.pptx` | 12127 | `d496a201b280d77e68a264c033faa45b71fc2dfb0d0a1f91cbadb10819e5ac3f` |
| 检索说明 | `/Users/a1234/.slock/agents/a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7/oops-energy-2024-kiyy19f8/检索说明_交付版.md` | 2297 | `6777b6f39d8971457b734d749b4769cc74430e67c9bbf6db865b139b399a0b3c` |

收尾补充仅要求停止重复上传并贴回既有文件信息：请求 `oops-phone-search-ppt-final-info-6f9a8f6e-e4c5-4963-842a-3d79f2496696`、communication `b60b1158540746df877ff9192b4596eb`、outbox `d2f13034b9d4422493d56509a17a3c37`。本轮总计1条根消息及2条同线程明确补充，无未知送达、无重复根。最终worker在线，队列0、dispatching0、unknown0；failed1为保留的发送前拒绝记录。

最终手机原生 `task.get` 与实际页面已读回完整最终回复，包含上述路径、字节数、SHA及上传额度错误，实屏保全于 `build/raft-search-ppt-20261017/phone-final-reply.png`；手机停在该任务结果，临时调试内存已清理。没有将远端回报冒称为本机已取得文件或本人验收。

### 决赛 HTML 真实任务摘要

用户随后要求将截图中的算术任务换成真实任务。已仅替换当前主稿 `artifacts/oops-finals-20261017/index.html` 和单文件交付版 `artifacts/oops-finals-release-20261017/Oops-finals.html` 的 `#proof` 区块：展示搜索2024年底风电与太阳能装机数据、制作3页PPT的实际交办，明确手机已收到回复、路径和校验信息；保留远端生成回报、附件待取回核验及业务待本人验收。移除本区块旧算式与“成果注记回流”，不把本轮未保存的人工成果注记写成已完成。

紫色布局、视频、跨端内容及其余HTML逐字保持，静态差异记录于 `build/raft-html-evidence-20261017/change-report.json`。没有运行测试或构建，没有更新历史ZIP、发布快照 `web/index.html` 或线上站点。

现有Oops adapter只导入同线程回复文字，手机没有附件下载入口。SDK原生支持附件读取，可在核对精确线程及目标回复后从原Raft附件取回文件；这不能当作手机已支持附件下载。现有a1234 SSH桥的本次probe超时20秒，未改用其他SSH身份、主机密钥或文件服务绕过。

本轮未运行测试、网站或Gradle构建、APK安装，也未调用Oops文字模型或ASR做额外验收。仅必要静态核对、用户明确要求的真实派工和交付回读。没有停止或开始手机录音，没有修改既有会议、飞书任务或个人记忆。
