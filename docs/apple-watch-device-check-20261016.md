# Apple 真机签名与连接检查（2026-10-16）

## 当前结果

用户已再次明确要求修改本机时间。已在系统设置关闭会回拨的自动校时，并按两个 Apple NTP 节点一致的日期、上海时间手动校准到分钟；后续界面复核时间持续推进，未再次回拨，时区保持上海。手动设置后的 NTP 抽查约慢 33 秒，现有 3 个开发签名身份均变为有效。自动校时目前保持关闭，其回拨原因尚未根治。

- iPhone 16 Pro Max / iOS 26.5：已配对、Developer Mode enabled、DDI 可用；签名构建、严格签名校验、真机安装与启动均成功。用户已在手机完成开发者信任。
- S9 / watchOS 26.0.2：已配对、Developer Mode enabled、DDI 可用；按真实 S9 目标签名构建、严格签名校验、真机安装与启动均成功。
- 最终 iPhone 包内嵌的 Watch profile 已确认包含这块 S9，最终整包严格签名校验通过。
- 用户已核对一次手机发起的固定 ping/pong：两端成功且请求 ID 一致。此结论来自用户阅读真实设备界面的回报，并非代理从日志直接读取。
- 用户随后报告两端“当前不可达”，刷新后为“手表可达、手机不可达”；两个 App 进程均仍存在。随后保持前台并由手表发起一次检查，用户确认手表通过、手机收到并回复且 ID 相同。两个方向各一次的真实往返均已由用户核对成功；不据此宣称持续可达、休眠恢复稳定性或后台通信通过。

## 工程与边界

`apple/OopsConnectionCheck.xcodeproj` 是独立 SwiftUI iPhone companion 与 Watch App，最低 iOS/watchOS 26.0；使用独立的 `com.oops.development.connectioncheck` 与 `.watchkitapp`。它尚未连接现有 Oops 业务、后端或录音功能，不覆盖正式 Android 主版。

连接检查只在用户点击后发送一次固定 ping；回包必须是同一请求 ID 的固定 pong。失败或 15 秒超时不排队、不自动重发；状态仅保留在当前进程。用户已授权创建本次开发证书、描述文件以及登记本人 iPhone/S9；私钥留在本机钥匙串，真实 Team 配置在已忽略的 `apple/Configuration/Signing.local.xcconfig`。账号、Team 与设备标识不写入可提交源码或本记录。

## 签名问题及处理

最初的 unsigned 构建已通过，但签名先后受到缺少 WWDR G3 中间证书、Mac 时间早于开发证书 Not Before 的阻碍。已从 Apple 官方取得并安装中间证书，未改信任规则、导出私钥或撤销其他证书。用户曾要求先搁置校时，期间按现有资产重试仍失败；后续重新明确授权校时，校准后 3 个现有身份有效，没有继续申请新开发证书。

第一次校时后的构建发现旧 profile 与选中的证书不匹配，已让 Xcode 更新 profile，签名构建通过。S9 首次安装失败，原因是 Watch profile 只含 iPhone；随后使用真实 S9 destination 和用户此前授权的设备登记，重新构建生成包含 S9 的 profile。重新安装成功。最后重新封装 iPhone 的内嵌 Watch 包，并覆盖安装本次开发检查 App；用户完成手机开发者信任后，两端启动成功。

不能把 `WCSession.isReachable=false` 直接等同于设备取消配对。它表示当前即时消息通道是否可用，受 Watch App 前台和系统后台运行条件影响；一次匹配回包只证明对应那次往返。当前没有新增后台队列、保活、录音会话或自动重发。

## 验证与本机证据

前一轮已实际完成 4 项 Watch XCTest（0 失败）、通用 iOS Simulator unsigned 构建及通用真机 SDK unsigned 构建；本轮源码未改，未重跑该测试套件，只进行用户授权的签名构建、签名校验、安装、启动及真实设备检查。

以下文件均在已忽略的 `apple/.build/`：

- `WatchTests-fixed.xcresult`、`watch-tests-fixed.log`：前一轮 4 项 XCTest。
- `iphone-signing-retry.log`：校时前现有资产重试失败。
- `iphone-signed-after-clock.log`：时间有效后暴露旧 profile 的证书不匹配。
- `iphone-signed-profiles-updated.log`：更新 profile 后 iPhone/内嵌 Watch 签名构建成功。
- `watch-signed-device.log`、`watch-install-device-profile.json`：真实 S9 目标签名及安装成功。
- `phone-final-embedded-watch.log`、`phone-final-install.json`：最终内嵌包与覆盖安装成功。
- `phone-trusted-launch.json`、`watch-final-launch.json`：两台真机启动成功。
- `phone-process-check.json`、`watch-process-check.json`：反馈暂不可达后的进程只读核对。

本轮按仓库要求再次完成 28 个受保护文件的运行时完整性检查，全部通过；未修改受保护运行时，未运行 React/Android 构建或扩大测试范围。

## 官方依据

- [Device Hub 与设备配对](https://developer.apple.com/documentation/xcode/pairing-your-devices-with-your-mac)
- [开启 Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
- [在设备上运行 App](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)
- [手动信任 iOS 开发者](https://help.apple.com/xcode/mac/current/en.lproj/dev96a12fb84.html)
- [即时消息的 isReachable 条件](https://developer.apple.com/documentation/watchconnectivity/wcsession/isreachable)
- [WatchConnectivity 的实时与后台传输](https://developer.apple.com/videos/play/wwdc2021/10003/)
- [Apple 官方证书](https://www.apple.com/certificateauthority/)
