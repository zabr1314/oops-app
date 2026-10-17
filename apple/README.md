# Oops Apple 原生工程

当前业务工程为 `OopsApple.xcodeproj`，schemes为`OopsPhone`与`OopsWatch`，显示名「Oops」。用户已明确要求新场改用 Oops 后端转写，沿用主版火山 ASR 协议与既有 Jev 处理；iPhone 负责 PCM 转换、受限请求与结果承接。独立服务已升级，Phone/Watch 新版签名构建、安装和启动成功。一个已有28.924秒片段的真实验证已完成：服务器与iPhone读回同一job的 `ready/acknowledged`，4句152字、136个词时间项，4项processing均ready，服务器确认引擎为 `jev-1.13.0`；只有1个job，临时PCM已清理。本次只证明该片段链路，新的整场、后台与连续WebSocket仍未验收。详见[后端 ASR 接入记录](../docs/apple-backend-asr-20261016.md)。

此前 89.392 秒/4段、本机识别20字且收尾 `incomplete` 是旧版真实历史，保留在[业务联动记录](../docs/apple-watch-business-20261016.md)，本次验证不覆盖其文字、closure或纪要。`python3 apple/generate-business-project.py`重生成业务工程；以下保留独立连接检查的说明与历史结果。

## 独立连接检查

这是独立的原生开发验证工程，用于核对 iPhone / Apple Watch 的开发安装和 WatchConnectivity。它不代表现有 Oops 产品已经接入 Apple 平台；不读取业务数据、不录音、不请求真实后端，也不含任何服务凭据。

工程：`OopsConnectionCheck.xcodeproj`。最低版本为 iOS 26.0、watchOS 26.0。SwiftUI + 系统 WatchConnectivity，无第三方依赖。

| Scheme | 用途 | Bundle ID |
| --- | --- | --- |
| `OopsPhoneCheck` | iPhone companion，内嵌 Watch App | `com.oops.development.connectioncheck` |
| `OopsWatchCheck` | Watch App 与 4 项单元测试 | `com.oops.development.connectioncheck.watchkitapp` |

独立 Bundle ID 不覆盖正式主版。真实 Team、账号与设备标识不写入可提交工程。

## 本机签名

在确认自己的 Apple Team 后，可从 `Configuration/Signing.local.xcconfig.example` 复制出 `Configuration/Signing.local.xcconfig`，只在本机填写 `DEVELOPMENT_TEAM`。该文件已忽略，工程可选读取；缺少时仍可做 unsigned / 模拟器构建。不要提交证书、描述文件、私钥、账号或设备 UDID。

真机签名、Developer Mode、设备信任以及手表与 iPhone 的系统配对分别核对。只有实际安装与收到匹配回包后，才可以报告真机端到端连接检查通过。

## 检查行为

1. 两端分别打开「Oops 连接检查」，查看实际激活、配对 / companion 安装与当前可达状态。
2. 用户点击「发送一次连接检查」才发送固定文本 `Oops development connection check`，每次生成唯一 request ID。
3. 对端只接受版本 1 的封闭检查格式，返回同一 ID 的固定 pong；其他文字、额外命令或未知字段不执行。
4. 只有本次待处理 ID 的确切 pong 可标为通过。发送失败、错误回包或 15 秒超时均结束本次检查，不排队、不自动重发；迟到回包不能完成下一次请求。

只用前台 `sendMessage` / reply handler，没有 application context、后台 transfer 队列、文件传输、网络调用或持久化。状态只保留在本次 App 进程内。可达状态不是持续连接或业务完成证明；模拟器编译 / 测试也不证明真实 Watch 与 iPhone 已配对。

## 构建与测试

下面命令从仓库根目录运行。结果和构建产物保存在已忽略的 `apple/.build/`，无需新增 iOS runtime。Watch 目的设备以本机已有 watchOS 26.0 S9 模拟器为准：

```sh
xcodebuild -project apple/OopsConnectionCheck.xcodeproj \
  -scheme OopsWatchCheck \
  -destination 'platform=watchOS Simulator,name=Oops S9 45mm (watchOS 26.0)' \
  -derivedDataPath apple/.build/DerivedData \
  CODE_SIGNING_ALLOWED=NO test

xcodebuild -project apple/OopsConnectionCheck.xcodeproj \
  -scheme OopsPhoneCheck -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apple/.build/DerivedData \
  CODE_SIGNING_ALLOWED=NO build
```

测试覆盖固定格式与回包、未知文字 / 版本 / 命令拒绝、不同请求 ID 拒绝、结束后迟到回复和下一次请求隔离。它们不模拟真实蓝牙配对或替代真机验收。

`python3 apple/generate-project.py` 可在无第三方工具时重生成 `.xcodeproj` 和两个共享 schemes；不要将手动签名信息放入生成文件。修改工程源文件列表或构建设置时同步该脚本。

## 本轮结果（2026-10-16）

- Watch App 在本机 `Oops S9 45mm (watchOS 26.0)` 模拟器构建成功并实际执行 XCTest：**4 项通过，0 失败**。结果：`.build/WatchTests-fixed.xcresult`，日志：`.build/watch-tests-fixed.log`。
- iPhone companion 连同内嵌 Watch App 的通用 iOS Simulator unsigned 构建成功，未下载或启动 iPhone 模拟器。日志：`.build/phone-build.log`。
- 首次编译发现 `textSelection` 不适用于 watchOS，已删除共享视图中的该修饰符；修复后上述同范围测试通过。
- 构建使用本机 Xcode 27.1 自带 iOS 27.1 / watchOS 27.0 SDK，部署目标保持 iOS / watchOS 26.0；模拟器运行时为 watchOS 26.0，后续已在用户真机 watchOS 26.0.2 签名安装成功，见真机记录。
- 构建日志只有未使用 AppIntents 时的系统元数据提取提示，无源码编译警告或错误。未执行全量产品构建、React / Android 测试或额外端到端检查。

以上 unsigned / 模拟器结果本身不证明真机连接。后续主任务已按用户授权完成校时、现有证书与 profile 适配、真实 iPhone/S9 目标签名、严格签名校验、安装及启动。用户已分别回报手机、手表发起的各一次固定 ping/pong 成功且 ID 一致；期间出现即时可达状态变化，持续可达、休眠恢复与后台通信尚未验收。完整事实和本机证据见 [真机记录](../docs/apple-watch-device-check-20261016.md)。

「对端当前可达」是 WatchConnectivity 的即时消息状态；手表进入休眠或普通后台时可能变化，不代表取消配对。此前成功结果与当前可达状态分别核对，不自动重发检查。
