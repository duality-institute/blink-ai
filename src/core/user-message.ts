import { z } from "zod";

export const MAX_USER_MESSAGE_LENGTH = 16_000;
export const UserMessageSchema = z.string().max(MAX_USER_MESSAGE_LENGTH);
export const OptionalUserMessageSchema = z.preprocess(
  (value) => value === null || (typeof value === "string" && value.trim() === "")
    ? undefined : typeof value === "string" ? value.replace(/\r\n/g, "\n") : value,
  UserMessageSchema.transform((value) => value.trim()).optional(),
);
