/**
 * Administration from the command line.
 *
 *   pnpm --filter @psx/api admin list
 *   pnpm --filter @psx/api admin grant you@example.com
 *   pnpm --filter @psx/api admin approve someone@example.com
 *
 * This exists to break the bootstrap circle: approval requires an admin, and
 * the first admin has nobody to approve them. Rather than an environment
 * variable that silently anoints whoever signs up first — which would make the
 * very first registration a race — the first admin is promoted deliberately,
 * from a shell on the machine that holds the database credentials.
 *
 * It stays useful afterwards as the way back in if every admin locks
 * themselves out, which a web-only approval screen cannot offer.
 */

import { randomBytes } from 'node:crypto';

import { createMailer } from '../email/mailer.js';
import { approvedEmail } from '../email/templates.js';
import { loadEnv } from '../env.js';
import { prisma } from '../db/prisma.js';
import { assertPasswordUsable, hashPassword } from '../auth/password.js';

function usage(): never {
  console.log(
    [
      'Usage:',
      '  admin list [status]            list accounts (default: PENDING_APPROVAL)',
      '  admin create <email> [name]    create an active admin with a temporary password',
      '  admin grant <email>            make an account an admin, and active',
      '  admin revoke <email>           demote an admin back to member',
      '  admin approve <email>          approve a verified account',
      '  admin reject <email> [note]    reject an account',
      '',
      'Statuses: PENDING_VERIFICATION, PENDING_APPROVAL, ACTIVE, REJECTED, SUSPENDED',
    ].join('\n'),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const [command, argument, ...rest] = process.argv.slice(2);

  if (command === undefined) usage();

  if (command === 'list') {
    const status = (argument ?? 'PENDING_APPROVAL').toUpperCase();
    const users = await prisma.user.findMany({
      where: status === 'ALL' ? {} : { status: status as never },
      orderBy: { createdAt: 'asc' },
      select: {
        email: true,
        name: true,
        status: true,
        role: true,
        createdAt: true,
        emailVerifiedAt: true,
      },
    });

    if (users.length === 0) {
      console.log(`No accounts with status ${status}.`);
    } else {
      console.log(`${users.length} account(s) with status ${status}:\n`);
      for (const user of users) {
        console.log(
          `  ${user.email.padEnd(34)} ${user.status.padEnd(21)} ${user.role.padEnd(7)} ` +
            `${user.emailVerifiedAt === null ? 'unverified' : 'verified  '} ` +
            `joined ${user.createdAt.toISOString().slice(0, 10)}`,
        );
      }
    }

    const counts = await prisma.user.groupBy({ by: ['status'], _count: { _all: true } });
    console.log('\nAll accounts by status:');
    for (const row of counts) console.log(`  ${row.status.padEnd(21)} ${row._count._all}`);
    return;
  }

  // Handled before the lookup below, which requires the account to exist.
  if (command === 'create') {
    if (argument === undefined) usage();
    const email = argument.trim().toLowerCase();
    const name = rest.join(' ').trim();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing !== null) {
      console.error(`${email} already exists (${existing.status}, ${existing.role}).`);
      process.exitCode = 1;
      return;
    }

    // base64url of 18 bytes: 24 characters, no ambiguity about which symbols
    // survive being pasted through a chat window or read aloud.
    const password = randomBytes(18).toString('base64url');
    assertPasswordUsable(password);

    const user = await prisma.user.create({
      data: {
        email,
        name: name === '' ? null : name,
        passwordHash: await hashPassword(password),
        // Both onboarding gates are passed deliberately. Whoever runs this has
        // database access, so asking them to prove the address by code and
        // then approve it from another screen would be ceremony, not control.
        status: 'ACTIVE',
        role: 'ADMIN',
        emailVerifiedAt: new Date(),
        approvedAt: new Date(),
        decisionNote: 'Created from the command line.',
        // The password above is a one-time credential: it was generated, not
        // chosen, and it has to travel to its owner somehow. The API refuses
        // every other route until it is replaced.
        mustResetPassword: true,
      },
      select: { email: true, name: true, status: true, role: true },
    });

    console.log(`Created ${user.email} (${user.name ?? 'no name'}) as ${user.role}, ${user.status}.`);
    console.log('');
    console.log(`  Temporary password: ${password}`);
    console.log('');
    console.log('  It works once, to sign in. Every screen stays blocked until a new password');
    console.log('  is chosen, and changing it signs out every other session. Do not store it.');
    return;
  }

  if (argument === undefined) usage();
  const email = argument.trim().toLowerCase();

  const user = await prisma.user.findUnique({ where: { email } });
  if (user === null) {
    console.error(`No account with email ${email}.`);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'grant': {
      // A granted admin is made active in the same step. Promoting someone who
      // then cannot sign in because they are still pending would be a trap.
      const updated = await prisma.user.update({
        where: { email },
        data: {
          role: 'ADMIN',
          status: 'ACTIVE',
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          approvedAt: user.approvedAt ?? new Date(),
          decisionNote: 'Promoted to administrator from the command line.',
        },
        select: { email: true, role: true, status: true },
      });
      console.log(`${updated.email} is now ${updated.role} and ${updated.status}.`);
      if (user.emailVerifiedAt === null) {
        console.log(
          '  Note: the email address was never verified by code. It has been marked verified',
          '\n  because the promotion was made by someone with database access.',
        );
      }
      return;
    }

    case 'revoke': {
      const admins = await prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
      if (user.role === 'ADMIN' && admins <= 1) {
        console.error(
          'Refusing to demote the only administrator. Grant another one first, or there ' +
            'would be nobody left to approve anyone.',
        );
        process.exitCode = 1;
        return;
      }
      await prisma.user.update({ where: { email }, data: { role: 'MEMBER' } });
      console.log(`${email} is now MEMBER.`);
      return;
    }

    case 'approve': {
      if (user.status === 'PENDING_VERIFICATION') {
        console.error(
          `${email} has not verified their email address. Approving it would open the account ` +
            'to whoever typed that address rather than whoever owns it.',
        );
        process.exitCode = 1;
        return;
      }
      if (user.status === 'ACTIVE') {
        console.log(`${email} is already active.`);
        return;
      }

      const updated = await prisma.user.update({
        where: { email },
        data: {
          status: 'ACTIVE',
          approvedAt: new Date(),
          decisionNote: 'Approved from the command line.',
        },
        select: { email: true, name: true, status: true },
      });

      const mailer = createMailer(env);
      await mailer.send(
        approvedEmail({ to: updated.email, name: updated.name, appUrl: env.APP_URL }),
      );
      console.log(`${updated.email} is now ACTIVE, and has been emailed.`);
      return;
    }

    case 'reject': {
      const note = rest.join(' ').trim();
      await prisma.user.update({
        where: { email },
        data: {
          status: 'REJECTED',
          ...(note !== '' ? { decisionNote: note } : {}),
        },
      });
      await prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      console.log(`${email} is now REJECTED and their sessions are revoked.`);
      return;
    }

    default:
      usage();
  }
}

main()
  .catch((error: unknown) => {
    console.error('failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
