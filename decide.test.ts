import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COOLDOWN_MS, MODEL_FALLBACK_ENTRY, planReturn, type CooldownLike, type SessionEntryLike } from "./decide.ts";

const NOW = 1_000_000_000;
const MIN = 60_000;

const modelChange = (ref: string): SessionEntryLike => {
	const [provider, ...rest] = ref.split("/");
	return { type: "model_change", provider, modelId: rest.join("/") };
};
const fallback = (from: string, to: string, extra: Record<string, unknown> = {}): SessionEntryLike => ({
	type: "custom",
	customType: MODEL_FALLBACK_ENTRY,
	data: { agent: "orchestrator", from, to, category: "quota", at: NOW - 40 * MIN, ...extra },
});
const thinking = (level: string): SessionEntryLike => ({ type: "thinking_level_change", thinkingLevel: level });
const message: SessionEntryLike = { type: "message" };

const free: CooldownLike = { available: () => true };
const cooling = (...models: string[]): CooldownLike => ({ available: (model) => !models.includes(model) });

// Pi's orchestrator fallback switches the model first (model_change), then records the entry.
const episode = (from: string, to: string, extra?: Record<string, unknown>) => [modelChange(to), fallback(from, to, extra)];

test("S1: returns to the primary once its cooldown has passed", () => {
	const entries = [modelChange("anthropic/opus"), message, ...episode("anthropic/opus", "openai/gpt"), message];
	assert.deepEqual(planReturn(entries, "openai/gpt", free, NOW), { primary: "anthropic/opus", from: "openai/gpt", category: "quota" });
});

test("S1: stays on the fallback while the primary is still cooling down", () => {
	const entries = [modelChange("anthropic/opus"), ...episode("anthropic/opus", "openai/gpt")];
	assert.equal(planReturn(entries, "openai/gpt", cooling("anthropic/opus"), NOW), undefined);
});

test("S2/S3: availability comes only from the shared cooldown, whatever the provider", () => {
	const entries = [...episode("opencode-go/kimi", "nan/glm")];
	const asked: string[] = [];
	const cooldown: CooldownLike = { available: (model, now) => (asked.push(`${model}@${now}`), true) };
	assert.equal(planReturn(entries, "nan/glm", cooldown, NOW)?.primary, "opencode-go/kimi");
	assert.deepEqual(asked, [`opencode-go/kimi@${NOW}`]);
});

test("a chained episode (A -> B -> C) returns to the first primary A", () => {
	const entries = [...episode("p/a", "p/b"), message, ...episode("p/b", "p/c"), message];
	assert.deepEqual(planReturn(entries, "p/c", free, NOW), { primary: "p/a", from: "p/c", category: "quota" });
});

test("S6: a model the user picked after the fallback is never overridden", () => {
	const entries = [...episode("p/a", "p/b"), message, modelChange("p/x")];
	assert.equal(planReturn(entries, "p/x", free, NOW), undefined);
});

test("S6: picking the fallback model again by hand counts as a manual choice", () => {
	const entries = [...episode("p/a", "p/b"), modelChange("p/x"), modelChange("p/b")];
	assert.equal(planReturn(entries, "p/b", free, NOW), undefined);
});

test("no plan when the session is not on the episode's fallback", () => {
	assert.equal(planReturn([...episode("p/a", "p/b")], "p/z", free, NOW), undefined);
	assert.equal(planReturn([...episode("p/a", "p/b")], undefined, free, NOW), undefined);
});

test("no plan once the session is already back on the primary", () => {
	const entries = [...episode("p/a", "p/b"), modelChange("p/a"), message];
	assert.equal(planReturn(entries, "p/a", free, NOW), undefined);
});

test("no plan without an orchestrator fallback entry", () => {
	assert.equal(planReturn([modelChange("p/a"), message], "p/a", free, NOW), undefined);
	const subagent = { ...fallback("p/a", "p/b"), data: { agent: "explore", from: "p/a", to: "p/b", category: "quota", at: NOW } };
	assert.equal(planReturn([modelChange("p/b"), subagent], "p/b", free, NOW), undefined);
});

test("no plan when the fallback started from an unknown model", () => {
	assert.equal(planReturn([...episode("default", "p/b")], "p/b", free, NOW), undefined);
});

test("malformed fallback entries are ignored", () => {
	const broken: SessionEntryLike = { type: "custom", customType: MODEL_FALLBACK_ENTRY, data: { agent: "orchestrator", from: 3, to: null } };
	assert.equal(planReturn([modelChange("p/b"), broken], "p/b", free, NOW), undefined);
});

test("without a shared cooldown, waits the default time from the fallback, per category", () => {
	const quota = [...episode("p/a", "p/b", { category: "quota", at: NOW - DEFAULT_COOLDOWN_MS.exhausted + 1 })];
	assert.equal(planReturn(quota, "p/b", undefined, NOW), undefined);
	const quotaDone = [...episode("p/a", "p/b", { category: "quota", at: NOW - DEFAULT_COOLDOWN_MS.exhausted })];
	assert.equal(planReturn(quotaDone, "p/b", undefined, NOW)?.primary, "p/a");
	const transient = [...episode("p/a", "p/b", { category: "rate_limit", at: NOW - DEFAULT_COOLDOWN_MS.transient })];
	assert.equal(planReturn(transient, "p/b", undefined, NOW)?.primary, "p/a");
	const noTime = [...episode("p/a", "p/b", { at: undefined })];
	assert.equal(planReturn(noTime, "p/b", undefined, NOW), undefined);
});

test("restores the thinking level the session had before the episode", () => {
	const entries = [thinking("high"), message, thinking("low"), ...episode("p/a", "p/b"), thinking("minimal")];
	assert.deepEqual(planReturn(entries, "p/b", free, NOW), { primary: "p/a", from: "p/b", category: "quota", thinking: "low" });
});
