/** Shared API/UI bounds. Model servers may support smaller budgets. */
export const MODEL_TOKEN_LIMITS = {
  contextWindow: { min: 2 ** 11, max: 2 ** 21 },
  maxOutputTokens: { min: 2 ** 7, max: 2 ** 20 },
} as const;
