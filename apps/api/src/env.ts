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

  PSX_DOWNLOAD_BASE: z.string().url().default('https://dps.psx.com.pk/download'),

  ANTHROPIC_API_KEY: z.string().optional(),
  NARRATIVE_MODEL: z.string().default('claude-sonnet-5-5'),
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
