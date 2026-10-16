# 录音豆 App 内开始与恢复：SDK 核对（2026-10-16）

本轮用户要求重新检查能否在 Oops 直接开始/恢复录音。仅静态核对随资料包提供的文档与 Android V1.3.02 实际字节码，没有暂停、结束、更新或重新安装当前正在收音的主版，没有执行新的真机控制测试。

## 结论

| 场景 | SDK证据 | 当前判断 |
| --- | --- | --- |
| 已启动过录音、蓝牙仍连接，暂停后继续 | 官方公开 pauseRecord / resumeRecord；录音状态回调2为暂停，1包含开始与恢复 | SDK提供控制能力；Oops尚未接入独立暂停/继续链路，需按回执和真实音频验收 |
| 完全停止、从未启动录音或重启设备后的首次开录 | 文档明确要求设备已启动录音；公开SoundcoreInterface没有独立startRecord | 不能保证。resumeRecord内部确实发送开始/恢复指令，但SDK没有软件状态校验不等于固件一定接受，须以冷启动真机回包验证 |
| 暂停后已断开蓝牙 | D3200Device.startRecord检查mIsDeviceConnected；未连接就直接返回 | 必须先恢复蓝牙连接再发送恢复，不能把命令发出或调用返回当作恢复成功 |

## 直接来源

1. 资料包 docs/SoundcoreSDK_ToB_集成文档.docx / 同名HTML，录音控制模块：resumeRecord(macAddress, uuid)、pauseRecord(macAddress, uuid)，前提为设备必须已经启动录音；状态STOP_RECORD=0、RECORDING=1、PAUSE_RECORD=2。实时音频模块说明pauseRecord后设备继续发送尚未传完的音频，随后停止传输。
2. Android SDK classes.jar 的公开SoundcoreInterface / SoundcoreSDK：有resumeRecord、pauseRecord、acquireRealtimeAudioData，没有独立公开startRecord。
3. 实际调用链：SoundcoreSDK.resumeRecord → SDKManagerImp.resumeRecord（先校验授权）→ D3200Device.startRecord（必须连接）→ AudioEventSendManager.startRecord → AUDIO_CONTROL命令、单字节载荷1。pauseRecord对应同命令、载荷2。
4. iOS模块SDK公开头文件也将resumeRecord说明为恢复录音，并保留已启动录音的前提；没有据此修改iOS工程。

反编译结果位于已忽略的build/bean-private/*-bytecode.txt；不是新增或建议使用未公开私有接口。不能把内部方法名startRecord单独作为首次开录已支持的证据。

## 当前Oops集成差距

源码只在SoundcoreBeanLink.stop中调用pauseRecord，随后disconnect；主版没有capture.pause / capture.resume桥接，也没有调用SDK resumeRecord。此前暂停后重新开始测试实际走的是“暂停、断开、重新扫描”，恢复命令没有发到设备。先前把这条重连失败路径直接归结为每次必须按硬件键，结论范围过大。

DeviceInfo.recording文档为0/1，不能仅凭0区分首次未开录与已暂停；应结合onAudioRecordStatusChanged和recodingOriginalTime等实际回执，未知状态不能冒认暂停。SDK方法返回Unit，无独立成功返回值，必须等RECORDING回调及新音频包。

## 可实施路径与验收边界

- 先做同一正式会议内的暂停/继续：暂停保留蓝牙连接与会话、保存合同和SDK临时目录租约，接住暂停前尚在传输的尾音；暂停状态不能继续显示收音或让ASR空转重连。继续调用resumeRecord，按真实状态回包恢复音频传输和ASR，失败给出可恢复原因。
- “结束会议”与“暂停”分开。结束继续按原会话的ASR尾包、云保存及临时副本清理规则关闭；不能为了随时恢复而默默继续硬件录音，或在旧文件写入未结束时删除/复用临时目录。
- 首次开录和断开后恢复分别验收；只在用户明确开始且已确认本场云保存时尝试控制。连接或鉴权成功不能代替开录授权，日常五分钟限制不绕过。
- 尚未实现或真机验收本节新控制链路。当前手机正在收音的会话保持运行；不能把本次静态核对写成控制测试通过。
