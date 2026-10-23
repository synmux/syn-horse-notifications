import { describe, expect, it } from "vitest";
import type { JevResponse } from "../src/jev.ts";
import type { Payload } from "../src/schema.ts";
import {
  buildModerationState,
  DROP_AT,
  decideModeration,
  HIJACK_AT,
  runAi,
} from "../src/stages/ai.ts";
import { CONTINUE, STOP } from "../src/stages/types.ts";
import fixtures from "./fixtures/jev-moderation.json" with { type: "json" };

type Fixture = (typeof fixtures)[keyof typeof fixtures];
type Channel = Payload["channel"];

/** Expected verdict for every recorded Jev response. */
const EXPECTED: Record<keyof typeof fixtures, "accept" | "drop"> = {
  alert_repeat_red: "accept",
  bare_test_red: "drop",
  birthday_green: "accept",
  cruise_red: "drop",
  fire_emoji_green: "accept",
  injection_red: "drop",
  locked_out_red: "accept",
  phishing_green: "drop",
  pricing_deploy_red: "accept",
  prompt_cat_green: "accept",
  prompt_cpu_red: "accept",
  prompt_db_down_red: "accept",
  prompt_mash_red: "drop",
  prompt_pills_green: "drop",
  spanish_mail_red: "accept",
  terse_disk_green: "accept",
};

function fixtureChannel(fixture: Fixture): Channel {
  return fixture.channel as Channel;
}

/** The JSON import widens `type` to string; the fixtures are real API bodies. */
function answersOf(fixture: Fixture): JevResponse["answers"] {
  return fixture.response.answers as JevResponse["answers"];
}

describe("decideModeration", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const fixture = fixtures[name as keyof typeof fixtures];
    it(`${expected}s ${name}`, () => {
      const verdict = decideModeration(
        answersOf(fixture),
        fixtureChannel(fixture)
      );
      expect(verdict.decision).toBe(expected);
    });
  }

  it("drops an injection attempt because of the hijack score, whatever the kind", () => {
    const verdict = decideModeration(answersOf(fixtures.injection_red), "red");
    expect(verdict.hijack).toBeGreaterThanOrEqual(HIJACK_AT);
    expect(verdict.reason).toContain("hijack");
  });

  it("keeps the kind, probabilities and urgency on the verdict", () => {
    const verdict = decideModeration(
      answersOf(fixtures.prompt_db_down_red),
      "red"
    );
    expect(verdict).toMatchObject({
      decision: "accept",
      dropProbability: 0,
      hijack: 0.02,
      kind: "page",
      kindConfidence: 1,
      urgency: 2,
    });
  });

  it("uses a lower drop threshold on red than on green", () => {
    expect(DROP_AT.red).toBeLessThan(DROP_AT.green);
    const answers = answersOf(fixtures.fire_emoji_green);
    expect(decideModeration(answers, "green").decision).toBe("accept");
    expect(decideModeration(answers, "red").decision).toBe("drop");
  });
});

describe("buildModerationState", () => {
  it("sends only the channel and message beside the context block", () => {
    const state = buildModerationState({
      channel: "red",
      contact: "ops@example.com",
      message: "db down",
      source: "monitor.example.com",
    });
    expect(state.page).toEqual({ channel: "red", message: "db down" });
    expect(typeof state.context).toBe("string");
    expect(JSON.stringify(state)).not.toContain("ops@example.com");
  });
});

interface Write {
  binds: unknown[];
  sql: string;
}

/** Minimal D1 stand-in that records every statement and its bindings. */
function fakeEnv(
  apiKey: string | undefined,
  writes: Write[],
  enforce = "true"
): Env {
  const db = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        run: () => {
          writes.push({ binds, sql });
          return Promise.resolve({});
        },
      }),
    }),
  };
  return {
    DB: db,
    MODERATION_ENFORCE: enforce,
    TYPESAFE_API_KEY: apiKey,
  } as unknown as Env;
}

const PAYLOAD: Payload = {
  channel: "red",
  contact: "ops@example.com",
  message: "You have been selected for a free cruise! Call 0800 123 4567 now",
};

function fetchWith(body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status: 200 })
    )) as typeof fetch;
}

describe("runAi", () => {
  it("drops spam, records the verdict and the terminal result", async () => {
    const writes: Write[] = [];
    const result = await runAi(
      fakeEnv("key", writes),
      "msg-1",
      PAYLOAD,
      fetchWith(fixtures.cruise_red.response)
    );
    expect(result).toBe(STOP);
    const [write] = writes;
    expect(write?.sql).toContain("ai_decision");
    expect(write?.binds).toContain("drop");
    expect(write?.binds).toContain("spam");
    expect(write?.binds).toContain("dropped");
  });

  it("delivers a page and records accept", async () => {
    const writes: Write[] = [];
    const result = await runAi(
      fakeEnv("key", writes),
      "msg-2",
      { ...PAYLOAD, message: "Production DB is down, on-call please ack" },
      fetchWith(fixtures.prompt_db_down_red.response)
    );
    expect(result).toBe(CONTINUE);
    expect(writes[0]?.binds).toContain("accept");
    expect(writes[0]?.binds).not.toContain("dropped");
  });

  it("fails open when Jev is unreachable: delivers and records the error", async () => {
    const writes: Write[] = [];
    const failing = (() =>
      Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    const result = await runAi(
      fakeEnv("key", writes),
      "msg-3",
      PAYLOAD,
      failing
    );
    expect(result).toBe(CONTINUE);
    expect(writes[0]?.binds).toContain("error");
    expect(
      writes[0]?.binds.some((b) => String(b).includes("fetch failed"))
    ).toBe(true);
  });

  it("fails open on a 529 from Jev", async () => {
    const writes: Write[] = [];
    const overloaded = (() =>
      Promise.resolve(
        new Response("overloaded", { status: 529 })
      )) as typeof fetch;
    const result = await runAi(
      fakeEnv("key", writes),
      "msg-4",
      PAYLOAD,
      overloaded
    );
    expect(result).toBe(CONTINUE);
    expect(writes[0]?.binds).toContain("error");
  });

  it("fails open when the secret is missing", async () => {
    const writes: Write[] = [];
    const result = await runAi(
      fakeEnv(undefined, writes),
      "msg-5",
      PAYLOAD,
      fetchWith(fixtures.cruise_red.response)
    );
    expect(result).toBe(CONTINUE);
    expect(writes[0]?.binds).toContain("error");
  });
});

describe("runAi with MODERATION_ENFORCE off (shadow mode)", () => {
  it("delivers spam but records the would-be drop", async () => {
    const writes: Write[] = [];
    const result = await runAi(
      fakeEnv("key", writes, "false"),
      "msg-6",
      PAYLOAD,
      fetchWith(fixtures.cruise_red.response)
    );
    expect(result).toBe(CONTINUE);
    const [write] = writes;
    expect(write?.binds).toContain("drop");
    expect(write?.binds).toContain("spam");
    expect(write?.binds).not.toContain("dropped");
    expect(write?.binds.some((b) => String(b).startsWith("shadow: "))).toBe(
      true
    );
  });

  it("treats anything other than exactly 'true' as shadow mode", async () => {
    for (const value of ["", "TRUE", "1", "yes"]) {
      const writes: Write[] = [];
      // biome-ignore lint/performance/noAwaitInLoops: one case at a time keeps the failing value obvious
      const result = await runAi(
        fakeEnv("key", writes, value),
        `msg-${value}`,
        PAYLOAD,
        fetchWith(fixtures.cruise_red.response)
      );
      expect(result, `MODERATION_ENFORCE=${JSON.stringify(value)}`).toBe(
        CONTINUE
      );
    }
  });

  it("leaves accepted pages unchanged", async () => {
    const writes: Write[] = [];
    const result = await runAi(
      fakeEnv("key", writes, "false"),
      "msg-7",
      { ...PAYLOAD, message: "Production DB is down, on-call please ack" },
      fetchWith(fixtures.prompt_db_down_red.response)
    );
    expect(result).toBe(CONTINUE);
    expect(writes[0]?.binds).toContain("accept");
    expect(writes[0]?.binds.some((b) => String(b).startsWith("shadow"))).toBe(
      false
    );
  });
});
