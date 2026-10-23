import type { Payload } from "./schema.ts";

/** Outcome of the rate-limit stage for a single message. */
export type RateLimitDecision = "accept" | "drop";

/**
 * Reason recorded alongside a {@link RateLimitDecision}.
 *
 * `kv_error` is used for the fail-open path: the message was accepted only
 * because the rate-limit counters could not be read, and the outage is
 * surfaced in the log rather than dropping legitimate pages.
 */
export type RateLimitViolation =
  | "none"
  | "hour"
  | "day"
  | "lifetime"
  | "kv_error";

/**
 * Outcome of the AI moderation stage for a single message.
 *
 * `error` is the fail-open path: Jev could not be asked (missing secret,
 * network error, timeout, 429/529, bad body) and the page was delivered
 * anyway, with the reason kept in `ai_reason`.
 */
export type AiDecision = "accept" | "drop" | "error";

/** What the AI stage writes to the log row; see migration 0002 for columns. */
export interface AiRecord {
  decision: AiDecision;
  /** P(spam) + P(gibberish). */
  dropProbability?: number;
  hijack?: number;
  kind?: "page" | "joke" | "gibberish" | "spam";
  kindConfidence?: number;
  model?: string;
  /** Drop reason, or the error text on the fail-open path. */
  reason?: string;
  urgency?: number;
}

/** Terminal disposition of a message after all pipeline stages have run. */
export type Result = "dropped" | "delivered" | "failed";

/**
 * Columns written by the logging stage at the start of a message's
 * pipeline run.
 *
 * The `id` is the queue message id, which is reused as the log row's
 * primary key so later stages can update the same row.
 */
export type InsertLogRow = Pick<Payload, "contact" | "message" | "channel"> & {
  id: string;
  source: string | undefined;
};

/**
 * Write the initial log row for a message.
 *
 * Called by the logging stage before any decision is made, so every page
 * is visible in the audit table even if a later stage fails or the worker
 * itself crashes.
 *
 * @param env - Worker environment exposing the `DB` binding (D1).
 * @param row - The row to insert.
 */
export async function insertLogRow(env: Env, row: InsertLogRow): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO log (id, contact, message, channel, source) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(row.id, row.contact, row.message, row.channel, row.source ?? null)
    .run();
}

/**
 * Persist the rate-limit stage's verdict for a message.
 *
 * When `result` is supplied the row's terminal `result` column is set at the
 * same time, which is used when a rate-limit drop is the final outcome of
 * the pipeline.
 *
 * @param env - Worker environment exposing the `DB` binding.
 * @param id - Message id (also the log row primary key).
 * @param decision - Whether the message was accepted or dropped.
 * @param violation - Specific reason for the decision.
 * @param result - Set to `"dropped"` to also record the terminal outcome.
 */
export async function updateRateLimit(
  env: Env,
  id: string,
  decision: RateLimitDecision,
  violation: RateLimitViolation,
  result?: "dropped"
): Promise<void> {
  if (result !== undefined) {
    await env.DB.prepare(
      "UPDATE log SET rate_limit_decision = ?, rate_limit_violation = ?, result = ? WHERE id = ?"
    )
      .bind(decision, violation, result, id)
      .run();
    return;
  }
  await env.DB.prepare(
    "UPDATE log SET rate_limit_decision = ?, rate_limit_violation = ? WHERE id = ?"
  )
    .bind(decision, violation, id)
    .run();
}

/**
 * Persist the AI moderation stage's verdict for a message.
 *
 * Mirrors {@link updateRateLimit}: pass `result` only when an AI drop is
 * the message's terminal disposition.
 *
 * @param env - Worker environment exposing the `DB` binding.
 * @param id - Message id (also the log row primary key).
 * @param record - The verdict and the Jev answers behind it.
 * @param result - Set to `"dropped"` to also record the terminal outcome.
 */
export async function updateAi(
  env: Env,
  id: string,
  record: AiRecord,
  result?: "dropped"
): Promise<void> {
  const binds = [
    record.decision,
    record.kind ?? null,
    record.kindConfidence ?? null,
    record.dropProbability ?? null,
    record.hijack ?? null,
    record.urgency ?? null,
    record.model ?? null,
    record.reason ?? null,
  ];
  const columns =
    "ai_decision = ?, ai_kind = ?, ai_kind_confidence = ?, ai_drop_probability = ?, " +
    "ai_hijack = ?, ai_urgency = ?, ai_model = ?, ai_reason = ?";
  if (result !== undefined) {
    await env.DB.prepare(`UPDATE log SET ${columns}, result = ? WHERE id = ?`)
      .bind(...binds, result, id)
      .run();
    return;
  }
  await env.DB.prepare(`UPDATE log SET ${columns} WHERE id = ?`)
    .bind(...binds, id)
    .run();
}

/**
 * Persist the delivery stage's outcome.
 *
 * Always sets the terminal `result` column — delivery is the last stage in
 * the pipeline, so there is no later writer to defer to.
 *
 * @param env - Worker environment exposing the `DB` binding.
 * @param id - Message id (also the log row primary key).
 * @param adapter - The {@link Adapter.name} that handled the delivery.
 * @param result - Terminal disposition (`"delivered"`, `"failed"`, ...).
 * @param reason - Optional free-form reason; persisted as `result_reason`.
 */
export async function updateDelivery(
  env: Env,
  id: string,
  adapter: string,
  result: Result,
  reason?: string
): Promise<void> {
  await env.DB.prepare(
    "UPDATE log SET adapter = ?, result = ?, result_reason = ? WHERE id = ?"
  )
    .bind(adapter, result, reason ?? null, id)
    .run();
}
