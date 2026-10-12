# 录音豆接入准备（2026-10-12）

还没有样机。下面这些已经写好并通过测试，等拿到设备和鉴权信息后再做真机验证。

## 已经准备好的

| 部分 | 位置 | 状态 |
|---|---|---|
| 录音豆音频源：Opus 解码、双声道合成单声道、48k→16k、按 100 ms 一帧交给下游 | `android/.../audio/BeanAudioSource.kt`、`OpusDecoder.kt`、`BeanFrames.kt` | 单元测试通过；系统 Opus 解码器还没在真机上跑过 |
| 丢包按缺失时长补齐时间轴；标记键按一次算一次「找回刚才」 | 同上 | 单元测试通过 |
| 录音豆模拟：把内置对话按录音豆的格式（每包 160 字节、20 ms）实时回放 | `ReplayBeanLink.kt`，音频 `assets/test/dialog.opusraw` | 设置 → 音源 →「录音豆模拟」 |
| 真实 SDK 接入：鉴权 → 扫描 → 连接 → 确认设备在录音 → 边录边传 | `android/app/src/soundcore/.../SoundcoreBeanLink.kt` | 按 SDK 文档和 v1.3.02 的实际接口编写并编译通过；未连过设备 |
| SDK 不进 git：有 SDK 的电脑才编译真实接入，没有的照样能编译 | `app/build.gradle.kts`、`scripts/bean_sdk_setup.sh` | 两种情况都编译通过 |
| 后端声纹按设备分开存，新增 `bean` | `scripts/local_backend.py` | 测试通过；**未部署到香港** |
| Mac 上转换录音豆的 Opus 裸流 | `scripts/bean_opus.py encode/decode` | 测试通过；可直接解 SDK 存下来的离线文件 |

## 本机使用

```sh
scripts/bean_sdk_setup.sh          # 从资料包打包 SDK 到 android/app/libs/soundcore/（已忽略）
./scripts/check.sh                 # 全部测试 + 编译
python3 scripts/bean_opus.py decode 录音豆文件.opus 输出.wav
```

鉴权信息暂时从 `android/local.properties` 读取：`BEAN_USER_ID`、`BEAN_DEVICE_ID`、`BEAN_TOKEN`、`BEAN_LICENSE_JSON`、`BEAN_LICENSE_SIGNATURE`、`BEAN_PRODUCTION`，可选 `BEAN_MAC`（只连这一台）。正式方案是由香港后端用 app_key 换取 token 后下发给 App，app_key 不进安装包。

## 需要问安克的问题

1. `POST /v1/third_party_sdk/get_token` 的请求参数和返回参数：文档里这两张表是空的，swagger 链接也没有附上。返回值里是否同时包含 `licenseJson` 和 `license_signature`？token 的有效期多久？
2. `X-Product-Code` 填什么：是 `D3200`，还是另有 PN 号？比赛用的是测试环境 `speaker-api-ci` 还是正式环境？
3. 边录边传的 `sequenceNumber` 是从 0 开始、每包加 1 吗？会不会回绕？断线重连后是接着编号，还是从头开始？
4. `isMark` 是按一下标记键只有一包为 true，还是按住期间连续为 true？
5. 实时 Opus 流的编码参数：是否有 pre-skip？是否固定 64 kbit/s（每包 160 字节）？两个声道是两个麦克风，还是同一路复制了两份？
6. 能否由 App 启动录音？文档只有暂停和恢复（resume），没有开始录音的接口，也就是必须先在设备上按录音键？
7. 边录边传时，如果蓝牙断开一段时间，设备会不会补发断开期间的音频，还是只能会后通过离线文件补齐？

## 拿到样机后的顺序

1. 在 `local.properties` 填好鉴权信息，`scripts/bean_sdk_setup.sh` 后装到测试手机。
2. 先选「录音豆模拟」，确认这台手机的系统 Opus 解码器正常（能出转写，延迟和手机麦接近）。
3. 换成「录音豆」：按录音键，App 里开始记录，确认能出转写；按一次标记键，确认会触发「找回刚才」。
4. 断开蓝牙 10 秒再恢复，确认时间轴补齐、转写能继续。
5. 每个人用录音豆在会议座位上重新录一次声纹（新的 `bean` 声纹），再部署后端的 `bean` 声纹支持。
6. 开一场真实会议，打开「本场录音存到手机本地」，会后用这批数据重新校准声纹阈值。
