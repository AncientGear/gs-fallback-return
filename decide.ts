// Decides, from the session's own history, whether the main session should
// leave a fallback model and go back to its primary.
//
// gentle-shell's orchestrator fallback switches the session model when a run
// fails on quota, rate limits or provider trouble, then records a
// `gentle-pi.model-fallback/v1` entry naming `from` and `to`. It never
// switches back. The history is enough to know where to return:
//
// - the newest orchestrator fallback entry names the model we are on (`to`);
// - walking back through chained fallbacks (A -> B, then B -> C) finds the
//   model the episode started from (A), the primary;
// - any model change after the newest entry is a manual choice (or a return
//   already made), and is never overridden.
//
// Whether the primary is usable again comes from gentle-shell's shared
// cooldown, which every usage reading feeds (built-in providers and those
// that extensions register through `gentle-pi:usage-source/v1`). No provider
// is named here. Without that registry, the default cooldown gentle-shell
// applies is waited from the time of the fallback.

export const MODEL_FALLBACK_ENTRY = "gentle-pi.model-fallback/v1";

/** gentle-shell's default skip times (lib/model-fallback-policy.ts COOLDOWN_MS). */
export const DEFAULT_COOLDOWN_MS = { exhausted: 30 * 60_000, transient: 2 * 60_000 } as const;
const EXHAUSTED_CATEGORIES: ReadonlySet<string> = new Set(["quota", "auth"]);

/** The subset of gentle-shell's ModelCooldown this extension reads. */
export interface CooldownLike {
	available(model: string, now: number): boolean;
}

/** The subset of a Pi session entry this extension reads. */
export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
}

export interface ReturnPlan {
	/** `provider/id` to switch back to. */
	primary: string;
	/** `provider/id` of the fallback the session is on. */
	from: string;
	/** Why the newest fallback happened, as gentle-shell recorded it. */
	category?: string;
	/** The thinking level the session had before the episode, when recorded. */
	thinking?: string;
}

interface FallbackRecord {
	from: string;
	to: string;
	category?: string;
	at?: number;
}

function fallbackRecord(entry: SessionEntryLike): FallbackRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== MODEL_FALLBACK_ENTRY) return undefined;
	const data = entry.data as Record<string, unknown> | null | undefined;
	if (!data || typeof data !== "object" || data.agent !== "orchestrator") return undefined;
	if (typeof data.from !== "string" || typeof data.to !== "string" || !data.from || !data.to) return undefined;
	const record: FallbackRecord = { from: data.from, to: data.to };
	if (typeof data.category === "string") record.category = data.category;
	if (typeof data.at === "number" && Number.isFinite(data.at)) record.at = data.at;
	return record;
}

const modelRef = (entry: SessionEntryLike) => (entry.type === "model_change" && entry.provider && entry.modelId ? `${entry.provider}/${entry.modelId}` : undefined);
const isModelRef = (value: string) => value.indexOf("/") > 0 && value.indexOf("/") < value.length - 1;

function newestFallback(entries: readonly SessionEntryLike[], before: number): number {
	for (let index = before - 1; index >= 0; index--) if (fallbackRecord(entries[index]!)) return index;
	return -1;
}

/**
 * What to switch back to before the next run, or undefined to stay.
 * `entries` is the session branch in order (root to leaf); `current` is the
 * session model as `provider/id`; `cooldown` is gentle-shell's shared
 * registry, undefined when it does not exist yet.
 */
export function planReturn(entries: readonly SessionEntryLike[], current: string | undefined, cooldown: CooldownLike | undefined, now: number): ReturnPlan | undefined {
	const last = newestFallback(entries, entries.length);
	if (last < 0) return undefined;
	const newest = fallbackRecord(entries[last]!)!;
	if (current === undefined || current !== newest.to) return undefined;
	// A model change after the fallback was recorded: the user chose, or we already returned.
	if (entries.slice(last + 1).some((entry) => modelRef(entry) !== undefined)) return undefined;

	// Walk chained fallbacks back to the model the episode started from.
	let start = last;
	let primary = newest.from;
	for (;;) {
		const previous = newestFallback(entries, start);
		if (previous < 0) break;
		const record = fallbackRecord(entries[previous]!)!;
		const switchedTo = fallbackRecord(entries[start]!)!.to;
		const onlyTheSwitch = entries.slice(previous + 1, start).every((entry) => {
			const ref = modelRef(entry);
			return ref === undefined || ref === switchedTo;
		});
		if (record.to !== primary || !onlyTheSwitch) break;
		start = previous;
		primary = record.from;
	}
	if (!isModelRef(primary) || primary === current) return undefined;

	const origin = fallbackRecord(entries[start]!)!;
	const usable = cooldown
		? cooldown.available(primary, now)
		: origin.at !== undefined && now >= origin.at + (EXHAUSTED_CATEGORIES.has(origin.category ?? "quota") ? DEFAULT_COOLDOWN_MS.exhausted : DEFAULT_COOLDOWN_MS.transient);
	if (!usable) return undefined;

	const plan: ReturnPlan = { primary, from: current };
	if (newest.category !== undefined) plan.category = newest.category;
	// The fallback switch itself (model change, then maybe its own effort) precedes the entry.
	let switchIndex = start;
	for (let index = start - 1; index >= 0; index--) {
		if (modelRef(entries[index]!) !== undefined) {
			switchIndex = index;
			break;
		}
	}
	for (let index = switchIndex - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
			plan.thinking = entry.thinkingLevel;
			break;
		}
	}
	return plan;
}
