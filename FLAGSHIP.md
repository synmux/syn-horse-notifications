# Replacing `MODERATION_ENFORCE` with a Flagship flag

Proposal for review, written 23 October 2026. Nothing here has been built. Every Flagship fact below comes from the Cloudflare docs (pages last updated 19 October 2026) or from the help text of Wrangler 4.151.0, the version this repository pins. Anything that is my opinion is marked as such.

## Summary

Today, turning moderation enforcement on or off means editing `wrangler.jsonc` and redeploying the Worker. Flagship is Cloudflare's feature-flag service, and it would let you flip enforcement from the dashboard or one Wrangler command, with no deploy. It also lets enforcement differ by channel, so green could start dropping spam while red stays in shadow mode.

The change is small: one binding, one flag, and about ten lines in `src/stages/ai.ts`. The main thing to weigh is that Flagship is in public beta.

My recommendation is to do it, with the flag defaulting to shadow mode, and to enforce on green before red.

## What we have now

`runAi` in `src/stages/ai.ts` reads the plain variable `MODERATION_ENFORCE`. Only the exact string `"true"` makes a Jev "drop" verdict actually drop the page. Anything else is shadow mode: the page is delivered, and the log row records `ai_decision = 'drop'` with an `ai_reason` that starts `shadow:`.

The variable lives in `wrangler.jsonc` and is `"false"`. Changing it means a code change, a commit and a deploy.

## What Flagship is

- A feature-flag service run by Cloudflare, evaluated inside Workers through a native binding. There is no outbound HTTP call and no API token to manage.
- Flag values can be booleans, strings, numbers or JSON.
- Flags can have targeting rules that compare attributes you pass in (for example `channel equals green`) and serve a different value when they match.
- Every create, update and delete is recorded, and `wrangler flagship flags changelog` shows the history.
- It went into public beta on 26 May 2026. Wrangler still labels every `flagship` command "[open beta]".
- Wrangler 4.107.0 or later is needed for the `wrangler flagship` commands. We are on 4.151.0.

## How the flag would behave

### Reading the flag

The binding exposes `getBooleanValue(flagKey, defaultValue, context)`. The docs say that for known failures, such as a missing flag or a type mismatch, it returns the default you pass in. They also say that "unexpected runtime failures can still throw".

So the code should pass `false` as the default and treat a thrown error as `false` too. Either way the result is shadow mode, so a Flagship problem can never cause pages to be dropped. That matches the rule we already follow for Jev and for the rate limiter's Workers KV store: if a dependency fails, deliver the page.

### Turning it off quickly

When a flag is disabled, Flagship serves its default variation and ignores every targeting rule. If the default is "off", `wrangler flagship flags disable` becomes an instant return to shadow mode for both channels.

### Changes are not instant

The docs say a flag change can take **up to 30 seconds** to reach every location. During that window some pages may be judged under the old setting. For this system that seems acceptable, since the old setting is either "deliver everything" or the enforcement you had already chosen.

### Different settings per channel

The binding takes an evaluation context. If we pass `{ channel: payload.channel }`, a rule such as `serve=on; when=channel equals green` enforces on green while red keeps the default. String comparisons are case-sensitive. A rule that names an attribute missing from the context never matches.

In my view per-channel enforcement is the most useful part of the move. Green is the awake channel and has the more tolerant threshold, so it is the safer place to start dropping spam for real.

### Local development and tests

The docs say `wrangler dev` uses the live Flagship app and that there is no local flag store. Wrangler 4.151.0 contradicts that slightly: it has `wrangler flagship flags pull` ("into the local flag store") and `--local` options on several commands. I have not tested either. It's worth checking before relying on local runs.

The unit tests would not touch Flagship. They already build a fake `env`, and we would add a fake `FLAGS` object whose `getBooleanValue` returns whatever the test needs, or throws.

## The code change

In `src/stages/ai.ts`, replace the string check:

```typescript
if ((env.MODERATION_ENFORCE as string) !== "true") {
```

with a call to a small helper, evaluated only when Jev has said "drop":

```typescript
/** Shadow mode unless Flagship says otherwise; any Flagship failure also means shadow. */
async function enforcementOn(env: Env, channel: Payload["channel"]): Promise<boolean> {
  try {
    return await env.FLAGS.getBooleanValue("moderation-enforce", false, { channel })
  } catch {
    return false
  }
}
```

Other changes that follow from it:

- `wrangler.jsonc`: add the `flagship` binding block, remove `MODERATION_ENFORCE` from `vars`.
- `pnpm run types` to regenerate `worker-configuration.d.ts`. `FLAGS` becomes type `Flagship`, and the cast in the current code goes away.
- `test/ai.test.ts`: swap `MODERATION_ENFORCE` in the fake env for a fake `FLAGS`. Add tests for "flag throws" and "flag returns false" (both must deliver) and for a per-channel answer.
- `AGENTS.md` and `README.md`: describe the flag instead of the variable.

Estimate: about an hour, including tests.

## Setting it up

These are the commands from the docs and the local help text. `<APP_ID>` comes from the first command's output.

```bash
# Create the app and add the binding to wrangler.jsonc
pnpm exec wrangler flagship apps create syn-horse-notifications --binding FLAGS --update-config

# Boolean flag: Wrangler creates on=true and off=false, serving off by default
pnpm exec wrangler flagship flags create <APP_ID> moderation-enforce \
  --description "Drop pages Jev judges as spam or gibberish. Off means shadow mode."
```

Once you're happy with the shadow-mode results on green, enforce on green only:

```bash
pnpm exec wrangler flagship flags update <APP_ID> moderation-enforce --add-rule "serve=on; when=channel equals green"
```

Later, enforce on both channels by making "on" the default:

```bash
pnpm exec wrangler flagship flags update <APP_ID> moderation-enforce --default on
```

Disabling the flag returns both channels to shadow mode at once:

```bash
pnpm exec wrangler flagship flags disable <APP_ID> moderation-enforce
```

This shows the value a channel receives right now:

```bash
pnpm exec wrangler flagship flags evaluate <APP_ID> moderation-enforce --context channel=red
```

## Things worth deciding

1. **Beta status.** Flagship is in public beta. Because every failure falls back to shadow mode, the worst a Flagship fault can do is stop enforcement. It cannot drop pages. My view is that this makes the beta acceptable here.
2. **Price.** I could not find a pricing page for Flagship in the docs. Check the dashboard or the Workers pricing page before turning it on.
3. **Thresholds as flags too?** Flagship can serve numbers and JSON, so `DROP_AT` and `HIJACK_AT` could move into a flag as well. My view is no, for now. They must change only alongside the fixture tests that prove what each threshold drops, and a dashboard edit skips those tests.
4. **Recording the mode.** The log row already shows whether a drop was enforced: a shadow drop has `result = 'delivered'` and the `shadow:` prefix. If you also want to know *why* a page was in shadow mode (flag off, flag disabled, or Flagship unreachable), `getBooleanDetails` returns a `reason` that could go into `ai_reason`. I would skip this unless it turns out to matter.
5. **Removing the variable.** I would delete `MODERATION_ENFORCE` in the same change rather than keep both. Two switches for one behaviour is how a page gets dropped by surprise.

## Sources

- Flagship overview: <https://developers.cloudflare.com/flagship/>
- Binding and methods, including error handling: <https://developers.cloudflare.com/flagship/binding/methods/>
- Configuration and local development: <https://developers.cloudflare.com/flagship/configuration/>
- Concepts, evaluation context and propagation: <https://developers.cloudflare.com/flagship/concepts/>
- Targeting rules and operators: <https://developers.cloudflare.com/flagship/targeting/>
- Limits: <https://developers.cloudflare.com/flagship/reference/limits/>
- Wrangler commands: <https://developers.cloudflare.com/flagship/reference/wrangler-commands/>
- Public beta announcement, 26 May 2026: <https://developers.cloudflare.com/changelog/post/2026-05-26-public-beta/>
