import { Router } from 'express';
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { body, cuid, params, query, validate } from '../http/validate.js';
import { prisma } from '../db/prisma.js';
import { currentUser } from '../auth/middleware.js';
import { requireAdmin } from '../auth/access.js';
import type { Tokens } from '../auth/tokens.js';
import type { Env } from '../env.js';
import type { Mailer } from '../email/mailer.js';
import { approvedEmail, rejectedEmail } from '../email/templates.js';

/**
 * Administration: the approval queue.
 *
 * Every route here sits behind `requireAdmin`, which answers 404 rather than
 * 403 to a member — an endpoint someone may not use should not confirm it
 * exists.
 *
 * Decisions are recorded, not just applied: who decided, when, and any note
 * they left. An approval queue with no audit trail is one where nobody can
 * answer "who let this account in" six months later.
 */

const ListQuery = z.object({
  status: z.enum(['PENDING_APPROVAL', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'SUSPENDED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const IdParams = z.object({ id: cuid });

const DecisionBody = z
  .object({ note: z.string().trim().max(500).optional() })
  .optional()
  .default({});

export function adminRoutes(tokens: Tokens, env: Env, mailer: Mailer): Router {
  const router = Router();
  const admin = requireAdmin(tokens);

  /** The queue. Defaults to accounts actually waiting on a decision. */
  router.get('/admin/users', ...admin, validate({ query: ListQuery }), async (req, res) => {
    const { status, limit } = query<z.infer<typeof ListQuery>>(req);

    const users = await prisma.user.findMany({
      where: status === undefined ? { status: 'PENDING_APPROVAL' } : { status },
      // Oldest first: a queue should be served in the order people joined it.
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        role: true,
        createdAt: true,
        emailVerifiedAt: true,
        approvedAt: true,
        decisionNote: true,
        approvedBy: { select: { email: true } },
      },
    });

    const counts = await prisma.user.groupBy({ by: ['status'], _count: { _all: true } });

    res.json({
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        role: user.role,
        createdAt: user.createdAt.toISOString(),
        emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
        approvedAt: user.approvedAt?.toISOString() ?? null,
        decisionNote: user.decisionNote,
        decidedBy: user.approvedBy?.email ?? null,
      })),
      counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
    });
  });

  router.post(
    '/admin/users/:id/approve',
    ...admin,
    validate({ params: IdParams, body: DecisionBody }),
    async (req, res) => {
      const { id } = params<z.infer<typeof IdParams>>(req);
      const input = body<{ note?: string }>(req);
      const actor = currentUser(req);

      const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, status: true },
      });
      if (target === null) throw notFound('User');

      if (target.status === 'ACTIVE') throw conflict('That account is already active');
      if (target.status === 'PENDING_VERIFICATION') {
        // Approving an unverified address would mean the account is open to
        // whoever typed the email, not whoever owns it. That is the whole
        // point of the first gate.
        throw badRequest(
          'That account has not verified its email address yet. It cannot be approved until it has.',
        );
      }

      const updated = await prisma.user.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          approvedAt: new Date(),
          approvedById: actor.id,
          ...(input?.note !== undefined ? { decisionNote: input.note } : {}),
        },
        select: { id: true, email: true, name: true, status: true, approvedAt: true },
      });

      await mailer.send(
        approvedEmail({ to: updated.email, name: updated.name, appUrl: env.APP_URL }),
      );

      res.json({ user: { ...updated, approvedAt: updated.approvedAt?.toISOString() ?? null } });
    },
  );

  router.post(
    '/admin/users/:id/reject',
    ...admin,
    validate({ params: IdParams, body: DecisionBody }),
    async (req, res) => {
      const { id } = params<z.infer<typeof IdParams>>(req);
      const input = body<{ note?: string }>(req);
      const actor = currentUser(req);

      const target = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, name: true, status: true, role: true },
      });
      if (target === null) throw notFound('User');
      if (target.role === 'ADMIN') throw conflict('Administrators cannot be rejected');

      const updated = await prisma.user.update({
        where: { id },
        data: {
          status: 'REJECTED',
          approvedById: actor.id,
          ...(input?.note !== undefined ? { decisionNote: input.note } : {}),
        },
        select: { id: true, email: true, name: true, status: true, decisionNote: true },
      });

      // Every refresh token is revoked, so a rejected account cannot keep
      // minting access tokens. requireActiveUser would block them anyway, but
      // leaving live credentials behind for an account that was just refused
      // is not a state worth having.
      await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await mailer.send(
        rejectedEmail({ to: updated.email, name: updated.name, note: updated.decisionNote }),
      );

      res.json({ user: updated });
    },
  );

  /** Suspends an account that was previously active. */
  router.post(
    '/admin/users/:id/suspend',
    ...admin,
    validate({ params: IdParams, body: DecisionBody }),
    async (req, res) => {
      const { id } = params<z.infer<typeof IdParams>>(req);
      const input = body<{ note?: string }>(req);
      const actor = currentUser(req);

      if (id === actor.id) throw badRequest('You cannot suspend your own account');

      const target = await prisma.user.findUnique({
        where: { id },
        select: { role: true },
      });
      if (target === null) throw notFound('User');
      if (target.role === 'ADMIN') throw conflict('Administrators cannot be suspended');

      const updated = await prisma.user.update({
        where: { id },
        data: {
          status: 'SUSPENDED',
          approvedById: actor.id,
          ...(input?.note !== undefined ? { decisionNote: input.note } : {}),
        },
        select: { id: true, email: true, status: true },
      });

      await prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      res.json({ user: updated });
    },
  );

  return router;
}
