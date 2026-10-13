# Mobile Prototype Agent Guide

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
