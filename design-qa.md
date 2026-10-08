# Oops App visual and interaction QA

final result: passed

Reviewed on 2026-10-08. This is an interactive frontend prototype; the pass applies to the implemented design and local demonstration flows, not production backend readiness.

## Reference and comparison

Source: /Users/hongyulin/.codex/generated_images/01a1109b-6d00-7dd1-b67b-ff332e7f9617/exec-25a2de6f-4b28-4da0-9975-7f54619550ff.png

Reference dimensions: 853×1844, normalized to 393×852 in screenshots/source-normalized.png. Final home: screenshots/pages/h01-home.jpg at 393×852. The reference and final implementation, plus screenshots/source-controls.png and screenshots/implementation-controls.png, were viewed together in one comparison input. The implementation includes the bundled native status bar, device frame and home indicator; the reference has no native safe-area chrome. Home spacing was adapted to those insets while keeping both recent rows and the first review action visible.

The official Oops wordmark and mascot replace generated brand artwork in the reference. Chinese system typography, two-line headline, lavender background, purple accent, rounded surfaces and blue-to-purple record button retain the selected direction. Phosphor SVG controls are consistent across pages. This is a brand-faithful adaptation, not a claim of pixel-identical tracing. Other pages use the same design system and were reviewed as real application screens; no separate image reference was supplied for each of them.

## Findings and fixes

- Closed P2: native safe areas originally pushed the first review action below the fold. Compact home spacing now exposes the complete action above the bottom navigation.
- Closed P2: two-item task statistics used a three-column grid and wrapped the deadline. Two- and four-item statistics now use two columns; task deadlines stay readable.
- Closed P2: same-title sessions were ambiguous in source selectors. Both memory review and growth review now identify sessions by title, date and a unique short ID, with full-ID fallback for collisions.
- Closed React warning: duplicate option keys when sessions share a title. Option rendering now has stable position-plus-label keys. No new browser warnings or errors were recorded after reload and the affected pages were revisited.
- Accepted P3: official brand imagery and native device chrome differ from generated reference imagery. These adaptations preserve the official identity and the required mobile runtime.

No remaining P0, P1 or P2 finding was identified in the reviewed prototype.

## Interaction verification

The following flows were exercised through the browser UI, not by injecting application state:

- Empty record-name validation; create a meeting; append timed example transcript; navigate away while recording; pause, resume and end through confirmation sheets; open the recap and related task.
- Task acceptance remains separate from assistant permission. Unchecked acceptance blocks submission. Allowed preparation, local generation, two artifacts and six-page presentation preview were exercised.
- Assistant input produces a local example answer with the visible source. Personal-space conversation history is hidden in a team space.
- Follow-up message body and account were edited and reviewed in the confirmation sheet. Confirmation creates a local simulation receipt, with no external transmission.
- Workflow creation, searchable empty state, five settings sections and cross-page navigation were exercised.
- A 12-minute meeting agenda was saved and its overtime indicator updated from the record duration.
- Sharing was tested per attachment: selecting only the product metrics file exposed only that file in the team materials view; revoking sharing removed the shared scope.
- Transfer request moves the task to a pending response state without implying actual external messaging.

## Screens, devices and board

All 94 distinct routes in screenshots/capture-plan.json were visited and captured as rendered 393×852 application screenshots, with nonempty route content verified. Groups: Home 6, Sessions 20, Tasks 25, Memory 21, Settings 22. Tabs and bottom sheets represent additional states and are not counted as separate unique pages.

The five contact sheets were visually inspected. The changed source-selector pages were recaptured after the last fix. The board reports 94/94 captured images. Search returned the four matching result pages for 成果; task grouping returned 25 cards; zoom changed to 110% and back to 100%. A result-preview link was checked against its canonical hash route.

The native device picker was also exercised for Pixel 10 (427×952). Header safe areas, navigation and content stayed within the viewport with no horizontal overflow. iPhone and Pixel proof is saved in screenshots/pages/h01-home.jpg and screenshots/pixel-home.jpg. Form fields are labelled; interactive controls have accessible names; reduced-motion settings are respected. No formal external accessibility audit is implied.

## Build verification and limits

Final npm run build passed TypeScript and Vite compilation. The mobile-runtime integrity check passed all 28 protected files. The build reports a 667 kB application bundle size advisory; it does not prevent this local prototype from running. No protected runtime files were modified.

Microphone recording, ASR, AI reasoning, email/message delivery, calendar submission, Bluetooth devices, external tools and collaborative access are local demonstrations. Generated artifacts are editable frontend drafts; exported presentation text is not a real PPTX. Browser storage provides local persistence, not authenticated cloud storage or production security enforcement. These limits are explicit in the app and README.

Proof files: screenshots/Oops-App-五个主页面.jpg; screenshots/Oops-App-真实页面画板.jpg; screenshots/send-confirm.jpg; screenshots/capture-results.json.

## Follow-up recording audit — 2026-10-08

A fresh user-flow audit exposed a P1 keyboard/viewport defect after text input followed by Tab to a native select. The device-screen scrollTop became 256, moving app chrome out of view and bringing the closed keyboard image back into view. Reload restores display but is not a fix. Earlier comparison results remain historical evidence; acceptance at that audit was blocked pending the app-level focus/scroll repair. See public/record-audit.html and ../outputs/Oops-记录体验审查/Oops-开始记录体验审查.md. No app implementation changes were made in this review.


## Recording improvements accepted — 2026-10-08

The prior P1 is closed. App-owned focus handling now closes the keyboard on text-to-select or nontext focus, keeps it open for text-to-text, and resets only the outer device-screen offset. Listeners attach after the phone ref is mounted. MobileScroll and sheets retain their scroll/drag behavior. Keyboard-attached buttons keep their pointer target stable until their action; actual native tapping on a visible save button was verified. Scrolling above the keyboard is needed before tapping controls otherwise covered by it.

Current full comparison: `screenshots/qa-improved-full.png`. Source is the selected 853×1844 image normalized to 393×852; rendered home is `screenshots/home-improved.png`, captured from data-phone-screen at verified 393×852 CSS pixels and scale(1), browser override 1400×1200. Both images were combined into the same full-view input and reviewed. Focused controls and navigation comparisons are `screenshots/qa-improved-controls.png` and `screenshots/qa-improved-nav.png`. Official artwork, native safe areas and denser home spacing are the accepted adaptations documented above. No new visual P0/P1/P2 difference remains.

Closed P2 after device testing: the new recording bar initially overlapped the Pixel navigation boundary by 7 px; its bottom offset is now 78 px, and a second Pixel capture/measurement verified a 1 px gap and no horizontal overflow. iPhone recording chrome is outside MobileScroll, and page padding lets final content clear it. Proof: `screenshots/record-improved/pixel-记录控制验证.png`.

The new flows were exercised through the actual browser UI, without data injection:

- Light start creates a private, automatically named session with no form; optional full preparation also starts with a blank name. The full preparation primary action stays fixed.
- Typed name → Tab → native select closes the keyboard, with outer screen.scrollTop=0 and app top equal to screen top. Text → text keeps keyboard visible. Sheet note edits and visible native save-button taps close keyboard and keep outer offset zero.
- Recording controls persist on Home and session views; pause duration stayed at 00:53 across navigation and review. Mark notes persist after reload and open their actual source.
- End freezes the content first. Cancel from a paused session keeps it paused; cancel from a running session resumes it. Manual save retained 4/6 turns and 1/2 private notes; discarded highlight source became an explicit unlinked time mark, and its related task showed requirements pending review and assistant not started.
- Conclusions and open questions were edited and saved; a chosen raw turn produced an unconfirmed private memory candidate. Anonymous confirmation can be skipped. Confirming a new example name left voice permission false; the person appeared in today’s list and its source link opened exactly 00:00:12.
- A private active recording title and global control were absent from the team start page. Its neutral return action switched back to personal space before navigation. Attempting to archive the active session left it paused and controllable.
- Pixel 10 was tested with blank preparation, pause, visible native note submission, end and empty recap. It was returned to iPhone after verification, with no active demonstration recording left.

Source invalidation was also reviewed across shared reading and writing: task-space is authoritative; old artifacts are retained with needsReview and revoked authority; invalid/unconfirmed/needs-review memories cannot be re-shared through detail/edit or read in team answer/search/export; private summary data is rebuilt from current visible turns. Focused source-priority, missing-source, sensitive-source, folder, confirmation and space assertions accompany the changes. These are frontend demo boundaries, not production authentication or security claims.

All 10 new board images loaded and the viewer advanced 1/10 → 2/10 and closed correctly. `public/record-improved.html` is the current flow board. The 94-page board remains historical overall coverage; this turn recaptured affected recording and people states rather than claiming a new traversal of all 94 routes.


Final delivery checks: TypeScript + Vite production build passed (521 modules, 701.94 kB JS bundle; size advisory only). Runtime integrity passed all 28 protected files. After the final reload, no new browser warning/error was recorded. The new source-removal guard was exercised in UI: choosing no source for an existing derived candidate was rejected with the expected validation message; the candidate remained private and unconfirmed. Final app is on Home with keyboard closed, device-screen scrollTop=0 and no active recording. Temporary viewport override was reset.
