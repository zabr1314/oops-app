# Apple Watch 开发前置环境（2026-10-16）

本文件保留初装阶段的历史结果与当时的后续计划。后续已新增原生检查工程、通过构建/4项测试，并完成真实 iPhone/S9 签名、安装、启动及两个方向各一次的连接检查；当前状态见 [真机记录](apple-watch-device-check-20261016.md)。

目标设备：用户确认的 **Apple Watch Series 9，watchOS 26.0.2**。初装阶段已完成 watchOS 开发所需的 Xcode、SDK、运行时和 S9 模拟器设备配置。当时配对 iPhone 信息尚未确认，真机连接与签名单独接续。

## 已安装与核对

| 项目 | 初装实际状态 |
| --- | --- |
| Mac | Apple Silicon / arm64，macOS 26.6.2（25G83） |
| Xcode | 官方 App Store 安装，27.1（27A9275） |
| Swift | 6.4，Xcode 自带 |
| 命令行开发目录 | `/Applications/Xcode.app/Contents/Developer`，已生效 |
| 首次初始化 | 已完成，`xcodebuild -checkFirstLaunchStatus` 成功 |
| watchOS SDK | watchOS 27.0 / watchOS Simulator 27.0，均可读取 |
| watchOS 模拟器运行时 | 26.0（23R353），arm64，CoreSimulator 显示 Ready、签名 Verified |
| S9 模拟器设备 | `Oops S9 41mm (watchOS 26.0)`、`Oops S9 45mm (watchOS 26.0)`，初装时已创建、可用，未启动；后续已运行相关 Watch XCTest |
| 开发签名身份 | 初装时钥匙串为 0；后续校时后已有 3 个有效身份 |
| iPhone 模拟器 | 本轮未安装；已暂停其下载并清理本轮分段文件，按后续配对联调需要补齐 |
| App 工程 | 初装时仓库尚无原生 Apple 工程；后续检查工程见 apple/，未接入业务后端 |

SDK 与模拟器版本分别记录。模拟器使用 watchOS 26.0，用户真机保持 26.0.2；初装时没有升级手表或 iPhone，也未编译应用；后续工程、最低系统版本和实际真机验证见真机记录。

## 安装与完整性记录

首次盘点只有 Command Line Tools，约 24 GiB 可用。用户完成 App Store 账户确认后，本轮继续下载安装 Xcode；后续可用空间已增加。Xcode 首次启动还排入了新版平台组件，为集中完成 Watch 环境，本轮退出 GUI 默认队列，暂停 iPhone 运行时，完成目标 Watch 运行时。

由于原生运行时下载速度慢，目标 watchOS 文件改用 Apple 官方目录记录的 `updates.cdn-apple.com` 资源分段续传，校验每段范围与长度，再核对完整文件的 SHA-256。结果与 Apple 目录一致。通过系统 Apple Archive 工具解包后，以 `xcrun simctl runtime add` 安装；系统再次核验并报告签名 Verified、状态 Ready。未改系统代理、DNS 或安全验证设置。

安装后已清理本轮的分段、归档和解包临时目录，安装运行时保留在 CoreSimulator 管理目录。仓库忽略的 `build/apple-platforms/installation-receipt.json` 保存版本与核验摘要；无用户账号、凭据或真实设备 ID。

## 检查入口与实际验证

`bash scripts/apple-watch-env.sh` 只读检查系统、磁盘、开发目录、Xcode 初始化、SDK、watchOS 运行时和签名身份数量。缺少必需工具或可用 watchOS 运行时会非零退出；不构建、不安装、不读取真实会议或打印签名身份详情。

初装阶段实际检查：

- 环境检查脚本成功：完整 Xcode、watchOS SDK 和 watchOS 26.0 运行时可用。
- CoreSimulator 运行时状态 Ready，签名 Verified；两台 S9 模拟器均可用、关闭状态。
- 仓库要求的 `npm run check:runtime` 成功，28 个受保护文件完整。
- **初装阶段未运行测试、App 构建、模拟器启动或真机验证；后续结果见页首真机记录。**

## 初装时的后续计划（历史记录）

1. 按产品范围选择 SwiftUI 独立 Watch App，或同时建立 iPhone companion 工程；本轮未替用户固定该决策。
2. 如需要 iPhone 配对联调，再按实际 iOS 版本安装对应模拟器运行时并配对。模拟器就绪不代表真实手表已经连接。
3. 真机阶段在 Xcode 使用用户自己的 Apple Account 和 Team，确认 Bundle ID；由用户在实际设备上完成信任、Developer Mode 等必要操作。本轮未创建证书、登记真机、保存账号密码或购买开发者计划。
4. 继续沿用队友已有真实接口、来源保护及幂等回执。WatchConnectivity 用于 Watch 与配对 iPhone 的 App 通信，不能直接连接 Android App；独立 Watch 直连后端时需要设备级授权，不能复制 Android 或 Mac 执行端的全权限 token。
5. 录音、后台运行、云保存、重连和录音豆控制后续分别实现、验证。延续日常五分钟临时保存与正式会议明确云保存边界，本轮不自动开录、上传会议或共享数据。

## 官方依据

- [Xcode SDK 与系统支持矩阵](https://developer.apple.com/xcode/system-requirements)
- [官方 Xcode 下载入口](https://apps.apple.com/cn/app/xcode/id497799835)
- [Xcode 运行时目录](https://devimages-cdn.apple.com/downloads/xcode/simulators/index2.dvtdownloadableindex)
- [下载和安装 Xcode 附加组件](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [独立 watchOS App](https://developer.apple.com/documentation/watchos-apps/creating-independent-watchos-apps)
- [WatchConnectivity](https://developer.apple.com/documentation/watchconnectivity)
- [真机 Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
