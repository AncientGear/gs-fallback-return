// gs-fallback-return: a Gentle Shell (Pi) extension that takes the main
// session back to its primary model once the fallback it was moved to is no
// longer needed. See decide.ts for the decision and README.md for usage.
//
// The switch happens in `before_agent_start`: Pi awaits it before reading the
// model for the run, so the next prompt already runs on the primary, and a
// run in progress is never interrupted. If the primary fails again,
// gentle-shell's own fallback moves the session on, as it always does.

import { planReturn, type CooldownLike, type SessionEntryLike } from "./decide.ts";

// Structural types only, so the package has no runtime or type dependency.
type Model = { provider: string; id: string };
interface Context {
	hasUI: boolean;
	model: Model | undefined;
	modelRegistry: { find(provider: string, modelId: string): Model | undefined };
	sessionManager: { getBranch(): readonly SessionEntryLike[] };
	ui: { notify(message: string, level: "info" | "warning" | "error"): void };
}
interface ExtensionApi {
	on(event: "before_agent_start", handler: (event: unknown, ctx: Context) => Promise<undefined> | undefined): void;
	setModel(model: Model): Promise<boolean>;
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
}

/** gentle-shell keeps one cooldown registry per process under this symbol. */
const COOLDOWN_KEY = Symbol.for("gentle-pi.model-fallback.cooldown");

function sharedCooldown(): CooldownLike | undefined {
	const value = (globalThis as unknown as Record<symbol, unknown>)[COOLDOWN_KEY];
	return value && typeof (value as CooldownLike).available === "function" ? (value as CooldownLike) : undefined;
}

export default function gsFallbackReturn(pi: ExtensionApi): void {
	// Subagents pick their model per launch and already return on their own.
	if (process.env.GENTLE_PI_AGENTS_CHILD === "1") return;

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const plan = planReturn(ctx.sessionManager.getBranch(), current, sharedCooldown(), Date.now());
			if (!plan) return undefined;
			const slash = plan.primary.indexOf("/");
			const primary = ctx.modelRegistry.find(plan.primary.slice(0, slash), plan.primary.slice(slash + 1));
			if (!primary) return undefined;
			// Pi refuses (false) or throws when the primary has no usable login.
			if (!(await pi.setModel(primary).catch(() => false))) return undefined;
			if (plan.thinking && pi.getThinkingLevel() !== plan.thinking) pi.setThinkingLevel(plan.thinking);
			if (ctx.hasUI) ctx.ui.notify(`orchestrator: ${plan.primary} is available again; back from ${plan.from}`, "info");
		} catch {
			// Never block a run: staying on the fallback is always safe.
		}
		return undefined;
	});
}
