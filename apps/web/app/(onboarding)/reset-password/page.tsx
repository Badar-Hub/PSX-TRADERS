import { requireStep } from '@/lib/account';
import { ResetPasswordForm } from './ResetPasswordForm';

/**
 * The gate for an account provisioned with a generated password.
 *
 * Not a suggestion: the API refuses every other route while the flag is set,
 * so this page is the only thing the account can reach. `requireStep` sends an
 * account that has already reset its password back into the app, which is what
 * stops this from reappearing after a refresh.
 */
export default async function ResetPasswordPage() {
  const account = await requireStep('RESET_PASSWORD');

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-slate-100">Choose a password</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
        This account was created for you with a temporary password. Pick one of your own before
        going any further — nothing else is reachable until you do.
      </p>

      <dl className="mt-5 border-t border-slate-800 pt-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-slate-500">Account</dt>
          <dd className="text-slate-200">{account.email}</dd>
        </div>
      </dl>

      <ResetPasswordForm />

      <p className="mt-5 text-xs leading-relaxed text-slate-600">
        Saving this signs out every other session, so the temporary password stops working
        everywhere the moment you replace it.
      </p>
    </div>
  );
}
