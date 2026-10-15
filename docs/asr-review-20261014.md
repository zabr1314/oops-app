# 会后逐句复核（MiMo 第二遍识别，2026-10-14）

## 做什么

会中照旧：手机直连火山流式识别，实时字幕、提醒和每句话的起止时间都来自它。

会后：录音传到服务器、`complete` 之后，后端按每句话已有的起止时间从 `audio.pcm` 截出音频（`Recordings.clip`，加前后 300 ms），
逐句交给小米 `mimo-v2.5-asr` 再识别一遍。结果**只给 AI 写纪要参考**：两边写法不同的句子，在交给模型的转写行末附
「（另一识别：…）」，提示词说明它只用于判断人名、产品名、术语和听错的词，不能据此新增内容。

不改原话、时间、说话人；App、标注站、事项引用和截音频都不受影响。

## 为什么不替换火山

- MiMo 只返回整段文字，不返回时间戳，也不分说话人（2026-10-14 实测，509 个流式片段只有 content）。
- 0236 会议实测两边各有对错：MiMo 对「声纹」「申请」「剪短视频」，火山对「AirDrop」「出现在你的生活中」。

## 时序

- 会议结束后，纪要原本 90 秒后开写。开启复核后，纪要最多等 `OOPS_ASR_REVIEW_WAIT_MIN`（默认 10）分钟：
  录音传完且复核跑完就立即写；超时、没有录音、录音已删除，则直接用原文写。
- 复核结果按句子指纹（id、起止时间、原文）缓存；句子被拆分或改文后重读。重试不会重复花钱。
- 复核结果不进入纪要指纹：复核晚到不会让已写好的纪要失效。

## 开关、费用和数据

- `/var/lib/oops/backend.env` 里设置 `MIMO_API_KEY` 才开启；可选 `MIMO_BASE_URL`、`MIMO_ASR_MODEL`。
  `/healthz` 的 `asr_review` 显示是否开启。删掉这一行并重启后端即关闭。
- 上限：每场会 `OOPS_ASR_REVIEW_MEETING_S`（默认 7200 秒音频），每天 `OOPS_ASR_REVIEW_DAILY_S`（默认 14400 秒），
  请求前先占用额度（`state/asr-review-usage.json`）。少于 0.6 秒的句子不读。连续 5 句失败就停。
- 结果存在该场录音目录 `asr_review.json`（0600）：会议删除时随录音目录删除；转写到期时随转写文件一起删除
  （`recordings.DERIVED_TRANSCRIPT_FILES`）；音频或转写不可用时不再提供参考。
- 请求失败只记录 HTTP 状态码，不记录请求体（里面有 key）。

## 实测

0236 前 4 分钟，12 句（多为 12–20 秒的长句），并发 4，13 秒读完。

代码：`scripts/asr_review.py`；接入点 `FeishuActions.tick_meeting` / `analyse` / `transcript`；测试 `scripts/test_asr_review.py`。
