# 转写后 Sol 统一：生产与主版交付

日期：2026-10-16。用户已明确授权部署现有生产后端、打包并原签名覆盖更新主版 APK，保留功能及业务数据。本文件记录实际交付状态，区别于上一轮仅本地源码完成。

## 当前状态

- APK 已构建、原签名覆盖安装到当前 Redmi K70E，安装包哈希回读一致，App 正常打开。
- 生产六模块已精确部署，认证健康为 `ok`，文字处理回包标明 `sol / gpt-6.1-sol / version 1`。
- 用户已明确允许正常结束保存后更新。实际活动记录为手机麦克风正式会议；已通过原结束面板正常结束，保留原音/全文各30天。完整备份完成；安装前后253个原文件全部存在且 SHA-256 完全一致。
- 新 Sol 召回使用空概率的语义候选契约，须由本次新 APK 承接；两端更新处于本次正常结束后的同一窗口，更新期间未重新开始录音。

## 主版 APK

安装包：`build/sol-unified-rollout-20261016/Oops-sol-unified.apk`。

- SHA-256：`985f61668d0398bc858bcb043b63d86890fb00316fa4ab8d78c3588c23c2283f`。
- 包名 `com.oops.app`，证书 SHA-256 `21f45ad84a683f71505afadfebf5e0f8f6b11a32ce57bea443c113bfe13efb88`，与原手机及近期任务核对版本一致。
- 隔离目录离线 `assembleDebug` 成功；版本、权限和旧手机 BuildConfig 字段保持一致，未输出配置值。
- 旧包105项资源全部保留，103项逐字节一致；仅 App 页面及模拟桥接脚本承接当前集成功能。纪要自动同步、原设计资源及录音豆能力保留。
- 与最近一次完整任务核对构建相比，261份缓存 class 逐字节保持；录音豆、ASR、收音服务、MainActivity、Settings 和 HttpOopsApi 等关键产物没有变化。只移除旧 Store 排序方式对应的编译器辅助类，无功能类缺失。
- 签名、APK 对齐与28份受保护运行时文件静态核对完成。未运行测试套件。

覆盖安装使用 `adb install -r`，没有卸载、清数据或更换身份。私有完整备份含253个文件，压缩后655,514,160字节，保存在已忽略、目录0700/文件0600的本机交付目录；安装前冻结原进程后再次核对来源，未发现需要补备的增量。安装后冷态逐项哈希与安装前一致，缺失/变更均0。随后正常启动 App，页面与原生桥接就绪，没有自动重新录音。

启动回读为 `capturing=false`、`asr=off`，音源仍为本人原先选择的 `mic`，`recordingsPending=0`、`recordingUpload=done`、`recordingsBlocked=0`。这只是当前队列与启动状态，不是录音豆冷启或持续使用质量验收。

详见忽略目录中的 `android-package-report.json`、`android-compiled-baseline-audit.json`；未将代码构建等同于真机效果验收。

## 生产准备

目标保持 `ser108841712320` 的 `oops-backend`，源码 `/opt/oops/app/scripts`。通过已有受校验的 Mac mini SSH 桥接访问，未改变连接配置。

仅四个原模块 `local_backend.py`、`meeting_features.py`、`feishu_actions.py`、`task_board.py` 合入相关片段，新增 `sol_text.py` 和 `minutes_long.py`。生产独有的 OAuth、任务候选核对、from-item、个人发送许可、删除待处理与来源保护均保留；不以整本本地后端覆盖生产。

另对新路径补齐生产完整删除检查，以及问题处理缓存的删除/到期回写保护。21个关键既有函数与敏感 HTTP 分支逐项静态核对，26个原健康字段保持；六候选哈希均固定。部署工具先核对全部45份原 Python 源码与私人配置基线，备份后原子安装，保持权限，只重启该服务；失败只回滚相关源码，不回退业务数据。

复用原私人 Sol 配置，长会分段开关保持关闭，纪要版本仍5；不触发历史重算，不修改保存期限或飞书发送确认。

生产备份：`/var/backups/oops-meeting/sol-text-20261016T125757Z-10h_wmu3`。服务 PID 从 `1276571` 更新为 `1288483`，六模块落盘哈希匹配；其余41份原 Python 源码与49项受保护文件/目录状态保持一致，原健康能力及门槛保持。53场会议文件无缺失，52份逐字节不变；变化的一份为本轮正常收尾的活动会议。

本场 `d3cf6bd5-7102-4a4d-b98d-390db7f0006b` 手机原音结束与服务器会议结束均在 `2026-10-16T12:57:29Z` 附近，ASR closure=`acknowledged`、错误码空，全文与结束状态 `synced`、待同步0；服务端有515句，原音342,560,000字节。结束时原音队列仍上传中；随后真实取得手机 `.uploaded` 与服务器 `complete.json` 回执，全部文件声明一致，服务器原音整文件 SHA-256 再次读取并与手机声明相同，原音完成与文字同步分别确认。

本场已有 `gpt-6.1-sol`、version 5 的纪要缓存，未据此宣称内容准确率通过。部署后的218条启动/运行日志摘要未见 traceback 或异常类记录；没有为验收额外请求模型。

## 验证边界

已完成源码静态核对、授权的 APK 构建、签名与包内容核对、真实生产部署/健康回读、正常收尾、完整备份、主版安装、数据哈希与启动回读。未运行测试套件，未为验收发起模型调用、新录音或外发。真实高亮质量、长会分段启用及完整硬件稳定性仍需另行验收。

私人证据目录：`build/sol-unified-rollout-20261016/`，主要回执为 `production/deployment-result.json`、`production/postflight-summary.json`、`installation-receipt.json`、`phone-backup-receipt.json`、`phone-final-state.json`、`current-audio-server-receipt.json`。原 APK 与服务器源备份均保留；没有回退业务数据或重新生成历史会议。
