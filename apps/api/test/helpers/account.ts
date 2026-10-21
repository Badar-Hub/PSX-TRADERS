import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../../src/db/prisma.js';
import { createRecordingMailer } from '../../src/email/mailer.js';

/**
 * Account helpers for the integration suites.
 *
 * Onboarding now has two gates, so "a signed-in user" is no longer one request.
 * Every suite that just wants a usable account goes through `signUpActive`,
 * which walks the real flow — register, read the code out of the email, verify
 * — and then flips the approval in the database.
 *
 * The approval is a direct write on purpose. Going through the admin endpoint
 * would need an admin, which needs a grant, which needs another account: a
 * fixture for every test that only wanted somewhere to record a trade. The
 * approval endpoint has its own tests; here the point is to arrive at an active
 * account cheaply.
 */

export const mailer = createRecordingMailer();

/** Pulls the six-digit code out of the most recent email to an address. */
export function codeSentTo(email: string): string {
  for (let i = mailer.sent.length - 1; i >= 0; i -= 1) {
    const message = mailer.sent[i];
    if (message === undefined || message.to !== email) continue;
    const match = /\b(\d{6})\b/.exec(message.text);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error(`No verification code was emailed to ${email}`);
}

export function emailsTo(email: string): string[] {
  return mailer.sent.filter((message) => message.to === email).map((message) => message.subject);
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
}

/** Registers and verifies, leaving the account waiting for approval. */
export async function signUpPending(app: Express, email: string): Promise<Session> {
  const registered = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'a-long-enough-password', name: 'Test User' })
    .expect(201);

  await request(app)
    .post('/api/auth/verify-email')
    .send({ email, code: codeSentTo(email) })
    .expect(200);

  return {
    accessToken: registered.body.accessToken,
    refreshToken: registered.body.refreshToken,
    userId: registered.body.user.id,
    email,
  };
}

/** Registers, verifies, and approves. The usual starting point. */
export async function signUpActive(app: Express, email: string): Promise<Session> {
  const session = await signUpPending(app, email);
  await prisma.user.update({
    where: { email },
    data: { status: 'ACTIVE', approvedAt: new Date() },
  });
  return session;
}

/** An active account that is also an admin. */
export async function signUpAdmin(app: Express, email: string): Promise<Session> {
  const session = await signUpActive(app, email);
  await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
  return session;
}

export function auth(session: Session): { authorization: string } {
  return { authorization: `Bearer ${session.accessToken}` };
}

/** The first portfolio, created for every account at registration. */
export async function firstPortfolioId(app: Express, session: Session): Promise<string> {
  const response = await request(app).get('/api/portfolios').set(auth(session)).expect(200);
  return response.body.portfolios[0].id as string;
}
