import type { SendOptions } from './mailer.js';

/**
 * Email bodies.
 *
 * Plain text is written first and carries everything that matters; the HTML is
 * a nicety. Many Pakistani users read mail on a phone over a thin connection,
 * and a code that only renders inside a styled table is a code they cannot
 * read. Every message also has a text part because a text-only message is far
 * less likely to be filtered as spam than an HTML-only one.
 *
 * The code is spaced in the HTML (`123 456`) because a six-digit run is easier
 * to carry across to another screen in two groups of three.
 */

const BRAND = 'PSX Trader';

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
<table role="presentation" style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
<tr><td>
<p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#64748b">${BRAND}</p>
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${title}</h1>
${body}
<p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#94a3b8">
This is an automated message about your ${BRAND} account. ${BRAND} shows signals
and analysis from public market data and is not investment advice.
</p>
</td></tr></table></body></html>`;
}

export function verificationCodeEmail(input: {
  to: string;
  name: string | null;
  code: string;
  ttlMinutes: number;
}): SendOptions {
  const greeting = input.name === null ? 'Hello,' : `Hello ${input.name},`;
  const spaced = `${input.code.slice(0, 3)} ${input.code.slice(3)}`;

  const text = [
    greeting,
    '',
    `Your ${BRAND} verification code is:`,
    '',
    `    ${input.code}`,
    '',
    `It expires in ${input.ttlMinutes} minutes and can be used once.`,
    '',
    'After you verify your email, an administrator still has to approve your',
    'account before you can sign in. You will get another email when that happens.',
    '',
    "If you did not create an account, you can ignore this message - nothing",
    'will happen without the code.',
  ].join('\n');

  const html = wrap(
    'Verify your email',
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.6">${greeting}<br>Enter this code to verify your email address.</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:600;letter-spacing:.12em;font-family:ui-monospace,Consolas,monospace">${spaced}</p>
<p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#475569">
It expires in <strong>${input.ttlMinutes} minutes</strong> and can be used once.</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#475569">
After verifying, an administrator still has to approve your account. We will email you when that happens.</p>`,
  );

  return { to: input.to, subject: `Your ${BRAND} verification code`, text, html };
}

/** Sent once the email is proven, so the wait is not a silence. */
export function awaitingApprovalEmail(input: { to: string; name: string | null }): SendOptions {
  const greeting = input.name === null ? 'Hello,' : `Hello ${input.name},`;
  const text = [
    greeting,
    '',
    'Your email address is verified. Thank you.',
    '',
    `An administrator now reviews your account before it is opened. ${BRAND} is`,
    'invitation-based, so this step is manual and may take a little while.',
    '',
    'We will email you as soon as a decision is made. You do not need to do',
    'anything else.',
  ].join('\n');

  return {
    to: input.to,
    subject: `${BRAND}: email verified, awaiting approval`,
    text,
    html: wrap(
      'Email verified',
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${greeting}<br>Your email address is verified.</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#475569">
An administrator now reviews your account before it is opened. ${BRAND} is invitation-based, so this step is manual.</p>
<p style="margin:0;font-size:14px;line-height:1.6;color:#475569">
We will email you as soon as a decision is made.</p>`,
    ),
  };
}

export function approvedEmail(input: { to: string; name: string | null; appUrl: string }): SendOptions {
  const greeting = input.name === null ? 'Hello,' : `Hello ${input.name},`;
  const text = [
    greeting,
    '',
    `Your ${BRAND} account has been approved. You can sign in now:`,
    '',
    `    ${input.appUrl}`,
    '',
    'Two things worth knowing before you start:',
    '',
    '  - Charge rates and the capital-gains estimate come from configuration.',
    '    Set them from a real contract note before trusting any P&L figure.',
    '  - Predictions are signals from public data, not advice, and the engine',
    '    has not yet been running long enough to report a hit rate.',
  ].join('\n');

  return {
    to: input.to,
    subject: `${BRAND}: your account is approved`,
    text,
    html: wrap(
      'Your account is approved',
      `<p style="margin:0 0 16px;font-size:15px;line-height:1.6">${greeting}<br>You can sign in now.</p>
<p style="margin:0 0 24px"><a href="${input.appUrl}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500">Open ${BRAND}</a></p>
<p style="margin:0;font-size:13px;line-height:1.6;color:#64748b">
Charge rates and the tax estimate come from configuration - set them from a real contract note before trusting a P&amp;L figure. Predictions are signals from public data, not advice.</p>`,
    ),
  };
}

/**
 * Sent on rejection.
 *
 * Deliberately short and without a reason unless the admin wrote one. Inventing
 * an explanation for a decision an admin made in one click would be worse than
 * saying little.
 */
export function rejectedEmail(input: {
  to: string;
  name: string | null;
  note: string | null;
}): SendOptions {
  const greeting = input.name === null ? 'Hello,' : `Hello ${input.name},`;
  const reason = input.note === null || input.note.trim() === '' ? '' : `\n\nNote: ${input.note}`;

  const text = [
    greeting,
    '',
    `Your request for a ${BRAND} account was not approved.${reason}`,
    '',
    'If you think this is a mistake, reply to whoever invited you.',
  ].join('\n');

  return {
    to: input.to,
    subject: `${BRAND}: account request not approved`,
    text,
    html: wrap(
      'Account request not approved',
      `<p style="margin:0 0 12px;font-size:15px;line-height:1.6">${greeting}</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#475569">Your request for a ${BRAND} account was not approved.</p>
${reason === '' ? '' : `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#475569">${input.note}</p>`}
<p style="margin:0;font-size:14px;line-height:1.6;color:#475569">If you think this is a mistake, reply to whoever invited you.</p>`,
    ),
  };
}

/** Tells the admins there is someone in the queue. */
export function newSignupEmail(input: {
  to: string;
  applicantEmail: string;
  applicantName: string | null;
  adminUrl: string;
}): SendOptions {
  const text = [
    'Someone has verified their email and is waiting for approval.',
    '',
    `  email: ${input.applicantEmail}`,
    `  name:  ${input.applicantName ?? '(not given)'}`,
    '',
    `Review the queue: ${input.adminUrl}`,
  ].join('\n');

  return {
    to: input.to,
    subject: `${BRAND}: ${input.applicantEmail} is awaiting approval`,
    text,
  };
}
