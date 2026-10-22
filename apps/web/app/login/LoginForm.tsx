'use client';

import { useActionState, useState } from 'react';
import { register, signIn, type AuthState } from './actions';

const initial: AuthState = { error: null };

export function LoginForm({ initialMode }: { initialMode: 'signin' | 'register' }) {
  const [mode, setMode] = useState(initialMode);
  const [signInState, signInAction, signingIn] = useActionState(signIn, initial);
  const [registerState, registerAction, registering] = useActionState(register, initial);

  const isRegister = mode === 'register';
  const state = isRegister ? registerState : signInState;
  const pending = isRegister ? registering : signingIn;

  return (
    <div className="card">
      <form action={isRegister ? registerAction : signInAction} className="space-y-4">
        {isRegister && (
          <div>
            <label htmlFor="name" className="label mb-1.5 block">
              Name
            </label>
            <input id="name" name="name" type="text" className="input" autoComplete="name" />
          </div>
        )}

        <div>
          <label htmlFor="email" className="label mb-1.5 block">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="input"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label htmlFor="password" className="label mb-1.5 block">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={isRegister ? 10 : 1}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            className="input"
          />
          {isRegister && (
            <p className="mt-1.5 text-xs text-slate-600">
              At least 10 characters. Length is what actually protects it, so there are no
              rules about symbols.
            </p>
          )}
        </div>

        {state.error !== null && (
          <p className="rounded-lg border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
            {state.error}
          </p>
        )}

        {state.notice != null && (
          <p className="rounded-lg border border-sky-800/40 bg-sky-950/30 px-3 py-2 text-sm leading-relaxed text-sky-300">
            {state.notice}
          </p>
        )}

        <button type="submit" disabled={pending} className="btn-primary w-full">
          {pending ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setMode(isRegister ? 'signin' : 'register')}
        className="mt-4 w-full text-center text-sm text-slate-500 hover:text-slate-300"
      >
        {isRegister ? 'Already have an account? Sign in' : 'No account? Create one'}
      </button>
    </div>
  );
}
