import type { AppData, Memory, Session, Task } from './store';
import type { SessionReviewItem } from './sessionLogic';
import { provenanceAvailable, sessionVisible, sourceAvailable, taskVisible } from './sourceAccess';
import { readSessionIntelligence } from './sessionIntelligenceLogic';

export type ProjectDecision = { session: Session; item: SessionReviewItem };
export function projectMemorySummary(data: AppData, projectId: string) {
  const personal = data.settings.space === '我的空间';
  const project = data.projects.find(item => item.id === projectId);
  if (!project || !personal && (data.settings.retention['project-space:' + project.id] || 'Oops 产品团队') !== data.settings.space) return { sessions: [] as Session[], decisions: [] as ProjectDecision[], tasks: [] as Task[] };
  const sessions = data.sessions.filter(session => session.project === project.name && sessionVisible(data, session.id));
  const sessionIds = new Set(sessions.map(session => session.id));
  const decisions = sessions.flatMap<ProjectDecision>(session => {
    let items: SessionReviewItem[] = [];
    try { const parsed: unknown = JSON.parse(data.settings.retention['session-review-items:' + session.id] || '[]'); if (Array.isArray(parsed)) items = parsed; } catch { /* Unreadable records cannot be confirmed. */ }
    // A newly accepted item can already be valid while another result in the
    // same session still needs review. Check its own captured evidence instead
    // of using the session-wide dirty flag as its confirmation state.
    const scoped = personal ? data : { ...data, settings: { ...data.settings, space: '我的空间' } };
    const currentDecisions = readSessionIntelligence(scoped, session.id, 'decisions').items;
    const currentConfirmation = (item: SessionReviewItem) => {
      if (item.id.startsWith('intelligence-conclusion:')) return currentDecisions.some(value => `intelligence-conclusion:${value.id}` === item.id && value.state === 'accepted' && value.text === item.text && value.sources.some(ref => ref.kind === 'session' && ref.id === session.id && ref.sourceId === item.sourceId));
      // Legacy manual rows have no source fingerprint. A changed session needs
      // explicit manual re-confirmation before these old bodies can reappear.
      return !data.settings.toggles['review-' + session.id];
    };
    return items.filter(item => item && typeof item.id === 'string' && item.kind === 'conclusion' && item.confirmed === true && typeof item.text === 'string' && item.text.trim() && currentConfirmation(item) && (personal || item.shared === true) && (item.sourceId === undefined || typeof item.sourceId === 'string' && sourceAvailable(data, { sourceSession: session.id, sourceId: item.sourceId }, { publicOnly: !personal, requireShared: !personal }))).map(item => ({ session, item }));
  });
  const belongs = (memory: Memory) => !memory.deleted && (memory.tags.includes(project.name) || !!memory.sourceSession && sessionIds.has(memory.sourceSession)) && provenanceAvailable(data, [{ kind: 'memory', id: memory.id }]);
  const tasks = data.tasks.filter(task => {
    const linked = !!task.sourceSession && sessionIds.has(task.sourceSession) || !!task.relatedSessionId && sessionIds.has(task.relatedSessionId) || !!task.sourceMemoryId && data.memories.some(memory => memory.id === task.sourceMemoryId && belongs(memory)) || task.sources?.some(ref => ref.kind === 'session' && sessionIds.has(ref.id) || ref.kind === 'memory' && data.memories.some(memory => memory.id === ref.id && belongs(memory)) || ref.kind === 'project' && ref.id === project.id);
    return !!linked && taskVisible(data, task) && provenanceAvailable(data, task.sources) && (!task.sourceMemoryId || provenanceAvailable(data, [{ kind: 'memory', id: task.sourceMemoryId }]));
  });
  return { sessions, decisions, tasks };
}
