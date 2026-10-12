import type { Session } from './store';

export type BudgetEvidence = { sourceId: string; time: string; speaker: string; text: string; amount: number };

/** Convert explicit Chinese or numeric money quantities into a finite base number. */
export function parseBudgetNumber(value: string): number | undefined {
  const numeric = value.replace(/,/g, '');
  if (/^\d+(?:\.\d+)?$/.test(numeric)) return Number(numeric);
  if (!/^[零〇一二两三四五六七八九十百千万亿]+$/.test(value)) return undefined;
  const digit: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千万亿]/.test(value)) return Number([...value].map(char => digit[char]).join(''));
  let total = 0, section = 0, number = 0;
  for (const char of value) {
    if (char in digit) number = digit[char];
    else if (char === '万') { total += (section + number || 1) * 10000; section = 0; number = 0; }
    else if (char === '亿') { total = (total + section + number || 1) * 100000000; section = 0; number = 0; }
    else { const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char]; section += (number || 1) * unit; number = 0; }
  }
  return total + section + number;
}

/** Explicit money only: do not infer totals or treat a stated budget ceiling as spending. */
export function budgetAmounts(text: string, options: { includeBaseline?: boolean } = {}): number[] {
  const context = /预算|费用|金额|支出|成本|总计|合计|加起来|花费|报价|价格|付款|支付|采购/;
  if (!context.test(text)) return [];
  const amounts: number[] = [];
  // Preserve thousands separators while separating a stated baseline from actual expenses.
  for (const clause of text.split(/[，。；;！？!?\n]|(?<!\d),|,(?!\d)/)) {
    const spending = /费用|金额|支出|成本|总计|合计|加起来|花费|报价|价格|付款|支付|采购/.test(clause);
    const changedBudget = /改为|改成|调整|提高|增加|申请|计划|拟|建议|需要|希望|先按/.test(clause);
    if (!options.includeBaseline && /预算|限额/.test(clause) && !spending && !changedBudget) continue;
    for (const match of clause.matchAll(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+)\s*(亿元|亿|万元|万|元)/g)) {
      const base = parseBudgetNumber(match[1]);
      const multiplier = match[2] === '亿元' || match[2] === '亿' ? 100000000 : match[2] === '万元' || match[2] === '万' ? 10000 : 1;
      const amount = base === undefined ? NaN : base * multiplier;
      if (Number.isFinite(amount) && amount > 0) amounts.push(amount);
    }
  }
  return [...new Set(amounts)];
}

/** The amount-checking page includes stated baselines so the user can compare every explicit amount. */
export function budgetEvidence(session: Pick<Session, 'transcript'>, publicOnly = false): BudgetEvidence[] {
  return session.transcript.filter(turn => !publicOnly || !turn.private).flatMap(turn => budgetAmounts(turn.text, { includeBaseline: true }).map(amount => ({ sourceId: turn.id, time: turn.time, speaker: turn.speaker, text: turn.text, amount })));
}
