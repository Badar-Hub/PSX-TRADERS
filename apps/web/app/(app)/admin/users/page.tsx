import Link from 'next/link';
import { api } from '@/lib/api';
import { requireAdmin, type UserStatus } from '@/lib/account';
import { shortDate } from '@/lib/format';
import { UserRow } from './UserRow';

/**
 * The approval queue.
 *
 * Oldest first, as the API returns it: a queue should be served in the order
 * people joined it. Every decision is recorded with who made it and any note
 * they left, so "who let this account in" has an answer six months later.
 */

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  role: 'MEMBER' | 'ADMIN';
  createdAt: string;
  emailVerifiedAt: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
}

const FILTERS: Array<{ status: UserStatus; label: string }> = [
  { status: 'PENDING_APPROVAL', label: 'Waiting' },
  { status: 'ACTIVE', label: 'Active' },
  { status: 'PENDING_VERIFICATION', label: 'Unverified' },
  { status: 'REJECTED', label: 'Rejected' },
  { status: 'SUSPENDED', label: 'Suspended' },
];

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;

  const requested = FILTERS.find((filter) => filter.status === params.status);
  const status: UserStatus = requested?.status ?? 'PENDING_APPROVAL';

  const { users, counts } = await api<{
    users: AdminUser[];
    counts: Partial<Record<UserStatus, number>>;
  }>(`/api/admin/users?status=${status}`);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Members</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          New accounts reach the queue once they have confirmed their email address
        </p>
      </div>

      <nav className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((filter) => {
          const count = counts[filter.status];
          const active = filter.status === status;
          return (
            <Link
              key={filter.status}
              href={`/admin/users?status=${filter.status}`}
              className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                active
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              {filter.label}
              {count !== undefined && <span className="ml-1.5 text-slate-500">{count}</span>}
            </Link>
          );
        })}
      </nav>

      {users.length === 0 ? (
        <div className="card text-center">
          <p className="text-sm text-slate-300">
            {status === 'PENDING_APPROVAL'
              ? 'Nobody is waiting.'
              : 'No accounts with that status.'}
          </p>
          {status === 'PENDING_APPROVAL' && (
            <p className="mt-1.5 text-xs text-slate-600">
              An account appears here after it has confirmed its email address, and not before —
              approving an unconfirmed address would open the account to whoever typed it rather
              than whoever owns it.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((user) => (
            <UserRow
              key={user.id}
              id={user.id}
              email={user.email}
              name={user.name}
              status={user.status}
              role={user.role}
              joined={shortDate(user.createdAt.slice(0, 10))}
              verified={
                user.emailVerifiedAt === null
                  ? null
                  : shortDate(user.emailVerifiedAt.slice(0, 10))
              }
              approved={
                user.approvedAt === null ? null : shortDate(user.approvedAt.slice(0, 10))
              }
              decisionNote={user.decisionNote}
              decidedBy={user.decidedBy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
