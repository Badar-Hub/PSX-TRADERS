/**
 * Whether the session cookies are marked `Secure`.
 *
 * This used to be `NODE_ENV === 'production'` written out in two places, which
 * is the usual advice and is wrong for a deployment served over plain HTTP. A
 * browser silently discards a `Secure` cookie that arrives over http://, so
 * the session never persists: every request after signing in is anonymous,
 * each page redirects to the login screen, and a redirect arriving in answer
 * to a server action surfaces as "An unexpected response was received from the
 * server" — a message that points nowhere near cookies. localhost hides it
 * entirely, because browsers treat it as a secure context and keep the cookie,
 * so it only appears once the app is deployed somewhere with a real address.
 *
 * Still defaults to on in production: HTTPS is the thing that should be fixed,
 * and a deployment that quietly stopped marking its cookies secure would be
 * worse than one that fails loudly. COOKIE_SECURE=false is the deliberate
 * exception, for a staging box on a private network where there is no
 * certificate to have — safe only because nothing outside that network can
 * reach it.
 *
 * Deliberately dependency-free. Middleware runs in the Edge runtime and cannot
 * import `next/headers`, so this cannot live beside the cookie writing in
 * session.ts; and the alternative — the same decision written out in both
 * places — is how one of them ends up changed and the other forgotten.
 */
export function useSecureCookies(): boolean {
  const configured = process.env.COOKIE_SECURE;
  if (configured !== undefined && configured !== '') return configured !== 'false';
  return process.env.NODE_ENV === 'production';
}
