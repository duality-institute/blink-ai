import { z } from "zod";
import type { AnswerUsage } from "../core/answer-client";

const UsageInfoSchema = z
  .object({
    tokens: z.object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      reasoning: z.number().nonnegative().default(0),
      cache: z
        .object({
          read: z.number().nonnegative().default(0),
          write: z.number().nonnegative().default(0),
        })
        .default({ read: 0, write: 0 }),
    }),
    cost: z.number().nonnegative().default(0),
  })
  .loose();

export function usageFromMessageInfo(info: unknown): AnswerUsage | undefined {
  const parsed = UsageInfoSchema.safeParse(info);
  if (!parsed.success) return undefined;
  const { tokens, cost } = parsed.data;
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
    cost,
  };
}
