import type { AppData, Memory, Session, Transcript } from './store';

type SourcedMemory = Memory & { sourceId?: string; needsReview?: boolean; private?: boolean; archivedAt?: string };
type CurrentSource = Transcript & { deleted?: boolean; discarded?: boolean };
type CurrentSession = Session & { deleted?: boolean; discarded?: boolean };

/** Content eligibility only. Callers also enforce the explicitly shared space. */
export function sharedMemoryEligible(data: AppData, item: Memory): boolean {
  const memory = item as SourcedMemory;
  if (memory.deleted || memory.private || !memory.confirmed || memory.needsReview || memory.archivedAt || memory.tags.some(tag => ['修订历史', '待复核', '待确认'].includes(tag))) return false;

  const sessionId = memory.sourceSession?.trim();
  const declaredSourceId = memory.sourceId !== undefined;
  const sourceId = memory.sourceId?.trim();
  const sourceTime = memory.sourceTime?.trim();
  // A manually written, confirmed entry has no conversation provenance to revoke.
  if (!sessionId) return !declaredSourceId && !sourceTime;
  const session = data.sessions.find(source => source.id === sessionId) as CurrentSession | undefined;
  if (!session || session.deleted || session.discarded) return false;

  // A declared ID cannot fall back to another turn with a matching timestamp.
  if (declaredSourceId || sourceTime) {
    const sources = session.transcript.filter(turn => declaredSourceId ? !!sourceId && turn.id === sourceId : turn.time === sourceTime) as CurrentSource[];
    if (!sources.length || sources.some(source => source.private || source.deleted || source.discarded)) return false;
  } else if (session.transcript.some(turn => turn.private || (turn as CurrentSource).deleted || (turn as CurrentSource).discarded)) {
    // Older whole-conversation entries cannot prove which private turn they contain.
    return false;
  }

  const material = memory.tags.includes('资料') || memory.tags.includes('会中检索') || session.attachments.includes(memory.title) || data.settings.toggles['material-shared:' + session.id + ':' + memory.title] !== undefined;
  return !material || session.attachments.includes(memory.title);
}
