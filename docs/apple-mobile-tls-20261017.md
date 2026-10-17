# Apple 手机 TLS 连接恢复与真机演示准备

用户明确要求修复iPhone TLS连接、恢复S9开录并再做一次实录，同时准备展示手表功能的录屏。此前后端结果保留修复与17项离线用例已完成，见`apple-asr-result-preservation-20261017.md`；本记录不将它代替本轮实录。

## 实际证据

- 新Phone包已原签名覆盖安装；原6场记录的片段、原文及后端原句摘要哈希均保持。未讲话准备场的确切ID/grant暂缓仍有效。
- S9“开始正式会议”按钮灰色。手机最初退后台，重新前台后仍报能力核对失败；原配置和本机存储正常，不需要重新配对。
- 真机安全诊断为`NSURLErrorDomain/-1200`，底层`kCFErrorDomainCFNetwork/-1200`、SSL stream code `-9816`。Apple SDK `SecBase.h`及[官方错误说明](https://developer.apple.com/documentation/security/errsslclosednonotify)将它定义为无通知关闭会话；它本身不证明证书过期、服务端哪一节点出错或后量子TLS问题。
- 公网入口`giftedprofessor.xyz`的SNI/SAN、有效期及完整4段证书链均通过严格校验。叶证书有效至2026-11-27；香港真实直连TLS1.3校验通过，本机系统`nscurl --tls-diagnostics`也协商到TLS1.3/X25519。Mac的TUN/Fake-IP路径与手机实际路径不同，不能据此声称手机链路正常。
- 同一iPhone切到显式DEBUG TLS1.2诊断session后，能力GET返回schemaMatched/available/ready均true，手机重新就绪。系统证书、主机名、HTTPS及重定向限制保持，无ATS例外、无自签信任。

这组对照支持当前手机连接路径存在协议握手兼容差异，尚不能定位为某台服务器、代理或特定TLS扩展。Apple说明iOS26的ClientHello可能因后量子密钥交换而增大，旧TLS实现或中间设备可能不兼容；这只是排查依据，不是本次已证实原因。[Apple兼容说明](https://support.apple.com/122756)

日本TLS入口的严格SSH鉴权被publickey拒绝，没有尝试替换key、降低主机校验或修改入口。香港8799、ASR模块、网关和配置保持；本轮TLS核对未触发ASR或模型。

## 兼容修复范围

已实现并原签名覆盖安装仅限原确切HTTPS网关的能力GET兼容路径：默认连接仅在已观察到的`-1200/SSL -9816`组合下，独立TLS1.2 session只重读一次能力GET；成功后按原endpoint/grant在内存选择该连接。证书、域名与来源保护保持，其他host和错误不改变行为，POST/PUT及配对均不透明重放。新的配置、身份、期限或断开清除旧选择，普通启动无需DEBUG协议参数。40项实际策略的离线断言通过，随后最小签名构建、严格签名与28项运行时完整性检查完成。

实际普通启动已回读active/asrReady/ready均true，7场记录安装前后原片段/正文摘要哈希保持，准备场hold仍在。本次普通启动的实际profile为`system_default`，所以不能说这次启动在线触发了备用握手；TLS1.2独立诊断的成功与正式启动的成功分别记录。具体TLS终止节点或网络设备的兼容原因仍未证实。

本轮没有通过USB创建或发送有效开录命令，预留UUID`11F213A4-BF3F-4063-81FA-9FE932396CA2`未使用。手表开发隧道蓝牙超时，改由用户在Watch正常界面确认7/7天并录约40秒自由讲话。录音期间手机先保持全局hold，取得实际canonical并排除公开页后才释放；旧准备场专属hold持续保留。

### 本轮53.112秒真实验证完成

用户实际录完53.112秒，Watch ID为`F47E7D86-3A62-4C95-9E51-8ED64846F7B0`，canonical为`f493d3a3-13a6-430a-9f41-6a8de0fee869`，与原grant匹配、原音／全文各7天。53.112秒的两段AAC与Phone实际PCM均哈希匹配，PCM合计1,699,584字节；无削波或检测阈值下的大段低电平不代表人声没有漏词。Watch清单读取失败，换段间隙未知，不能说整表审计完成。

先仅给此canonical追加公开排除，保留原3项、其他范围及owner/0640权限；公网HTTP200列表不含本ID。备份`/var/backups/oops-apple-mobile/PRIVATE_CHECK_20261017T041600108782Z`。随后普通启动去掉全局hold，旧准备场独立hold不变。

真实两个job、每段各一个登记请求，PCM哈希和0–28.924／28.924–53.112秒坐标匹配。两段均ready/acknowledged，实际发送PCM字节完整，EOS／末包／provider_ack均true；保留5句226个原文字字符、186项词时间，拒收与溢出均0，安全异常计数空。五项Sol处理全ready，实际engine为`gpt-6.1-sol`。旧7个ASR任务及未讲话准备场0任务保持，没有重送。

Phone最终回读asrClosed=true、frozenASRClosure=acknowledged、audioUploaded=true、sourceUnavailable=false、待核对写入0；两段均transcribed。手机按段用换行连接，因此显示字符长度合计229，与原文字226分开统计。后续会后结果为无实质内容，不据此声称完整纪要质量通过；自由讲话仍需本人核对最后几句，不能以ASR状态或字数作准确率承诺。

安全回执为`watch-real-asr-20261017-f493d3a3-receipt.json`、`asr-fix-phone-final-receipt-20261017.json`、`asr-fix-watch-audio-audit-20261017-report.json`、`private-watch-check-20261017-f493d3a3-exclusion-receipt.json`及`mobile-tls-normal-launch-result-20261017.json`（均在忽略目录）。

## 演示画面准备

最初Mac QuickTime新建独立录影窗口并选择“屏幕 → 天才教授的iPhone”，实际预览显示真实Oops手机界面；当时没有开始录制或修改已有宣传片。

用户随后明确要求由本助手录成视频文件，并强调以Apple Watch画面为主。已录下手机当前新场处理／返回的补充素材，另存为`output/apple-watch-demo-20261017/Oops-iPhone-results-raw-20261017.mov`，02:35，未覆盖原宣传片。此为用户本次明确要求的本机演示导出，不向任何第三方发送。已重新打开独立手机屏幕预览，主手表画面仍等待用户开启Apple Watch镜像；手机素材不会冒称手表录屏。

用户随后确认镜像已开启，但Mac预览仍为手机详情；已请求确认iPhone是否确实停在包含手表边框／表冠的镜像界面，没有据此单方面认定系统不支持。主手表录影尚未开始，手机补充另有8秒无声音轨H.264文件`phone-results-8s.mp4`，不作为主要Watch画面交付。

用户进一步确认当时仍停留在手机Oops会话详情，尚未进入可见手表屏幕／表冠的镜像页面。已请其切到该镜像页并保持；Mac独立QuickTime窗口仍选择真实iPhone屏幕，仅预览未开录。此时不能把手机详情仍可见解释为Watch镜像捕获失败。

用户找不到入口后明确要求由助手操作。Mac原生“iPhone镜像”已成功识别iPhone 16 Pro Max；当前界面要求先锁定正在使用的手机，已请用户按侧键锁屏再由Mac接管，尚未实际进入手机设置。此路径与QuickTime只读视频预览不同，不再要求用户反复手动寻找入口。

锁屏后已短暂接管并通过系统搜索打开设置（实际停在“通用”）；镜像内容没有可用的iOS辅助树，坐标点击连续返回`noWindowsAvailable`，重绑及重置控制会话未解决，键盘搜索仍可用。调小镜像窗口后，系统又明确报告“因iPhone被使用，iPhone镜像已结束”；已请用户保持手机锁屏、仅在Mac回复后再恢复。尚未找到或开启Watch镜像，不将尝试操作记作录影完成。

随后一次重连仍未恢复坐标操作，原生镜像最终提示“连接中断”；QuickTime窗口的恢复操作也出现同一控制接口错误。已向用户如实说明目前不能代点，并将所需人工步骤缩为解锁手机、只进入“设置 → 辅助功能”页面。没有再启动录音、ASR、构建或测试；真实Watch主片仍未生成。

S9可在配对iPhone的“设置 → 辅助功能 → Apple Watch镜像”显示真实手表画面。[Apple镜像说明](https://support.apple.com/guide/watch/apple-watch-mirroring-apd890848603/26/watchos/26) [USB QuickTime捕获说明](https://support.apple.com/guide/quicktime-player/record-a-movie-qtp356b55534/mac)

Apple未单独保证Watch入站镜像与USB捕获的组合，需以实际预览确认；不承诺iPhone自带录屏能与镜像同时工作。现版Oops开录要求Phone前台就绪，镜像操作若导致Phone后台，要重新核对就绪，不为了拍摄绕过门禁。可分段展示Watch控制与Phone结果，演示只使用本次新测试的真实状态。

证据在忽略目录`build/apple-platforms/`：`apple-mobile-tls-readonly-20261017.json`、`mobile-tls-mac-check-20261017.json`、`mobile-tls-public-dns-20261017.json`、`mobile-nscurl-tls-diagnostic-20261017.log`、`mobile-tls-device-diagnostic-20261017.json`、`mobile-tls12-device-result-20261017.json`。仅保留安全元数据，无凭据、原文或原始异常消息。
