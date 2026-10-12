import type { AssistantMessage } from './store';

/** Bind each answer to its own question, including persisted pre-binding messages. */
export function assistantQuestion(messages: AssistantMessage[], answer: AssistantMessage): AssistantMessage | undefined {
  const index = messages.findIndex(message => message.id === answer.id);
  if (answer.role !== 'assistant' || index < 0) return undefined;
  const preceding = messages.slice(0, index).filter(message => message.role === 'user' && (message.space || '我的空间') === (answer.space || '我的空间'));
  return answer.replyToId !== undefined ? preceding.find(message => message.id === answer.replyToId) : preceding[preceding.length - 1];
}

/** Navigation can interrupt local processing; the unanswered question stays retryable. */
export function unansweredAssistantQuestion(messages: AssistantMessage[]): AssistantMessage | undefined {
  const question = [...messages].reverse().find(message => message.role === 'user');
  return question && !messages.some(answer => answer.role === 'assistant' && assistantQuestion(messages, answer)?.id === question.id) ? question : undefined;
}
