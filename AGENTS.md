# Mobile Prototype Agent Guide

## App 已有内容优先本机缓存（2026-10-17）

用户要求已经读过的内容尽量保留在App，只有新增或变化内容再向服务器取回，以减少切页等待。Android会议列表/详情/纪要、项目和任务采用私有显示快照优先、后台条件GET核对；内容不变复用本机正文。本人核对、Raft授权、发送及业务完成仍以实时来源校验和原回执为准，缓存不扩大原保存期限或访问权限。

首次交付仅源码，后续用户明确允许部署及更新主版。本轮已窄部署主后端单模块，原53份其他源码及20项保护配置保持，只重启主backend，History/整理worker不动。1080份业务文件0缺失，2份并发业务变化未回退。真实只读详情200后条件GET返回304/正文0字节，原能力及无凭据401保持，备份 `/var/backups/oops-meeting/app-cache-20261017T012804Z`。

主版已以最新 `ee7a4bdf…` 原包窄更新为 `210a6503…`，仅两H5及三个DEX变化，211其他条目/10其他DEX保持；325份私有文件冷安装前后均无缺失或哈希变化，原备份链及本轮9份差异保全。准备期间发现新正式会议后停止安装，获用户单独允许再正常结束保存；服务器ASR acknowledged、手机synced、上传done/队列0，30/30天保持。新包已普通启动，真机实际回读列表、详情、ready纪要的缓存首包和未变化最终回包，私有落盘也已确认。未运行测试、全量Gradle/网站构建、性能基准或新增收费验收请求；仅必要离线增量编译、签名与部署/安装交付回读，不作速度比例承诺。

缓存按服务器、凭据范围、个人会话与已核绑定版本隔离；有效显示最长60秒且不越来源期限，有完整期限合同的正文可短期私有落盘，未知来源仅内存。来源/身份变化、删除、到期与迟到回包保护保留。实际范围见 `docs/app-local-cache-20261017.md`；后续更新仍须从生产及手机最新基线窄合入并保留并行增量。

## History 读取超时续修（2026-10-17）

用户报告真实History反复超时并清空，已在线上复现并窄更新3文件：详情鉴权只核对目标会议自动公开资格，固定/个人会话及来源、删除、期限规则仍逐次校验；列表单请求复用纪要状态，不跨请求缓存正文。前端合并同路径同validator的在途GET、各调用独立正文，写会话时换代清索引；已结束会议保留30秒和聚焦核对，活动会议仍5秒。15秒单次截止、超时清空和恢复位置保护保留，不靠延时或失效正文掩盖。

备份 `/var/backups/oops-history/read-stability-20261017T023814Z`；仅重启History至1397101，主后端/整理worker不动。132业务、63保护项与64其他History文件均0缺失/0哈希变化；337句/284步骤及完整API投影保持，304零正文和范围外403保持。原页面已实际自动恢复39:01与190/337，新读取器也已实读同场；337旧复核来源变化提示仍保留。未运行测试/构建/基准或模型/ASR请求；记录 `docs/history-read-stability-20261017.md`。

## History 16:9 动态展示（2026-10-17）

用户已授权将16:9版更新到原线上History并使用真实会议，生产已窄更新4文件（页面、两份展示资源、静态白名单）。独立逐句页在至少960×480时默认进入16:9，动态舞台约79.5%高度，原话/连线/分类列比例32/46/22；返回完整页以wide=0保留本人选择，PPT内嵌不默认进入。选会、来源与详细记录可展开，原播放、60倍、检索、整理及PPT入口保留。

备份 `/var/backups/oops-history/wide-20261017T021637Z`；仅重启History，63项后端/配置及63份其他History文件保持，主后端和整理worker进程不变。132份业务/合同/私有复核文件0缺失，131份哈希保持，另一场并发新增原话未回退。真实471句路演会议已×60回读，168/471句及类别累计一致，完整页往返保持位置。337句独立复核当前source_changed，原保护继续撤下旧复核并提示，只显示原保存分类；本次未恢复、重算或改写。仅必要静态、健康和线上交付回读，未运行测试/构建、模型/ASR请求或手机更新，详见 `docs/history-wide-20261017.md` 生产段。

16:9续修：用户截图发现337句选会后来源变化长提示遮住播放栏，已纯静态窄更新3资源，无服务重启。提示改独立布局行并只显示实际原因，完整来源说明保留；原选会从0暂停行为及来源失效保护不变。63保护项、64其他History文件和132业务记录均0缺失/0哈希变化。用户指定337句已实际60倍播放至39:01、190/337及累计一致，播放控件可见且不再被提示挡住；未测试/构建，详见同一交付文档续修段。

## History 按会议内容分类（2026-10-17）

用户随后明确要求真实判断该337句会议。本轮由当前聊天助手结合上下文逐段复核，独立保存分类、理由与原话依据；来源标为“本次助手复核”，不冒称原会议当时判断、后台Sol新请求或本人确认。补全原50段缺失分类，仍保留28段待厘清；新增事实陈述与问题类型仅属于本次复核，不从原六类标签倒推。原标签、过程和纪要保留，本机预览与生产更新分别记录于 `docs/history-judgment-20261017.md`。

用户以「录音助手功能收敛与路演准备」337句会议明确希望主要看每句话是决定、观点／判断等内容作用，并进一步明确重点是原「逐句 · 判断回放」60倍速的动态分布，而非另做一个静态分类页。保留原回放为默认入口，右侧及连线优先按内容去向逐句累计，可原位切换实际处理分工；仅保存最终标签的句子仍进入其类别，未记录分类独立显示，不伪造处理步骤。辅助全场检索才显示不随回放变化的总数、筛选、搜索与上下文。“无意义”不作为类别名称，使用“闲聊／衔接”，保留原话。决定及待办分类不自动等于本人确认、正式任务或业务完成，未记录、待厘清或闲聊不作为失败或删除依据。本场原库只有六类标签，不伪造事实／问题的独立历史分类，不因浏览补调模型。实现、预览与生产部署分别记录于 `docs/history-content-20261017.md`。

用户已明确授权将337句复核与新版页面更新原History；2026-10-17生产已窄更新12文件（7份既有、5份新增），独立私有复核绑定原会议、原快照及当前来源合同，原标签、280条过程记录、284步骤和纪要保留。API实际ready337，八类计数11／23／83／31／24／8／129／28；87份会议文件0缺失／0哈希变化，92项后端／配置与51份其他History文件保持，只重启History，原权限保留。真实线上深链接已直接×60播放，终点337／337计数一致，新“60倍速回放”从头启动；既有30秒清理已接来源删除／到期／变化，私有派生副本不绕过原来源保护。备份 `/var/backups/oops-history/content-review-20261016T232033Z`；实际状态取代此前仅本机状态，详见同一复核交付文档生产段。仅语法、28文件运行时完整性及交付回读，未运行测试／构建或新增模型／ASR请求，不作分类准确率声明。

用户继续要求处理「安克黑客松决赛开赛与赛制说明」225句、225条过程记录，已逐段独立复核并更新原History；主类为决定0、待办候选1、观点73、事实98、问题6、限制15、衔接22、待厘清10，41段保留次要内容。声纹测试朗读不作真实事实，过往职业选择不作本场决定，主办方承诺不作本人任务，赛制规则与赛程事实分开，193段楼层矛盾保留待核对。生产只窄更新两个脚本并新增私有侧车，保留本场原文／225过程／460步骤和先前337句复核；87会议文件0缺失／0哈希变化，93保护项及61其他History文件保持，只重启History。备份 `/var/backups/oops-history/anker-review-20261016T232750Z`，原权限与来源失效清理保留，清理任务更新后已执行成功。公网API已ready225，线上浏览器实际自动×60，终点225／225及八类计数一致，无警告或控制台错误；切处理分工保持时钟，原规则40步／Jev420步／Sol0步，不作模型调用次数或Sol旧判断声明。仅必要静态、28文件运行时完整性及交付回读，未测试／构建或新增模型／ASR请求，详见 `docs/history-anker-judgment-20261017.md`。

## 会议确认任务派给 a1234（2026-10-17）

用户要求手机里核对会议任务后直接派给 a1234，并将执行回复与成果回到对应任务。接入原 App 会后已确认待办及核对站本人已确认答案；派工时另行核对本次正文和群成员，不自动批量发送、附入整场会议或创建飞书任务。原负责人和执行 Agent 分开，业务完成仍由本人决定。来源、本人绑定、核对版本或权限变化停止后续派工，未知发送只查询原请求，不降为无来源手写或重新发送。

App 会后事项的全局历史 `review.by` 不能当作本人身份，新增独立本次派工确认须由服务端验证个人飞书会话；核对站来源只使用本人答案。回复与成果注记按真实来源对象、独立协作任务和确切 Raft 线程绑定，原会议与各人的答案保留。本轮核对站暂无单事项单调版本，保守冻结本人的会议核对版本；该版本变化需重新核对，不能声称只影响改动的单事项。源码、生产部署、真机安装与真实业务派工分别记录于 `docs/raft-meeting-tasks-20261017.md`，前一轮手写只读任务的成功回流不代替本轮会议派工验收。

生产已窄更新3个Raft模块并新增1模块，其他48模块、8项原配置及62场会议/1份操作保留。用户另外允许新场正常结束后更新；并行历史聊天已正常结束8dcbd7bb…，服务器ASR acknowledged，手机synced/待同步0、原音done，30/30天保持。主版已原签名安装并回读，两个H5及相关单DEX增量同时保留个人记忆、历史读取及已授权短会议筛选文案，213其他条目保持；304份私有文件安装前后无缺失/哈希变化。真机成功读取本人确认任务、版本与当前a1234目标；两项派工确认未预勾、未发送真实会议任务，不冒称本轮业务执行闭环已经验收。同源同版及同Task根线程防重，账号重绑不会复活旧许可；没有原许可直接恢复入口，须实际重核对原事项版本。仅必要静态、保护运行时及离线原生增量编译，未运行测试套件。

## 往期会议读取与空记录过滤（2026-10-17）

用户继续要求不足3分钟的会议先默认不显示；原0句过滤继续保留。仅对有合法起止时间且0≤时长＜180秒的记录新增默认隐藏，恰好180秒显示，时长未知或负值不推定为短会议。仍为可恢复的列表筛选、不删除数据，“查看全部”保留；当前收音和收尾继续通过本机独立活动卡承接。前端隐藏数量、开关和空态使用通用文案，不把有原话的短会议说成0句或没有内容。实际交付见同一文档的3分钟续改段。

不足3分钟续改已上线并由“raft 连接”统一合包覆盖主版（c5056336…），保留个人记忆、Raft会议派工及录音功能；304份手机私有文件安装前后哈希一致。生产只改显示判定函数，51份其他源码和14项配置保持，部署现场63场会议、1份操作、52份保存合同无缺失/哈希变化；后续并发业务更新未回退。真机原生桥实际回读默认21/63、隐藏42（26场0句、16场短会）；查看全部最近30场含原0句及短会，partial=false。用户允许正常结束保存后更新，本场ASR acknowledged、文字synced、30/30天保持，不据此声称原音整文件已云归档。未运行测试套件或Gradle，详情见交付文档最新段。

最新展示规则：用户明确要求此前14场0句会议也默认隐藏，不删数据，保留“查看全部”入口。此要求取代下文ASR未确认、旧记录未结束或资产未知时继续显示的旧过滤门槛；0有效句统一从默认往期列表隐藏，不将隐藏等同无录音、无结果、来源失效或删除。当前正在收音/收尾仍由本机独立当前会议卡和固定控制承接；查看全部、原会议详情及项目/任务已有结果保留。实际部署及手机更新见交付文档最新续改段。

续改已部署及覆盖更新主版：生产仅改一个显示判定函数，50份其他源码与14项配置保持，59场会议/操作/合同哈希保持。全库实际默认隐藏26场0有效句，包含此前14场；手机默认列表0句为0，点查看全部读回原14场，随后已回到默认隐藏。主版仅一份H5脚本变化，215个其他APK条目和13份DEX保持；283份私有文件无缺失/哈希变化。未停新录音、运行测试或Gradle构建，原上传队列已读到done。

用户要求优化往期会议经常请求失败，以及0句原话会议的默认过滤标准。本轮选择可恢复的列表过滤，不自动物理删除。确证已经结束、ASR结束获确认、原话无文字、纪要已完成且无实质内容、没有独立摘要/短依据/人工内容/任务或录音的记录默认收起，可在会话与记忆会议列表查看全部。正在同步、ASR失败/未确认、有录音、已有结果、全文自然到期或资产状态未知的0句会议继续保留；不将短句、没有待办或模型判断无关作为删除依据，既有原文折叠与查看全部保留。

本轮源码将历史列表的重复全目录清理及外发操作锁等待移出逐场读取，坏档单独提示部分读取；原自动题名保留为单在途异步扫描。安卓历史只读GET独立20秒总预算、至多一次临时故障重读与同身份同路径在途合并；默认过滤先于最近30场截取，显式查看全部才包含空记录。新权限/来源失效、删除和迟到回包保护保留。只完成源码和本地隔离示例，未运行测试、构建、生产部署、APK安装或真机验收，不改变原录音收尾及其他聊天统一安装的分工。交付见 `docs/history-stability-empty-filter-20261017.md`。

用户随后明确授权部署后端并更新手机主版、保留功能和数据，并在发现活动收音后另外允许正常结束保存。已正常结束录音豆正式会议，ASR acknowledged、文字synced、30/30天合同保持。生产只窄合入3模块，48份其他源码及14项配置保护保持，59场会议、1份操作和48份保存合同无缺失。主版已原签名覆盖更新：只替换2个H5脚本和3份相关DEX，211个其他APK条目保持；281份手机私有文件安装前后无缺失、无哈希变化。真机已成功读取最近30场、总数59、partial=false；其中14场0有效句均因转写未确认或未结束而保留，当前实际隐藏0场，不冒称已清空零句。原音上传待办保留并在更新后续传，不把文字同步冒称原音云归档完成。未运行测试套件，仅必要离线APK编译、静态与交付回读；实际状态见交付文档部署段。

## 记忆分为会议／项目与个人（2026-10-17）

用户进一步明确个人记忆的主流程为「从日常对话自动整理身份、偏好、目标和经历 → 本人核对、修改或舍弃 → 保存到真机」，手动填写仅作补充。普通日常高亮不能冒充已提取的个人档案；没有本人核对不得自动成为已保存事实。提取沿用既有 Sol 文字处理请求，不额外重算旧记录或新增收费调用；建议分类、模型整理与原话短依据分开，明确核对内容确属本人，不因第一人称、显示称呼或匿名声道推定真人身份。保存应保留核对版本和必要来源，沿用本机私有、来源失效与迟到回包保护。源码、生产接入及真机安装仍分别记录，不能以实现替代实际交付。

自动个人候选链路已窄部署Sol单模块并更新主版真机（2026-10-17）：仅日常请求显式启用，同次回包提取五类候选；原生同库原子确认／舍弃并记录精确回执，来源修订更新版本，未知只读核对。合包以最新往期会议版13904399…为基线，保留其读取／0句隐藏及Raft；安装包c4608bdd…实际回读一致，296份原私有文件无缺失／哈希变化。用户允许正常收尾后更新，两场录音豆正式记录均ASR acknowledged、文字synced、上传done，30/30天不变。个人页与新版原生桥已实读，当前typed候选0、processing_status=not_observed，不宣称真实分类／确认质量已验收。旧23条泛高亮未补算或代确认；录音豆日常SDK限制保留。仅必要静态、离线打包、部署／安装回读，未运行测试套件或额外收费模型请求，详见docs/personal-memory-auto-20261017.md。

用户要求做好记忆模块，明确分为「会议／项目」与「个人」。会议侧展示每一次会议录音处理后的内容与已有结果，包括总结纪要；项目串联相关历次会议及其决定、行动。会议仍使用原会话对象、来源和结果状态，不复制成个人记忆，查看不触发重新分析。个人范围已由用户明确选择为本人身份、偏好、目标、经历及日常值得记住的事；不以人物库、收藏或模板替代此定义，既有辅助入口与深链接保留。

本轮沿用现有紫色界面与五导航，先补本地页面和Android本机私有手动档案。原生个人档案使用独立不自动备份的本机存储，不改变任务身份、声音许可或已有录音／保存片段；手动填写从空白开始，不推断或伪造个人事实，不默默传给模型、云端或项目。日常候选仍逐条确认并保留短依据。云同步、生产部署、APK构建／安装与真实设备验收不因本地源码实现自动完成；实际交付状态见 `docs/memory-module-20261017.md`。

用户随后纠正「我说的是真机」，本项交付以主版 `com.oops.app` 实际安装及记忆入口接通为准，不能以网页预览完成代替。用户明确允许通知「raft 连接」聊天，将两项合成一次原签名覆盖更新，避免相互覆盖；由该聊天统一负责其已获允许的正常结束当前正式会议及最终安装。本聊天负责记忆增量与接通核对，不另行停录或重复安装。原APK作为基线，保留两项新增及原录音、纪要同步、业务数据；实际安装状态仍以交付记录为准。

真机合并版已原签名覆盖安装并启动；当前会议正常收尾后ASR acknowledged、文字synced，原保存合同保持30/30天。手机实屏已显示记忆两区和个人五类，实际原生personal.list回执ok/count=0；未替用户填写个人事实或验收全部增改删。安装前275份私有文件无缺失，273份哈希保持，仅系统/WebView标记变化；必要APK编译与交付回读已执行，未运行测试套件。个人仍仅本机私有，不冒称已接云同步或模型使用；证据与限制见 `docs/memory-module-20261017.md` 真机交付段。

用户继续指出个人全空、任务提示部分会议不可读。真实日常有23条未确认候选、手写及单独保存均0；个人页须直接承接已有日常内容与核对入口，不能只数新手写档案而让用户误以为原内容全空。候选与已确认仍分开，不为了填满身份／偏好／目标／经历而编造或自动确认。任务三场16条来源均ready，原失败为App会后已确认待办的2秒投影超时；修复需保留来源与删除／到期保护，区分忙、超时和异常，不能靠隐藏提示或延长等待掩盖。实际交付见 `docs/memory-personal-task-read-20261017.md`。

续修已落到真机及生产：仅两份H5资源更新，214个其他条目及13份DEX保持，275份安装前文件无缺失/哈希变化；个人已显示23待核对、0本次确认与3条真实预览。生产仅改两模块，49份其他模块与8份配置保持；手机任务回读三场16条及App汇总均ready，本次汇总396ms（不作固定性能承诺）。未运行测试套件、Kotlin或网站构建；核对后新场录音保持运行，未再次停录或安装。个人候选仍待本人核对，实际姓名/身份与模型使用授权不扩大。

## 转写后全部理解整理统一 Sol（2026-10-16）

用户明确选择“转写后的全部理解整理统一用 Sol”，取代此前仅会后纪要切 Sol、实时文字仍 Jev/DeepSeek 的范围限制。ASR、MiMo 第二识别参考与声学/声纹不变；所有新文字模型调用共用现有私人配置的 `gpt-6.1-sol`。原有独立校准负责人规则、人工确认、来源失效、日常五分钟与逐场云保存及外发确认保留，Sol 语义选择不伪造概率或套用旧 Jev 概率门槛。

统一处理器、结构化高亮与 Android/H5 承接已完成，摘要、短原话和本人改写分别保存；相似只分组不删原句，确认/舍弃防迟到回包复活。用户随后明确授权生产部署、原签名覆盖更新主版，并允许正常结束当前记录后安装：实际结束的是 Redmi K70E 上 mic 正式会议，保留30/30天，ASR acknowledged、文字synced，后续原音完整归档与整文件哈希另获确认。生产四模块窄合入、两模块新增，41份其他源码与49项保护项保持；健康显示Sol，备份 `/var/backups/oops-meeting/sol-text-20261016T125757Z-10h_wmu3`。主版已离线构建、原签名覆盖安装并启动；完整备份后253个原文件安装前后SHA一致。未运行测试套件或额外模型验收请求；不能把本次正常收尾与安装当作高亮质量、长会分段或录音豆完整硬件验收。分段开关仍关闭，不重算历史，不覆盖生产专有接口/删除/发送保护。交付见 `docs/sol-text-rollout-20261016.md`。

## 三项后端修复已部署（2026-10-16）

用户明确要求将长会议输入截断、事项投票误合并和零字节上传报错的修复部署现有生产，只更新相关代码并保留功能数据。已重新读取生产基线，精确合入 `feishu_actions.py`、`minutes_vote.py`、`recordings.py` 三模块；其他42份Python模块与相关配置、人员和声纹哈希保持，OAuth、任务核对、发送确认、Mac队列及原删除/到期保护保留。正常纪要完整输入，不增加三份调用次数，版本仍5；超模型容量明确失败，不承诺无限长度，也不触发旧纪要重算。

仅重启oops-backend并核对新PID、认证健康和三模块落盘哈希，能力及门槛与部署前一致。既有业务快照没有缺失，活动会话重启后继续同步；不结束手机录音、不改历史数据或上传队列。备份 `/var/backups/oops-meeting/three-fixes-20261016T105320Z-jplg7_ci`。本轮未运行测试或构建，不制造模型/任务/发送请求验收。详情以 `docs/backend-three-fixes-20261016.md` 生产交付段为准；本地完整后端仍不能直接覆盖生产已有额外能力。

## 任务列表稳定性与 App 内核对（2026-10-16）

用户明确要求修复真实任务列表频繁请求失败，并把任务核对放在 App 内，不再跳转站外核对站。保留原核对站的逐人答案、原话指纹、核对版本与幂等请求编号；App 只以服务端核实的本人飞书身份保存自己的确认、改写、负责人、排除、合并或撤回，不覆盖他人答案，不把核对当作创建飞书任务或业务完成。候选与正式任务独立读取、失败与重试；旧候选在来源不可读时清空，正式任务的历史回执单独保留并标明读取状态。读列表不等待外部发送持有的全局授权锁，实际写入仍在当前绑定与来源校验后执行。本轮实施与部署/手机安装的实际状态见 docs/task-review-in-app-20261016.md；不能以代码或模拟预览完成代替新 APK 已接通。

## 已授权的 Oops → Raft 本机通信（2026-10-16）

用户要求 Oops 主动与本机 Raft/Slock 沟通或发送指令，并明确授权在 `/yu-yuan` 创建独立 `@Oops` External Agent、私下保存标准通信凭据及发一条连通确认。首版只转交本人显式填写并逐次确认的文本、使用后端目标白名单，不自动附入会议、任务、录音或资料。消息、发送尝试与回复使用独立 SQLite outbox，不替换队友既有数据结构、Mac工作队列或执行器；未知送达停止自动重发，不把已发送或收到回复当作业务完成。

用户随后要求连接 a1234：已核对 `1234deMac-mini.local` 的computerID `93e2637f-3cdf-4e7f-8890-a532ecf4b716`，收件Agent显示名`剪辑组_Sol_6.1`但实际handle为`@剪辑组_Astra`、ID `a56dbb7c-5efa-4e1f-9fbb-ad50f2393ce7`。本机白名单追加其实际DM目标，保留MacBook目标与历史。新增1条只读连接确认已得到Raft送达ID；远端回复/消费与真实执行继续分别核对，不重发未知消息或改变其原工作环境。

Raft/worker凭据只在可信本机或服务器，不能借用其他managed Agent身份、放入App/公开网站/Git/日志。回复只读取实际发送消息的确切线程，不把外部回复执行为反向指令。React入口仅本机私人体验开放，隔离示例与公开站禁用，页面令牌仅内存。当前已核对专用身份并由真实SDK发出1条消息、回读送达ID；新增API尚未部署生产、Android APK尚未接入，回复回收的实际状态见 `docs/raft-connection-20261016.md`。运行数据在仓库外私人目录，避免开发热更新影响页面。未运行测试或构建；只做必要静态、运行时完整性与用户授权的连接尝试。

## 多协作共用 Raft 群（2026-10-17）

用户明确要求将 Oops 的多协作融入 Raft 聊天群，并选择“先共用一个 Oops 协作群”。已用专用 External Agent 在 `/yu-yuan` 创建私人 `#oops-collaboration`，channelID `9d83a076-b723-4743-b24d-3b945c73ad22`；成员为本人 giftedprofessor、@Oops、a1234 的实际 @剪辑组_Astra（显示名剪辑组_Sol_6.1）和本机 @剪辑组_Mb_Astra。本轮仅创建空群和添加这三名已核对成员，没有发送业务任务。

React 任务页与原多人协作入口统一承接到 Oops 协作群；本人填写空白标题/简报、选当前群 Agent并逐次确认后登记交接，独立任务线程续发和回复核对分别记录。原型 TaskRef 仅供返回/筛选，不附入任务、原话或资料，不充当真实后端来源证明；来源变化/结束任务停止关联派工。进展/成果核对注记不自动完成业务任务、不代表验收。真实群、发送人和线程须以稳定ID核对，群不可读撤下旧正文与回复，未知送达不重发，原DM历史与既有执行器保留。

本轮接入限本机私人服务与React预览，公开/画板使用独立内存演示。生产业务任务数据库来源适配、新API生产部署及Android安装包尚未接入；不能把真实空群或前端实现当作实际任务执行闭环。未运行测试或构建，只做必要静态、运行时完整性与真实群读取核对。详情见 `docs/raft-collaboration-20261017.md`。

## Raft 生产与手机任务回流（2026-10-17）

用户明确要求继续接手机安装版和后端数据库，并从Oops向a1234发一个简单任务检验执行及结果回流。已授权正常结束当前正式会议后覆盖安装；用户在记忆模块聊天又授权两项合成一次更新，统一由本轮安装。主版com.oops.app已原签名覆盖，Raft与个人记忆桥都保留。安装前275份文件私有备份，安装后0缺失，273份逐字节一致，仅安装/WebView系统标记变化；未开新录音或写假个人事实。原场30/30天保持，ASR acknowledged、文字synced。

生产以重新读取的基线窄合入一个主模块并新增四个Raft模块，其他46份源码、6项原配置和既有会议/操作保留。新的独立SQLite任务/交接/回复库接入原backend；不替换飞书正式任务、原会议/录音或Mac执行器。真实来源引用有服务端合同核对，手机本轮只开放本人手写协作，不自动附入历史内容，也不将prototype TaskRef当作真实授权。

本轮真实手机创建task `raft-task:eb5ab7779f014e3bbae197b98c7aa9eb`，只给a1234的实际@剪辑组_Astra派一条只读hostname/算术任务。Raft根消息`ed08a8fb-3b31-41db-b3f8-4b33e130c72b`，目标同线程回复实际输出`1234deMac-mini.local`及`728`，真实sender/channel/thread UUID核对通过。回复已回到手机，人工成果注记映射回原任务；业务仍open/business_complete=false，不自动完成或创建飞书任务。

Raft resolve精简回包不含UUID，桥接须用完整消息UUID定位consume:false history存储行。首条unknown只通过原lease核实已知消息为sent，没有重发；新reconcile仅允许Raft读取。生产worker在可信本机以独立私有配置/journal运行，已加载登录启动的LaunchAgent；Mac离线不能冒称已送达。此次用户授权联调和必要APK编译已执行，未跑自动化测试套件或扩大历史业务/录音验收。当前生产与手机状态取代前节“仅本机、未接入”状态；详情见 `docs/raft-mobile-production-20261017.md`。

## 录音豆默认音源（2026-10-16）

用户要求补齐真实 SDK 接入并默认使用录音豆，明确指定主版 Oops（com.oops.app），不继续使用独立测试版。真机更新沿用原证书覆盖安装、保留既有功能与业务数据；本轮已明确授权结束当前日常聆听并进行原音/全文各7天的正式会议云保存测试。包含 Soundcore SDK 的 Android 安装包首次升级默认切到 bean，之后保留用户明确选择的音源；无 SDK 的构建保留手机麦克风。默认音源不等于自动开录或云保存授权。录音豆暂只支持用户逐次明确确认云保存的正式会议，日常五分钟限制保留；不得静默改用手机麦克风或把模拟器当真机。鉴权配置由可信开发端换取，app_key 不进入 APK、公开网页或 Git；token、license、身份与期限核对失败须给出原因，不能闪退。构建和真机验证的实际完成状态见 docs/bean-device-check-20261016.md。

录音豆结束后会暂停硬件并断开。当前SDK实测不能保证仅从App重新开始就恢复硬件，开始页须提示先按硬件录音键；扫描超时明确失败，不能永久“等待收音”，未有音频不能标成“正在收音”。设备选择优先保存的真实地址，不能被旧BLE别名覆盖。2026-10-16续测时临时位置权限对照未解决连接问题，已撤回并恢复正常包；当前收音成功不等于自动重连通过。

SDK录音控制复核（2026-10-16）：公开接口确有pauseRecord/resumeRecord，文档支持已启动录音后的暂停与恢复；不能将此前“暂停后断开、再扫描失败”当作resumeRecord不可用的证明。当前主版尚无独立暂停/继续桥接。后续优先在同一会议内保留蓝牙连接、按设备回执恢复；首次冷启动开录与断开后恢复分别验证，不能承诺已支持或为恢复而默默继续硬件录音。本轮仅静态核对，保留当前收音，详见docs/bean-record-control-sdk-20261016.md。

## App 开始直接启动录音豆（2026-10-16）

用户明确要求 App 点开始后自动让录音豆开录，并授权真机尝试 SDK 的 resumeRecord，避免每次按硬件录音键。本节取代上文“开始前必须先按硬件录音键”的当前产品要求；它不等于设备一开电源或一连接就可以绕过 App 开始与本场保存确认。

主版 com.oops.app 已沿用原证书覆盖安装。用户明确开始并确认正式会议云保存后，连接读取 recording：1 直接接收，0 每条连接仅尝试一次公开 resumeRecord；重复鉴权/设备信息不重复启动。等设备录音回执与解码后的真实 PCM 再显示收音，鉴权/扫描/连接/状态读取/出音均有截止时间，失败关闭本次连接并显示原因；发过启动指令的失败/结束路径须先尝试暂停硬件再断开，不静默换麦克风，不放宽录音豆日常保存限制。

本轮第一条尝试未找到设备，未发出 resumeRecord。用户随后确认设备已开机靠近手机、未按录音键；16:46:03 真实设备返回 recording=0，App 发送 initial resume，16:46:04 返回 RECORDING=1，16:46:07 收到首个 Opus 包并产出真实 PCM，实时转写已有最终结果。当前这场保留原音/全文各30天设置并保持运行。只证明本次“开机未录音 → App 开始 → 出音”通过，不把 recording=0 当作已证明设备刚断电冷启；完全断电冷启动、长时间待机及反复断开重连稳定性尚未验收。仅运行相关6项音频单元测试、APK构建、必要静态与28项运行时完整性检查，未扩大验证。详见 docs/bean-app-autostart-20261016.md。

录音豆完全关机重启续验（2026-10-16）：用户明确要求再试完整关机重启，已通过正常结束流程收尾上一场；用户随后确认完全关机再开机、未按录音键。仅在App发起一次开始，16:50:28连接时设备已返回recording=1，16:50:29收到真实音频与PCM，App开始至首包约37.4秒，实时识别已到达，当前新场继续录音，原音/全文各30天。此轮没有调用initial resume，不能把它写成“冷机未录音由resumeRecord启动成功”；只证明用户确认的这次关机开机后，不额外按录音键、只走App开始的收音流程通过。首次recording=0的resume成功与本次设备连接时已录音分别记录；长待机和反复重连稳定性仍未验证。未重装、构建或运行测试套件，详见docs/bean-app-autostart-20261016.md续验段。

录音豆连接提速（2026-10-16）：用户要求减少37秒等待。实时收音扫描改用公开SDK的BLE-only（startScan(true, false, ...)），去掉同时启动的经典蓝牙发现，保留设备白名单、授权、超时及真实PCM确认，不用旧BLE别名硬连或提前开录。主版已原签名覆盖安装。用户选择先测当前状态，不再完全关机；本次手机端开始至首个真实音频包约8.5秒，扫描约1.2秒、SDK连接约6秒，PCM与ASR中间结果正常，当前新场继续录音，原音/全文各30天。它与此前37.4秒冷启条件不同，不能当作固定性能承诺；优化后冷启动未重测。本轮未重跑测试套件，APK构建与必要静态/运行时完整性检查通过，详见docs/bean-connection-speed-20261016.md。

录音豆BLE提速后的完整重启计时（2026-10-16）：用户进一步授权完整关机再开机测一次，已正常结束上一场并取得ASR收尾确认；用户确认完全关机再开机、未按录音键。App一次开始后扫描约4秒找到同一目标，但随后SDK连接等约15秒返回-102，总约19.5秒失败退出，未收到音频、未发initial resume，当前App已停止。本轮没有成功收音耗时，不能把19.5秒当成优化成功或将先前8.5秒推广为冷启性能。完整关机重启的连接稳定性仍有问题；未自动重试、改代码或重装，详见docs/bean-connection-speed-20261016.md续验段。

录音豆超时恢复阶段收尾（2026-10-16）：最终保留开录前明确-102超时的同设备一次重新扫描/重连、800ms延后以等SDK旧回调清理、连接代次隔离与60秒启动上限；不重发录音指令。试验中的SDK close()清注册表导致系统GATT已连但业务握手未完成，已撤回该方式。最终包已覆盖安装；用户随后报告“已经可以了”，要求告一段落直接提交PR，故停止真机操作。最终版尚无代理完成的再次冷启动验收，用户反馈不能冒充实测或普遍修复证明。独立PR保留录音豆相关代码与既有声纹修复，其余工作区改动不纳入；详见docs/bean-reconnect-handoff-20261016.md。

## 会议待核对直接发到 Raft（2026-10-17）

用户要求会议待核对卡片暂不展示对话，直接用「发到 Raft」按钮承接；卡片保留任务内容与人工核对状态，紧凑派工页仅展示当前任务与固定 a1234 接收人，再明确确认发送。此授权允许未完成核对的当前任务候选显式转交 Raft 先澄清、再执行，不能伪造人工确认、负责人或业务完成，也不改写各人原核对答案；原确认任务路径继续保留。候选授权使用独立签名域，来源、版本、本人身份和目标仍由服务端校验；来源失效、已排除或合并拒绝派工。相同来源旧派工若未知送达或仍在发送，跨核对版本也须先核实，不能借新版生成另一条根消息。已知送达的回复和成果继续绑定原任务线程。本轮实际部署、手机更新与验证状态见 docs/raft-direct-task-20261017.md；未选定并擅自发送具体会议业务任务。

本轮已窄部署四份 Raft 后端模块、原签名覆盖安装主版并启动。获用户单独允许后正常结束 e18c4127 场，ASR acknowledged、文字 synced、归档 done/队列0，30/30天保留；本场原音此前已触及原有3小时上限，文件保全不代表整场原音完整。311份私有文件安装前后SHA保持。真实手机16张候选卡片均有按钮且无对话，0236未核对候选的独立合同与真实a1234成功只读核对；没有点击发送确认或发出业务任务。未运行测试，实际细节见同交付文档。

用户随后明确选择主动作「交给 Oops」，统一确认「确认交给 Oops 处理」与后续「查看处理进展」，融入 Oops 任务生态。此文案决定取代界面中的「发到 Raft」；实际底层 Raft 群、a1234 目标、来源与逐次确认及回流保护继续沿用，不将“已送达”称为已执行或已完成。 文案版已仅更新两份H5并原签名覆盖主版，13份DEX与214其他条目保持；新0a3c4d40场另获允许后正常收尾，318份私有文件冷安装前后SHA一致。未运行测试、Gradle或后端部署，详见同交付文档的后续文案段。

## Prototype Instructions

In ChatGPT Work Mode, run `sites-preview start "$PWD"`, open `http://terminal.local:4173/` in the cloud browser, and verify the rendered app and its primary interactions. Keep that preview open and tell the user to inspect it in the cloud browser; do not present the local URL as a user-facing chat link. In Codex Desktop, run the local server yourself, open the preview in the in-app browser, and provide the clickable local URL. Do not deploy to Sites unless the user explicitly asks to share, publish, or deploy. Do not give the user server-start instructions when you can run it.

Before planning or implementing any mobile-app change, read this `AGENTS.md` in full. It is the source of truth for the template's runtime and component guidance.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Editing Boundary

- Build app-specific UI in `src/Prototype.tsx` and `src/prototype.css`.
- Treat `src/App.tsx`, `src/main.tsx`, `src/styles.css`, `src/mobile/`, `public/assets/iphone/`, `public/assets/android/`, `public/assets/status/`, `vite.config.ts`, `worker/index.js`, and `scripts/prepare-sites-build.mjs` as protected runtime files. Do not edit, replace, remove, or recreate them unless the user explicitly asks to change the mobile runtime itself. For an explicit runtime change, update the affected lock hashes only after verifying the new runtime behavior.
- Run `npm run check:runtime` before preview or handoff. If it fails, restore the protected runtime instead of weakening or bypassing the check.
- `npm run build` preserves the mobile runtime and prepares the static Cloudflare Worker output required by Sites. Before a Sites handoff, confirm `dist/client/index.html`, `dist/server/index.js`, `dist/.openai/hosting.json`, and source `.openai/hosting.json` exist, then run `npm run test:sites`. Do not replace this project with a Vinext starter.

## Runtime Contract

- Preserve the mobile device runtime unless the user's task explicitly asks otherwise. Do not replace it with a standalone page. Visual fidelity applies to app-owned content inside the device screen, not to template-owned device chrome.
- Keep `App` composed around `PhoneFrame` -> `KeyboardProvider`, with `StatusBar`, app content, `HomeIndicator`, and `KeyboardDock` mounted inside the phone frame. `StatusBar` and the iOS home indicator are overlaid device chrome. When the Android keyboard is closed, the app viewport reserves the protected navigation-bar region instead of painting behind it. When the Android keyboard is open, preserve the current full-screen keyboard layout: its asset includes the IME navigation strip and the separate black navigation bar is hidden. iOS screens continue to paint behind the home-indicator area and own their safe-area content padding.
- Preserve the `iPhone` / `Pixel 10` device picker and both calibrated device presets. The Pixel screen is `427 x 952`; its `32 x 32` camera circle and `public/assets/android/navigation-bar.svg` bottom navigation bar are protected device chrome, not app content.
- Preserve the device picker's intentionally lightweight Codex styling in the top-right corner: its trigger wrapper is borderless and transparent, its trigger sizes to content, and its right-aligned menu uses the compact 3px inset plus the specified hairline and elevation shadow layers. Keep the prototype root and default app screen white.
- Preserve `StatusBar` as live device chrome, including its platform-specific typography, source status-icon assets, and spacing. Pixel 10 uses Roboto, Android indicators, and 32px top, left, and right padding. iPhone uses its iOS indicators, system typography, and calibrated spacing. Do not hardcode screenshot times like `9:41` into the status bar, replace its real-time clock, or move status bar content into app markup unless the user explicitly asks for a fixed/mock device time.
- `PhoneFrame` owns the calibrated device frame, screen portal, device picker, camera cutout, and custom cursor. Keep device assets in `public/assets/iphone/` and `public/assets/android/`; if an asset fails to load, repair the asset path or restore the asset instead of removing the frame, keyboard, or image render.
- Use `MobileScroll` directly for simple single-screen prototypes. Use `FlowStack` for conventional multi-screen flows whose routes can own their fixed header and footer; when using it, define each route as a `FlowScreen`: `{ id, header?, headerHeight?, footer?, footerHeight?, render }`, and use `flow.push(screen)`, `flow.pop()`, and `flow.replace(screen)` from `FlowStack` render callbacks or `useFlow()` instead of introducing another router.
- Use `Carousel` for a carousel, horizontal rail, swipeable cards, image or media strip, horizontally scrollable cards, chip rail, or other horizontal collection.
- For a layered app shell—such as a persistent composer, independently presented sheet, pushed/peek sidebar, or app-wide transition—compose directly in `Prototype.tsx` rather than forcing it through `FlowStack`. Keep app-owned fixed chrome as sibling layers outside `MobileScroll`.
- When using `FlowScreen`, put route-owned fixed headers or footers in `FlowScreen.header` or `FlowScreen.footer`. Set `headerHeight` to the visible app-toolbar height; `FlowStack` adds the device's top safe-area/status-bar inset automatically. Do not include `StatusBar` or its height in the header. Set `footerHeight` to the full app-footer height. `FlowScreen.footer` is an overlay, not reserved layout space; screens using it must add their own bottom content padding such as `padding-bottom: calc(var(--flow-footer-height) + var(--mobile-safe-area-height) + 24px)` so final content can scroll above the footer while still painting behind it.
- Render only scrollable content inside `MobileScroll`; it is for content that should move with scroll and rubber-band overscroll. Keep app-owned headers, nav bars, tabs, composers, and overlays outside it. This keeps scroll physics, safe areas, keyboard insets, scrollbars, and drag click suppression active without letting content paint under fixed chrome.
- Buttons, links, cards, and images inside `MobileScroll` should still allow drag scrolling when the pointer moves beyond tap slop. Use `data-scroll-drag="ignore"` only for rare controls that must own the drag gesture themselves.
- Do not add `var(--keyboard-height)` to ordinary screen/content padding inside `MobileScroll`; the scroll viewport already shrinks above the simulated keyboard. For custom fixed composers, search bars, or toast chrome, use `useKeyboardInsets().bottomInset`. It is relative to the app viewport: Android returns `0` while the closed-keyboard viewport already reserves navigation, then returns the keyboard height while open; iOS continues to clear the home indicator while closed and ride directly above the keyboard while open. Do not pin custom bottom chrome to `bottom: 0` or only `keyboardHeight`.
- Use `KeyboardInput`, `KeyboardTextarea`, or `MobileTextField` for every text-entry control. A raw `input` or `textarea` disconnects focus, keyboard animation, safe-area insets, and attached surfaces.
- Use `BottomSheet` for phone-scoped sheets. Its props are `open`, `onOpenChange`, `title`, optional `description`, optional `snap`, and `children`; it renders through the phone screen portal and dismisses the keyboard before opening.

## Horizontal Carousels

- Use `Carousel` for horizontally draggable cards, images, media, chips, or other horizontal collections. Do not recreate these with `overflow-x`, custom pointer handlers, or a generic div.
- `Carousel` can be nested directly inside `MobileScroll`. It owns horizontal gestures and automatically yields vertical gestures to the parent.
- Never put `data-scroll-drag="ignore"` on or around a `Carousel`; doing so prevents vertical parent scrolling when a gesture begins inside it.
- Do not add CSS scroll snapping to `Carousel`; its runtime owns momentum and release motion.
- Use `data-scroll-drag="ignore"` only when a control must prevent parent scrolling in every drag direction.

See `src/mobile/COMPONENTS.md` for the full component and gesture contract.

## Keyboard Rule

The simulated keyboard is a separate top-layer component. Before presenting anything that behaves like iOS navigation or modal UI, dismiss it first.

Call `keyboard.hide()` before:

- pushing, popping, or replacing FlowStack routes
- opening bottom sheets, action sheets, dialogs, menus, or navigation sheets
- starting transitions where the destination should not inherit text-input focus

`FlowStack` already hides the keyboard for `push`, `pop`, and `replace`. `BottomSheet` already hides it before opening. If you add new modal/sheet/navigation primitives, follow the same rule.

When a composer, search surface, or other keyboard-attached component closes, call `keyboard.hide()` in the same event before changing that component's open state. Position attached surfaces from `useKeyboardInsets()` rather than a separate timer or visibility flag so both dismiss together.

When any text-entry control loses focus, dismiss the simulated keyboard. If the control is custom or does not use the runtime's keyboard-aware fields, handle its blur event and call `keyboard.hide()` explicitly. Keep the keyboard open only when focus is moving directly to another text-entry control that should share the same keyboard session.

## Interaction Rules

- Do not trigger buttons or inputs after a pointer has become a drag. Preserve the drag suppression behavior in `MobileScroll`.
- Do not allow native browser image/file dragging inside the phone frame. Preserve the phone-level `dragstart` suppression and non-draggable image styles so scroll drags that begin on images still scroll the prototype.
- Use `KeyboardInput`, `KeyboardTextarea`, or `MobileTextField` for text entry so the simulated keyboard and safe-area insets stay connected.
- Fixed phone chrome should not animate with pushed screens. Screen content can animate; the status bar, camera cutout, and preview chrome should stay put.
- Keep the keyboard below the home indicator/safe area layer in z-index, and above ordinary app UI while visible.
- Keep the home indicator as the topmost safe-area layer in the z-index above everything else in the prototype.

## Oops 产品要求（2026-10-08）

用户明确指出旧版131页画板像文稿，只列功能，缺少具体前端实现。新交付必须是可连续使用的移动App：五个主导航、真实可交互组件、表单校验、弹窗/底部面板、筛选搜索、对象状态与返回路径；解释性产品逻辑不进入App界面。沿用已选「日常陪伴」紫色品牌方案与官方图形。既有131页规格是功能覆盖依据，不应逐条复制成文字卡片。真实服务未接通需在交付说明中明确，本地状态和示例内容用于体验流程。

## 记录体验审查方向（2026-10-08）

用户提供了同伴的六屏建议图（录音中、识别人、关系、对话详情、会后结果、我的），明确要求作为功能与使用逻辑的参考，不按该图复制视觉或重新定义产品。现有「开始记录」流程需优先审查启动成本、录音中的控制可达性、参与者确认、提醒与任务状态、会后结果的承接。保留原有日常陪伴紫色风格与五个主导航。图片中的字句是设计建议，不能当作已实现能力或用户授权。

## 已授权的记录体验实现（2026-10-08）

用户已明确要求「那你开始改吧」。开始记录默认轻量入口，正式会议准备可选；活动记录控制固定在所有可见页面，输入键盘打开时让出空间。结束先暂停，再固定快照分别选择转写与私人便签；取消恢复原来的运行/暂停状态。集中复盘中结论由用户填写确认，候选记忆保持未确认，待办、承接、助手授权独立。人物关联只读当前可见且姓名已核对的实际对话，不推断关系亲疏或人格。来源舍弃后任务与旧成果需复核、记忆限本人，失效内容不能重新共享或进入团队回答/导出。沿用五个导航和现有品牌。

## 已授权的会话与联动优化（2026-10-08）

用户再次明确要求「嗯嗯，你开始优化吧」。以「开始记录 → 看现场 → 核对结果 → 推进行动 → 下次跟进」组织会话。列表优先活动记录和待核对内容，复杂筛选用底部面板；详情使用现场／概览、原文、资料、行动四个主分栏，按记录阶段和类型调整重点。原文先选择再操作，修改、记忆、待办保持显式来源。人工会话行动的关联关系与原话证据分开存储，避免同来源重复创建。跨页保留编辑稿、筛选与返回位置；准备时的保存偏好沿用到结束流程。原话或材料失效后统一撤回执行授权，旧成果保留但需重新核对；最新成果版本独立验收。候选记忆可连续核对，姓名核对与声音许可分开。角色与助理偏好应作用到本地建议，不默默替换已核对的旧记忆。沿用已有紫色品牌、五个主导航与移动运行时。

## 已授权的任务流程优化（2026-10-08）

用户在六项任务优化建议后明确回复「嗯嗯，你去做吧」。保留待我处理／我的待办／助手工作三个入口，按实际处理原因、日期和跟进关系组织；任务详情使用概览／资料／成果／记录，主动作随工作阶段变化。本人创建的普通行动免重复自承接，允许手工记录结果并完成，正式交付按选定成果与版本核对。助手草稿完成不自动代表业务交付；实际资料选择、产出模式、额度与生成请求保持一致。问题支持待回答／已回答／已解决及下一次跟进；转交撤回或婉拒恢复原业务状态，并保留我提出／我跟进的可见入口。沟通正文与附件绑定明确成果版本，更新后由用户选择保留或更新草稿；外部操作确认继续独立。保留来源失效保护、重复动作防护、跨页草稿与历史记录。

## 已授权的功能逻辑修订与画板同步（2026-10-08）

用户要求修复来源引用、转交、完成结果、复盘队列、人物关联、导出与草稿断点，并同步线上真实页面总览及原131页交互画板；已明确允许内置浏览器操作和截图。两份画板必须来自当前真实App、共享路线映射与截图清单；合并的页面注明实际入口，服务或界面缺口如实注明，不把旧页面文字当作已实现能力。board-preview示例数据和草稿只在当前页面内存，不能读取或覆盖用户持久化数据。截图使用实际渲染，保留设备外框、真实时钟与原紫色风格。角色替换为单一私有当前记忆并保留私有历史；人物按明确确认的单段personId关联；成长复盘与目标分开授权；完成结果重开后归档；旧成果须逐版核对来源，个人历史备份明确确认，团队不导出失效内容。

## 已授权的 P0 前端补齐（2026-10-09）

用户明确要求先敲定页面前端、暂不做后端，并授权补齐 P0。将智能聆听的有效对话判定、语音唤醒、自动会议起止，声音身份关联与匹配核对，对话理解、决定候选、跑题／时间／冲突／遗漏提醒，个性化会后结果及项目决定与任务汇总做成可连续操作的前端流程。演示内容保留明确来源和必要状态，不宣称已调用麦克风、模型或硬件；自动起止体验保留可纠正和取消入口，结束沿用现有保存快照流程。新增能力接入现有导航与详情，而非另列功能说明文稿。继续同步当前 App、真实截图总览及独立交互画板；原131条目保留，可增加P0新入口，不再用固定131或108限制真实覆盖数量。

## 已授权的统一分享入口（2026-10-09）

用户要求把 App、149 张真实页面总览与 172 个交互入口集成到一个网站。统一使用 showcase.html 体验中心，在同页切换三个模式；保留原入口及移动运行时。切换保留 App 草稿、画板筛选和浏览位置，画板的示例体验与个人自由体验隔离，并可返回自由体验。分享链接支持模式、App 页面及示例场景，继续明确前端演示范围；反馈入口连接原飞书意见表。

## 10 分钟试用路线（2026-10-09）

用户要求做给朋友的 10 分钟试用路线。统一体验中心以 `?view=app&tour=1` 打开六步引导，时间分配为 1、1、2、2、2、2 分钟。引导共用 `guided-trial` 隔离示例会议，确认结果在本次切换中保留；刷新重新载入示例。自由体验、画板示例和试用示例使用独立 iframe，不能覆盖已有用户数据。路线在外层体验中心展示，不把说明文稿放进 App。试用中的分享操作复制起点链接，不复制依赖当前内存的新建任务地址；反馈继续使用现有飞书表，录音与 AI 的前端演示边界必须清楚。


## 已授权的 29 项功能逻辑验收（2026-10-09）

用户要求按原29项检查入口、操作、结果与跨模块联动，发现问题直接修，继续保持仅前端范围。任务负责人、提出人与说话人分别确认；人物身份以稳定ID为准，当前显示名变更不得重写历史发言或发送回执。议程变更应更新当前议题理解；项目改名迁移精确标签且保持空间归属；源头变化后统一撤回派生许可。记忆确认须展示当前引用并绑定本次核对证据，问答派生绑定对应问题。29项覆盖表必须区分主要本地流程、部分前端和概念入口；浏览器被保存权限设置拦截时不得冒充实屏验收，画板明确标注待重拍。

## 2026-10-12 三项 P0 补齐约定

人物列表/匿名详情应直接显示交流时间、原话线索和核对/建档入口。只能把明确 personId 绑定的片段归入人物，其余匿名片段单列；姓名核对与声音/共享授权分开。普通事实与观点在现场章节及会后概览保留来源绑定摘录，不以任务或决定候选为前提；旧摘要不能冒充当前来源，源头变化与私密/空间范围需即时生效。首次使用先阅读、未预勾选地明确确认原型使用与隐私说明，再保存身份与可选能力；确认只记录版本/时间，不扩大任何权限。整条反馈中还有 P1 时，不因 P0 子项完成就把整条标成已完成。两份画板与独立文件随页面一起更新，区分本地实屏验证与线上发布确认。

## 前后端协作基线（2026-10-12）

用户确认 gifted-professor 的 Android 与后端是在现有产品基础上开发，后续整合时其已实现的代码优先级更高。优先沿用已有真实接口、数据结构和运行链路，由前端适配；不因前端演示模型不同而推倒后端重写。明确复现的功能缺陷仍应修复，存在产品规则冲突时说明差异再统一。PR #1 已合并；源码合并不等同公开网站已接通真实服务。

## 已授权的意见表逐项落实（2026-10-12）

用户要求基于合并后代码，按飞书意见收集中的改版优先级与处理状态逐项优化，并同步 GitHub 和原分享网站。以本轮重新读取的 26 条记录为准，保留同伴回复、原建议与截图；已评估项优先落实 P0，待讨论项只实施已经明确且兼容的部分。设备打开是否自动记录、日常/会议保存规则、团队页价值、五个导航调整继续待讨论。保持真实后端接口与行为，公开体验仍使用隔离示例；本次发布不把团队凭据或真实会议接入公开网站。只在完成并验证发布后，更新对应意见状态；混合意见分项说明，不能将部分完成标记为整条完成。

## 已授权的接口适配与异常闭环（2026-10-12）

用户同意继续现有后端接口适配与异常状态闭环。先修保存失败误报成功、列表失败无法重试、迟到响应覆盖筛选与本人任务误归属；核对应等对应服务器回执再推进。AI纪要复用已有只读接口，区分等待、不可用、来源已变更和读取失败，旧文档仅保留历史入口，不自动重生成或重发。真实读取沿用安卓授权通道，公开网页不加入全权限凭据或隐式读取真实会议。可在统一体验中心附真实安卓H5代码的隔离模拟预览，明确模拟且不能持久化或执行外部操作；发布、GitHub与画板继续保持同步。保存、硬件、团队与导航待讨论规则保持不变。

## 已授权的团队标注减负（2026-10-12）

用户明确要求同音色批量确认身份、连续表达合起来标注、保留单句纠错和撤销，并同步原来的私有标注链接。音色组确认只传播身份关联，不能传播内容类别、任务或负责人，也不能冒充逐句独立听辨真值。内容批量操作保留单句例外；身份组与单句/内容操作分别可撤销，原始细粒度原话与各人答案保留。短句上下文可跳过，不自动当无效。验收按真实人工内容覆盖的原ASR段落评分，内容就绪、身份覆盖、独立说话人证据、校准完成和真实会议验收分开报告。公开体验网站不接入团队原音频或标注凭据。

## 已授权的意见直接改进与接入边界（2026-10-12）

用户授权继续实施意见中已经明确、可直接改动的部分并同步交付。本轮前端包含文档角色草稿、工作助手类型入口与异常/已有结果承接、人物内容线索、可纠正的个人理解、紧凑录音条及首页官方形象状态动效，具体归档见 `docs/feedback-direct-20261012.md`。文档角色入口可跳过，仅使用示例或本人粘贴且手动选定的段落；建议可编辑，应用身份与核对历史角色背景分开。它不连接飞书选文档、不上传文档，也不宣称真实模型已完成文档分析。人物话题仅来自已核对且绑定稳定人物 ID 的当前可见原话，不推断兴趣、亲疏或人格；个人理解展示本人设置及来源有效的已确认目标/背景，时间未知就明确未记录。

活动记录在当前会话现场保留完整控制，其他页面默认紧凑并可展开，暂停与结束保持可达；切换会话、空间、页面或分栏不继承旧展开状态，键盘打开时隐藏，内容与任务固定操作同步让位。继续沿用原有结束快照、取消恢复与来源失效保护，不改变保存策略或硬件唤起。首页使用现有官方形象，姿态只反映当前可见记录和本人工作状态；暂停和减弱动态设置停止相应动画，不以形象动效证明模型或真实设备正在工作。

已有工作助手的查资料、报告和 PPT 能力优先沿用，但 React App 的工作提交/状态读取/结果取回尚未接通。公开工作助手页面仅演示隔离状态，不改变任务承接、业务完成、生成授权、成果或外部回执；生成失败重新核对，交付失败只恢复同一结果。真实结果入口必须来自明确绑定任务、空间、请求与来源的服务回包，不拼造文档或下载地址。真实接入前，`queued`/`preparing` 中切换助手类型必须取消旧 job 或锁定类型，不能把本地状态重置当成真实取消；沿用已有防重与回执语义。

硬件开机后的自动聆听/正式保存边界、日常五分钟缓冲与会议云端存档策略、团队独立空间/工作台范围以及主导航调整仍待讨论。本轮不修改队友现有每场默认存档及会后上传行为；五分钟环形缓冲已存在，但不等于日常完整存档已关闭。真实飞书文档读取、工作助手 App 接口及录音豆联调属于接入依赖，不用“前端已做”代替。发布、截图、测试数量由本轮最终验证填写，部分完成的混合意见仍分项记录。

## 已授权的意见最终定稿与排期（2026-10-12）

用户新授权由我们结合原建议、同伴回复及评估意见最终拍板，尽量清掉待讨论。本节及 `docs/feedback-decisions-20261012.md` 取代上文相关事项继续待讨论的旧约定；原建议、回复和历史评估保留为过程记录。本轮是产品决策与意见表排期，不表示已实施下面的新前端、原生或后端改动，也不删除历史数据。处理状态按整条意见判断：首版子项已做、仍含后续子项的混合意见继续计划修改；不能把新决策当作完成证明。

- 智能聆听（原第2条，P1，计划修改）：采纳硬件开机后自动聆听；首次配对单独选择开启，之后已授权设备连接正常且服务可运行时进入日常临时聆听。暂停、停止、安静时段优先，重连不能擅自恢复；自动聆听不等于正式存档、声音身份或团队共享。先落实日常保存模式，再接真实设备事件与原生服务，失败显示真实原因和恢复入口。
- 日常/会议保存（原第5条，P0，计划修改）：日常完整原音和临时全文只滚动保留最近5分钟，停止后清除，不写全场归档或团队同步；自动整理的私人候选重点、摘要和必要短原话核对后才进入长期记忆。正式会议明确选择云端保存后沿用既有链路，新会议原声与全文默认30天，可分别选7/30/90天；本机、服务端和镜像需落实到期清理。云端ASR即时处理与长期存档分别告知，不承诺日常音频完全不上云。日常转会议从切换时开始存档，之前缓冲另选；新默认不追溯删除历史会议。
- 团队范围（原第7条，P0，计划修改）：首版不做重复飞书的独立团队门户；首页不要求先切团队空间，创建/加入团队及成员角色管理退出主要路径。保留记忆→项目和会话中的背景、历史决定、获准资料及同一任务引用；共享管理归具体对象和设置。入口收敛保留空间绑定、对象ID、分空间草稿及授权边界，本地角色不冒称真实权限。
- 联系人/社交（原第11条，P2，计划修改）：首版已做的P1联系人界面保留已核对身份、最近交流、内容标签、原话和明确约定；完整社交与轻量互认后置P2，不再占首版讨论。未来靠近只发起双方核对，不自动认定身份、注册声纹或扩大共享；混合意见尚含P2，整条不标已修改。
- 个人理解/复盘（原第14条，P2，计划修改）：首版已做的可纠正个人理解限本人填写或确认的身份、偏好、目标和背景，带来源、场景及真实更新时间，不放理解百分比。长期表达/工作习惯复盘后置P2，需本人选择开启、逐项有来源、可拒绝和纠正，不固化人格、推断关系亲疏或给出偏差诊断。
- 录音悬浮条（P1，已修改）：已实现的当前会话现场完整控制、其他页默认紧凑可展开、暂停/继续和结束可达、键盘隐藏与避让方案正式定稿；保留结束快照和取消恢复。真实设备后台唤起由智能聆听条目追踪，不重复挂在此界面意见上；界面完成不证明硬件已接通。
- 五导航（原第16条，P1，计划修改）：定为首页／会话／任务／记忆／设置；第五栏“我的”收敛成账户、身份、偏好、设备、连接、隐私与共享设置。记忆保留可检索复用的内容、人物和项目，顶部展示新理解/待核对，不变成泛动态流。后续实施保留既有settings路由、深链接、对象ID及草稿，安卓H5、网站及两份画板同步。

其他计划项的剩余范围已经明确：原第4条P0隐私及首版引导已做，余下真实飞书授权、用户选定文档读取和角色分析排P1；原第9/10条前端成果与准备已做，余下共用已有研究/报告/PPT执行能力的App提交、状态和结果回流排P1，不承诺任意文件格式或另造执行器；首页官方形象状态已做，真实眨眼/表情素材后置P2。具体模型下拉首版暂不处理（P2），有真实多模型路由与用户需求后另评估。

继续优先适配队友已有真实后端、任务队列、结果结构与防重回执。不得把Mac执行端全权限token放进App或公开网站，公开体验继续隔离示例。真实结果必须绑定任务、空间、唯一job和所选来源，文件/文档链接只采用可信显式回包；源头变化或撤回时撤回派生许可，旧版本保留但不得继续当当前成果共享或发送。生成、交付、外部发送、验收及业务完成分别核对；交付失败只恢复同一job结果，生成重试先重新允许。

本轮12条决策已写入飞书并回读全部26行验证，状态为15已修改、10计划修改、1暂不处理、0待讨论，验证错误0。原建议、评估意见反馈、截图与反馈人保留。网站仍为v13，本轮没有新增功能发布；表格排期已更新不代表计划项已经实施。

## 已授权的 P0 保存策略与团队入口实施（2026-10-12）

用户要求按最终定稿先实施日常/会议保存与团队入口收敛，优先沿用队友后端，并同步GitHub、网站、画板和飞书。此节记录已实施代码，取代此前这两项“尚未实现”的描述；没有改变P1硬件自动唤起、第五导航改名或工作助手真实接入的排期。

- 新日常默认五分钟临时缓冲，停止清除完整原音/临时全文，不走全场录音、MeetingSync、团队全量同步。网页临时全文和对应草稿不落localStorage/sessionStorage；原生复用现有环形缓冲、取消迟到ASR。仅留有界私人待确认候选与必要短证据，确认后才进入长期记忆，不自动建任务、共享或执行。
- 新正式会议明确选择云保存；原音与全文独立7/30/90天、默认30天，保存合同冻结在会话开始，重试不续期。日常切换创建新ID且从切换时开始，之前缓冲另选；安卓首版不复制之前缓冲。旧无合同记录保持旧规则，不追溯删除。
- 后端沿用现有会议/录音接口，新增version1合同和分项清理；新App核对healthz能力，不能让旧服务静默忽略策略。确认摘要及短依据走同一后端retain接口，核对来源hash；普通失败同请求重试，来源变更409先重新读取。完整原文自然到期保留独立有效依据，主动修订/删除仍撤回派生许可；旧全文缓存、修订与回收站副本也遵循到期。
- 首页退出强团队空间入口，设置收起创建/加入团队与成员角色模拟；保留记忆→项目的背景、历史决定、获准资料及同一TaskID引用。具体对象共享/撤回、空间绑定、旧内容范围及分空间草稿继续保留，不扩大权限或把本地角色当真权限。
- 两份画板用同一清单生成，当前182张React实屏、205项交互入口；本轮更新24张并新增8张，原131编号保留。独立HTML与在线交互画板字节一致。安卓流程预览由当前H5源码生成，另附独立保留前后实屏。公开站继续隔离示例，不包含真实服务或Mac执行凭据。

真实服务器部署尚未执行：当前Mac只读SSH在主机可信校验即停止，未跳过验证；不能宣称生产TTL已经生效。完整APK缺所需JDK17/AndroidSDK，未构建/安装或真机验收。队友Mac镜像/源码目录不在本机；镜像脚本已有清理接入与任务安装入口，但不冒称任务已安装。网站部署成功只证明网页发布，不替代这些真实服务与设备验收。飞书整条保存意见保留“计划修改”并明确代码已实施/真实部署待验；团队入口意见可按已实现范围关闭。验证详情见docs/p0-storage-team-20261012.md。

## 团队标注工作台体验优化（2026-10-12）

用户指出标注页信息过多、体验差，授权直接优化。团队标注工具改为“标内容 / 认声音”两个工作区；内容一次专注一段，默认待核对，完整列表支持筛选搜索；单句先显示结果，点修改才展开。声音组独立展示代表录音、确认范围及逐句纠错跳转。保留紫色品牌、既有个人答案、来源指纹、两类持久撤销及幂等回执；可选自动下一条仅在保存成功且当前内容完整后推进。冲突或写后读取失败时暂停编辑，完整重读成功再恢复。手机保留时间位置并收起列表，桌面显示列表与当前表达。

## 已授权的 AI 预分类与独立盲测（2026-10-12）

用户要求改为 AI 先分类、人工主要核对和纠错，同时修复普通事实类别和完整表达分段，并发布到原私有标注链接。事实独立于观点/方案、任务、决定、无关内容；事实类别表示原话中的事实陈述，不表示已核验真伪。模型按相邻原子句组织完整表达，保留原文、ID、时间和逐句例外；混合类别、不确定内容不得伪装成统一确定结果。任务负责人继续人工核对，不根据说话人或声音组推断。

建议与人工答案分开保存，模型生成或页面读取都不自动提交答案；确认、修改、逐句纠错、范围明确的本页批量确认均留下辅助核对来源。批量确认不覆盖既有答案、单句例外，不批量确认任务和决定。内容辅助核对、独立盲测、声音身份分别撤销，不能相互覆盖。

在调用模型前按原 ASR 父段固定约 5% 独立盲测，排除已有人工答案的父段；盲测原话既不发送为模型目标，也不发送为上下文，不展示 AI 建议或全场搜索。保留来源指纹和 AI 暴露记录，辅助答案、旧答案与独立盲测答案分开计数；独立分类样本不等于独立真实会议验收或声纹精度证明。来源变化时停止使用旧建议，保留历史人工答案供重新核对。新模型调用必须先给费用上限并获得授权；收费重试也需明确授权，不能由浏览器访问触发。公开体验站继续不接入真实会议、原声或私有标注凭据。

## 最新前端验收口径与两项 P1 实施（2026-10-12）

本轮工作标识沿用20261012，验收日期为2026-10-13。

用户明确意见表本阶段主要按前端判断：已完成入口、操作、结果与异常交互的页面可标“前端已实现”；真实后端、设备或部署尚未接通，写在具体完成情况及接入边界，不再单独据此把已做前端继续标为“计划修改”。此口径取代上文按整条真实服务部署完成才关闭前端意见的旧标准，尤其适用于文档角色、会议保存和工作助手前端。仍有实际前端剩余的混合意见继续计划修改，分清首版已做与P2未做，不把新状态当作真实服务已接通。已有后端能力继续优先沿用，公开网页不包含真实会议或Mac全权限执行token。

用户授权补齐余下五条意见中的P1。本轮源码已实施第2条设备开机自动聆听的前端闭环和第16条“我的→设置”；已确认前端逻辑、Android H5界面、运行时完整性及全量截图，画板生成、生产构建和资源检查收尾后准备同步网站、GitHub与飞书。本节不宣称已经上线。

- 首次配对独立选择这台设备是否开机自动聆听，默认未选；切换设备重置该选择。配对、保存偏好和把条件改为就绪本身不开始录音；后续明确的示例开机信号才检查是否开始。开启不扩大正式会议云保存、姓名、声纹、长期记忆或共享权限。
- React设备运行环境只放内存，刷新回到尚未收到开机信号；设备选择可作为本机示例偏好保存。画板场景继续隔离已有用户数据。Android H5设备页是独立内存示例，不向原生收音桥发送指令、不修改真实设备偏好；安静状态由用户手动选示例条件，不冒称已经接上真实时钟或硬件事件。
- 权限缺失、后台受限、断连、安静时段及服务不可用都有原因和恢复路径；条件恢复后需明确恢复。暂停、停止与解除配对优先于开机/重连，不擅自重新开始；暂停的设备日常沿用同一session，停止后明确恢复才新建日常，重复信号不重复创建。已有正式会议、其他活动记录或不一致的活动状态优先，不改变其ID、模式、保存合同或内容。
- 设备自动日常始终是个人五分钟临时记录，停止清除、私人候选待核对沿用已有保存逻辑。个人安静时段不随正在浏览的共享范围改变；从设备进入偏好编辑保存后返回原设备。五分钟全文及镜像清理保留设备归属，跨页暂停/结束仍能同步停留状态，不因清理丢失设备关联而绕过恢复。
- React第五导航显示“设置”及齿轮，保留settings路由和旧深链接；设置首页按账户、身份与助理、设备与聆听、工具与通知、隐私与共享编排，原11个目的入口各保留一次。移除重复的大个人档案/关注展示，内容、人物、项目与检索仍在记忆，不改泛动态。Android H5保留me及既有收音/身份/许可/连接/诊断动作，按各端现有能力收敛导航，不伪造同一组后端功能。

本轮只补React与Android H5前端，未改Kotlin或后端执行契约，真实录音豆事件、系统权限及后台服务仍待接入与真机验收。2026-10-13已确认323项前端逻辑、53项Android H5界面回归通过，28个移动运行时文件完整性检查通过；其中新增设备22项、设置4项包含在323项内。原182张截图全部重拍并新增12张，共194张实屏和217项交互入口清单已核对，保留原131编号。画板一致性7项、原生预览7项、站点资源4项与生产构建已通过；独立HTML与在线交互画板字节一致，GitHub、网站和飞书按此版本同步，发布结果以部署工具为准。实施及检查方法见docs/p1-device-settings-20261012.md。

## 已授权的相似表达一起核对（2026-10-12）

用户要求对已有 AI 建议实时查找相似表达，核对一段时可以一起确认其他段。默认查找现有三场会议、最低文字相似度80%，可选择70%／60%或仅当前会议；百分比表示文字接近程度，不表示语义等价、模型置信度或分类准确率。确认前必须列出具体原话、会议和时间，允许逐条排除或只确认当前表达，不因达到阈值自动提交。候选只含同类且未答的事实、观点／方案、无关内容；已有答案和单句例外保留独立，任务、决定、负责人和身份不传播。每个成员直接与当前表达比较，固定独立盲测绝不进入索引或确认范围。

所选相似组可以跨1–3场一次确认并整组撤销，保留各自原话、来源与建议指纹、原单场撤销和后来的纠错；撤销及后续再次撤销不得复活旧结果。跨文件写入用持久事务、幂等回执及读取前恢复，失败不得误报整组成功。组答案仍计为AI辅助核对，不新增独立盲测证据；相似查找使用本地文字计算，不触发新的收费模型调用。发布继续同步原私有标注链接，不将真实会议或标注凭据接入公开体验站。实现与最终验收见docs/label-similar-review-20261012.md。

## 已授权的后端 P0 缺陷修复（2026-10-13）

用户授权直接修可落地的 P0，优先沿用队友后端，并同步 GitHub、原网站和飞书后端功能表。本轮在最新主分支上补带来源任务的服务端版本与当前有效性校验、原生任务板的服务／来源代次保护、真实录音豆 SDK 冗余副本管理；保留现有任务日志、防重、外部创建读回、会议保存合同及私有标注工具。来源合同与登录权限是两件事，不把新来源保护当作已实现用户／对象权限。

已创建任务保留历史回执；外部结果未知继续查询，不因来源失效冒称未创建。只有服务明确证明本次未外写的来源冲突才提示重新起草。自然全文到期后，只能继续使用独立确认、当前有效的短依据；原话修订／撤回／删除仍撤回派生授权。普通正式会议五分钟现场滚窗不等于归档到期。

没有真实 SDK 禁用落盘的可验证接口时，真实录音豆日常模式在初始化前明确阻止，不静默改音源或宣称满足五分钟策略；手机麦和录音豆模拟不受影响。正式会议 SDK 冗余音频只进入本场受管临时目录，传输关闭确认后清理，异常残留仅清理新命名空间；旧 bean 目录不追溯删除。代码检查、公开隔离示例发布、真实服务部署、APK／SDK 编译及真人验收分别记录，详情见 docs/p0-backend-fixes-20261013.md。

## 已授权的 App 会后结果事项化（2026-10-13）

用户确认 App 会后结果要像标注站一样按事项核对，并选择沿用后端已有 AI 纪要作为来源（不另起一套提取）。有纪要时，会后核对队列和概览改为纪要事项（待办/决定/待定），逐句候选不再进入待核对；无纪要时保留原逐句队列。事项由已存纪要即时派生、不调用模型；核对单独存于会议 `item_reviews`，不写句子核对、不让纪要失效；纪要失效时事项只读。待办负责人由人选（团队成员或“大家”），`owner_hint` 只提示不预选。纪要提示新增 `undecided`，有人反对或仍在争论的不算决定；负责人只在本人认领或被点名时填写；已有纪要不重写。从事项建飞书任务、React 原型与两份画板同步尚未做。接口见 docs/api.md「会后事项核对」。

## 已授权的三场待办接入 App（2026-10-13）

用户明确要求将核对站0235／0236／0238的16个待办接到真实安卓版任务页，带原话依据和人工核对状态，并清理旧服务器验收测试任务。这项授权将上述三场当前明确事项接到App，不扩大为全部会议自动导入、自动确认、自动分派或自动创建飞书任务。

任务页默认显示会议候选，按原始事项ID与指纹读取8／6／2条，保留四人的确认、改写、排除、合并及原句身份核对。各人的答案分别显示，分歧不自动取舍；说话人、认领线索、人工负责人仍独立。仅人工明确指定本人且无核对分歧的候选进入“我的任务”；大家或不确定不默认为本人。内容确认、业务完成与飞书创建分别记录，候选不冒充正式飞书任务或增加其首页数量。继续核对使用原核对站，App刷新动态读取，不另存一套答案。

沿用已认证的 `/v1/tasks`，保留 `items`，新增 `parsed_items/parsed_status`；服务端私有配置固定三场和16个当前指纹，只读loopback核对站。来源或指纹变化时撤回该场正文；读取失败清除候选缓存，筛选、本人和服务切换保护迟到回包。公开React体验、网站和画板不接入这些真实会议或私有凭据。

旧验收任务已按明确授权在飞书删除并回读确认不存在；服务端操作回执归档但保留原op_id防重，不再列入任务页。后端已发布，Redmi已覆盖更新，原核对数据、人员与声纹保留。本轮未运行测试；只做必要静态核对、受保护运行时检查、APK打包及真实部署/安装回读。交付范围及接入依赖见 `docs/mobile-data-alignment.md`。

## 已授权的手机旧数据与链路对齐（2026-10-14）

用户要求继续检查真实手机旧数据及未对齐链路并直接补齐。三段早期合成语音保存片段已可恢复归档，一场无录音/核对/关联成果的调试碎片会话备份后删除；其他实际会议、录音、人工答案及原操作编号保留。旧无服务归属录音不从当前设置推定归属，不自动上传或恢复到当前服务器。

首页/记忆独立展示核对站候选与App会后已确认待办；外部核对返回刷新，读取中及失败时不拿旧候选当当前依据。真实会议的已确认纪要待办汇入任务，已确认决定进入项目和历史来源；保留原话、人工负责人、真实会话ID与正式任务回执，不复制逐句答案或自动补确认。删除按会话/requestId清派生缓存并拒绝迟到回包；空队列不称业务完成，缺时区的旧时间明确未记录。

新录音冻结服务URL/mock归属且不存token；异常恢复先同步未到期原始定稿、确认合同和会话回包，再写结束标记。服务变化撤回旧异步建议与未提交草稿，活动收音/收尾时禁止跨端点切换；已提交操作仍按原端点查询。保存召回捕获原会话/证据，防止异步把旧片段写入新会话。

外部任务首次确认和实际写入前校验来源；改文/改时间保留单调源版本及旧核对历史，撤回旧许可。日常短依据使用最长五分钟的有界内存receipt，停止/到期后未提交草稿需重核。明确未执行的来源拒绝可重新起草；已有外部尝试且结果未知继续pending并停止重发，GET只查询原操作/原GUID，不用新op掩盖未知结果。

本轮后端与Redmi已实际更新：11场旧会议、三场16个核对站候选、0条正式任务；App已人工确认纪要待办当前为0，不能把核对站的人次答案冒充本库确认。发布保护20份服务端文件，覆盖安装前后19份手机私有文件哈希一致。未运行测试，只做必要静态检查、28文件运行时完整性检查、APK打包和交付回读；不代表异常退出/长期录音已实录验收。详情见 `docs/mobile-data-alignment.md`。

## 会后逐句复核：MiMo 只给纪要参考（2026-10-14）

用户选定：会中仍用火山流式识别；会后由服务器按已有起止时间逐句截音频交给小米 `mimo-v2.5-asr` 再识别，结果只作为写纪要时的参考（行末「另一识别」），不改原话、不在界面显示、不自动替换。原因：MiMo 不返回时间戳和说话人，实测与火山各有对错。由 `MIMO_API_KEY` 开关，每场/每天有音频秒数上限，结果随录音删除、随转写到期删除。纪要最多等 10 分钟。详情见 `docs/asr-review-20261014.md`。

## 实时漏斗可视化页（2026-10-14）

用户参考「每个词一个岔口」的蜘蛛视频，要求把 Oops 的实时处理做成同类页面。本轮只做可视化，不改后端判断：`public/funnel.html` 是体验中心的独立页，逐句回放每句话经过的岔口，按谁来答分成规则 / Jev / DeepSeek / 你四层。规则岔口用当前后端代码（`TextClean` 语气词、`rules_tag`、`looks_like_question`、`assess_item`）重算，Jev 与 DeepSeek 结果只取回放记录，概率没记录就留空，不编。数据由 `scripts/funnel_replay.py` 生成。

公开站只放编写的示例会议（`scripts/funnel_example_replay.json` → `public/funnel-sample.json`，页面标「示例数据」）。真实会议回放只生成到已忽略的 `build/funnel-*.json`，在页面里「打开回放文件」本机读取，不上传、不提交、不发布。「规则先判」面板只做旁路比较；要把后端改成规则优先的分层，需另行授权，并按 Jev 验收要求在独立样本上重新评估。

页面结构（2026-10-14 定稿）：用户选定参考视频的深色风格（原文面板 + 弧形扇面 + 爬行的蜘蛛 + 右侧分层卡片），不套品牌视觉。弧分成四个扇区，分别正对规则 / Jev / DeepSeek / 你四张卡片，每个问题的线从原话连到答它那一层的扇区，刻度长度表示置信度 p。卡片显示该层回答的问题数、在该层结束的句子数和主要出口（出口名称由 `funnel_replay.py` 的 `outcome` 给出）；点一句话，决策流水只显示这句经过的问题。

会后整理（2026-10-14）：页面另有「会后 · 整理」标签，参考蜘蛛逐段抓取全文的录屏。四步：①DeepSeek 一次读完全文写纪要（耗时取自回放）；②`minutes_items.build` 把纪要变成待办 / 决定 / 未决问题并对回原话；③`item_quality.assess_item` 复核；④`meeting_features.review_queue` 排会后核对顺序。②–④都是现有后端代码，由 `funnel_replay.py` 的 `post` 段生成，不调模型、不编结果。蜘蛛按原话顺序爬过全文只是展示每条结果引用了哪些原话，不代表模型逐句阅读。


## 蜘蛛页历史与协作回放定稿（2026-10-15）

用户要求独立蜘蛛页直接读取真实后端已有会议，保留原历史和“重新分析”的区别。限定会议与期限的独立只读会话提供历史，公开站只放编写示例；查看和播放不触发模型、ASR、资料查询或飞书发送。没有保存的概率、上下文、真实时序和回执明确缺失；模型选项概率不当作实测准确率。来源修订、删除、全文到期或权限失效后清空旧正文和画布，派生副本继承来源期限。

用户已授权多只 Oops 展示现场判断和会后纪要／资料／人工核对／飞书之间的交接，并要求参照提供录屏复刻黑蓝底、品红方框、两排四格仪表、微缩立体办公室、小角色离座对白及八足线框蜘蛛。原录屏家具裁切仅作参考布景；动效只由当前已到达的已有记录驱动，不假造查询、人工确认或发送。控制默认收敛为播放、进度、切换会议和更多，详情按需打开；暂停、隐藏、换源和减弱动态立即停止。

38句会议的Jev重新分析已在用户批准的0.10元上限内完成，结果存于私有服务，不能提交Git或公开站；本轮仅复用已有结果。加载失败保留真实原因，授权列表成功后才判断指定run是否缺失；失败刷新保留明确导航意图，用户另选来源优先，迟到响应不得覆盖或复活历史。只读GET可有限重读，写请求不自动重试。详见docs/funnel-replay-20261015.md。


## 蜘蛛页改版：蛛网与 Oops 接力（2026-10-15）

用户认为录屏复刻版太杂，要求保留“多只小 Oops 分工”和“蜘蛛（Jev）处理”的逻辑，按 Oops 自己的项目优化。本节取代上文“蜘蛛录屏复刻修正”的视觉方案；数据边界不变。

- 不再使用参考录屏的家具、墙屏、金融数码与第三方标志裁图，也不用八格仪表；页面改为三栏：原话／事项 → 蛛网与接力 → 详情，深色底配 Oops 紫色，只用官方 Oops 形象。
- 会中蛛网的线只画当前句已回放到的已存问题；颜色为处理方（规则／Jev／生成／你），长度为已存概率，无概率画虚线。每句处理完网多一圈；蜘蛛只在刚到达的线上停留，暂停、减弱动态或换源即回中心或清空。
- 会后蛛网以纪要为中心、事项为节点，依据、规则复核与待核对序号按引擎阶段出现；点节点看事项。接力带的 Oops 无执行记录就置灰，不为动画假造查询、纪要、核对或发送。
- 判断轨迹只在会议同步时附入归档，分类请求只记内存，不在手机 10 秒路径上读写会议文件；附入时读写原始存档行，不把展示用副本写回。
- 用户确认元素保留，要求效果参考原录屏：Jev 做成线框爬虫，在整页上走到回放刚到达的原话、蛛网线、判断卡和工位，落脚处高亮并弹出已存答案短标签；腿逐步落脚、关节为绿点、脚间有淡连线。只标已存结果，减弱动态时关闭。
- 视觉冲击加强：霓虹配色与发光、更大的爬虫带触须连到附近元素、丝线拖尾、落点爆闪与实心标签，新判断线从中心射出带涟漪，播放时舞台边框呼吸发光。
- 用户要看真实效果：本机预览可用 `?local=real-0238.json` 直接打开 `./data/` 下的回放文件，仅限 localhost。真实回放由 `funnel_replay.py` 从已有 build/replay-*.json 生成（不调模型），只放在已忽略的 build/ 下，不提交、不发布。
- 用户随后要求回到参考录屏的仪表布局并结合后端数据：品红外框与顶栏、八张角色卡（主控/聆听/规则/判断/生成/你/纪要/飞书，均按已回放到的已存步骤计数，问 JEV 标记只在判断卡）、中部工作室（大屏为当前原话与 Jev 蛛网，六张原录屏书桌各坐一只着色 Oops，产出时冒出已存答案气泡）、Jev 已存概率曲线（只画已回放的有概率判断）、底部原话／Jev 分析／规则检查三栏。只复用六张书桌裁图，不用墙面、FOMO 与第三方代币标志。会后模式沿用三栏事项蛛网。

## 历史页暂时免邀请（2026-10-15）

用户明确要求先不要邀请、暂时让所有人可以访问私有历史页。网关新增开关：`/var/lib/oops-history/open-access.json` 存在且列出会议 ID 时，没有个人会话的访问者可只读这些会议；文件每次请求读取，删除即恢复仅邀请访问，无需重启。用户随后确认开放全部有内容且未过期的会议：当前 11 场、726 句（含 38 句会议及其 Jev 重新分析），列表为写入时的固定 ID，之后新录的会议不会自动开放。响应继续 noindex、no-store、只读，不调用模型；这些会议原文对任何拿到地址的人可见，仅限用户本人决定的这段时间。
- 用户随后要求把 10-05 三场团队讨论录音（DJI 0235/0236/0238）也放上历史页。它们不写入后端会议存储，而是作为事后分析回放文件放在 `/var/lib/oops-history/replays/dji-*.json`，由网关在开放列表里与会议并列显示；标为事后分析（Jev / DeepSeek 结果来自那次分析，不是会议当时实时判断，规则用当前代码重算），不重新调用模型。从开放列表移除 ID 或删除文件即下线。
- 三场又按真实时间拼成一场 `dji-1005-all`（324 句、约 96 分钟、19 项纪要为三段各自纪要合并，非重新生成）。个人邀请会话不再收窄开放列表：可读范围为开放列表与个人会话的并集。
- 用户最终只要合并版：三段单独回放已从开放列表移除（文件保留在服务器但不可读），历史页只列 `dji-1005-all`。
- 合并回放的说话人改用团队标注站已确认的音色组（`identities/shared.json`，808 句）：回放每句约 20 秒，按其下属分句的确认身份汇总，单人显示姓名、多人按发言量列出多个名字，无确认保持未认人（未认人 236→43）。这是组关联结果，不是逐句独立听辨。
- 用户要求历史页先只展示合并的 10-05 讨论并以此为基础继续优化：开放列表只剩 `dji-1005-all`，此前的邀请与个人会话已全部撤销（访问库已备份）；列表只有一场时页面自动打开它。其他 11 场需要时可重新加回开放列表。

## 恢复旧版蜘蛛界面（2026-10-15）

用户提供旧版截图并明确选择“恢复截图里的旧界面”。本节取代以上工作室、仪表和多只 Oops 的视觉方案：恢复 Site v20（`d5d81459551917a2aa3852442e8c89d6810dede4`）的深色原文终端、扇形连线、小蜘蛛、规则／Jev／DeepSeek／你四层卡片，以及“逐句 · 判断回放／会后 · 整理”分栏。只恢复界面，不恢复旧会议范围或覆盖当前数据；当前合并会议、已确认说话人、事后分析标记及原分析结果保留。继续保留新版读取保护、失败恢复、唯一可读会议自动打开、来源失效清空、完整概率与暂停行为；播放不提交模型或外部操作。原线上 Site、历史页和 PR 同步本次界面恢复。

## 97 分钟全链路重新分析（2026-10-15）

用户先选定 v25 页面只换蜘蛛（霓虹线框爬虫，`funnel-spider.js`，旧蜘蛛保留为回退），再批准按标注站细句全链路重跑：Jev 上限 ¥2.00 实花 ¥0.725，DeepSeek 上限 ¥2.00 实花 ¥0.984（整场纪要不截中段、待办措辞、待查问题）。盲测 81 句不发给任何模型。结果 `dji-1005-full` 已发布在原历史页并成为唯一开放会议。详细见 `docs/dji-1005-full-chain-20261015.md`。新的收费重跑仍需单独报价授权。

## 蜘蛛页实时跟随（2026-10-16）

用户要求将本次新会话接到蜘蛛页查看实时过程，并明确后续也需要实时能力。只新增本次明确会话的读取范围，保留旧回放，不自动开放以后所有会议。页面每5秒核对服务器已同步的原话与已有处理轨迹；支持跟随最新、暂停查看旧句、失败后恢复和会后结果承接。未收到结束标记不能单独证明设备正在录音，结束时间与最后同步时间分别展示；缺失过程、概率或模型记录不补造。新到达动效仅反映已经收到的记录，不发起模型/ASR/外部操作。撤权、删除、到期或超时必须清空旧内容，隐藏页面停止读取与动效。当前接入时本场已于12:00结束，共225句；持续新录音的端到端延迟仍需下一场实录核验。实现与部署见 `docs/spider-live-20261016.md`。

## 已授权的新录音自动接入蜘蛛页（2026-10-16）

用户随后明确要求“把后续新录音也做成自动接入蜘蛛页，不要每次手动添加”，取代上一节未来会议不自动开放的限制。原免邀请只读页自动纳入本次授权时间起新建、合同有效且明确选择云保存的正式会议，保留两场固定记录，不把其他旧记录、日常临时内容或任意预制回放加入自动范围。服务每请求重新核对配置、来源和期限；可关闭自动开关、动态排除或撤回独立许可。前端根入口/auto=1 每5秒发现并跟随最新会话，手动查看历史、暂停、示例和本机文件不被新会话抢跳；退出、隐藏及来源失效保护继续生效。查看不启动模型、ASR或外部动作。规则已在原站启用，后续不需逐场添加ID；端到端时延仍待下一场真实录音核验。详见 `docs/spider-auto-20261016.md`。

## 蜘蛛页断线和播放稳定性（2026-10-16）

用户要求实际测试中途卡住、断开和数据未刷出。列表暂时失败时单独核对当前正文，正文可读则不中断；正文暂时失败仍清空可见私有内容，仅保留内存中的会话ID和数字播放意图，重新授权读取成功后续播，不保存旧正文。撤权/删除/到期停止自动恢复，换源/示例/退出取消迟到恢复；隐藏页面不继续读取或自动续播。同源新增记录不得重置正在播放的会后进度；蜘蛛动效须容忍RAF与performance时钟差，单次绘制异常不能使动画永久失效。实际服务器无新会话时如实显示最后同步，不将“自动接入已开启”当成手机正在上传的证明。详见 `docs/spider-stability-20261016.md`。

用户继续指出 `history.readonly` 原文没有实时滚动。原文跟随当前已经显示的句子，覆盖逐字出现、倍速跳过短判断和播放末帧；使用实际滚动容器坐标，长句跟随当前句末。首次载入与跟随最新立即定位，不误触4秒手动滚动冷却；手动翻看、选择旧句和暂停保留既有保护，同源更新不覆盖正在播放的跟随位置。

用户随后提供截图，要求先去掉右侧框选的落点光圈/爆闪，优先解决卡顿。逐句与会后视图均停止触发落点爆闪，保留蜘蛛、原文与已有判断；逐句画布按20fps预算绘制，像素倍率上限1.5，播放时钟独立推进。判断记录流复用当前可见窗口的DOM，避免每次新增记录都重建九份完整请求详情；换源及撤权立即释放旧窗口，概率/依据详情仍可查看。

## 蜘蛛页 Sol 处理展示与会后总数（2026-10-17）

用户指出四个处理方均为0并明确要求直接修复。Sol须使用独立处理方身份和实际保存的记录，不归作未知、规则或旧Jev；Sol语义选择不伪造概率或套旧门槛。会后数量直接显示当前可用已存纪要的各类总数，事项及原话定位载入即显示，动画不决定结果是否可见；无可用纪要显示“—”并清旧进度，真实空纪要才显示0。模型名称只取历史记录，不能从当前部署倒推。本地修复与线上部署分别记录于docs/spider-sol-display-20261017.md。

## 会中 Sol 每20秒增量整理（2026-10-17）

用户明确选择20秒一轮并授权真实试跑，重点观察处理速度，取代此前一分钟汇总建议。仅有新原话时发起，上一轮未完成不叠加；独立worker复用现有私人Sol配置和来源保护，不改正式三份纪要、任务确认、录音或保存合同。会中草稿含小结、待办/决定候选、未决和观点，逐条绑定原话；首次仅启用时最近约60秒，不默默补跑整场旧录音，显示覆盖范围、真实模型耗时与更新时间。失败或未知结果暂停，不同来源的新版本与旧失败回执分别核对。活动会议页面显示“会中·实时整理”，结束恢复会后承接。实现、试跑速度、等待上限与生产状态见docs/live-minutes-20s-20261017.md。

用户随后要求优化超时与积压。滚动整理改为只生成新增/修订补丁，旧候选由程序保留，以连续原话前缀推进，不能跳到最新而丢掉中段。20秒仍为发起间隔，单轮串行；输出与输入分批限额，独立60秒总等待上限不冒充20秒内完成。相同真实请求仍防重，未知回执不自动重试。本次当前会议结束后尚有120句积压，允许仅对该明确会话及已有有效checkpoint做一次旧协议到新协议的审计恢复并顺序补齐；不扩大为自动重算其他结束历史。页面分别显示未覆盖数、来源进度与成功/失败用时。部署与实际速度见docs/live-backlog-optimization-20261017.md。

用户继续要求尽量每轮20秒内，并修复新8句会议没有整理正文。当前生产启用compact-v1紧凑输入、最多6项短变化、成功后按实际耗时在每批6–12句调整；20秒为软目标，仍接受超过目标但有效的结果，未知请求不缩批重发。首轮即使没有事项也须有绑定原话的小结。来源失效、暂停及停止原因不得被结束标记覆盖；历史调用成功不能冒充当前有效草稿。正式substantive:false的真实空结果明确说明未提取正式事项，缺少历史耗时仍留空。本轮仅对用户截图明确的8句会议审计授权一次新来源重建，已12秒完成全8句并撤销临时重建范围，不覆盖正式纪要，不自动补跑其他失效历史。交付见docs/live-speed-and-empty-draft-20261017.md。

## 冲突提醒跟随20秒理解（2026-10-17）

用户认为旧冲突提醒效果不足，明确要求依托现有每20秒持续整理的 Agent 结果发现冲突再提醒。正式会议的同场冲突改为同一次 Sol 增量整理的有来源候选，不再逐句另发同场冲突判断；原跨往期会议核对仅接受其他会议的历史依据，时间规则及日常五分钟边界保留。候选须有先前与当前两组确切原话、待核对说明和问题，先区分预算/条件获明确更新、撤回、转述和假设；同一先前依据稳定更新，不重复震动，解除需要新原话依据。模型提醒不代表本人确认、派工、事实核验或业务完成。

本轮已完成本地源码：worker 同次输出、只读认证投影、实时页面呈现及 Android 既有提醒/短震动承接。新协议与旧未记录判断区分；来源修订、说话人/人工核对变化、撤权、到期及失败撤正文，迟到回包不复活；候选正文不复制进原会议提醒同步队列。旧依据从已覆盖会议候选检索且受预算限制，20秒仍为调度软目标，不承诺整场冲突全部检出或固定完成时延。未运行测试、构建、收费模型验收、生产部署或手机安装；实际状态和接入依赖见 `docs/live-agent-notices-20261017.md`。

用户随后明确授权部署并更新手机，已窄上线7目标、94项其他源码/配置保持；原23条attempt逐值保持、worker无新增付费验证，公网认证接口200/无凭据401。原930份业务文件0缺失，929份SHA保持，仅Raft原群轮询正常变化且原任务/交接/核对逻辑行保持；65会议/1操作/54合同保留。主版已以当前已装2b1821…为基线原签名更新到ee7a4bdf…，只替换2份目标DEX，214其他条目、11其他DEX及全部H5保持；318份私有文件冷安装前后无缺失/哈希变化，已普通启动并回读原生空闲/队列0。未结束或新开录音，未测试套件、Gradle全构建、业务发送或收费模型验收；必要离线增量编译与部署/安装回读已执行。满30条提醒不暂停原整理，原跨往期核对保留；实际质量及速度仍待真实使用，不把上线当效果验收。

## 网页与PPT同屏演示（2026-10-17）

用户要求一部分展示当前页面、一部分展示PPT，并明确允许新建。新增独立同屏入口与6页可编辑Oops产品PPT：左侧单个同源history iframe沿用原会议、权限和读取链路，右侧显示该PPT导出的同源静态画面；不把真实会议正文、身份或访问凭据放入公开PPT。原页入口携带当前会议/重新分析与live/after分栏，不复制invite/token。均分/网页为主/PPT为主和拖动仅调比例，两个区域始终可见，不销毁iframe；翻页不触发模型或事项写入，窄屏上下排。品牌沿用紫色与原吉祥物，手机截图标明前端界面示例。实现和生产入口见docs/presentation-split-20261017.md。



## 安卓声纹录入停留与计时（2026-10-16）

用户指出安装版点开始录入后跳到首页/录音页，无法在 App 内完成声纹录入。开始声纹采集必须保留当前入口和录入面板，不能被普通收音启动的自动跳页关闭并取消。录入过程中计时、进度与音源连接提示局部更新，阶段/质量/结果变化才刷新面板，保留朗读位置和独立放弃入口。沿用本人单独声音授权、质量核对、明确保存与原服务回执，不替用户录入或覆盖已有声纹。修复已写入本地 Android H5，并从手机原 APK 提取相同修补包保留安装版额外功能。用户后续明确授权打包覆盖更新、正常结束并保存当前正式会议；已用原证书重新签名安装，仅替换声纹页面脚本，212 个其他条目保持一致，52 份已有业务文件校验值一致。手机安装包已回读，未运行测试或替本人登记声纹。后续原生全量构建须继续保留安装版额外 H5/原生功能，不用旧主分支直接覆盖；本轮未混入并行录音豆开发改动。交付见 docs/voiceprint-enrollment-20261016.md。


## 会后整理 Sol 专用接入试跑（2026-10-16）

用户提供自己的 OpenAI-compatible 服务并要求会后整理使用 `gpt-6.1-sol`，先在现有链路试跑。会后模型使用独立服务器私人配置（`OOPS_MINUTES_CONFIG`）；凭据不进Git、App、网页或日志，不用全局模型配置连带替换实时Jev、任务草稿或查询。保持原话、身份、事项来源及人工核对边界。已用上午225句同源转写完成三次真实API调用并复用现有解析、质量检查及三份投票，原纪要不改、不发送飞书。仅本地接入代码与候选配置完成，线上未切换；本机试跑需进程内指定已核对的Tailscale节点解析并保留HTTPS证书校验，生产网络尚未验证。换模型仍存在投票遗漏，不能据单场宣称整体准确率提高。细节见 docs/sol-minutes-trial-20261016.md。


## 线上会后整理已切换 Sol（2026-10-16）

用户明确要求先确认服务器连通再切换线上，并一起修复路演日程投票遗漏。服务器已安装Tailscale并由用户确认设备加入原网络，HTTPS合成请求成功；生产会后专用配置选择 `gpt-6.1-sol`，保留原实时Jev、任务草稿与查询配置。凭据仅服务器私有0600文件，App和公开页面不持有。只部署会后三模块，备份 `/var/backups/oops-meeting/sol-20261016T085542Z`；不覆盖生产独有的删除保护和发送确认。日程清洗保留原话ids，投票核对时间/时长，同源冲突进入人工核对，不因读页面补算旧纪要。三份真实回包重放已保留10月17日15:00–19:00路演，原会议不覆盖、不发送。6项最小投票测试、源码与健康回读通过，未跑全量或构建；首次新会议完整生成仍待真实使用观察。详见 docs/sol-minutes-rollout-20261016.md，取代前节“线上未切换”的状态。


## 会后结果默认同步手机（2026-10-16）

用户要求会后整理完默认传到手机，明确选择先做App内自动同步，离线后恢复网络或下次打开补取；本轮不做退出App后的系统通知。主版沿用已有原生鉴权与只读会议/纪要接口，前台自动核对，后台停读，结果到达提示但不跳页；显示“纪要已同步”不等于人工确认、创建任务、长期记忆或飞书发送。保持来源修订/删除/到期、切后端、迟到响应与失败清理，正文不另存永久离线副本。用户已明确允许正常结束保存当前正式会议再覆盖更新；实际ASR收尾确认、文字与结束状态已同步；更新时原音仍在原有持久队列，收尾已回读到本场uploaded标记，三个状态分别核对。最终主版原签名覆盖安装、213份非目标条目及190份业务文件保持；真机自动收到7份结果，含本场Sol回包，6项最小控制器检查通过，未做全量或Gradle构建。详见 docs/minutes-phone-sync-20261016.md。


## Apple Watch 原生开发验证（2026-10-16）

用户已授权安装 Xcode/watchOS 环境，并进一步要求真机签名、iPhone 配对、相关测试与 App 构建。目标是本人 iPhone 16 Pro Max / iOS 26.5 与已配对的 S9 / watchOS 26.0.2。原生连接检查独立放在 apple/，使用 com.oops.development.connectioncheck 及其 .watchkitapp，不覆盖正式 Android 主版或冒充 Oops 业务已接 Apple 平台。固定 ping/pong 只在点击后前台发送一次，确切 requestID 匹配才通过；失败/超时不自动排队或重发，不读取会议、不录音、不连接真实业务后端。

用户已在 Xcode 登录自己的 Personal Team，并明确允许为本次检查创建开发证书、描述文件和登记 iPhone/S9；私钥留本机钥匙串，真实Team只在已忽略的 apple/Configuration/Signing.local.xcconfig。前一轮实际完成4项Watch XCTest、通用模拟器与真机SDK unsigned构建。两台真实设备均paired、Developer Mode enabled、DDI可用。用户后来再次明确要求校时，已关闭会回拨的自动校时并手动校准上海时间，3个现有开发身份有效；自动校时保持关闭，根因尚未修复。用现有证书更新profile，并按真实S9目标补齐登记后，两个App签名构建、严格校验、安装与启动均成功，最终iPhone内嵌Watch profile也包含S9。用户已完成手机开发者信任，并回报手机发起的一次固定ping/pong两端成功且请求ID一致；随后报告暂不可达，刷新后为手表可达/手机不可达；再由手表发起一次，用户确认手机收到并回复且ID相同。两个方向各一次往返均通过，不把它当持续可达、休眠恢复稳定性或后台验收。未改检查源码或重跑既有测试，不跳过有效期、自动重发或撤销其他证书。后续以docs/apple-watch-device-check-20261016.md为准。

## Apple Watch 业务联动首版（2026-10-16）

用户明确要求开始Apple Watch版Oops，先接手表/iPhone业务联动，并选择“手表负责录音，iPhone承接转写和会后结果”。业务工程独立为apple/OopsApple.xcodeproj，保留连接检查；首版使用Watch真实麦克风、同场暂停/继续、约29秒真实音频分段和持久传输回执，iPhone进行中文本机识别与已有后端会后结果承接。仅明确确认云保存的正式会议，原音/全文分别7/30/90天、默认30；首版单场手机接收30分钟音频，超限明确失败并保留手表原音，不假标完整归档。日常五分钟模式、独立Watch云识别、声音身份和自动开录不在此首版。

业务凭据仅iPhone Keychain与可信服务器，Watch不持token；新增独立手机网关仅能访问本grant新建的会话，不认领旧会议、不接收任意代理路径。来源删除/撤权/到期/跨服务时清正文与相应原音，未知写入沿用原请求查询，不能自动换ID或重发控制。临时即时不可达不等于断配，音频传输与录音控制分别处理；后台不自动继续录音。后端沿用已有会议/录音/纪要结构，生产的发送确认保护需核对后再接入，云保存不扩大飞书发送或团队共享。

本节记录授权与实现范围，构建、部署、配对和真实录音完成状态以docs/apple-watch-business-20261016.md为准，不能用先前固定ping/pong代替本次业务验收。

USB续验：用户要求直接USB操作，专用网关已在香港独立8799与新前缀部署、手机兑换并保存Keychain，S9实际收到同grant就绪。中文语音识别首次系统授权经用户允许后已就绪，复用持久recognizer与availability观察，不能把已配对或权限就绪当作录音/转写成功。用户明确允许一次20秒、7/7天私有云保存尝试；该段等待权限后开始，代理再次启动前未先核对活动录音而中断，未封口，不算通过、不自动重录。随后用户在Watch界面确认新场30/30天并明确“已结束并保存，按30天继续”：实际89.392秒4段传入手机，AAC尾帧EOF修复后全段PCM转换，原音2,860,544字节已完整归档；中文20字同步，2段无文字、末短段1110失败，ASR冻结incomplete，界面独立提示。手机已取回本场ready的空纪要结果，不冒称实质纪要质量通过。

本次测试不外发：发现既有蜘蛛页自动发现正式会议后，先hold云正文/原音；用户追加明确授权，仅将本次会话ID加入香港open-access.json排除，先备份并保留其他范围、owner/mode，不重启服务。公开列表回读不含本场，原生产会后发送确认保护保留。三处已兑换码临时明文已清理，不撤销有效手机身份。必要相关真机签名构建/安装与最小业务联调已执行，未新增或运行单元测试；长时间后台、断网补传、暂停/继续和有实质内容的纪要仍未验收。

## Apple音频改用主版后端转写（2026-10-16）

用户在明确获知前版只用Apple本机识别后，要求手表音频接Oops现有后端转写、与主版同链路。本节取代上文Apple本机识别作为新场正式转写的要求：手表采集，iPhone只做真实PCM转换和受限传输，由独立手机网关复用主版火山bigmodel_async、二遍/ITN/标点/热词/definite/EOS结束回执，定稿进入既有/v1/utterances语句处理、会议sync与会后接口。不以MiMo会后参考替代主转写；不自动增加声纹身份登记、真人关联、任务创建或外发。按现有29秒文件分段承接，分段WS与主版持续WS的跨段上下文差异须如实说明。

付费ASR在发出前持久登记会话/分段/PCM哈希/原时间与唯一请求，结果未知只查询、不换ID重复收费。任务和Jev处理各有真实状态，202只表示登记；结果继承原音/全文较短期限与原grant，源撤回/到期不返回旧正文。火山凭据仅可信服务器0600配置，Apple App不持供应商密钥。旧已同步Apple转写与冻结incomplete保留，不自动覆盖或双加新句；本轮可用已获授权、已公开排除的原场片段做一次独立后端ASR/Jev核对，不改旧文字、收尾或纪要。部署只升级既有8799专用服务及其目录，不覆盖主后端生产源码/配置/数据；实际完成状态另记docs/apple-backend-asr-20261016.md。

本轮实际：独立服务已升级，主后端PID/源码哈希未变；Phone/Watch签名构建、安装、启动完成，S9收到后端就绪。唯一28.924秒旧片段由服务器和iPhone读回同job ready/acknowledged，4句152字及136项词时间，4项Jev-1.13.0处理完成，未改旧场20字及冻结incomplete。首次查询TLS失败后仅GET原job恢复，未重复付费；临时配置副本已清除。另旧35段995.380秒原音已补归档，保留108字，27段旧文字未自动重转写。未运行自动化测试；新的整场收尾/实质纪要、长时间后台与连续WS仍未验收，不将这次真实片段通过扩大为整场通过。

Apple片段漏话续修与安装（2026-10-17）：用户反馈28.9秒内持续讲话但漏了很多，不能用152字或ASR ready证明收音质量通过。源码修正换段前的传输阻塞、持续时钟停滞/停止采集检测及旧场无文字提示；stop/start仍非无缝，切换诊断只记下界，不重写旧时间或文字。用户确认已结束录音并允许安装，随后接入iPhone USB；两端复用前轮签名包覆盖安装和普通启动成功，4场原记录、片段清单与文字哈希保持，S9当前场仍stopped/16段，手机后端ASR就绪。本轮未重建、运行测试、新开录音或新增识别验证，未宣称片段内漏话已解决；详见docs/apple-recording-missing-speech-20261016.md续装段。

用户随后明确反馈28.9秒片段内一直讲话但漏掉很多。不能用152字、ready或词时间覆盖率证明收音质量正常。原音只读核对确认该PCM28.924秒/哈希一致、无明显数字削波或大段数字静音，但未证明人声清晰或没有漏词。旧页面仍显示20字，新增152字只是独立验证、未覆盖旧文字；无文字须说明未识别，不能当成没有录到声音。当前实现的每29秒stop/start有采集间隙风险，时钟监测还存在一次推进后不能发现后续停滞的问题；修复与实际验证状态以docs/apple-recording-missing-speech-20261016.md为准，不提前宣称段内漏话已修复，不新开录音或为排查擅自重跑收费识别。


## Apple Watch 自由讲话复验失败（2026-10-17）

用户要求重新录制并改为自由讲话。本次S9实际40.184秒、两份AAC/PCM哈希一致并已收齐，手机原音上传完成；段0后端ready/acknowledged，3句187字、148项词时间、3项Sol处理ready，末段11.260秒failed/incomplete、无文字，整场frozenASRClosure=incomplete。因此测试未通过，不能用文件完整、电平、字数或49ms换段诊断下界证明语音完整或收音正常。现有通用ASR错误和窄窗口日志不足以确定根因；代码确认的整批normalize丢结果风险尚未证实为本次原因，未修改或部署ASR代码、重放失败段或改写旧结果。

此前未讲话的40.312秒准备场已按确切ID/grant持久暂缓至原音原到期，ASR任务0，不得在后续普通启动时误提交；当前自由讲话场已正常解除暂缓。两场原音/全文各7天、提交前均私下排除公开蜘蛛页，没有飞书或其他外发。本轮必要DEBUG单次40秒及准备场暂缓更新已签名构建/覆盖安装，28项运行时完整性检查通过，未运行自动化测试套件或扩大收费验证。最终手机asrClosed=true/audioUploaded=true/sourceUnavailable=false、待确认写入0，原音与失败回执按原期限保留；详见docs/apple-watch-free-speech-test-20261017.md。


## Apple 后端结果保留修复（2026-10-17）

用户新授权继续定位后端失败、修复并再做一次Watch实录。已修复整批normalize遇异常丢合法句及付费结果被后续来源读取失败清空的风险；拒收原文/真实坐标独立隔离、不得进正式原文/sync/Sol/纪要，任一拒收保持incomplete。缺失时间不补0，新增安全阶段计数，保留来源、较短TTL与并发失效保护。17项相关离线用例通过；旧失败任务具体原因仍无原始证据，不把风险当已证根因。

生产仅原子更新既有8799的ASR模块至78ac9217…，仅重启独立服务一次；主backend源码/PID、网关/probe/配置/公开范围与原五表逻辑内容/schema保持，旧job未重跑。备份/var/backups/oops-apple-mobile/asr-module-20261017T000833425396Z。Phone隔离原话/较短TTL承接已最小签名构建、严格签名核对和28项运行时检查；安装时CoreDevice4016，手机明确unavailable，新版尚未安装，新录音未开始。已请用户重插USB解锁；后续恢复后先保留原六场与EB5847CB准备场hold，再做本次新UUID的40秒自由讲话、7/7天私有验证，canonical须在音频/正文提交前独立排除公开页。新场计划UUID11F213A4-BF3F-4063-81FA-9FE932396CA2，尚无有效开录命令，不复用旧helpers/attempt。详见docs/apple-asr-result-preservation-20261017.md。


## Apple TLS恢复、53秒复验与手表录屏（2026-10-17）

用户新要求修复TLS、恢复S9开录、实录验证并由本助手在Mac录视频，随后强调主画面是Apple Watch真实屏幕，手机结果仅少量补充。不得用手机会话页或模拟器画面冒称手表录屏，也不以旧宣传片当本次素材。

手机实际NSURLError -1200、SSL -9816（无通知关闭）；SNI/证书链/期限严格校验通过，TLS1.2独立session真机能力GET成功，但未证实具体网络节点/PQTLS根因。已给原exact HTTPS网关能力GET加一次窄兼容：仅该错误组合允许独立TLS1.2读取，成功后只按同endpoint/grant内存选session；其他host/错误、POST/PUT与配对均不透明重试，证书/域名/ATS保护保持。40项真实策略离线断言、最小签名构建及28项runtime检查通过；普通启动真机ready，实际profile本次为system_default，不能声称本次在线走了备用分支。

用户手动从Watch正常确认7/7天并结束自由讲话，实际F47E7D86…/canonical f493d3a3…、53.112秒两段；先私下单ID排除公开页，再释放全局hold，原准备场hold仍在。两个ASR job各一个登记、两段ready/ack、5句226原字/186词时间、拒收0，五项Sol全ready；Phone asrClosed=true/frozen=acknowledged/audioUploaded=true、待核对写入0。旧7job及准备场0job保持。原AAC/PCM哈希匹配仅证明文件与转换一致，Watch清单读不到、间隙未知；不能以字数或ready作准确率承诺，用户逐字核对仍未答。源码/部署/真实验收详见docs/apple-mobile-tls-20261017.md。

Mac已录并保存仅作补充的Phone素材（原MOV及无声8秒MP4在output/apple-watch-demo-20261017/），没有覆盖既有宣传片。用户已开启AppleWatch镜像，但QuickTime预览仍为Phone详情，正在请用户确认手机是否确实停在含表冠的镜像界面；主手表视频尚未开始/完成，不可把手机补充片当成Watch交付。预留11F213A4…从未使用，实际复验UUID以F47E7D86…为准；当前没有新麦克风活动或另开演示会话。
