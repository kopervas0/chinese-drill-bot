// Счётчик работ по темам форума. Живёт только в памяти процесса —
// при рестарте бота обнуляется (осознанно, без хранения на диске).
// Ключ — чат + тема: номера тем в разных группах совпадают.
const topicCounts = new Map<string, number>();
const MAX_TOPICS = 5000;

const key = (chatId: number, topicId: number): string => `${chatId}:${topicId}`;

export function increment(chatId: number, topicId: number): number {
  const k = key(chatId, topicId);
  const next = (topicCounts.get(k) ?? 0) + 1;
  topicCounts.set(k, next);
  // защита от неограниченного роста памяти: вытесняем самую старую запись
  if (topicCounts.size > MAX_TOPICS) {
    const oldest = topicCounts.keys().next().value as string;
    topicCounts.delete(oldest);
  }
  return next;
}

export function reset(chatId: number, topicId: number): void {
  topicCounts.delete(key(chatId, topicId));
}
