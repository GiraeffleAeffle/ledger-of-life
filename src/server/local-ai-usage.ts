/** Host-reported generated tokens, bounded by the job and UTF-8 text actually received. */
export function boundedOutputTokens(reported: unknown, maximum: number, answer: string, reasoning: unknown): number | null {
  if (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) return null;
  return Math.min(reported, maximum, Buffer.byteLength(answer, 'utf8') + (typeof reasoning === 'string' ? Buffer.byteLength(reasoning, 'utf8') : 0));
}
