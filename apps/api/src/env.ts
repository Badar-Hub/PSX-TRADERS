import { z } from 'zod';

/**
 * Environment validated once, at startup.
 *
 * A missing JWT secret or a malformed database URL should stop the process
 * immediately with a readable message, not surface as a confusing 500 on the
 * first login attempt an hour later. The schema also refuses the placeholder
 * secrets from `.env.example`, since a deployment running on "change-me" signs
 * tokens anyone can forge.
 */

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  /** Where the sign-in link in emails points. */
  APP_URL: z.string().url().default('http://localhost:3000'),

  /**
   * `console` prints mail instead of sending it, for running with no mail
   * server. Refused in production by `createMailer`, because a verification
   * email written to stdout is an account nobody can verify.
   */
  EMAIL_TRANSPORT: z.enum(['smtp', 'console']).default('smtp'),
  /**
   * 127.0.0.1, not "localhost".
   *
   * Node resolves "localhost" to ::1 before 127.0.0.1, and a local mail catcher
   * bound to 127.0.0.1 — which is what `docker run -p 1025:1025` gives you —
   * refuses the IPv6 connection. The failure reads `ECONNREFUSED ::1:1025`,
   * which looks like the mail server is down rather than listening on the
   * other loopback.
   */
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((value) => value === true || value === 'true')
    .default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('PSX Trader <no-reply@psx-trader.local>'),

  /**
   * Ten minutes, as asked for. Short enough that a code read off a screen or
   * forwarded inbox is stale quickly, long enough to survive mail delivery and
   * someone switching between their phone and their laptop.
   */
  VERIFICATION_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  /** Wrong guesses before the code is burned. Five is enough for a typo. */
  VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** Stops a resend button from becoming a way to mail-bomb someone. */
  VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  /**
   * Per-IP request budgets over 15 minutes, for the credential and code
   * endpoints respectively.
   *
   * Configurable rather than fixed so the test suite can raise them. With the
   * production values, a suite that signs up thirty accounts from one address
   * trips the limiter and every later assertion fails on a 429 instead of
   * testing what it claims to. Raising them in `.env.test` also means the
   * resend test's 429 comes from the per-account cooldown it is actually
   * about, not from the IP limiter shadowing it.
   */
  AUTH_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(20),
  CODE_RATE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(10),

  PSX_DOWNLOAD_BASE: z.string().url().default('https://dps.psx.com.pk/download'),

  /**
   * Absent or empty means the LLM narrative pass is off and the app shows the
   * deterministic summaries. That is a supported way to run, not a degraded
   * one: the factor table is the explanation, and the prose is a rendering of
   * it.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  NARRATIVE_MODEL: z.string().default('claude-sonnet-5-5'),

  /**
   * Pinned explicitly rather than left to the SDK.
   *
   * The Anthropic SDK reads `ANTHROPIC_BASE_URL` from the environment by
   * itself, so on a machine where that is set for some other tool — a proxy, a
   * gateway, a local recorder — this app would quietly send its prompts there
   * instead. Reading it through the schema means the value is validated, it
   * appears in the startup log when it is not the official endpoint, and
   * redirecting the app takes a deliberate change to its own configuration.
   */
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),

  /** Enough for five sentences with room to spare; a cut-off reply is discarded. */
  NARRATIVE_MAX_TOKENS: z.coerce.number().int().min(256).max(8_000).default(1_024),

  /**
   * A ceiling on generations, counted per process rather than per day.
   *
   * Not a budget so much as a blast radius: narratives are written for the
   * symbols actually looked at, a handful a day, so reaching this means
   * something is looping — and the realistic loop is inside one run of the
   * nightly job. A counter that lives as long as the process catches exactly
   * that, and restarting resets it, which is the honest limitation of not
   * having a column to count from. The app falls back to the deterministic
   * summaries when it trips, so a wrong guess here costs prose, not function.
   */
  NARRATIVE_CALL_BUDGET: z.coerce.number().int().min(0).max(100_000).default(250),
});

export type Env = z.infer<typeof Schema> & { corsOrigins: string[] };

/**
 * Matched as a substring, not compared for equality.
 *
 * The length rule below would catch "change-me-access" on its own, but it would
 * happily accept a 40-character "change-me-change-me-change-me-change-me". The
 * substring scan also runs before the schema, so the message says the secret is
 * a placeholder rather than that it is too short, which is the more useful
 * thing to be told.
 */
const PLACEHOLDER_PATTERN = /change[-_ ]?me|changeme|your[-_]secret|secret[-_]here|placeholder|xxxxx/i;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    const value = source[key];
    if (value !== undefined && PLACEHOLDER_PATTERN.test(value)) {
      throw new Error(
        `${key} still looks like the placeholder from .env.example. Generate a real one ` +
          `with \`openssl rand -hex 32\` before starting the server.`,
      );
    }
  }

  const parsed = Schema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  const env = parsed.data;

  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ, or a refresh token ' +
        'would be accepted as an access token.',
    );
  }

  return {
    ...env,
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}
