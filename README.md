# gs-fallback-return

> A [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) extension that takes your session **back to its primary model** once the quota that forced a fallback has reset.

## The problem

Gentle Shell profiles (`/gentle:profiles`) can define **fallbacks**: when the session model runs out of quota, hits a rate limit or its provider fails, the orchestrator moves the session to the next model in the chain and keeps working.

It never moves back. Hours after the primary's quota window reset, the session is still on the fallback, usually a weaker or pricier model, until you switch it by hand.

Subagents are not affected: they pick their model on every launch and already return to the primary on their own. Only the main session stays stuck.

## What this extension does

Before each new prompt, it checks whether the session is still on a fallback and whether the primary is usable again. If it is, it switches back and tells you:

```text
orchestrator: anthropic/claude-opus is available again; back from openai/gpt-5
```

- **Between runs only.** The switch happens in `before_agent_start`, so the prompt you just sent already runs on the primary. A run in progress is never interrupted.
- **Model agnostic.** No provider is hardcoded. Availability comes from Gentle Shell's own shared cooldown registry.
- **Reads usage from extensions too.** Gentle Shell feeds that registry with every usage reading, including providers registered by other extensions through the `gentle-pi:usage-source/v1` event (for example an opencode go usage extension). When a reading says the quota resets at 10:00, the session returns at the first prompt after 10:00.
- **Respects your choice.** If you change the model yourself after a fallback, it is never overridden.
- **Restores the thinking level** the session had before the fallback.
- **Optimistic and safe.** If the primary turns out to be still exhausted, Gentle Shell's fallback moves the session on again, exactly as before. Nothing probes your models or spends tokens to check.

## Install

Into the standalone Gentle Shell home:

```bash
gentle-shell install git:github.com/AncientGear/gs-fallback-return
```

Or, when `gentle-pi` runs inside an existing Pi:

```bash
pi install git:github.com/AncientGear/gs-fallback-return
```

Restart the session (or `/reload`) and it is active. There is nothing to configure: it uses the fallback chains you already set in `/gentle:profiles`.

## How it decides

| Question | Source |
| --- | --- |
| Is the session on a fallback? | The newest `gentle-pi.model-fallback/v1` session entry Gentle Shell wrote for the `orchestrator`, whose `to` is the current model, with no model change after it. |
| What is the primary? | That entry's `from`, followed back through chained fallbacks (A → B → C returns to A). |
| Is the primary usable again? | Gentle Shell's shared cooldown (`Symbol.for("gentle-pi.model-fallback.cooldown")`): quota and auth failures wait 30 minutes, transient errors 2 minutes, and usage readings wait until the real reset time. |
| No registry yet (for example, a resumed session)? | It waits the same default time, counted from when the fallback happened. |

If the primary is no longer in your model registry, or Pi refuses the switch (no valid login), the session stays on the fallback.

## Requirements

- Gentle Shell with profile fallbacks (`gentle-pi` 4.x, which writes `gentle-pi.model-fallback/v1` entries).
- Node.js 22.18 or newer (TypeScript runs without a build step).

## Limitations

- It acts when you send the next prompt, not while the session is idle. An idle session shows the fallback until you write again.
- Usage readings only refresh when Gentle Shell refreshes them, after a run and at most every 5 minutes. Without a reading, the 30-minute default applies.

## Development

```bash
npm test
```

Tests use `node:test` with no dependencies. `decide.ts` holds the pure decision; `index.ts` wires it to Pi.

## License

[MIT](LICENSE)
