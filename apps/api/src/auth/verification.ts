import { createHash, randomInt } from 'node:crypto';
import type { User } from '@prisma/client';
import { tooManyRequests } from '../http/errors.js';
import { prisma } from '../db/prisma.js';
import type { Env } from '../env.js';
import type { Mailer } from '../email/mailer.js';
import {
  awaitingApprovalEmail,
  newSignupEmail,
  verificationCodeEmail,
} from '../email/templates.js';

/**
 * Email verification.
 *
 * A six-digit code, emailed, valid ten minutes, single use.
 *
 * Six digits rather than a long link because the code has to be typed into a
 * phone app as well as a browser, and a link that opens a browser does not help
 * someone sitting in the React Native sign-up screen. The cost is that six
 * digits is only a million possibilities, so the guessing budget does the work
 * that length would otherwise do: five wrong attempts burn the code, and a
 * resend is rate-limited. Guessing therefore costs an email round trip per five
 * tries instead of being free.
 *
 * `randomInt` from node:crypto, not `Math.random`. A predictable code is the
 * same as no code at all, and `Math.random` is seeded per process.
 *
 * Only a hash is stored. That alone would not stop an offline search of a
 * million candidates, but it does mean a casual look at the table, a log line
 * or a backup does not hand over live codes.
 */

export const CODE_LENGTH = 6;

export function generateCode(): string {
  // randomInt is uniform over the range; building the number digit by digit
  // from a biased source would skew the distribution.
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface VerificationConfig {
  ttlMinutes: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
}

export function configFromEnv(env: Env): VerificationConfig {
  return {
    ttlMinutes: env.VERIFICATION_TTL_MINUTES,
    maxAttempts: env.VERIFICATION_MAX_ATTEMPTS,
    resendCooldownSeconds: env.VERIFICATION_RESEND_COOLDOWN_SECONDS,
  };
}

/**
 * Issues a code and emails it.
 *
 * Any earlier unconsumed code is superseded first, so a resend invalidates the
 * previous one. Leaving both live would mean the oldest code stays valid for
 * its full ten minutes after the user has asked for a fresh one, which is the
 * opposite of what a resend implies.
 *
 * The mail is sent after the row is committed. If delivery then fails the row
 * is left in place rather than rolled back: the user can press resend, and
 * discarding a perfectly good account because a mail server blipped is worse
 * than a code nobody reads.
 */
export async function issueVerificationCode(
  user: Pick<User, 'id' | 'email' | 'name'>,
  config: VerificationConfig,
  mailer: Mailer,
): Promise<{ expiresAt: Date }> {
  const now = new Date();

  const recent = await prisma.emailVerification.findFirst({
    where: {
      userId: user.id,
      purpose: 'EMAIL_VERIFICATION',
      consumedAt: null,
      supersededAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });

  if (recent !== null) {
    const elapsed = (now.getTime() - recent.createdAt.getTime()) / 1000;
    if (elapsed < config.resendCooldownSeconds) {
      throw tooManyRequests(
        `A code was already sent. Try again in ${Math.ceil(config.resendCooldownSeconds - elapsed)} seconds.`,
      );
    }
  }

  const code = generateCode();
  const expiresAt = new Date(now.getTime() + config.ttlMinutes * 60_000);

  await prisma.$transaction(async (tx) => {
    await tx.emailVerification.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', consumedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
    await tx.emailVerification.create({
      data: {
        userId: user.id,
        purpose: 'EMAIL_VERIFICATION',
        codeHash: hashCode(code),
        sentTo: user.email,
        expiresAt,
      },
    });
  });

  await mailer.send(
    verificationCodeEmail({
      to: user.email,
      name: user.name,
      code,
      ttlMinutes: config.ttlMinutes,
    }),
  );

  return { expiresAt };
}

export type VerifyFailure =
  | 'NO_CODE'
  | 'EXPIRED'
  | 'WRONG_CODE'
  | 'SUPERSEDED'
  | 'TOO_MANY_ATTEMPTS';

export type VerifyOutcome =
  | { ok: true; user: User }
  | { ok: false; reason: VerifyFailure; attemptsLeft: number };

/**
 * Checks a code and, on success, moves the account to PENDING_APPROVAL.
 *
 * Verification never grants access on its own. It only proves the address, and
 * the account then waits for an admin, which is the second gate.
 */
export async function verifyCode(
  email: string,
  code: string,
  config: VerificationConfig,
  mailer: Mailer,
  appUrl: string,
): Promise<VerifyOutcome> {
  const user = await prisma.user.findUnique({ where: { email } });

  // No user, or a user who is already past this gate. Both are reported as
  // NO_CODE rather than distinguished: telling a caller "that address has no
  // pending code" versus "that address does not exist" is an enumeration oracle.
  if (user === null || user.status !== 'PENDING_VERIFICATION') {
    return { ok: false, reason: 'NO_CODE', attemptsLeft: 0 };
  }

  const record = await prisma.emailVerification.findFirst({
    where: {
      userId: user.id,
      purpose: 'EMAIL_VERIFICATION',
      consumedAt: null,
      supersededAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (record === null) return { ok: false, reason: 'NO_CODE', attemptsLeft: 0 };

  if (record.attempts >= config.maxAttempts) {
    return { ok: false, reason: 'TOO_MANY_ATTEMPTS', attemptsLeft: 0 };
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'EXPIRED', attemptsLeft: 0 };
  }

  const submitted = hashCode(code);

  if (record.codeHash !== submitted) {
    // Before counting it as a wrong guess, check whether they typed a code we
    // ourselves replaced. Someone who presses resend and then pastes the code
    // from the first email is an ordinary user, not an attacker, and should not
    // lose one of five attempts on the live code for it. This reveals nothing:
    // an attacker already knows a superseded code does not work.
    const superseded = await prisma.emailVerification.findFirst({
      where: {
        userId: user.id,
        purpose: 'EMAIL_VERIFICATION',
        consumedAt: null,
        supersededAt: { not: null },
        codeHash: submitted,
      },
      select: { id: true },
    });

    if (superseded !== null) {
      return {
        ok: false,
        reason: 'SUPERSEDED',
        attemptsLeft: Math.max(0, config.maxAttempts - record.attempts),
      };
    }

    // The attempt is counted before anything is returned, so a wrong guess
    // costs the attacker one of five whether or not they wait for the response.
    const updated = await prisma.emailVerification.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return {
      ok: false,
      reason: 'WRONG_CODE',
      attemptsLeft: Math.max(0, config.maxAttempts - updated.attempts),
    };
  }

  const verified = await prisma.$transaction(async (tx) => {
    await tx.emailVerification.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return tx.user.update({
      where: { id: user.id },
      data: { status: 'PENDING_APPROVAL', emailVerifiedAt: new Date() },
    });
  });

  // Told that the wait is deliberate, rather than left wondering.
  await mailer.send(awaitingApprovalEmail({ to: verified.email, name: verified.name }));
  await notifyAdminsOfSignup(verified, mailer, appUrl);

  return { ok: true, user: verified };
}

/**
 * Emails the admins that someone is in the queue.
 *
 * Best effort: a failure here must not fail the user's verification, which has
 * already happened and is none of their business to retry. With no admin yet
 * (a fresh install) there is nobody to tell, and that is not an error either.
 */
async function notifyAdminsOfSignup(
  applicant: User,
  mailer: Mailer,
  appUrl: string,
): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', status: 'ACTIVE' },
      select: { email: true },
    });

    for (const admin of admins) {
      await mailer.send(
        newSignupEmail({
          to: admin.email,
          applicantEmail: applicant.email,
          applicantName: applicant.name,
          adminUrl: `${appUrl}/admin/users`,
        }),
      );
    }
  } catch (error) {
    console.error('[verification] could not notify admins:', error);
  }
}

/** Removes expired and consumed rows. Called by the nightly job. */
export async function pruneVerifications(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const { count } = await prisma.emailVerification.deleteMany({
    where: {
      OR: [
        { consumedAt: { lt: cutoff } },
        { expiresAt: { lt: cutoff } },
        { supersededAt: { lt: cutoff } },
      ],
    },
  });
  return count;
}
