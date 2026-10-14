"""Conservative, source-bound checks on model item candidates; never a human verdict.

No model calls, storage or automatic correction. Ambiguous quantities remain
questions for a person, and examples do not become executable meeting tasks.
"""
import re


_EXAMPLE = re.compile(r'举(?:个)?例(?:子)?|例如|比如|比方|假设|假如|设想(?:一下)?')
_RESET = re.compile(r'回到(?:这次|当前|实际)|实际(?:安排|执行|要做)|具体(?:任务|安排)|'
                    r'另外|但(?:是)?这次|这次(?:由|我|我们|你)|'
                    r'(?:今天|明天|后天|本周|周[一二三四五六日天])(?:我|我们|由|你)')
_CONDITION = re.compile(r'如果|只要|一旦|要是')
_PRINCIPLE = re.compile(r'(?:有|发现)(?:什么|任何)?问题.{0,12}(?:说|沟通|反馈|提出来)|'
                        r'(?:不要|别).{0,12}卡壳|保持.{0,8}沟通|及时沟通|随时(?:沟通|联系)|'
                        r'提高效率|继续努力|多想想|要更努力')
_SPECIFIC = re.compile(r'合同|发票|报告|方案|接口|邮件|客户|服务器|测试|登录|清单|代码|仓库|PR|账号|申请|资料|会议纪要', re.I)
_ACTION_GROUPS = ('买 购买 采购', '发 发送 发给 提交 上传', '做 完成 制作', '修复 修改 更新 迭代 重启',
                  '问 联系 沟通 反馈', '列 整理', '负责 跟进 处理', '开发 实现 打通',
                  '申请 注册', '测试 验证', '订 预订', '叠 合并', '设计')
_ACTIONS = sorted({word for group in _ACTION_GROUPS for word in group.split()}, key=len, reverse=True)
_ACTION = '(?:' + '|'.join(_ACTIONS) + ')'
_NEGATIVE = re.compile(r'(?:不用|无需|不需要|不再|不要|别|取消|暂缓|先不|不能|不|没)(?:再|去|来)?' + _ACTION +
                       r'|不是我(?:来)?负责|' + _ACTION + r'(?:不(?:了|到|完)|不了)')
_PAST = re.compile(r'已经|已|刚刚|刚才|上次|昨天|曾经')
_FUTURE = re.compile(r'明天|后天|本周|下周|周[一二三四五六日天]|接下来|(?:我|我们)(?:会|来|负责)|再(?:做|发|修|提|更新)')
_PLEDGE = re.compile(r'(?:我|我们|林春源|洪玉麟|江古月|黄丽萍)(?:今天|明天|后天|这边)?'
                     r'(?:会|来|负责|就|先|马上|立即|立马|再|把).{0,20}' + _ACTION)
_QUANTITY = re.compile(r'(?<![A-Za-z0-9])(?P<number>\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+)'
                       r'\s*(?P<unit>个星期|个礼拜|个小时|版本|星期|礼拜|小时|分钟|个月|万元|元|版|份|台|套|次|天|周|月|年|个|张|万|%)?')
_DIGITS = {'零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
           '六': 6, '七': 7, '八': 8, '九': 9}
_UNITS = {'十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000}


def _number(value):
    if re.fullmatch(r'\d+(?:\.\d+)?', value):
        return str(float(value)).removesuffix('.0')
    total, section, digit = 0, 0, 0
    for char in value:
        if char in _DIGITS:
            digit = _DIGITS[char]
        else:
            unit = _UNITS[char]
            if unit < 10000:
                section += (digit or 1) * unit
            else:
                total += (section + digit) * unit
                section = 0
            digit = 0
    return str(total + section + digit)


def quantities(text):
    out = []
    for match in _QUANTITY.finditer(text or ''):
        number, unit = match.group('number'), match.group('unit') or ''
        # "一样/一下/一起" and P0/3D are words or identifiers, not quantities.
        if (not unit and len(number) == 1 and not number.isdigit()
                or not unit and re.match(r'[A-Za-z]', (text or '')[match.end():])):
            continue
        value = _number(number)
        unit = {'版本': '版', '个月': '月', '个星期': '周', '星期': '周', '个礼拜': '周',
                '礼拜': '周', '个小时': '小时'}.get(unit, unit)
        noun = (text or '')[match.end():].lstrip()
        # Ordinary Chinese counters vary for the same explicitly named object.
        # This does not equate semantic units such as 100 versions / 100 reports.
        if unit in ('个', '张') and re.match(r'表(?:格)?', noun):
            unit = '表'
        if unit == '万元':
            value, unit = str(float(value) * 10000).removesuffix('.0'), '元'
        elif unit == '万':
            value, unit = str(float(value) * 10000).removesuffix('.0'), ''
        out.append((value, unit))
    return out


def _clauses(text):
    return [(match.start(), match.group().strip())
            for match in re.finditer(r'[^，,。！？!?；;\n]+', text or '') if match.group().strip()]


def _relevant(title, clauses):
    groups = [group.split() for group in _ACTION_GROUPS if any(word in title for word in group.split())]
    matches = [(offset, clause) for offset, clause in clauses
               if any(any(word in clause for word in group) for group in groups)]
    return matches or clauses


def _completed(title, clause):
    groups = [group.split() for group in _ACTION_GROUPS if any(word in title for word in group.split())]
    actions = sorted({word for group in groups for word in group}, key=len, reverse=True) or _ACTIONS
    for action in re.finditer('|'.join(actions), clause):
        prefix = clause[:action.start()]
        # "把昨天整理的报告发给客户" describes the report's history, not
        # completion of the requested send. "下班之前" is also a deadline.
        prefix = re.sub(r'(?:已经|已|刚刚|刚才|上次|昨天|曾经).{0,16}?的', '', prefix)
        if _PAST.search(prefix[-12:]) or re.match(r'(?:好了|完了|完成了|过了|过|了)', clause[action.end():]):
            return True
    return False


def _source_states(title, evidence, context):
    originals = {row['id']: row['text'] for row in context if isinstance(row, dict)
                 and isinstance(row.get('id'), str) and isinstance(row.get('text'), str)}
    states = []
    for row in evidence:
        if row.get('support_only'):
            continue  # a resolved noun is not independent evidence of a commitment
        text = row['text']
        original = originals.get(row['id'], text)
        position = original.find(text)
        selected = _relevant(title, _clauses(text))
        example = False
        # A short quoted task inherits the local example scope from its full source.
        if position > 0:
            prefix = original[:position][-500:]
            for _, clause in _clauses(prefix):
                if _EXAMPLE.search(clause):
                    example = True
                elif _RESET.search(clause):
                    example = False
        offsets = {offset for offset, _ in selected}
        condition = False
        for offset, clause in _clauses(text):
            if _EXAMPLE.search(clause):
                example = True
            elif _RESET.search(clause):
                example = False
            if _CONDITION.search(clause):
                condition = True
            if offset not in offsets:
                continue
            if example:
                reason = 'example_or_hypothesis'
            elif _NEGATIVE.search(clause):
                reason = 'negated_or_cancelled'
            elif _completed(title, clause) and not _FUTURE.search(clause):
                reason = 'already_completed'
            elif _PRINCIPLE.search(clause) and not _SPECIFIC.search(title):
                reason = 'generic_principle'
            elif condition and not (_PLEDGE.search(clause) or _FUTURE.search(clause)):
                reason = 'conditional_commitment_unconfirmed'
            else:
                reason = None
            states.append(reason)
    return states


def bounded_context(rows, ids, limit=16):
    """Only local neighbours of cited rows; unrelated meeting totals are not proof."""
    rows = [row for row in rows or [] if isinstance(row, dict) and isinstance(row.get('text'), str)]
    positions = [i for i, row in enumerate(rows) if row.get('id') in ids]
    if not positions:
        return []
    chosen = set(positions[:limit])
    for distance in (1, 2, 3):
        for i in positions:
            for near in (i - distance, i + distance):
                if 0 <= near < len(rows) and len(chosen) < limit:
                    chosen.add(near)
    return [rows[i] for i in sorted(chosen)]


def assess_item(title, evidence, context=(), kind='task', detail=''):
    """Return accepted/rejected/needs_review + reason + exact evidence ids.

    Evidence may mark a verified pronoun-resolution quote ``support_only=True``:
    it supports names/numbers but cannot turn an example into a real commitment.
    ``accepted`` only means these deterministic checks found no contradiction;
    it never confirms a person, owner or a model's proposal on someone's behalf.
    """
    rows = [row for row in evidence or [] if isinstance(row, dict)
            and isinstance(row.get('id'), str) and isinstance(row.get('text'), str) and row['text'].strip()]
    ids = list(dict.fromkeys(row['id'] for row in rows))
    def result(status, reason, **extra):
        return dict(status=status, reason=reason, ids=ids, **extra)
    if not rows:
        return result('needs_review', 'evidence_missing')
    context = bounded_context(context, ids)
    title = str(title or '')
    if _PRINCIPLE.search(title) and not _SPECIFIC.search(title):
        return result('rejected', 'generic_principle')
    if kind in ('task', 'action', 'commitment', 'open'):
        states = _source_states(title, rows, context)
        if states and all(reason is not None for reason in states):
            if 'conditional_commitment_unconfirmed' in states:
                return result('needs_review', 'conditional_commitment_unconfirmed')
            return result('rejected', states[0])
    source = '\n'.join(row['text'] for row in rows)
    nearby = source + '\n' + '\n'.join(row.get('text', '') for row in context
                                       if isinstance(row, dict))
    proposed = quantities(title + ' ' + str(detail or ''))
    supported = quantities(source)
    # Do not silently resolve the observed ASR homophone: both interpretations
    # remain visible for listening, even if the model chose one of them.
    if (proposed and '一百' in source and '一版' in nearby
            and any(n == '100' and u in ('', '版') for n, u in supported)
            and re.search(r'版|代码|叠|合并|迭代|上传', title + source + nearby)):
        return result('needs_review', 'quantity_ambiguity', issues=['原话“一百／一版”混用，需回听核对'])
    for number, unit in proposed:
        if (number, unit) in supported:
            continue
        same_number = [u for n, u in supported if n == number]
        if unit and same_number:
            return result('needs_review', 'quantity_unit_conflict', issues=['候选数字的单位没有相符原话'])
        if not unit and same_number:
            continue
        return result('needs_review', 'unsupported_quantity', issues=['候选新增了原话未核对的数字或单位'])
    return result('accepted', 'supported_candidate')
