# 协作进展读取超时修复

用户报告「执行结果读取失败，旧正文已撤下：协作回执尚未确认：timeout」。真实手机对原任务 source.links 的单次只读诊断在10030ms返回相同错误；本轮没有重新交办、取消任务或重发根消息。

## 原任务事实

原协作Task `raft-task:6404059310bf44349c5deaf2c8f12b63`，来源0235的 `ai-190f3221ef6b`，仍current/permitted/open。原handoff `5e31bdf2a4954797bfac21188aa00e30`、outbox `253b5c03de964921b1975e16edc85cbe` 已sent，Raft根 `51ba0993-ef3b-4fe8-9dee-62c8854762e1`。回复 `cb229d34-5c65-4271-843f-3d69d8825b95` 已在服务器保存，sender_id确为a1234的 `a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7`。存在回复不表示业务已完成，未自动记录成果或改飞书任务状态。

旧提示只表示当前页面在读取失败后清空正文和临时许可，未向后端发出cancel，也不代表原交办已撤销。

## 修复

旧Android RaftClient只覆盖callTimeout=20s，实际继承父http.readTimeout=10s。新GET独立连接10秒、读取20秒、单次总预算20秒，无自动重试或跳转；写请求继续原oneShot/no retry语义。H5将「当前可读」与「允许再次派工」分开，unknown/dispatching/preparing只挡写；临时读取失败撤页面正文，但保留原编号、送达事实和导航，提示原交办未取消。读取恢复后清旧错误，只回原对象；硬身份/来源/版本变化仍清私有内容。刷新与前台轮询互斥。

旧source.links对单个sent来源任务无成果注记约做5次来源验证及1次当前来源读取，每次持Task写锁跨来源网络和账号等待。新显式SourceReadContext只用于一个非worker GET，同请求复用一次label来源快照，每次使用仍核对本人绑定；没有全局TTL缓存。强POST、worker及发送前验证仍读取新鲜来源并使用严格账号guard。Task改为短读冻结receipt、释放数据库锁再查来源、短事务检查receipt未变且permitted仍1后保存状态；不能恢复已撤回许可。GET保留必要冻结交接映射修复，但不重放成果写入。

## 实际部署与安装

生产窄更新四份Raft模块，保留50份其他模块、9项保护配置、66场现有会议和1份操作；认证健康能力合同不变。备份 `/var/backups/oops-meeting/raft-read-timeout-20261017T013510Z`。源库任务、原根和回复未更换编号或重发。

手机主版已原签名覆盖安装。以重新读取的最新本地缓存版 `210a6503…` 为基线，保留它及live-agent的编译类和页面；仅替换 `raft-collaboration.js` 与包含RaftClient的classes8.dex。只编译3份RaftClient类，重合DEX的172份非目标类保留原per-class DEX来源，其他12份DEX及214个APK条目保持；未运行Gradle。APK SHA256 `d627fb7ca860bf16b5e2efd80cc87635fa1d02428fcfed31a7541fe302bc4dd8`，回读一致。安装时没有活动录音，未停止或开始录音；336份私有文件已完整备份，冷安装前后0缺失、0哈希变化。

**修复后的手机原任务回读仍待完成。** 安装和后端部署完成后USB连接断开，已有无线ADB不响应；未借助未核实的其他设备操作。用户已选择重新接USB继续核对，等待原硬件重新就绪后仅读取原任务与已有回复，不点击交办确认。

未运行测试。仅必要静态/独立权限及并发审阅、28份保护运行时检查、3类离线编译、原证书及数据保全校验和用户明确故障的单次只读复现。
