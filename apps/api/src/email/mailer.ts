import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../env.js';

/**
 * Outbound email.
 *
 * SMTP rather than a provider SDK, because SMTP works with everything: Mailpit
 * in development, a Gmail app password for a handful of friends, and SES,
 * Postmark or Resend later without touching this file. The only cost is that
 * deliverability tuning (SPF, DKIM, a warmed sending domain) becomes the
 * provider's job rather than something a library hides.
 *
 * Two transports:
 *
 * - `smtp` sends for real. In development that means Mailpit on localhost:1025,
 *   which accepts anything and shows it in a web UI, so the whole flow can be
 *   exercised without signing up to a provider or mailing a real address.
 * - `console` prints the message instead of sending it, for running the app with
 *   no mail server at all. It is refused in production: an account-verification
 *   email that silently goes to stdout is an account nobody can ever verify.
 */

export interface SendOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send: (options: SendOptions) => Promise<void>;
  /** Describes where mail is going, for the startup log. */
  describe: () => string;
}

export class EmailError extends Error {}

export function createMailer(env: Env, log: (message: string) => void = console.log): Mailer {
  if (env.EMAIL_TRANSPORT === 'console') {
    if (env.NODE_ENV === 'production') {
      throw new EmailError(
        'EMAIL_TRANSPORT=console is refused in production. A verification email ' +
          'printed to stdout is an account that can never be verified.',
      );
    }
    return {
      describe: () => 'console (not sending real email)',
      send: async (options) => {
        log(
          [
            '',
            '──────── email (console transport) ────────',
            `to:      ${options.to}`,
            `subject: ${options.subject}`,
            '',
            options.text,
            '───────────────────────────────────────────',
            '',
          ].join('\n'),
        );
      },
    };
  }

  const transporter: Transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Mailpit and most local catchers speak plain SMTP on 1025 with no auth and
    // no TLS, so neither is forced on.
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER !== undefined && env.SMTP_USER !== ''
      ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } }
      : {}),
  });

  return {
    describe: () => `smtp ${env.SMTP_HOST}:${env.SMTP_PORT}${env.SMTP_SECURE ? ' (tls)' : ''}`,
    send: async (options) => {
      try {
        await transporter.sendMail({
          from: env.EMAIL_FROM,
          to: options.to,
          subject: options.subject,
          text: options.text,
          ...(options.html !== undefined ? { html: options.html } : {}),
        });
      } catch (error) {
        // Wrapped so a route can tell a delivery failure from a database one.
        // The caller decides what to do about it; see the note in verification.ts
        // about not rolling back an account because the mail server blipped.
        throw new EmailError(
          `Could not send mail to ${options.to}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

/** A mailer that records what it would have sent. Used by the tests. */
export function createRecordingMailer(): Mailer & { sent: SendOptions[] } {
  const sent: SendOptions[] = [];
  return {
    sent,
    describe: () => 'recording (test)',
    send: async (options) => {
      sent.push(options);
    },
  };
}
