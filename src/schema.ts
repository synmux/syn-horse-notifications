import { z } from "zod";

/* example message

{
  "channel": "red",
  "contact": "alerts@example.com",
  "message": "Need your help! Site is down.",
  "source": "monitoring.example.com"
}

*/

/**
 * RFC 1123 hostname matcher.
 *
 * Allows labels up to 63 characters, total length up to 253, and rejects
 * leading/trailing hyphens. Used to validate `source` when it is neither
 * an IPv4 nor IPv6 literal.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/u;

/**
 * Zod schema for an inbound page message arriving on the queue.
 *
 * `strictObject` is used deliberately: unknown fields surface as parse
 * errors rather than being silently ignored, which would otherwise mask
 * upstream contract drift.
 */
export const messageSchema = z.strictObject({
  channel: z.enum(["red", "green"]),
  contact: z.string().trim().min(1).max(256),
  message: z.string().trim().min(1).max(8192),
  source: z
    .union([z.ipv4(), z.ipv6(), z.string().regex(HOSTNAME_RE)])
    .optional(),
});

/** A validated inbound page message. */
export type Payload = z.infer<typeof messageSchema>;

/**
 * Parse and validate a message payload, throwing on failure.
 *
 * @param input - The raw payload as decoded from the queue message body.
 * @returns The validated {@link Payload}.
 * @throws {z.ZodError} If the payload does not match {@link messageSchema}.
 */
export function parseMessage(input: unknown): Payload {
  return messageSchema.parse(input);
}

/**
 * Parse and validate a message payload, returning a discriminated result.
 *
 * Prefer this over {@link parseMessage} in the queue handler: a malformed
 * message can then be acknowledged and logged rather than escalating to a
 * retry that will fail forever.
 *
 * @param input - The raw payload to validate.
 * @returns A Zod `SafeParseResult` carrying either the parsed data or the
 *   validation error.
 */
export function safeParseMessage(input: unknown) {
  return messageSchema.safeParse(input);
}

/**
 * Type guard narrowing `unknown` to {@link Payload}.
 *
 * @param input - Candidate payload.
 * @returns `true` when the payload satisfies {@link messageSchema}.
 */
export function isMessage(input: unknown): input is Payload {
  return messageSchema.safeParse(input).success;
}

/**
 * Build a single-line, log-friendly summary of a message.
 *
 * The body is truncated at 60 characters (57 + `"..."`) so a log line stays
 * within typical viewer widths even when the original page is close to the
 * 8192-character upper bound.
 *
 * @param message - The validated message to summarise.
 * @returns A human-readable summary including contact, optional source,
 *   and a truncated body.
 */
export function formatMessageSummary(payload: Payload): string {
  const truncated =
    payload.message.length > 60
      ? `${payload.message.slice(0, 57)}...`
      : payload.message;
  const via = payload.source ? ` via ${payload.source}` : "";
  return `page from ${payload.contact}${via}: ${truncated}`;
}

export default {
  formatMessageSummary,
  isMessage,
  messageSchema,
  parseMessage,
  safeParseMessage,
};
