import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MODEL_FALLBACK_ENTRY, type CooldownLike } from "./decide.ts";

const extension = (await import("./index.ts")).default;
const COOLDOWN_KEY = Symbol.for("gentle-pi.model-fallback.cooldown");
const host = globalThis as unknown as Record<symbol, CooldownLike | undefined>;

afterEach(() => {
	delete host[COOLDOWN_KEY];
	delete process.env.GENTLE_PI_AGENTS_CHILD;
});

type Model = { provider: string; id: string };
const model = (ref: string): Model => ({ provider: ref.slice(0, ref.indexOf("/")), id: ref.slice(ref.indexOf("/") + 1) });

function harness(options: { current: string; setModelResult?: boolean | Error; known?: string[]; thinking?: string; hasUI?: boolean }) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const calls: string[] = [];
	const notices: Array<[string, string]> = [];
	let thinkingLevel = options.thinking ?? "medium";
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
		async setModel(next: Model) {
			calls.push(`setModel ${next.provider}/${next.id}`);
			if (options.setModelResult instanceof Error) throw options.setModelResult;
			return options.setModelResult ?? true;
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel(level: string) {
			calls.push(`setThinkingLevel ${level}`);
			thinkingLevel = level;
		},
	};
	const entries = [
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{ type: "model_change", provider: "anthropic", modelId: "opus" },
		{ type: "model_change", provider: "openai", modelId: "gpt" },
		{ type: "custom", customType: MODEL_FALLBACK_ENTRY, data: { agent: "orchestrator", from: "anthropic/opus", to: "openai/gpt", category: "quota", at: 0 } },
	];
	const ctx = {
		hasUI: options.hasUI ?? true,
		model: model(options.current),
		modelRegistry: { find: (provider: string, id: string) => ((options.known ?? ["anthropic/opus"]).includes(`${provider}/${id}`) ? { provider, id } : undefined) },
		sessionManager: { getBranch: () => entries },
		ui: { notify: (text: string, level: string) => notices.push([text, level]) },
	};
	extension(pi as never);
	const run = () => handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
	return { handlers, calls, notices, run };
}

test("switches back to the primary before the next run and announces it", async () => {
	host[COOLDOWN_KEY] = { available: () => true };
	const h = harness({ current: "openai/gpt" });
	assert.equal(await h.run(), undefined);
	assert.deepEqual(h.calls, ["setModel anthropic/opus", "setThinkingLevel high"]);
	assert.deepEqual(h.notices, [["orchestrator: anthropic/opus is available again; back from openai/gpt", "info"]]);
});

test("S3: reads gentle-shell's shared cooldown, which usage readings from extensions feed", async () => {
	host[COOLDOWN_KEY] = { available: (ref) => ref !== "anthropic/opus" };
	const h = harness({ current: "openai/gpt" });
	await h.run();
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.notices, []);
});

test("keeps the current thinking level when it already matches", async () => {
	host[COOLDOWN_KEY] = { available: () => true };
	const h = harness({ current: "openai/gpt", thinking: "high" });
	await h.run();
	assert.deepEqual(h.calls, ["setModel anthropic/opus"]);
});

test("stays on the fallback when Pi refuses or throws on the switch", async () => {
	host[COOLDOWN_KEY] = { available: () => true };
	for (const setModelResult of [false, new Error("expired login")]) {
		const h = harness({ current: "openai/gpt", setModelResult });
		assert.equal(await h.run(), undefined);
		assert.deepEqual(h.calls, ["setModel anthropic/opus"]);
		assert.deepEqual(h.notices, []);
	}
});

test("does nothing when the primary is not in Pi's model registry", async () => {
	host[COOLDOWN_KEY] = { available: () => true };
	const h = harness({ current: "openai/gpt", known: [] });
	await h.run();
	assert.deepEqual(h.calls, []);
});

test("switches silently without a UI", async () => {
	host[COOLDOWN_KEY] = { available: () => true };
	const h = harness({ current: "openai/gpt", hasUI: false });
	await h.run();
	assert.deepEqual(h.calls, ["setModel anthropic/opus", "setThinkingLevel high"]);
	assert.deepEqual(h.notices, []);
});

test("registers nothing inside a gentle-shell subagent process", () => {
	process.env.GENTLE_PI_AGENTS_CHILD = "1";
	const h = harness({ current: "openai/gpt" });
	assert.equal(h.handlers.size, 0);
});
