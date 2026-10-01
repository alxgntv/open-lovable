'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  builderAuthErrorMessage,
  sendBuilderPasswordReset,
  signInBuilderWithEmail,
  signInBuilderWithGoogle,
  signUpBuilderWithEmail,
} from '@/lib/auth/firebase';

type AuthMode = 'signin' | 'signup' | 'reset';
type NoticeTone = 'success' | 'error' | 'neutral';

interface BuilderLoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
}

interface AuthNotice {
  tone: NoticeTone;
  message: string;
}

async function establishBuilderSession(idToken: string): Promise<void> {
  const response = await fetch('/api/auth/exchange', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
  if (!response.ok || !payload.success) {
    throw new Error(payload.error || 'Code Market could not create a session.');
  }
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.16.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function ArrowMark() {
  return (
    <span className="-mr-1" aria-hidden="true">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 12H19.5833M19.5833 12L12.5833 5M19.5833 12L12.5833 19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// ─── Ariadne's Thread [AT-0073] ─────────────────────
// What: Show the existing Code Market Google and email sign-in choices before paid generation
// Why:  The first Builder request must be retained locally until the same Code Market account authorizes token usage
// Date: 2026-09-30
// Related: [AT-0068] frontend→lib/auth/firebase.ts:builderAuth, [AT-0074] app/generation/page.tsx:sendChatMessage
// ─────────────────────────────────────────────────────
// ─── Ariadne's Thread [AT-0081] ─────────────────────
// What: Restyle the Builder login dialog to the Code Market auth form layout and copy
// Why:  The modal should present the same Welcome back / Google / email login the user already sees on code.market
// Date: 2026-10-01
// Related: [AT-0073] components/app/generation/BuilderLoginModal.tsx:BuilderLoginModal, [AT-0068] frontend→lib/auth/firebase.ts:builderAuth
// ─────────────────────────────────────────────────────
export default function BuilderLoginModal({ open, onClose, onSuccess }: BuilderLoginModalProps) {
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    console.log('[BuilderLoginModal] Opened');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const switchMode = (nextMode: AuthMode) => {
    console.log('[BuilderLoginModal] Switch mode', { from: mode, to: nextMode });
    setMode(nextMode);
    setNotice(null);
  };

  const completeCredential = async (credential: { user: { getIdToken: (forceRefresh?: boolean) => Promise<string> } }) => {
    const idToken = await credential.user.getIdToken(true);
    await establishBuilderSession(idToken);
    setPassword('');
    await onSuccess();
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) || (mode !== 'reset' && password.length < 6)) {
      console.log('[BuilderLoginModal] Email form rejected', { mode, emailLength: normalizedEmail.length, passwordLength: password.length });
      setNotice({ tone: 'error', message: 'Enter a valid email and a password with at least 6 characters.' });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    console.log('[BuilderLoginModal] Email form submitted', { mode, emailLength: normalizedEmail.length });
    try {
      if (mode === 'reset') {
        await sendBuilderPasswordReset(normalizedEmail);
        setNotice({ tone: 'success', message: 'Password reset email sent. Check your inbox.' });
        setMode('signin');
        return;
      }
      if (mode === 'signup') {
        const check = await fetch('/api/auth/check-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizedEmail }),
        });
        const checkPayload = await check.json().catch(() => ({})) as { error?: string };
        if (!check.ok) throw new Error(checkPayload.error || 'This email address cannot be used.');
        await completeCredential(await signUpBuilderWithEmail(normalizedEmail, password));
        return;
      }
      await completeCredential(await signInBuilderWithEmail(normalizedEmail, password));
    } catch (error) {
      console.error('[BuilderLoginModal] Email auth failed', { mode, message: error instanceof Error ? error.message : 'unknown' });
      setNotice({
        tone: 'error',
        message: error instanceof Error && !('code' in error)
          ? error.message
          : builderAuthErrorMessage(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const submitGoogle = async () => {
    setSubmitting(true);
    setNotice(null);
    console.log('[BuilderLoginModal] Google sign-in started', { mode });
    try {
      await completeCredential(await signInBuilderWithGoogle());
    } catch (error) {
      console.error('[BuilderLoginModal] Google sign-in failed', { message: error instanceof Error ? error.message : 'unknown' });
      setNotice({ tone: 'error', message: builderAuthErrorMessage(error) });
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel = mode === 'reset' ? 'Send Reset Email' : mode === 'signup' ? 'Create account' : 'Login';
  const submitDisabled = submitting || !email.trim() || (mode !== 'reset' && !password);
  const noticeClass = notice?.tone === 'success'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
    : notice?.tone === 'error'
      ? 'border-rose-200 bg-rose-50 text-rose-800'
      : 'border-gray-200 bg-gray-50 text-gray-700';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-[16px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose();
      }}
    >
      {/* ─── Ariadne's Thread [AT-0083] ─────────────────────
          What: Size the login dialog with explicit pixels instead of the numeric Tailwind scale
          Why:  This app maps h-10, px-6 and max-h-8 to raw pixels, which collapsed the Code Market form
          Date: 2026-10-01
          Related: [AT-0081] components/app/generation/BuilderLoginModal.tsx:BuilderLoginModal, tailwind.config.ts:spacing
      ───────────────────────────────────────────────────── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="builder-login-title"
        className="relative w-full max-w-[480px] rounded-[16px] bg-white px-[28px] pb-[28px] pt-[20px] shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="absolute right-[16px] top-[16px] rounded-[8px] px-[8px] py-[4px] text-[13px] text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
          aria-label="Close"
        >
          Close
        </button>
        <div className="mx-auto flex w-full flex-col items-center justify-center gap-[24px]">
          <h2 id="builder-login-title" className="px-[28px] text-center text-[32px] font-normal leading-[1.15] text-gray-900 sm:text-[40px]">
            {mode === 'reset' ? 'Reset your password.' : mode === 'signup' ? (
              <>
                <span className="text-gray-400">Welcome!</span>
                <br />
                Create your account.
              </>
            ) : (
              <>
                <span className="text-gray-400">Welcome back!</span>
                <br />
                Login to your account.
              </>
            )}
          </h2>
          <div className="mx-auto flex w-full max-w-[380px] flex-col gap-[20px] rounded-[16px] border border-gray-200 px-[24px] py-[24px] shadow-sm">
            {mode !== 'reset' && (
              <>
                <button
                  type="button"
                  onClick={() => void submitGoogle()}
                  disabled={submitting}
                  className="flex h-[40px] w-full items-center justify-center rounded-[16px] border border-gray-200 bg-white px-[16px] text-[14px] font-semibold text-gray-900 shadow-sm hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <GoogleMark />
                  <span className="ml-[12px] text-[14px] font-semibold text-gray-900">Continue with Google</span>
                </button>
                <div className="flex items-center gap-[8px] text-center text-gray-500">
                  <span className="h-px flex-1 bg-gray-200" />
                  <span className="text-[12px] text-gray-500">or continue with email</span>
                  <span className="h-px flex-1 bg-gray-200" />
                </div>
              </>
            )}
            <form onSubmit={(event) => void submitEmail(event)} className="flex flex-col">
              <div className="mb-[12px]">
                <label htmlFor="auth-form-email" className="text-[14px] font-semibold text-gray-900">
                  Email
                </label>
                <input
                  id="auth-form-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  className="mt-[6px] h-[40px] w-full rounded-[8px] border border-gray-200 bg-white px-[12px] text-[14px] text-gray-900 shadow-sm outline-none hover:border-gray-300 focus:border-gray-300"
                />
              </div>
              {mode !== 'reset' && (
                <div>
                  <label htmlFor="auth-form-password" className="text-[14px] font-semibold text-gray-900">
                    Password
                  </label>
                  <input
                    id="auth-form-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                    className="mt-[6px] h-[40px] w-full rounded-[8px] border border-gray-200 bg-white px-[12px] text-[14px] text-gray-900 shadow-sm outline-none hover:border-gray-300 focus:border-gray-300"
                  />
                </div>
              )}
              {mode === 'signin' && (
                <div className="mt-[10px] text-right text-[12px]">
                  <button
                    type="button"
                    onClick={() => switchMode('reset')}
                    className="font-semibold text-gray-500 hover:text-gray-900 hover:underline"
                  >
                    Forgot Password?
                  </button>
                </div>
              )}
              <button
                type="submit"
                disabled={submitDisabled}
                className="mt-[20px] flex h-[40px] w-full items-center justify-center gap-[6px] rounded-[16px] border border-gray-900 bg-gray-900 px-[16px] text-[15px] font-semibold leading-[22px] text-white shadow-sm hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitLabel}
                {mode !== 'reset' && <ArrowMark />}
              </button>
            </form>
            {notice && (
              <div className={`rounded-[8px] border px-[12px] py-[8px] text-[12px] ${noticeClass}`} role="status">
                {notice.message}
              </div>
            )}
          </div>
          {mode === 'reset' ? (
            <p className="text-center text-sm font-normal text-gray-500">
              <button
                type="button"
                onClick={() => switchMode('signin')}
                className="font-semibold text-gray-500 hover:text-gray-900 hover:underline"
              >
                Back to Login
              </button>
            </p>
          ) : (
            <p className="text-center text-sm font-normal text-gray-500">
              {mode === 'signin' ? (
                <>
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('signup')}
                    className="font-semibold text-gray-500 hover:text-gray-900 hover:underline"
                  >
                    Create One!
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('signin')}
                    className="font-semibold text-gray-500 hover:text-gray-900 hover:underline"
                  >
                    Login
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
