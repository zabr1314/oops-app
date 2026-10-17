# 录音豆完整硬件流程验收准备

日期：2026-10-16，时区 Asia/Shanghai。状态：**计划与静态准备完成；本文件列出的新验收均未执行**。

用户选择先做完整硬件流程验收，并同时关注高亮质量与长会议。此文件只准备真实设备验收步骤和证据要求，不将计划、代码分支或历史成功当作本轮通过。准备期间未执行 adb、设备控制、录音、网络变更、模型调用、测试、构建或部署。

## 当前已知状态与未鲜读事项

| 项目 | 最近已有证据 | 本轮不能据此认定 |
| --- | --- | --- |
| 主版 | 使用 `com.oops.app`、原签名覆盖安装；`docs/minutes-phone-sync-20261016.md` 记载最后一次安装回读 APK SHA-256 为 `6ce9554a86352e8f3145a3570846084217ddad153428e06ed9234fb684e725db` | 当前连接设备、当前安装包及是否仍在录音均未鲜读。Gradle 的 versionCode=1、versionName=0.1.0 不能区分当天多份安装包 |
| 设备与 SDK | 之前真实验收为 Redmi K70E、Soundcore SDK V1.3.02，已选录音豆真实地址保存在本机私人设置 | USB 当前是否连接、授权是否有效、设备电量/物理开机状态未知；不能拿旧地址或系统 GATT 状态替代物理确认 |
| App 开始 | `docs/bean-app-autostart-20261016.md` 记录一次 recording=0 → initial resume → RECORDING=1 → 真实 PCM 与最终转写 | 不证明设备开电源后自动日常聆听，不证明每次冷启动都成功 |
| 最终连接恢复包 | `docs/bean-reconnect-handoff-20261016.md` 记录最终包安装及用户反馈可用 | 最终版没有代理再次观测的完整关机重启验收；8.457 秒成功与约 19.5 秒失败分别来自不同条件 |
| 已有闭环 | `docs/bean-device-check-20261016.md` 曾分别取得 PCM、最终转写、ASR acknowledged、文字 synced 和原音 uploaded；`docs/minutes-phone-sync-20261016.md` 曾真机自动收到 7 份纪要 | 各自是对应场次/版本的证据，不能合成最终版长期硬件稳定性通过 |
| 后端 | `docs/backend-three-fixes-20261016.md` 记录完整输入、事项投票及零字节上传三模块已部署；回读时仍有活动会话正常同步 | 本轮不主动结束该活动会话；不代表新长会议实际完整生成、所有旧空文件已恢复 |
| 产品边界 | 真实录音豆只允许逐场明确云保存的正式会议；打开自动聆听、录音豆日常及双击切会议尚未真实接入 | 本轮不以绕过日常限制、默认勾云保存、改用手机麦或模拟 WAV 的方式通过硬件验收 |

## 开始前先只读核对

首先记录当前设备、包哈希、活动状态、会话 ID、音源、模式和保存合同。已有活动记录优先：保持其 ID、合同和当前运行状态；用户在正常结束面板明确结束后，才进行会中断该记录的冷启/故障步骤。可以先观察现有长会议，但不能把它重新标记为由本次冷启创建。

以下命令是**待执行清单，准备阶段未运行**。运行端应使用实际列出的 USB 序列号，不自动选择 `devices` 的第一行；输出和 APK 仅存已忽略的私人证据目录。

```sh
OOPS_ADB="$HOME/Library/Android/sdk/platform-tools/adb"
OOPS_DEVICE_SERIAL='<从 devices -l 核对的序列号>'
"$OOPS_ADB" devices -l
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" get-state
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell getprop ro.product.model
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell getprop ro.build.version.release
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell dumpsys package com.oops.app
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell pm path com.oops.app
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell sha256sum '<上一条实际返回的 base.apk 绝对路径，不含 package: 前缀>'
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell pidof com.oops.app
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell dumpsys activity services com.oops.app
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell dumpsys meminfo com.oops.app
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell dumpsys power
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell settings get global airplane_mode_on
"$OOPS_ADB" -s "$OOPS_DEVICE_SERIAL" shell cat /proc/net/unix
```

`dumpsys package` 只提取 versionCode/versionName、lastUpdateTime、权限与 DEBUGGABLE 等包信息；不用列出整个设备应用或私人配置。`dumpsys power` 只提取屏幕/唤醒状态；不把服务存活、唤醒锁或进程存活当作真实音频持续到达。

只读阶段日志可用 `adb -s SERIAL logcat -d -T 1 -v threadtime -s Oops AndroidRuntime`，后续观察用同样过滤器持续读取，不使用 `logcat -c` 清历史。保存前只保留连接阶段、错误类型/码、设备地址掩码、包数/长度与句数，不输出原话、ASR 原始响应、token、license 或 SharedPreferences 全文。`cat /proc/net/unix` 仅定位当前进程的 `webview_devtools_remote_...`，不假定旧 PID/端口仍有效。

若当前包开启 WebView 调试，可建立本机转发后连接其实际页面，附加纯只读事件观察器。该附加会建立本机诊断连接，因此留到实际验收阶段，不在本次准备运行。观察器必须保留并调用原 `OopsNative.onmessage`，不替换业务处理、不刷新页面、不发 `capture.*` / `settings.*` / `recall.*` 请求；只白名单保存下一节字段与事件计数。源码中的 `S` 是闭包变量，历史 `__beanMain` / `__beanAsr` 是当轮临时诊断对象，不能假定当前页面已有。

不要直接执行旧诊断脚本：

- `scripts/device_stability.py` 会先结束当前收音、切为 WAV，并可打开飞行模式；它不适用于本轮真实录音豆。
- `scripts/device_wav_recall.py` 同样主动停止并使用合成 WAV，不证明硬件流程。
- `build/bean-autostart-20261016/cold_start_check.py` 会通过 JS 勾选云保存并点击开始，不能用来替代本人本场保存确认。
- `build/*/cdp.py` 可执行任意表达式，旧端口和旧观察对象不构成只读保证；使用前必须限为本轮白名单观察表达式。

## 统一证据与判定

每次尝试使用独立 attempt 编号，记录手机本地时间和观察端单调时钟。等待失败原样保留；不要用后续成功覆盖首轮失败，也不把失败退出用时计作收音耗时。

| 层次 | 本轮最少证据 | 不足以替代它的状态 |
| --- | --- | --- |
| 来源与许可 | 实际 source=bean、recordingMode=meeting、cloudSaveConfirmed=true，原音/全文独立天数，会话 ID | 默认音源、配对或 SDK 鉴权成功 |
| 首次收音 | 同一 attempt 的扫描/连接/recording 状态、是否 initial resume、首 Opus 时间、首解码 PCM / sourceReady 时间 | resume 方法返回、GATT 已连、ASR socket 已开 |
| 持续收音 | 每 5–10 秒的 sessionMs 增量、level 变化、sourceReady/captureControl 和错误；开始/中段/结尾的自选短标记句各实际进入最终转写 | sourceReady 单次为 true、进程存活；sessionMs 是 PCM 样本累计时间，不能当墙钟时长 |
| 暂停/继续 | 同一 sessionId 和合同，设备 PAUSE_RECORD 与尾音收完、paused；继续回执及新的 PCM 增量 | 仅点击按钮、UI 文案变化 |
| ASR | 每阶段 final 计数增量、asr 状态、asrGaps；结束后 asr_closure 与错误码 | 中间结果，或单独 asr=live |
| 全文同步 | 确切 sessionId 的 ended_at、最后句、句数、syncStatus 和 syncPending=0 | 首页总数、别场 synced |
| 原音归档 | 本场 `.uploaded` 回执及服务端 complete/文件哈希；PCM 字节与实际 PCM 时长相符 | 文字已同步、纪要 ready、全局队列数下降 |
| 纪要回流 | 本场 ready、来源版本、模型标记、生成时间，App 自动出现该场状态；头/中/尾依据能回到当前原句 | 旧同版本纪要、他场 ready、人工已确认/业务完成 |
| 硬件结束 | 正常结束后的 App/ASR/连接状态，另记录用户观察的硬件录音指示状态 | App stopped、上传成功本身不能证明物理录音已暂停 |

用 `BridgeJson.state` 已有字段可观察 capturing、sessionId、source、sourceReady、sourceDetail、captureControl/error、sessionMs、level、asr/detail、asrGaps、recordingMode/合同、recordingsPending/recordingUpload/recordingsBlocked、syncStatus/syncPending、analysisPending/analysisFailed、sessionTruncated。只记 `final` 数量及时间/ID，不在验收日志复制正文。ASR closure 目前需从本场历史回包或本场录音元数据核对，不从 `asr=off` 推断。

读取本场私人文件时只选择精确会话 ID 的 `.json` 与 `.uploaded` 并筛选上述元数据；不批量导出全部录音目录，不读 `oops_settings`，不为验收更改/删除历史队列。旧无音频条目的恢复只观察正常队列处理，不伪造完成请求或清空旧数据。

## 最小执行顺序

这一轮覆盖一个确定的观察窗口，不承诺整夜待机、所有手机系统或所有无线环境。最长一场优先复用自然真实会议，不为凑字数制造无意义语音。只在本人选择正式会议云保存后开始；同一场暂停/继续不新建合同，结束后重开每场重新确认。

| 编号 | 人控动作与建议窗口 | 最小观察与通过条件 | 当前结果 |
| --- | --- | --- | --- |
| H0 当前基线 | 查看当前 App；若有活动会议先保持。本人选择何时正常结束 | 确认设备/安装包、真实音源、活动会话及合同；记录结束前后状态，不擅自结束 | 未执行 |
| H1 真冷启一次 | 本人完全关闭录音豆，确认已关机，再开机，**不按录音键**；从 App 本人确认本场保存并开始一次 | 记录物理确认与实际 recording 值；0 才证明本次 initial resume 分支，1 只证明设备当时已录音。60 秒内应真实出音或明确失败；内置已知开录前 -102 一次恢复单独计数 | 未执行 |
| H2 同场控制与后台 | H1 成功后，在同一场暂停/继续 3 轮；本人切后台/锁屏至少 5 分钟，再返回 | ID/合同不变；暂停尾音正确收完，继续有新 PCM；锁屏期间 PCM 和 ASR final 持续增长，返回不新建/重复开录、不丢原页面状态 | 未执行 |
| H3 同场网络中断 | 保持蓝牙，用户仅关闭 Wi-Fi 与移动数据约 30 秒，再恢复原网络 | 硬件 PCM 持续；ASR 明确重连/缺口，恢复后新 final 继续，本场 ID/合同不变。当前代码不承诺把断网段重新转写，实际缺口必须保留。不要用飞行模式把蓝牙断连混入网络验收 | 未执行 |
| H4 长会与正常收尾 | 同一真实场次累计至少 60 分钟（按本人安排可延长），头/中/尾各有一段本人选定的可核对事项，然后正常结束 | 全程按检查点有真实 PCM/final；无静默截断。分别核对 ASR closure、全文 ended/synced、原音 complete、纪要 ready/App 自动补取。若纪要输入未超过 40,000 字符，仅标长时硬件覆盖，不能宣称跨过旧截断边界 | 未执行 |
| H5 长待机后新开 | H4 正常结束，录音豆按本人选择保持上电待机至少 30 分钟；再从 App 明确确认新场保存 | 不在待机中自动开录；新场使用新 ID，本次明确开始后真实出音；记录等待时长和实际 recording 状态。只验这次 30 分钟窗口 | 未执行 |
| H6 再连接与一次故障断连 | H5 正常结束后再明确新开一场，构成三轮独立连接样本；本场由本人选择一次关设备或离开有效范围，等待 App 识别断连；返回后由本人显式恢复并逐场确认 | 故障失败有原因，ready 清除，不永久伪装收音；不默换麦、不新建隐形会议、不重发未知录音指令。断连后硬件实际停录状态由本人观察；需要重开则记新 attempt/新场，不能把恢复后的成功抹掉原失败 | 未执行 |
| H7 离线结束与纪要补取 | 仅当上述主链路通过且本人愿意再做：保持蓝牙，短场明确保存后断网并正常结束，恢复网络；App 后台等待，随后本人打开 App | 本场 ASR 若结束未确认应明确 incomplete；原始定稿/合同/结束按原队列同步、原音同场续传；前台自动补取同场纪要，不自动跳页或发送飞书。退出 App 后系统通知不在当前实现范围 | 未执行 |

H2/H3/H4 尽量并入 H1 的同一场，避免多次录音与多次模型整理。H7 是异常收尾补充，不能用它的预期 incomplete 覆盖 H4 正常收尾结果。未通过主链路时先停在实际故障，保留相应记录和队列，不靠连续重试凑出一次成功。

关于长会：旧问题是 `transcript()` 格式化输入超过 40,000 字符后的中段裁剪，单纯录了 60 分钟不必然触发。实际验收额外记录服务器本场原句数、格式化输入字符数、当前来源指纹；若现有自然长会议已越过边界，沿用其正常会后流程，不为验收重新生成旧纪要。已部署修复提供完整输入，但模型容量、生成错误和头/中/尾遗漏仍分别核对。高亮的误报/漏报和待办/决定/待定质量由另一份人工内容核对记录承接，硬件成功不能替代内容准确率。

## 当前可先补的观测缺口

本次只列出，不修改源码。必要时先补纯诊断观测，再进行耗时验收，不改变开录/保存规则：

1. **版本识别**：包版本号始终相同，当前需要读安装 APK 哈希；可以增加只读构建标识/SDK 标识展示，不能把源码 HEAD 当安装版。
2. **首 PCM 与持续流计数**：已有日志记录首个 Opus，但没有稳定只读的 attemptId、首 PCM 单调时刻、累计帧/字节、lastPCM 时间。首 PCM 可先由观察器采样 ready 转变，持续流由 sessionMs 增量核对；需要更精确性能数据再加不含原音的计数日志。
3. **结束时硬件暂停回执**：`SoundcoreBeanLink.stop()` 先清 sink，再发 pauseRecord 并立即 disconnect，当前桥接无法证明这次 pause 已获硬件确认；不能以 App 停止当物理停录通过。先记录用户实际指示灯观察；如要软件级验收，应单独设计有界的暂停回执观察，失败不冒报成功、不默默继续硬件录音。
4. **稳态断流**：sourceReady 首帧后可保持 true，当前 lastPacketAt 主要用于暂停尾音。连接保持但没有新音频时，单次 ready 不足；外部观察 sessionMs 增量可先发现，后续是否新增明确无包状态需另行实现，不用静音能量为 0 误判断流。
5. **回执汇总**：ASR closure、全文同步、原音 complete 和纪要来源分散在不同回包/本场元数据中；可以先汇总只读 attempt 证据表，不把它们合并为单一“已保存”标记或业务完成。

源码定位（以本轮静态读到的版本为准）：`MainActivity.kt:221–225` 明确开始/暂停/继续桥接；`SoundcoreBeanLink.kt:85–113` 启动截止时间、`191–203` initial resume、`206–248` 同场控制、`274–302` 一次已知超时恢复、`139–175` 结束路径；`BeanAudioSource.kt:133–146` 解码后确认 PCM；`OopsEngine.kt:234` 样本时间、`567–668` 收尾、`941–955/1441–1471` ASR 缺口及重连；`BridgeJson.kt:23–59` 状态字段；`minutes-sync.js:10/98–105` 纪要资格与前后台；`SessionRecorder.kt:24` 三小时原音上限。60–90 分钟窗口不覆盖三小时上限行为。

## 本轮实际证据表（执行时填写）

| attempt / 场次 | 包哈希 / SDK | 人控条件与确认时间 | 实际合同 | 首 Opus / 首 PCM | 暂停/后台/网络/断连证据 | ASR closure / final 数 | 全文 / 原音 / 纪要各自回执 | 判定与未覆盖 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待填写 | 未鲜读 | 未执行 | 未确认 | 无本轮证据 | 未执行 | 未核对 | 未核对 | 准备完成，未验收 |

最终交付逐行写“通过 / 失败 / 未执行 / 证据不足”，附本场对应版本与观察窗口。用户物理确认、代理观察、服务回执和用户反馈分开标注；失败和缺口留在结果中。
