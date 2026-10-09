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
