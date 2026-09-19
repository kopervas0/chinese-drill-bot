// Счётчик работ по темам форума. Живёт только в памяти процесса —
// при рестарте бота обнуляется (осознанно, без хранения на диске).
const topicCounts = new Map<number, number>();

export function increment(topicId: number): number {
  const next = (topicCounts.get(topicId) ?? 0) + 1;
  topicCounts.set(topicId, next);
  return next;
}

export function getCount(topicId: number): number {
  return topicCounts.get(topicId) ?? 0;
}

export function reset(topicId: number): void {
  topicCounts.delete(topicId);
}
