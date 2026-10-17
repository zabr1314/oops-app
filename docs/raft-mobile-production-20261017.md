# Raft 手机与生产任务回流

本轮已接通主版 Android、现有生产后端的协作任务库，以及专用 @Oops → Raft → a1234 链路。用户明确授权实际派一个简单任务；另已允许正常结束当前会议后覆盖安装，并在记忆模块聊天授权两项合成一次更新。

## 实际执行结果

直接在手机 Oops 的「任务 → Oops 协作群」填写空白任务表单，只选择 a1234 的实际 @剪辑组_Astra（显示名剪辑组_Sol_6.1），确认一次「保存 Oops 任务并派工」。后端先保存独立手写任务，再登记原线程发送。没有附入会议、原话、录音、个人记忆或飞书任务资料。

简报要求在实际执行端运行 `hostname` 和 `python3 -c 'print(37*19+25)'`，只读、不写文件，并在同一根消息线程返回实际输出。收到的目标 Agent 回复为：

```text
hostname → 1234deMac-mini.local
python3 -c 'print(37*19+25)' → 728
已完成
```

发送人与回复人的真实 UUID、群 UUID、根消息及线程 UUID均已核对。手机实际读取到了原回复；算式独立核对为728，执行端名称与前期核对的a1234电脑一致。随后在手机点击「核对为成果」，填写本次验证说明并明确确认，后端任务的 `reply_reviews` 已包含同一原回复ID与哈希。任务仍 `open`、`business_complete:false`，没有自动完成业务或创建飞书正式任务。

| 对象 | 实际编号 |
| --- | --- |
| Oops任务 | `raft-task:eb5ab7779f014e3bbae197b98c7aa9eb` |
| 任务创建请求 | `oops-phone-raft-ef7ce418-56be-40f9-aca8-9a94b301dacb` |
| 交接 | `de74ddf1aa13414ea2a98a98195e28a7` |
| 派工请求 | `oops-phone-raft-c48086d5-d13a-4ae7-9ddd-c78cbf501ede` |
| 原outbox单次尝试 | `6b54ad3fc5ef4436bf8d12d308fb09e8` |
| Raft根消息 | `ed08a8fb-3b31-41db-b3f8-4b33e130c72b` |
| Raft实际线程 | `9a9d34d0-6d73-42ab-b564-5213c8d27082` |
| a1234原回复 | `7c1f24df-136a-46bd-9ac8-2f0dfee8c2d4` |
| 人工成果注记 | `fbcf41b958674a9196291383686bf924` |

[打开本次Raft线程](https://app.raft.build/s/yu-yuan/channel/9d83a076-b723-4743-b24d-3b945c73ad22?thread=9d83a076-b723-4743-b24d-3b945c73ad22:ed08a8fb-3b31-41db-b3f8-4b33e130c72b)。

![手机收到原回复并保存人工核对](../build/raft-mobile-20261017/phone-execution-reply.png)

## 回执修复与发送次数

本次只发送一条任务。首个真实发送已返回根消息ID，但Raft的 `resolve` 接口只给精简envelope，缺少发送人/群/线程UUID；首版验证因此将其保守记为 `unknown`，停止重发。

已修复桥接：以 `resolve` 提供的canonical target和完整消息UUID，调用 `messages.read({around:完整UUID,limit:1,consume:false})` 取得存储行，严格核对真正的sender/channel/thread UUID。发送验证、续发定位和回复回收均使用完整存储行。

使用 `reconcile.mjs` 只读核对实际消息内容与冻结原正文、journal digest、原消息ID及真实身份，然后以**原lease**将已有unknown回执核实为sent。核对与补回执的Raft网络写入数为0，未另发消息、未换请求编号。原线程中已经存在的a1234回复随后被回收。手机两次只读查询遇到传输EOF时保留失败/撤下旧群数据，仅手动重读GET，没有因此重发任务。

## 生产后端

以本轮实际读取的生产源码为基线，只给 `local_backend.py` 加Raft路由/初始化，并新增 `raft_api.py`、`raft_outbox.py`、`raft_collaboration.py`、`raft_task_binding.py`。原46份其他Python模块、6项原配置保持；部署时58场既有会议、原操作记录均存在，原健康能力与门槛保持。

- 原服务仍为 `https://giftedprofessor.xyz/oops-meeting`。
- 备份：`/var/backups/oops-meeting/raft-20261016T170429Z`（UTC目录名）。
- 协作任务、交接/注记、outbox/回复分别存于原state-dir下 `raft/` 的独立SQLite库，不改原会议、录音、飞书操作或Mac队列。
- 新worker配置通过独立私有env/drop-in启用；原API与模型凭据没有改动。

专用SDK worker仍在可信本机Mac上运行，使用新的生产配置和独立journal，未迁移/复用本机首轮数据库。已加载本机 `local.oops.raft-bridge` LaunchAgent，登录后启动并保留单worker锁；Raft和worker凭据只在私有配置。Mac离线/未登录时，不能声称桥接在线或任务已送达。

## 手机覆盖更新与保存

正常结束的原场为 `d401d862-7b4c-48d2-9d8a-c99cbe879daa`；保持原音/全文30天。手机显示停止、文字synced/0 pending，生产元数据回读 `asr_closure:acknowledged` 和 `ended_at`，未开新录音。

安装包以实际安装版为基线，13份原dex与Sol隔离源匹配；仅合入Raft传输/Engine方法/Activity入口，以及另行授权的个人记忆Store/桥接。保留原AndroidManifest和resources.arsc；H5以记忆窄补丁为起点再加入Raft接线。原签名覆盖安装主版 `com.oops.app`，安装后APK SHA-256实际回读一致：

`a25164abf947fbfddf33a1779ecdbc88761ba0f0b0e25bcdbbcd2fbe4880ddb2`

208份非目标APK条目保持；安装前275份业务/本机文件已完整私有备份，安装后0缺失、273份逐字节一致，变化仅profileInstalled和WebView访问日志两项系统标记。个人档案真实 `personal.list` 返回空列表，未写假个人事实；记忆两主分区的真实截图已保存。后续一次App进程重开后，也按原任务ID重新读回原回复，没有新建任务。

## 验证范围

执行了两次必要离线APK编译（第二次用于用户授权的记忆合并及串行请求闸门修正）、原签名/落盘回读、目标源码静态核对、28份移动运行时完整性检查，以及本轮用户授权的一次手机派工和结果核对。未新增或运行自动化测试套件，未启动额外录音、跑旧模型或创建飞书测试任务。

这次证明独立手写协作任务的一次实际发送、目标执行回复、手机读取和后端结果注记已贯通。手机进入页面/手动刷新读取，系统通知、多个用户身份互认、历史业务任务的手机转交入口、长时间断网与反复重连未作为本轮验收。真实来源引用合同有服务端校验代码，未用历史会议或飞书任务实跑，不把静态合同核对当成相应实测。
