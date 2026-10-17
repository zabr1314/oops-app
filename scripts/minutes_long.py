"""Opt-in, source-complete minutes parts. No model, network, cache or external writes.

Parts are processing boundaries, never independent votes. Their conclusions stay
unconfirmed because a later part can qualify, contradict or withdraw an earlier one.
"""
import os

from minutes_model import MinutesModelError


class LongMinutesError(MinutesModelError):
    def __init__(self, reason, message):
        self.reason = reason
        super().__init__(message)


def settings():
    """Unset/zero preserves the existing full-input path and number of calls."""
    value = os.environ.get('OOPS_MINUTES_PART_CHARS', '').strip()
    if value in ('', '0'):
        return None
    try:
        budget = int(value)
        maximum = int(os.environ.get('OOPS_MINUTES_MAX_PARTS', '8'))
        if budget <= 0 or not 1 <= maximum <= 64:
            raise ValueError
    except ValueError:
        raise LongMinutesError('invalid_part_budget', '长会议分段预算无效；未发送纪要请求') from None
    return dict(chars=budget, max_parts=maximum)


def part_note(index, total):
    return (f'本次输入是同一长会议的第{index}/{total}段，不是整场会议。只整理本段，保留原话编号；'
            '本段决定、待办和安排仅为候选，其他段可能有条件、反对或撤回；不要声称已核对全场。\n\n')


def plan_parts(row, rendered, fixed_chars, config):
    """Preflight every whole utterance before any request; hints and headers count too."""
    if config is None:
        return None
    full_chars = fixed_chars + len('\n'.join(line for _, line in rendered))
    if full_chars <= config['chars']:
        return None
    reserve = fixed_chars + len(part_note(config['max_parts'], config['max_parts']))
    available = config['chars'] - reserve
    if available <= 0:
        raise LongMinutesError('part_budget_too_small', '纪要提示已超过分段预算；未发送纪要请求')
    parts, current, used = [], [], 0
    for utterance, line in rendered:
        if len(line) > available:
            raise LongMinutesError('single_utterance_exceeds_budget', '一条完整原话连同纪要提示已超过分段预算；未发送纪要请求，请先调整预算或核对原话')
        added = len(line) + (1 if current else 0)
        if current and used + added > available:
            parts.append(current)
            current, used, added = [], 0, len(line)
        current.append(utterance)
        used += added
    if current:
        parts.append(current)
    if len(parts) > config['max_parts']:
        raise LongMinutesError('too_many_parts', '完整会议所需分段超过本场上限；未发送纪要请求，不能只处理前几段')
    if not parts:
        raise LongMinutesError('part_budget_too_small', '纪要提示已超过分段预算；未发送纪要请求')
    return [dict(index=index, total=len(parts), utterances=part, chars=config['chars'],
                 note=part_note(index, len(parts))) for index, part in enumerate(parts, 1)]


def collect(results, parts, version):
    """One complete run: retain part provenance, demote every potentially cross-part conclusion."""
    if len(results) != len(parts):
        raise LongMinutesError('incomplete_part_run', '长会议分段尚未全部处理；不能发布部分纪要')
    out = dict(version=version, substantive=False, theme='长会议分段待核对', overview='',
               decisions=[], actions=[], topics=[], undecided=[], open_questions=[], follow_ups=[],
               segment_summaries=[], quality_rejected=[])
    for analysis, part in zip(results, parts):
        index, total = part['index'], part['total']
        ids = [utterance['id'] for utterance in part['utterances']]
        summary = dict(part=index, total=total, scope='segment_only', ids=ids,
                       start_ms=min(u['start_ms'] for u in part['utterances']),
                       end_ms=max(u['end_ms'] for u in part['utterances']),
                       theme=analysis.get('theme', ''), overview=analysis.get('overview', ''),
                       topics=analysis.get('topics') or [])
        out['segment_summaries'].append(summary)
        if summary['overview']:
            out['topics'].append(dict(topic=f'第{index}/{total}段概览（待全场核对）',
                                      points=[summary['overview']], ids=ids, part=index))
        out['topics'].extend(dict(topic=f"第{index}/{total}段 · {topic['topic']}",
                                  points=topic['points'], ids=topic.get('ids', []), part=index)
                             for topic in summary['topics'])
        groups = (('task', '待办候选', 'actions', 'task'), ('decision', '决定候选', 'decisions', 'text'),
                  ('schedule', '日程候选', 'follow_ups', 'title'), ('open', '待定事项', 'undecided', 'topic'),
                  ('question', '待查候选', 'open_questions', 'question'))
        for original_type, label, key, title_key in groups:
            for item in analysis.get(key) or []:
                evidence = item.get('ids') or ([item['id']] if item.get('id') else [])
                if not evidence or not item.get(title_key):
                    continue
                detail = '仅为本段候选；其他段可能已有回答、条件、冲突或撤回，须结合全场原话核对。'
                if original_type == 'task':
                    detail += f"负责人线索：{item.get('owner') or '未定'}；期限：{item.get('due') or '未定'}。"
                elif original_type == 'schedule':
                    detail += f"候选时间：{item.get('start')}；时长：{item.get('minutes')}分钟。"
                elif item.get('views'):
                    detail += str(item['views'])
                out['undecided'].append(dict(topic=f'第{index}段{label}：{item[title_key]}',
                    views=detail, ids=list(evidence), original_type=original_type, part=index,
                    requires_cross_part_review=True))
        out['quality_rejected'].extend(dict(item, part=index) for item in analysis.get('quality_rejected') or [])
        out['substantive'] = out['substantive'] or bool(analysis.get('substantive'))
        if analysis.get('generation_model'):
            out['generation_model'] = analysis['generation_model']
    count = sum(len(part['utterances']) for part in parts)
    out['overview'] = f'已完整处理{len(parts)}段、{count}句原话；以下为分段候选。跨段结论、条件、撤回与冲突仍须结合全场核对。'
    out['long_meeting'] = dict(mode='parts_review_only', source_complete=True, part_count=len(parts),
                               coverage_scope='available_transcript_utterances', utterance_count=count,
                               part_chars=parts[0]['chars'], cross_part_resolved=False)
    return out


def finish_vote(analysis, parts, runs):
    """The existing vote may combine source IDs; keep all contributing part numbers explicit."""
    for item in analysis.get('undecided') or []:
        ids = set(item.get('ids') or [])
        item['parts'] = [part['index'] for part in parts if ids.intersection(u['id'] for u in part['utterances'])]
    analysis['long_meeting']['complete_runs'] = runs
    # Do not inherit a single model's summary as a whole-meeting summary.
    count = analysis['long_meeting']['utterance_count']
    analysis['overview'] = f'已完整处理{len(parts)}段、{count}句原话，完成{runs}份独立全段处理后投票；跨段结论、条件、撤回与冲突仍须结合全场核对。'
    return analysis
