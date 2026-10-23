import { describe, expect, it } from "vitest";
import { askJev, JevError } from "../src/jev.ts";

const QUESTIONS = {
  is_urgent: { instructions: "Is `page.message` urgent?", type: "noul" },
};

const OK_BODY = {
  answers: { is_urgent: { noul: 0.9, type: "noul" } },
  model: "jev-1.13.0",
  usage: { input_tokens: 10, output_tokens: 1 },
};

interface Captured {
  init: RequestInit;
  url: string;
}

function fetchReturning(
  status: number,
  body: unknown,
  captured: Captured[] = []
): typeof fetch {
  return ((url, init) => {
    captured.push({ init: init ?? {}, url: String(url) });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      })
    );
  }) as typeof fetch;
}

describe("askJev", () => {
  it("posts state, model and questions with a bearer key and returns the answers", async () => {
    const captured: Captured[] = [];
    const response = await askJev({
      apiKey: "secret-key",
      fetchImpl: fetchReturning(200, OK_BODY, captured),
      model: "jev-1.13.0",
      questions: QUESTIONS,
      state: { page: { message: "db down" } },
    });

    expect(response.answers.is_urgent).toEqual({ noul: 0.9, type: "noul" });
    expect(response.model).toBe("jev-1.13.0");

    const [call] = captured;
    expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call?.init.method).toBe("POST");
    expect(new Headers(call?.init.headers).get("authorization")).toBe(
      "Bearer secret-key"
    );
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: "jev-1.13.0",
      questions: QUESTIONS,
      state: { page: { message: "db down" } },
    });
  });

  it("throws a JevError carrying the status on a non-2xx response", async () => {
    await expect(
      askJev({
        apiKey: "secret-key",
        fetchImpl: fetchReturning(429, { detail: "slow down" }),
        model: "jev-1.13.0",
        questions: QUESTIONS,
        state: "x",
      })
    ).rejects.toMatchObject({ name: "JevError", status: 429 });
  });

  it("throws a JevError when the body does not match the answer schema", async () => {
    await expect(
      askJev({
        apiKey: "secret-key",
        fetchImpl: fetchReturning(200, {
          answers: { is_urgent: { type: "noul" } },
        }),
        model: "jev-1.13.0",
        questions: QUESTIONS,
        state: "x",
      })
    ).rejects.toBeInstanceOf(JevError);
  });

  it("throws a JevError before calling fetch when the key is empty", async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;
    await expect(
      askJev({
        apiKey: "",
        fetchImpl,
        model: "jev-1.13.0",
        questions: QUESTIONS,
        state: "x",
      })
    ).rejects.toBeInstanceOf(JevError);
    expect(calls).toBe(0);
  });

  it("aborts the request after timeoutMs", async () => {
    const fetchImpl = ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted"))
        );
      })) as typeof fetch;
    await expect(
      askJev({
        apiKey: "secret-key",
        fetchImpl,
        model: "jev-1.13.0",
        questions: QUESTIONS,
        state: "x",
        timeoutMs: 5,
      })
    ).rejects.toBeInstanceOf(JevError);
  });
});
