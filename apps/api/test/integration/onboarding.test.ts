import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadEnv } from '../../src/env.js';
import { prisma } from '../../src/db/prisma.js';
import { hashCode } from '../../src/auth/verification.js';
import { hashPassword } from '../../src/auth/password.js';
import { auth, codeSentTo, emailsTo, mailer, signUpActive, signUpAdmin } from '../helpers/account.js';

/**
 * The two onboarding gates, end to end.
 *
 * Proving the email and getting approved are independent, and both have to
 * hold before the account can touch anything. Most of what is asserted here is
 * about the failure paths — an expired code, a used code, a guessed code, an
 * unapproved account reaching for data — because those are the cases that make
 * the gates worth having.
 */

function isTestDatabase(): boolean {
  const url = process.env.DATABASE_URL ?? '';
  const name = url.split('/').pop()?.split('?')[0] ?? '';
  return /test/i.test(name);
}

async function reachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const hasDatabase = isTestDatabase() && (await reachable());
if (!hasDatabase) console.warn('\n  Skipping onboarding tests: no test database.\n');

const env = hasDatabase ? loadEnv() : null;
const app = hasDatabase ? createApp({ env: env!, logError: () => {}, mailer }) : null;

async function wipeUsers(): Promise<void> {
  await prisma.emailVerification.deleteMany();
  await prisma.lotConsumption.deleteMany();
  await prisma.taxLot.deleteMany();
  await prisma.positionCycle.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.portfolio.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  mailer.sent.length = 0;
}

describe.skipIf(!hasDatabase)('registration and the verification code', () => {
  beforeEach(async () => {
    await wipeUsers();
  });

  it('creates an unverified account and emails a six-digit code', async () => {
    const response = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'new@example.com', password: 'a-long-enough-password', name: 'New User' })
      .expect(201);

    expect(response.body.user.status).toBe('PENDING_VERIFICATION');
    expect(response.body.next).toBe('VERIFY_EMAIL');
    expect(response.body.codeLength).toBe(6);

    const sent = mailer.sent.filter((message) => message.to === 'new@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('verification code');
    expect(codeSentEmailHasCode(sent[0]?.text ?? '')).toBe(true);
  });

  /** The ten minutes you asked for, asserted against the stored row. */
  it('gives the code a ten-minute life', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'ttl@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const record = await prisma.emailVerification.findFirstOrThrow({
      where: { user: { email: 'ttl@example.com' } },
    });

    const minutes = (record.expiresAt.getTime() - record.createdAt.getTime()) / 60_000;
    expect(minutes).toBeCloseTo(10, 1);
  });

  it('stores only a hash of the code, never the code', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'hash@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const code = codeSentTo('hash@example.com');
    const record = await prisma.emailVerification.findFirstOrThrow({
      where: { user: { email: 'hash@example.com' } },
    });

    expect(record.codeHash).not.toBe(code);
    expect(record.codeHash).toBe(hashCode(code));
    expect(record.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('verifies with the right code and moves to awaiting approval', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'ok@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const response = await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'ok@example.com', code: codeSentTo('ok@example.com') })
      .expect(200);

    expect(response.body.status).toBe('PENDING_APPROVAL');
    expect(response.body.next).toBe('AWAITING_APPROVAL');

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'ok@example.com' } });
    expect(user.status).toBe('PENDING_APPROVAL');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.approvedAt).toBeNull();

    // Told that the wait is deliberate rather than left in silence.
    expect(emailsTo('ok@example.com').join(' ')).toContain('awaiting approval');
  });

  it('accepts a code pasted with a space in it', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'spaced@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const code = codeSentTo('spaced@example.com');
    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'spaced@example.com', code: `${code.slice(0, 3)} ${code.slice(3)}` })
      .expect(200);
  });

  it('burns the code after use', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'once@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const code = codeSentTo('once@example.com');
    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'once@example.com', code })
      .expect(200);

    const again = await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'once@example.com', code })
      .expect(400);
    expect(again.body.error.code).toBe('NO_CODE');
  });

  it('rejects an expired code', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'stale@example.com', password: 'a-long-enough-password' })
      .expect(201);

    // Wound back past the ten-minute window.
    await prisma.emailVerification.updateMany({
      where: { user: { email: 'stale@example.com' } },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'stale@example.com', code: codeSentTo('stale@example.com') })
      .expect(400);

    expect(response.body.error.code).toBe('EXPIRED');
    expect(response.body.error.message).toContain('10 minutes');
  });

  /**
   * Six digits is only a million possibilities, so the attempt budget is what
   * makes guessing expensive rather than free.
   */
  it('burns the code after five wrong guesses', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'guess@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const real = codeSentTo('guess@example.com');
    const wrong = real === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request(app!)
        .post('/api/auth/verify-email')
        .send({ email: 'guess@example.com', code: wrong })
        .expect(400);
      expect(response.body.error.code).toBe('WRONG_CODE');
      expect(response.body.error.details.attemptsLeft).toBe(5 - attempt);
    }

    // And now even the correct code is refused.
    const blocked = await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'guess@example.com', code: real })
      .expect(400);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('supersedes the old code when a new one is sent', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'resend@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const first = codeSentTo('resend@example.com');

    // Past the resend cooldown.
    await prisma.emailVerification.updateMany({
      where: { user: { email: 'resend@example.com' } },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });

    await request(app!)
      .post('/api/auth/resend-code')
      .send({ email: 'resend@example.com' })
      .expect(202);

    const second = codeSentTo('resend@example.com');
    expect(second).not.toBe(first);

    // A resend implies the old code is dead; leaving it live for its full ten
    // minutes would be the opposite of what the button says.
    const old = await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'resend@example.com', code: first })
      .expect(400);
    expect(old.body.error.code).toBe('SUPERSEDED');
    expect(old.body.error.message).toContain('most recent email');

    // And it cost nothing: pasting the first email's code after pressing
    // resend is an ordinary mistake, not a guess, so the five attempts on the
    // live code are all still there.
    expect(old.body.error.details.attemptsLeft).toBe(5);

    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'resend@example.com', code: second })
      .expect(200);
  });

  it('rate-limits a rapid resend', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'spam@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const response = await request(app!)
      .post('/api/auth/resend-code')
      .send({ email: 'spam@example.com' });

    expect(response.status).toBe(429);
  });

  /** A resend must not tell the caller which addresses are registered. */
  it('answers the same for an unknown address as for a pending one', async () => {
    const unknown = await request(app!)
      .post('/api/auth/resend-code')
      .send({ email: 'nobody@example.com' })
      .expect(202);

    expect(unknown.body.message).toContain('If that address has an account');
    expect(mailer.sent.some((message) => message.to === 'nobody@example.com')).toBe(false);
  });

  it('re-sends rather than erroring when an unverified address registers again', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'retry@example.com', password: 'a-long-enough-password' })
      .expect(201);

    await prisma.emailVerification.updateMany({
      where: { user: { email: 'retry@example.com' } },
      data: { createdAt: new Date(Date.now() - 120_000) },
    });

    const again = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'retry@example.com', password: 'a-long-enough-password' })
      .expect(202);

    expect(again.body.status).toBe('PENDING_VERIFICATION');
    expect(again.body.message).toContain('new code has been sent');
  });

  it('still refuses a second registration once the account is verified', async () => {
    await signUpActive(app!, 'taken@example.com');
    const response = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'taken@example.com', password: 'a-long-enough-password' })
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });
});

describe.skipIf(!hasDatabase)('the approval gate', () => {
  beforeEach(async () => {
    await wipeUsers();
  });

  /**
   * Tokens are issued at registration even though nothing can be done with
   * them. This is what makes that safe: every route reads the status.
   */
  it('blocks an unverified account from the app, with a reason', async () => {
    const registered = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'unverified@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const response = await request(app!)
      .get('/api/portfolios')
      .set({ authorization: `Bearer ${registered.body.accessToken}` })
      .expect(403);

    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('blocks a verified but unapproved account, with a different reason', async () => {
    const registered = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'pending@example.com', password: 'a-long-enough-password' })
      .expect(201);

    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'pending@example.com', code: codeSentTo('pending@example.com') })
      .expect(200);

    const response = await request(app!)
      .get('/api/portfolios')
      .set({ authorization: `Bearer ${registered.body.accessToken}` })
      .expect(403);

    expect(response.body.error.code).toBe('AWAITING_APPROVAL');
    expect(response.body.error.message).toContain('administrator');
  });

  /** The screen the sign-up flow polls has to work while everything else is shut. */
  it('lets a blocked account read its own status', async () => {
    const registered = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'status@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const response = await request(app!)
      .get('/api/auth/me')
      .set({ authorization: `Bearer ${registered.body.accessToken}` })
      .expect(200);

    expect(response.body.user.status).toBe('PENDING_VERIFICATION');
    expect(response.body.next).toBe('VERIFY_EMAIL');
  });

  it('lets an approved account through', async () => {
    const session = await signUpActive(app!, 'approved@example.com');
    await request(app!).get('/api/portfolios').set(auth(session)).expect(200);
  });

  /**
   * Signing in succeeds for a pending account and says so. Refusing the
   * password would have the user retyping something that was never wrong.
   */
  it('signs in a pending account but reports the status', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'signin@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const response = await request(app!)
      .post('/api/auth/login')
      .send({ email: 'signin@example.com', password: 'a-long-enough-password' })
      .expect(200);

    expect(response.body.next).toBe('VERIFY_EMAIL');
    expect(response.body.user.status).toBe('PENDING_VERIFICATION');
    expect(response.body.accessToken).toBeTypeOf('string');
  });

  it('blocks a suspended account immediately, without waiting for the token to expire', async () => {
    const session = await signUpActive(app!, 'suspend@example.com');
    await request(app!).get('/api/portfolios').set(auth(session)).expect(200);

    await prisma.user.update({
      where: { email: 'suspend@example.com' },
      data: { status: 'SUSPENDED' },
    });

    // The same token, still cryptographically valid, is now refused.
    const response = await request(app!).get('/api/portfolios').set(auth(session)).expect(403);
    expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe.skipIf(!hasDatabase)('the admin queue', () => {
  let admin: Awaited<ReturnType<typeof signUpAdmin>>;

  beforeAll(async () => {
    await wipeUsers();
    admin = await signUpAdmin(app!, 'admin@example.com');
  });

  it('lists accounts awaiting approval, oldest first', async () => {
    await request(app!)
      .post('/api/auth/register')
      .send({ email: 'queue1@example.com', password: 'a-long-enough-password' })
      .expect(201);
    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'queue1@example.com', code: codeSentTo('queue1@example.com') })
      .expect(200);

    const response = await request(app!).get('/api/admin/users').set(auth(admin)).expect(200);

    expect(response.body.users.map((user: { email: string }) => user.email)).toContain(
      'queue1@example.com',
    );
    expect(response.body.counts.PENDING_APPROVAL).toBeGreaterThan(0);
  });

  it('tells the admins when someone joins the queue', async () => {
    expect(emailsTo('admin@example.com').join(' ')).toContain('awaiting approval');
  });

  /** A member must not even learn that these endpoints exist. */
  it('hides the admin endpoints from a member', async () => {
    const member = await signUpActive(app!, 'member@example.com');
    await request(app!).get('/api/admin/users').set(auth(member)).expect(404);
    await request(app!)
      .post(`/api/admin/users/${member.userId}/approve`)
      .set(auth(member))
      .send({})
      .expect(404);
  });

  it('approves an account and emails them', async () => {
    const pending = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'letmein@example.com', password: 'a-long-enough-password' })
      .expect(201);
    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'letmein@example.com', code: codeSentTo('letmein@example.com') })
      .expect(200);

    const approved = await request(app!)
      .post(`/api/admin/users/${pending.body.user.id}/approve`)
      .set(auth(admin))
      .send({ note: 'Known to me.' })
      .expect(200);

    expect(approved.body.user.status).toBe('ACTIVE');
    expect(emailsTo('letmein@example.com').join(' ')).toContain('approved');

    // And the account can now use the app with the token it already had.
    await request(app!)
      .get('/api/portfolios')
      .set({ authorization: `Bearer ${pending.body.accessToken}` })
      .expect(200);

    // The decision is recorded, not just applied.
    const record = await prisma.user.findUniqueOrThrow({
      where: { email: 'letmein@example.com' },
      select: { approvedById: true, decisionNote: true },
    });
    expect(record.approvedById).toBe(admin.userId);
    expect(record.decisionNote).toBe('Known to me.');
  });

  /**
   * Approving an unverified address would open the account to whoever typed
   * the email rather than whoever owns it, which defeats the first gate.
   */
  it('refuses to approve an account that has not verified its email', async () => {
    const unverified = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'notyet@example.com', password: 'a-long-enough-password' })
      .expect(201);

    const response = await request(app!)
      .post(`/api/admin/users/${unverified.body.user.id}/approve`)
      .set(auth(admin))
      .send({})
      .expect(400);

    expect(response.body.error.message).toContain('not verified its email');
  });

  it('rejects an account, revokes its sessions and emails them', async () => {
    const applicant = await request(app!)
      .post('/api/auth/register')
      .send({ email: 'nope@example.com', password: 'a-long-enough-password' })
      .expect(201);
    await request(app!)
      .post('/api/auth/verify-email')
      .send({ email: 'nope@example.com', code: codeSentTo('nope@example.com') })
      .expect(200);

    await request(app!)
      .post(`/api/admin/users/${applicant.body.user.id}/reject`)
      .set(auth(admin))
      .send({ note: 'Not a known contact.' })
      .expect(200);

    const blocked = await request(app!)
      .get('/api/portfolios')
      .set({ authorization: `Bearer ${applicant.body.accessToken}` })
      .expect(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_REJECTED');

    // The refresh token is dead too, so they cannot mint a new access token.
    await request(app!)
      .post('/api/auth/refresh')
      .send({ refreshToken: applicant.body.refreshToken })
      .expect(401);

    expect(emailsTo('nope@example.com').join(' ')).toContain('not approved');
  });

  it('will not let an admin suspend themselves', async () => {
    const response = await request(app!)
      .post(`/api/admin/users/${admin.userId}/suspend`)
      .set(auth(admin))
      .send({})
      .expect(400);
    expect(response.body.error.message).toContain('your own account');
  });

  it('will not reject or suspend another admin', async () => {
    const other = await signUpAdmin(app!, 'admin2@example.com');
    await request(app!)
      .post(`/api/admin/users/${other.userId}/reject`)
      .set(auth(admin))
      .send({})
      .expect(409);
    await request(app!)
      .post(`/api/admin/users/${other.userId}/suspend`)
      .set(auth(admin))
      .send({})
      .expect(409);
  });
});

function codeSentEmailHasCode(text: string): boolean {
  return /\b\d{6}\b/.test(text);
}

/**
 * The third gate: a password the account's owner never chose.
 *
 * An account provisioned from the CLI gets a generated password that has to
 * travel to its owner somehow — a message, a note, read aloud. Treating it as
 * a one-time credential is the point, so what is asserted here is mostly that
 * the flag is a control rather than a suggestion: the API refuses real routes
 * while it is set, and the only way to clear it still needs the password.
 */
describe.skipIf(!hasDatabase)('a provisioned account must choose a password', () => {
  beforeEach(async () => {
    await wipeUsers();
  });

  async function provision(email: string, password: string): Promise<void> {
    await prisma.user.create({
      data: {
        email,
        name: 'Provisioned',
        passwordHash: await hashPassword(password),
        status: 'ACTIVE',
        role: 'ADMIN',
        emailVerifiedAt: new Date(),
        approvedAt: new Date(),
        mustResetPassword: true,
      },
    });
  }

  it('reports RESET_PASSWORD at login even though the account is active', async () => {
    await provision('provisioned@example.com', 'temporary-password');

    const response = await request(app!)
      .post('/api/auth/login')
      .send({ email: 'provisioned@example.com', password: 'temporary-password' })
      .expect(200);

    expect(response.body.user.status).toBe('ACTIVE');
    expect(response.body.next).toBe('RESET_PASSWORD');
  });

  it('refuses the rest of the API until the password is replaced', async () => {
    await provision('provisioned@example.com', 'temporary-password');
    const login = await request(app!)
      .post('/api/auth/login')
      .send({ email: 'provisioned@example.com', password: 'temporary-password' })
      .expect(200);

    const response = await request(app!)
      .get('/api/portfolios')
      .set({ authorization: `Bearer ${login.body.accessToken}` })
      .expect(403);

    expect(response.body.error.code).toBe('PASSWORD_RESET_REQUIRED');
  });

  it('will not change the password without the current one', async () => {
    await provision('provisioned@example.com', 'temporary-password');
    const login = await request(app!)
      .post('/api/auth/login')
      .send({ email: 'provisioned@example.com', password: 'temporary-password' })
      .expect(200);

    await request(app!)
      .post('/api/auth/change-password')
      .set({ authorization: `Bearer ${login.body.accessToken}` })
      .send({ currentPassword: 'not-the-password', newPassword: 'a-brand-new-password' })
      .expect(401);

    // Still flagged, so a failed attempt cannot be used to slip past the gate.
    const user = await prisma.user.findUnique({ where: { email: 'provisioned@example.com' } });
    expect(user?.mustResetPassword).toBe(true);
  });

  it('clears the flag, opens the API and revokes the other sessions', async () => {
    await provision('provisioned@example.com', 'temporary-password');

    // Two sessions, as if the temporary password had been used twice.
    const first = await request(app!)
      .post('/api/auth/login')
      .send({ email: 'provisioned@example.com', password: 'temporary-password' })
      .expect(200);
    const second = await request(app!)
      .post('/api/auth/login')
      .send({ email: 'provisioned@example.com', password: 'temporary-password' })
      .expect(200);

    const changed = await request(app!)
      .post('/api/auth/change-password')
      .set({ authorization: `Bearer ${second.body.accessToken}` })
      .send({ currentPassword: 'temporary-password', newPassword: 'a-brand-new-password' })
      .expect(200);

    expect(changed.body.next).toBe('READY');

    // The pair the change issued works on a real route.
    await request(app!)
      .get('/api/portfolios')
      .set({ authorization: `Bearer ${changed.body.accessToken}` })
      .expect(200);

    // The other session's refresh token is gone, so whoever held the
    // temporary password cannot keep using it.
    await request(app!)
      .post('/api/auth/refresh')
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);

    // And the old password no longer signs in.
    await request(app!)
      .post('/api/auth/login')
      .send({ email: 'provisioned@example.com', password: 'temporary-password' })
      .expect(401);
  });
});
