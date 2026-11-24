// The real model access (src/ai/sdk.ts) with the network replaced: what each kind of connection sends (no tools, the
// data block as the prompt, structured output limited to the options), how answers come back, and how each failure
// reads in the status's terms. No real service is ever called and no real key is used.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AiCredentials } from "@usualmail/core";
import { detailsRequest, eventRequest } from "../src/ai/prompt.ts";
import { askRequest } from "../src/search/ask-words.ts";
import { AiServiceError, CATEGORY, DEFAULT_MODELS, sdkModelAccess, type ChoiceRequest, type TextRequest } from "./sdk-fixtures.ts";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers with `reply`. */
function fakeFetch(reply: (sent: Sent) => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
    const request: Sent = { url: String(input), headers, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} };
    sent.push(request);
    return reply(request);
  };
  return { fetch: fetchLike as typeof fetch, sent };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const choice: ChoiceRequest = {
  model: "",
  instructions: "Decide which kind of email this is.",
  data: '<usual-mail-data id="abc">\n{"subject":"Invoice 7","text":"Please pay."}\n</usual-mail-data id="abc">',
  options: CATEGORY,
};
const text: TextRequest = { model: "", instructions: "Say what it is about.", data: '<usual-mail-data id="def">\n{"subject":"Hi"}\n</usual-mail-data id="def">', maxCharacters: 200 };

const KEYS = {
  gateway: { kind: "gateway", gateway: "vercel", apiKey: "vck_made-up-gateway-key-123456" },
  openai: { kind: "direct", provider: "openai", apiKey: "sk-proj-made-up-openai-key-123456" },
  anthropic: { kind: "direct", provider: "anthropic", apiKey: "sk-ant-made-up-anthropic-key-123456" },
} satisfies Record<string, AiCredentials>;

const OPTIONS = { maxRetries: 0, timeoutMs: 5_000 };

/** No request ever carries tools. */
function noTools(sent: Sent[]): void {
  for (const request of sent) {
    const body = JSON.stringify(request.body);
    assert.ok(!("tools" in request.body) || (Array.isArray(request.body.tools) && request.body.tools.length === 0), `no tools in ${request.url}`);
    assert.ok(!body.includes('"tool_choice"') || body.includes('"tool_choice":null'), "no tool choice");
  }
}

describe("defaults", () => {
  test("a decision model on the gateway for categorizing, each provider's smallest current model otherwise", () => {
    const access = sdkModelAccess();
    assert.deepEqual(access.defaults({ kind: "gateway", gateway: "vercel" }), DEFAULT_MODELS.vercel);
    assert.deepEqual(access.defaults({ kind: "direct", provider: "openai" }), { categorize: "gpt-6-luna", summarize: "gpt-6-luna" });
    assert.deepEqual(access.defaults({ kind: "direct", provider: "anthropic" }), { categorize: "claude-haiku-5-5", summarize: "claude-haiku-5-5" });
    assert.deepEqual(DEFAULT_MODELS.vercel, { categorize: "liquid/d1.2", summarize: "anthropic/claude-haiku-5.5" });
  });
});

describe("Vercel AI Gateway", () => {
  test("categorizes through the decision API with a choice question, and summarizes through a language model", async () => {
    const { fetch, sent } = fakeFetch((request) => request.url.endsWith("/decision-model")
      ? json(200, {
        answers: { kind: { type: "choice", choice: "invoice", probabilities: { conversation: 0.02, newsletter: 0.02, invoice: 0.9, receipt: 0.04, notification: 0.01, otp: 0.01 } } },
        model: "liquid/d1.2",
        usage: { inputTokens: 120 },
      })
      : json(200, {
        content: [{ type: "text", text: "A bill for October." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
        warnings: [],
      }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    const chosen = await models.choose({ ...choice, model: "liquid/d1.2" });
    assert.equal(chosen.value, "invoice");
    // What the gateway reported, as it reported it: input tokens only here, and never a cost (none is in its answer).
    assert.deepEqual(chosen.usage, { inputTokens: 120, outputTokens: null, costUsd: null });
    const decision = sent[0]!;
    assert.match(decision.url, /^https:\/\/ai-gateway\.vercel\.sh\/.+\/decision-model$/);
    assert.equal(decision.headers.authorization, `Bearer ${KEYS.gateway.apiKey}`);
    assert.equal(decision.headers["ai-model-id"], "liquid/d1.2");
    const question = (decision.body.questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>).kind!;
    assert.equal(question.type, "choice");
    assert.equal(question.instructions, choice.instructions);
    assert.deepEqual(Object.keys(question.criteria), ["conversation", "newsletter", "invoice", "receipt", "notification", "otp"]);
    assert.ok(JSON.stringify(decision.body.stateParts).includes("Invoice 7"), "the data block is the state");

    const written = await models.write({ ...text, model: "anthropic/claude-haiku-5.5" });
    assert.equal(written.value, "A bill for October.");
    assert.deepEqual(written.usage, { inputTokens: 10, outputTokens: 5, costUsd: null });
    const language = sent[1]!;
    assert.match(language.url, /\/language-model$/);
    assert.equal(language.headers["ai-language-model-id"], "anthropic/claude-haiku-5.5");
    noTools(sent);
  });

  test("a text call's generation id is looked up for its cost: only the id is sent, and the gateway's total is taken", async () => {
    const { fetch, sent } = fakeFetch((request) => request.url.includes("/v1/generation?")
      ? json(200, {
        data: {
          id: "gen_01FAKE", total_cost: 0.00042, market_cost: 0.0004, upstream_inference_cost: 0, usage: 0.00042,
          created_at: "2026-11-18T18:00:00Z", model: "anthropic/claude-haiku-5.5", is_byok: false, provider_name: "anthropic",
          streamed: false, finish_reason: "stop", latency: 300, generation_time: 900, native_tokens_prompt: 10,
          native_tokens_completion: 5, native_tokens_reasoning: 0, native_tokens_cached: 0, native_tokens_cache_creation: 0,
          billable_web_search_calls: 0,
        },
      })
      : request.url.endsWith("/decision-model")
        ? json(200, { answers: { kind: { type: "choice", choice: "invoice" } } })
        : json(200, {
          content: [{ type: "text", text: "A bill for October." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
          providerMetadata: { gateway: { generationId: "gen_01FAKE" } },
          warnings: [],
        }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    assert.equal((await models.write({ ...text, model: "anthropic/claude-haiku-5.5" })).generation, "gen_01FAKE");
    assert.equal((await models.choose({ ...choice, model: "liquid/d1.2" })).generation, null, "a decision without the gateway's id has none");
    assert.equal(await models.lookupCost!("gen_01FAKE"), 0.00042);
    const lookup = sent.at(-1)!;
    assert.equal(lookup.url, "https://ai-gateway.vercel.sh/v1/generation?id=gen_01FAKE");
    assert.deepEqual(lookup.body, {}, "nothing but the id, in the address");
    assert.equal(lookup.headers.authorization, `Bearer ${KEYS.gateway.apiKey}`);
    const own = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.openai);
    assert.equal(own.lookupCost, undefined, "a provider's own key has no lookup");
  });

  test("a refusal, a choice outside the options or an incomplete distribution is no answer, not a failure", async () => {
    const answers = [{ kind: { type: "refusal" } }, { kind: { type: "choice", choice: "spam" } }, { kind: { type: "choice", choice: "invoice", probabilities: { invoice: 1 } } }];
    const { fetch } = fakeFetch(() => json(200, { answers: answers.shift() }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    assert.deepEqual(await models.choose({ ...choice, model: "liquid/d1.2" }), { value: null, usage: { inputTokens: null, outputTokens: null, costUsd: null } }, "nothing reported is null, not 0");
    // An answer outside the options isn't used either way: the SDK refuses it, and the pipeline would drop it.
    const second = (await models.choose({ ...choice, model: "liquid/d1.2" })).value;
    assert.ok(second === null || second === "spam");
    assert.equal((await models.choose({ ...choice, model: "liquid/d1.2" })).value, null);
  });

  const failures: Array<[number, unknown, AiServiceError["failure"]]> = [
    [401, { error: { type: "authentication_error", message: "Invalid API key" } }, "key_refused"],
    [404, { error: { type: "model_not_found", message: "No such model", param: { modelId: "x/y" } } }, "model_not_found"],
    [402, { error: { type: "payment_required", message: "Insufficient credits" } }, "out_of_credit"],
    [429, { error: { type: "rate_limit_exceeded", message: "Slow down" } }, "unavailable"],
    [500, { error: { type: "internal_server_error", message: "Oops" } }, "unavailable"],
  ];
  for (const [status, body, failure] of failures) {
    test(`a ${status} reads as ${failure}`, async () => {
      const { fetch } = fakeFetch(() => json(status, body));
      const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
      await assert.rejects(models.choose({ ...choice, model: "liquid/d1.2" }), (error: unknown) => {
        assert.ok(error instanceof AiServiceError);
        assert.equal(error.failure, failure);
        assert.ok(!error.message.includes(KEYS.gateway.apiKey));
        return true;
      });
    });
  }

  test("a service that can't be reached is unavailable", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    await assert.rejects(models.write({ ...text, model: "anthropic/claude-haiku-5.5" }), { failure: "unavailable" });
  });
});

const openaiResponse = (output: string) => json(200, {
  id: "resp_1",
  object: "response",
  created_at: 1_790_000_000,
  model: "gpt-6-luna",
  status: "completed",
  output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
});

describe("which models fit which job on the gateway", () => {
  const config = json(200, {
    models: [
      { id: "typesafe-ai/jev", name: "Jev", modelType: "decision", specification: { specificationVersion: "v4", provider: "typesafe-ai", modelId: "typesafe-ai/jev" } },
      { id: "anthropic/claude-haiku-5.5", name: "Haiku", modelType: "language", specification: { specificationVersion: "v4", provider: "anthropic", modelId: "anthropic/claude-haiku-5.5" } },
    ],
  });

  test("categorizing needs a decision model and summarizing a language model, from the gateway's own model list", async () => {
    const { fetch, sent } = fakeFetch(() => config.clone());
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    assert.match(await models.fitFor!("categorize", "anthropic/claude-haiku-5.5") ?? "", /categorizing needs a decision model; anthropic\/claude-haiku-5\.5 is a language model/);
    assert.match(await models.fitFor!("summarize", "typesafe-ai/jev") ?? "", /summarizing needs a language model; typesafe-ai\/jev is a decision model/);
    assert.equal(await models.fitFor!("categorize", "typesafe-ai/jev"), null);
    assert.equal(await models.fitFor!("summarize", "anthropic/claude-haiku-5.5"), null);
    assert.equal(await models.fitFor!("categorize", "nobody/knows-this"), null, "a model it doesn't list: the request will say");
    assert.ok(sent.every((request) => request.url.endsWith("/config")), "only the model list was asked for, no mail");
    assert.ok(!JSON.stringify(sent).includes("usual-mail-data"));
  });

  test("a model list that can't be read says nothing, and the request decides", async () => {
    const { fetch } = fakeFetch(() => json(500, { error: { message: "down" } }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    assert.equal(await models.fitFor!("categorize", "anthropic/claude-haiku-5.5"), null);
  });
});

describe("OpenAI with the person's own key", () => {
  test("structured output limited to the six categories, nothing stored at OpenAI, no tools", async () => {
    const { fetch, sent } = fakeFetch((request) => openaiResponse(JSON.stringify(request.body.text) ? '{"result":"receipt"}' : ""));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.openai);
    assert.equal((await models.choose({ ...choice, model: "gpt-6-luna" })).value, "receipt");
    const request = sent[0]!;
    assert.equal(request.url, "https://api.openai.com/v1/responses");
    assert.equal(request.headers.authorization, `Bearer ${KEYS.openai.apiKey}`);
    assert.equal(request.body.store, false);
    const format = JSON.stringify(request.body.text);
    for (const category of ["conversation", "newsletter", "invoice", "receipt", "notification", "otp"]) assert.ok(format.includes(category), `${category} in the schema`);
    assert.ok(!format.includes('"unknown"'), "nobody chooses unknown");
    assert.ok(JSON.stringify(request.body.input).includes("Invoice 7"));
    noTools(sent);
  });

  test("plain text for a summary; malformed structured output is no answer", async () => {
    const replies = ["Asks you to pay invoice 7.", "not json"];
    const { fetch } = fakeFetch(() => openaiResponse(replies.shift()!));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.openai);
    assert.equal((await models.write({ ...text, model: "gpt-6-luna" })).value, "Asks you to pay invoice 7.");
    assert.equal((await models.choose({ ...choice, model: "gpt-6-luna" })).value, null);
  });

  const failures: Array<[number, unknown, AiServiceError["failure"]]> = [
    [401, { error: { message: "Incorrect API key provided: sk-proj-****3456.", type: "invalid_request_error", code: "invalid_api_key" } }, "key_refused"],
    [404, { error: { message: "The model `gpt-9` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }, "model_not_found"],
    [429, { error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }, "out_of_credit"],
    [429, { error: { message: "Rate limit reached.", type: "requests", code: "rate_limit_exceeded" } }, "unavailable"],
    [503, { error: { message: "The engine is overloaded.", type: "server_error" } }, "unavailable"],
  ];
  for (const [status, body, failure] of failures) {
    test(`a ${status} (${(body as { error: { message: string } }).error.message}) reads as ${failure}, without the key`, async () => {
      const { fetch } = fakeFetch(() => json(status, body));
      const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.openai);
      await assert.rejects(models.write({ ...text, model: "gpt-6-luna" }), (error: unknown) => {
        assert.ok(error instanceof AiServiceError, String(error));
        assert.equal(error.failure, failure);
        assert.ok(!error.message.includes("3456"), `no part of the key in "${error.message}"`);
        return true;
      });
    });
  }
});

const anthropicResponse = (output: string) => json(200, {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: output }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe("Anthropic with the person's own key", () => {
  test("its native structured output (output_config.format), never a forced tool", async () => {
    const { fetch, sent } = fakeFetch(() => anthropicResponse('{"result":"otp"}'));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.anthropic);
    assert.equal((await models.choose({ ...choice, model: "claude-haiku-5-5" })).value, "otp");
    const request = sent[0]!;
    assert.equal(request.url, "https://api.anthropic.com/v1/messages");
    assert.equal(request.headers["x-api-key"], KEYS.anthropic.apiKey);
    const format = (request.body.output_config as { format?: { type: string; schema: unknown } } | undefined)?.format;
    assert.equal(format?.type, "json_schema");
    assert.ok(JSON.stringify(format?.schema).includes("notification"));
    assert.ok(!("temperature" in request.body), "no sampling settings, which current models refuse");
    assert.ok(JSON.stringify(request.body.system).includes("Decide which kind"), "the server's words are the system prompt");
    assert.ok(JSON.stringify(request.body.messages).includes("Invoice 7"), "the data block is the user's turn");
    noTools(sent);
  });

  const failures: Array<[number, unknown, AiServiceError["failure"]]> = [
    [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "key_refused"],
    [402, { type: "error", error: { type: "billing_error", message: "Billing problem" } }, "out_of_credit"],
    [400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, "out_of_credit"],
    [404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }, "model_not_found"],
    [529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "unavailable"],
  ];
  for (const [status, body, failure] of failures) {
    test(`a ${status} reads as ${failure}`, async () => {
      const { fetch } = fakeFetch(() => json(status, body));
      const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.anthropic);
      await assert.rejects(models.write({ ...text, model: "claude-haiku-5-5" }), { failure });
    });
  }
});

describe("a receipt's details, as an object from the summarize job's model", () => {
  const DETAILS = '{"party":"Kestrel Roasters","amount":"1,240.00","currency":"EUR","refund":false,"state":"due","dueDate":"2026-11-30","what":"October beans"}';
  const details = (model: string) => ({ ...detailsRequest(model, "Invoice 7", [{ fromName: "Kestrel Roasters", text: "1,240.00 EUR, due 30 November.", html: null }], "abcdef0123456789ab", "invoice").request });
  const FIELDS = ["party", "amount", "currency", "refund", "state", "dueDate", "what"];

  test("on the gateway: a language model asked for the object's JSON schema; the object comes back", async () => {
    const { fetch, sent } = fakeFetch(() => json(200, {
      content: [{ type: "text", text: DETAILS }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
      warnings: [],
    }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    const answer = await models.extract(details("anthropic/claude-haiku-5.5"));
    assert.deepEqual(answer.value, JSON.parse(DETAILS));
    assert.deepEqual(answer.usage, { inputTokens: 30, outputTokens: 20, costUsd: null });
    assert.match(sent[0]!.url, /\/language-model$/);
    const format = sent[0]!.body.responseFormat as { type: string; schema: { properties: Record<string, unknown>; required: string[] } };
    assert.equal(format.type, "json");
    assert.deepEqual(Object.keys(format.schema.properties).sort(), [...FIELDS].sort());
    assert.deepEqual([...format.schema.required].sort(), [...FIELDS].sort(), "every field present, null when the mail doesn't say");
    noTools(sent);
  });

  test("with OpenAI's own key: strict structured output, nothing stored", async () => {
    const { fetch, sent } = fakeFetch(() => openaiResponse(DETAILS));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.openai);
    assert.deepEqual((await models.extract(details("gpt-6-luna"))).value, JSON.parse(DETAILS));
    assert.equal(sent[0]!.body.store, false);
    const format = (sent[0]!.body.text as { format: { type: string; strict: boolean; schema: { required: string[] } } }).format;
    assert.deepEqual([format.type, format.strict], ["json_schema", true]);
    assert.deepEqual([...format.schema.required].sort(), [...FIELDS].sort());
    noTools(sent);
  });

  test("with Anthropic's own key: its native output_config.format, never a forced tool; malformed output is no answer", async () => {
    const replies = [DETAILS, "not json"];
    const { fetch, sent } = fakeFetch(() => anthropicResponse(replies.shift()!));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.anthropic);
    assert.deepEqual((await models.extract(details("claude-haiku-5-5"))).value, JSON.parse(DETAILS));
    const format = (sent[0]!.body.output_config as { format?: { type: string; schema: { required: string[] } } } | undefined)?.format;
    assert.equal(format?.type, "json_schema");
    assert.deepEqual([...format!.schema.required].sort(), [...FIELDS].sort());
    noTools(sent);
    assert.equal((await models.extract(details("claude-haiku-5-5"))).value, null);
  });
});

describe("a notification's event, as an object from the summarize job's model", () => {
  test("on the gateway: the seven fields' JSON schema, every one required", async () => {
    const EVENT = '{"summary":"Arrives today","status":"Out for delivery","about":"A parcel","date":"2026-11-16","time":"15:15","endTime":"18:15","reference":null}';
    const { fetch, sent } = fakeFetch(() => json(200, {
      content: [{ type: "text", text: EVENT }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 30, noCache: 30, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
      warnings: [],
    }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    const request = eventRequest("anthropic/claude-haiku-5.5", "Out for delivery", [{ fromName: "Parcelway", text: "Today, 3:15–6:15 pm.", html: null }], "abcdef0123456789ab").request;
    assert.deepEqual((await models.extract(request)).value, JSON.parse(EVENT));
    const format = sent[0]!.body.responseFormat as { schema: { required: string[] } };
    assert.deepEqual([...format.schema.required].sort(), ["about", "date", "endTime", "reference", "status", "summary", "time"]);
    noTools(sent);
  });
});


describe("a search asked in a sentence, as an object from the summarize job's model", () => {
  const FILTERS = '{"kinds":["invoice"],"from":"Hetzner","to":null,"subject":null,"hasAttachment":null,"unread":null,"after":"2026-10-01","before":"2026-11-01","exclude":null,"text":"over 100 euros"}';
  const request = askRequest("anthropic/claude-haiku-5.5", "invoices from Hetzner over 100 euros last month", "abcdef0123456789ab", "Monday 2026-11-16");

  test("on the gateway: the ten fields' JSON schema, every one required; the sentence only in the data block; no tools", async () => {
    const { fetch, sent } = fakeFetch(() => json(200, {
      content: [{ type: "text", text: FILTERS }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 400, noCache: 400, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 60, text: 60, reasoning: 0 } },
      warnings: [],
    }));
    const models = sdkModelAccess({ fetch, ...OPTIONS }).open(KEYS.gateway);
    assert.deepEqual((await models.extract(request)).value, JSON.parse(FILTERS));
    const format = sent[0]!.body.responseFormat as { schema: { required: string[] } };
    assert.deepEqual([...format.schema.required].sort(), ["after", "before", "exclude", "from", "hasAttachment", "kinds", "subject", "text", "to", "unread"]);
    const body = JSON.stringify(sent[0]!.body);
    assert.equal(body.split("invoices from Hetzner over 100 euros last month").length, 2, "the sentence once, in the data");
    noTools(sent);
  });

  test("it is never sent twice: a failure the access would otherwise try again is one request", async () => {
    const mail = detailsRequest("anthropic/claude-haiku-5.5", "Invoice 7", [{ fromName: "Kestrel Roasters", text: "1,240.00 EUR", html: null }], "abcdef0123456789ab", "invoice").request;
    for (const [what, sentRequest, expected] of [["a search sentence", request, 1], ["mail", mail, 2]] as const) {
      const { fetch, sent } = fakeFetch(() => json(503, { error: { message: "Overloaded", type: "server_error" } }));
      const models = sdkModelAccess({ fetch, timeoutMs: 5_000, maxRetries: 1 }).open(KEYS.gateway);
      await assert.rejects(models.extract(sentRequest), (error: unknown) => error instanceof AiServiceError && error.failure === "unavailable");
      assert.equal(sent.length, expected, what);
    }
  });
});
