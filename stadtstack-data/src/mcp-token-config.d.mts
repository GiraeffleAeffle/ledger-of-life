export interface TokenLimits {
  readonly requestsPerMinute: number;
  readonly maxConcurrent: number;
}
export interface TokenHashRecord {
  id: string;
  sha256: string;
  limits?: TokenLimits;
}
export const DEFAULT_TOKEN_LIMITS: Readonly<TokenLimits>;
export const MAX_TOKEN_LIMITS: Readonly<TokenLimits>;
export function validateTokenRecords(value: unknown, options?: { allowEmpty?: boolean }): TokenHashRecord[];
