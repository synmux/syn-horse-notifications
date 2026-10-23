import { z } from "zod";

/** TypeSafe System One endpoint. */
const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

/** How long a single Jev request may take before it is abandoned. */
const DEFAULT_TIMEOUT_MS = 5000;

/** How much of an error body to keep in the thrown error's message. */
const ERROR_BODY_EXCERPT = 200;

const choiceAnswerSchema = z.object({
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
  type: z.literal("choice"),
});

const noulAnswerSchema = z.object({
  noul: z.number(),
  type: z.literal("noul"),
});

const scoreAnswerSchema = z.object({
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
  score: z.number(),
  type: z.literal("score"),
});

const answerSchema = z.discriminatedUnion("type", [
  choiceAnswerSchema,
  noulAnswerSchema,
  scoreAnswerSchema,
]);

/** Response body of `POST /v1/systemone`, reduced to the fields we read. */
const jevResponseSchema = z.looseObject({
  answers: z.record(z.string(), answerSchema),
  model: z.string(),
  usage: z
    .looseObject({ input_tokens: z.number(), output_tokens: z.number() })
    .optional(),
});

export type JevAnswer = z.infer<typeof answerSchema>;
export type JevChoiceAnswer = z.infer<typeof choiceAnswerSchema>;
export type JevNoulAnswer = z.infer<typeof noulAnswerSchema>;
export type JevScoreAnswer = z.infer<typeof scoreAnswerSchema>;
export type JevResponse = z.infer<typeof jevResponseSchema>;

/**
 * Any failure to get a valid answer out of Jev: missing key, network error,
 * timeout, non-2xx status, or a body that does not match the answer schema.
 * `status` is set when the API answered at all.
 */
export class JevError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, { cause: options?.cause });
    this.name = "JevError";
    this.status = options?.status;
  }
}

export interface AskJevInput {
  apiKey: string | undefined;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  model: string;
  /** Raw question objects as the HTTP API expects them. */
  questions: Record<string, unknown>;
  state: unknown;
  timeoutMs?: number;
}

/**
 * Send one System One request and return its validated answers.
 *
 * No retries here on purpose: the caller decides what a failure means
 * (the moderation stage fails open). Every failure path throws
 * {@link JevError} so the caller has a single thing to catch.
 */
export async function askJev(input: AskJevInput): Promise<JevResponse> {
  if (!input.apiKey) {
    throw new JevError("TYPESAFE_API_KEY is not set");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(SYSTEM_ONE_URL, {
      body: JSON.stringify({
        model: input.model,
        questions: input.questions,
        state: input.state,
      }),
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new JevError(`Jev request failed: ${reason}`, { cause });
  }

  if (!response.ok) {
    const excerpt = (await response.text()).slice(0, ERROR_BODY_EXCERPT);
    throw new JevError(`Jev responded ${response.status}: ${excerpt}`, {
      status: response.status,
    });
  }

  const parsed = jevResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new JevError(
      `Jev response did not match schema: ${parsed.error.message}`,
      {
        cause: parsed.error,
        status: response.status,
      }
    );
  }
  return parsed.data;
}
