import Anthropic from '@anthropic-ai/sdk';
import { buildNarrativePrompt, type ScoredSignal } from '@psx/engine';
import type { Env } from '../env.js';

/**
 * The LLM pass over a prediction's factor table.
 *
 * The factor table is the explanation. This writes prose over it, and the
 * ordering is the whole design: `summarise` in `@psx/engine` already produces
 * a readable paragraph from the same numbers the score came from, with no
 * network and no cost, and that is what the app shows unless this succeeds.
 * An expired key, a rate limit or an outage therefore costs prose quality and
 * nothing else — a prediction is never left without an explanation.
 *
 * Injected rather than imported at the call site, in the same shape as the
 * mailer, so the tests can prove the fallback paths without a key or a
 * network. `createRecordingWriter` is the double.
 */

export interface NarrativeRequest {
  signal: ScoredSignal;
}

export type NarrativeOutcome =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number }
  /**
   * Every failure is a reason, never a throw. The caller's job is to fall back
   * to the deterministic summary, and making that a normal return value rather
   * than an exception is what keeps the fallback impossible to forget.
   */
  | { ok: false; reason: NarrativeFailure; detail: string };

export type NarrativeFailure =
  /** No key configured, so the pass is off. Not an error. */
  | 'DISABLED'
  /** The key was rejected. Worth logging loudly: it will not fix itself. */
  | 'AUTH'
  | 'RATE_LIMITED'
  /** A 400: almost always a model id or a parameter this model refuses. */
  | 'BAD_REQUEST'
  /** The model's safety classifiers declined. */
  | 'REFUSED'
  /** Ran into `max_tokens`, so the prose is cut off mid-sentence. */
  | 'TRUNCATED'
  /** Replied with no text block at all. */
  | 'EMPTY'
  | 'TIMEOUT'
  | 'API_ERROR'
  /** The process call budget, checked by the caller. */
  | 'BUDGET_SPENT';

export interface NarrativeWriter {
  /** False when no key is configured, so callers can skip the work entirely. */
  readonly enabled: boolean;
  readonly model: string;
  write: (request: NarrativeRequest) => Promise<NarrativeOutcome>;
  /** For the startup log. Never includes the key. */
  describe: () => string;
}

/** Nothing here waits longer than this; a slow narrative is a failed one. */
const REQUEST_TIMEOUT_MS = 20_000;

export function createNarrativeWriter(
  env: Env,
  log: (message: string) => void = console.log,
): NarrativeWriter {
  const key = env.ANTHROPIC_API_KEY?.trim() ?? '';

  if (key === '') {
    return {
      enabled: false,
      model: env.NARRATIVE_MODEL,
      describe: () => 'off (no ANTHROPIC_API_KEY); using the deterministic summaries',
      write: async () => ({
        ok: false,
        reason: 'DISABLED',
        detail: 'No ANTHROPIC_API_KEY is configured.',
      }),
    };
  }

  /*
   * The call budget, held here rather than at the call sites.
   *
   * Encapsulated because a counter the callers have to initialise is a counter
   * someone forgets: there are three entry points (the server, the nightly job
   * and the tests) and the one that forgets is the one that runs away. Living
   * in the writer, it is initialised exactly where the writer is built, from
   * the same config.
   */
  let remaining = env.NARRATIVE_CALL_BUDGET;

  const client = new Anthropic({
    apiKey: key,
    // Explicit, so the SDK cannot pick up an ANTHROPIC_BASE_URL set on this
    // machine for something else. See the note in env.ts.
    baseURL: env.ANTHROPIC_BASE_URL,
    // One retry, not the SDK's default of two. A narrative is worth a second
    // attempt and not a third: the caller has a free, instant alternative, and
    // a user waiting on a page should not pay for three round trips.
    maxRetries: 1,
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (env.ANTHROPIC_BASE_URL !== 'https://api.anthropic.com') {
    log(`[narrative] WARNING: sending prompts to ${env.ANTHROPIC_BASE_URL}, not the Anthropic API`);
  }

  return {
    enabled: true,
    model: env.NARRATIVE_MODEL,
    describe: () =>
      `${env.NARRATIVE_MODEL} via ${env.ANTHROPIC_BASE_URL}` +
      (env.ANTHROPIC_BASE_URL === 'https://api.anthropic.com' ? '' : ' (overridden)'),

    write: async ({ signal }) => {
      if (remaining <= 0) {
        return {
          ok: false,
          reason: 'BUDGET_SPENT',
          detail:
            `This process has used its budget of ${env.NARRATIVE_CALL_BUDGET} narrative ` +
            `calls. Reaching it means something is generating in a loop; restarting resets ` +
            `it, and NARRATIVE_CALL_BUDGET raises it.`,
        };
      }
      remaining -= 1;

      const prompt = buildNarrativePrompt(signal);

      try {
        /*
         * The parameters here are deliberately sparse, and each omission is a
         * current-model breaking change rather than an oversight:
         *
         * - No `temperature` or other sampling parameter. Haiku 5.5 returns a
         *   400 for any non-default sampling.
         * - No `thinking`. Adaptive thinking is the default on every current
         *   model and never fails, whereas `{type: "disabled"}` is a 400 on
         *   Sonnet 5.5 at every effort level, and `budget_tokens` has been
         *   removed outright.
         * - Depth is controlled through `output_config.effort` instead, which
         *   both Sonnet 5.5 and Haiku 5.5 accept. `low` is right for five
         *   sentences over a table that is already scored; Sonnet 5.5 would
         *   otherwise default to `high` and think at length about nothing.
         */
        const response = await client.messages.create({
          model: env.NARRATIVE_MODEL,
          max_tokens: env.NARRATIVE_MAX_TOKENS,
          output_config: { effort: 'low' },
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        });

        if (response.stop_reason === 'refusal') {
          return {
            ok: false,
            reason: 'REFUSED',
            detail: `The model declined to write about ${signal.symbol}.`,
          };
        }

        if (response.stop_reason === 'max_tokens') {
          // Discarded rather than shown: prose that stops mid-sentence reads as
          // a broken product, and the deterministic summary is complete.
          return {
            ok: false,
            reason: 'TRUNCATED',
            detail: `Hit max_tokens (${env.NARRATIVE_MAX_TOKENS}) before finishing.`,
          };
        }

        // `content` is a discriminated union; narrowing on the tag is required
        // before `.text` exists. Several blocks are possible when the model
        // thinks, so the text blocks are joined rather than indexing [0].
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();

        if (text === '') {
          return { ok: false, reason: 'EMPTY', detail: 'The reply contained no text.' };
        }

        return {
          ok: true,
          text,
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
      } catch (error) {
        return { ok: false, ...classify(error) };
      }
    },
  };
}

/**
 * Maps a thrown SDK error to a reason, most specific class first.
 *
 * Kept separate from `write` so the mapping can be read at a glance: which
 * failures are worth an operator's attention (a rejected key, a 400 naming a
 * parameter) and which are weather (a rate limit, a timeout).
 */
function classify(error: unknown): { reason: NarrativeFailure; detail: string } {
  if (error instanceof Anthropic.AuthenticationError) {
    return {
      reason: 'AUTH',
      detail: 'The Anthropic API rejected the key. Check ANTHROPIC_API_KEY.',
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { reason: 'RATE_LIMITED', detail: 'Rate limited by the Anthropic API.' };
  }
  if (error instanceof Anthropic.BadRequestError) {
    // The message matters here in a way it does not elsewhere: a 400 usually
    // names the model id or the parameter it refused, which is the one thing
    // that tells an operator what to change.
    return { reason: 'BAD_REQUEST', detail: error.message };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { reason: 'TIMEOUT', detail: `No reply within ${REQUEST_TIMEOUT_MS}ms.` };
  }
  if (error instanceof Anthropic.APIError) {
    return { reason: 'API_ERROR', detail: `${error.status ?? '?'}: ${error.message}` };
  }
  return {
    reason: 'API_ERROR',
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * A writer that returns canned prose and records what it was asked.
 *
 * The tests need to exercise four paths — accepted, rejected by the validator,
 * failed, and never called — and none of them should depend on a key, a
 * network or a model's mood.
 */
export function createRecordingWriter(
  responder: (signal: ScoredSignal) => NarrativeOutcome = defaultResponse,
  options: { enabled?: boolean } = {},
): NarrativeWriter & { calls: ScoredSignal[] } {
  const calls: ScoredSignal[] = [];
  return {
    calls,
    enabled: options.enabled ?? true,
    model: 'recording-writer',
    describe: () => 'recording (test)',
    write: async ({ signal }) => {
      calls.push(signal);
      return responder(signal);
    },
  };
}

function defaultResponse(signal: ScoredSignal): NarrativeOutcome {
  return {
    ok: true,
    text:
      `${signal.symbol} reads as ${signal.action.toLowerCase().replace('_', ' ')} on the ` +
      `factors that could be assessed. Although some measures argue the other way, the ` +
      `balance of the table points one direction. This sentence exists so the test prose ` +
      `is long enough to be realistic.`,
    model: 'recording-writer',
    inputTokens: 100,
    outputTokens: 50,
  };
}
