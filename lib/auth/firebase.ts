'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signInWithPopup,
  type Auth,
  type UserCredential,
} from 'firebase/auth';

export { onAuthStateChanged };

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyB2Oj8nOcn_ULvE_MoNxDsItE3qeAaJRFg',
  authDomain: 'codemarket-auth.firebaseapp.com',
  projectId: 'codemarket-auth',
  storageBucket: 'codemarket-auth.firebasestorage.app',
  messagingSenderId: '681478192555',
  appId: '1:681478192555:web:a6e4e46e3ef377a4bda6ee',
};

function builderFirebaseApp(): FirebaseApp {
  return getApps()[0] ?? initializeApp(FIREBASE_CONFIG);
}

export function builderAuth(): Auth {
  return getAuth(builderFirebaseApp());
}

// ─── Ariadne's Thread [AT-0068] ─────────────────────
// What: Reuse the production Code Market Firebase project from the Builder login modal
// Why:  Builder accounts must be the same Firebase users exchanged by the existing Code Market API
// Date: 2026-09-30
// Related: [AT-0069] backend→app/api/auth/exchange/route.ts:POST, components/app/generation/BuilderLoginModal.tsx:BuilderLoginModal
// ─────────────────────────────────────────────────────
export async function signInBuilderWithGoogle(): Promise<UserCredential> {
  console.log('[builder-firebase] Starting Google sign-in');
  const credential = await signInWithPopup(builderAuth(), new GoogleAuthProvider());
  console.log('[builder-firebase] Google sign-in completed', {
    uid: credential.user.uid,
    hasEmail: Boolean(credential.user.email),
  });
  return credential;
}

export async function signInBuilderWithEmail(email: string, password: string): Promise<UserCredential> {
  console.log('[builder-firebase] Starting email sign-in', { email });
  const credential = await signInWithEmailAndPassword(builderAuth(), email, password);
  console.log('[builder-firebase] Email sign-in completed', { uid: credential.user.uid });
  return credential;
}

export async function signUpBuilderWithEmail(email: string, password: string): Promise<UserCredential> {
  console.log('[builder-firebase] Starting email sign-up', { email });
  const credential = await createUserWithEmailAndPassword(builderAuth(), email, password);
  console.log('[builder-firebase] Email sign-up completed', { uid: credential.user.uid });
  return credential;
}

export async function sendBuilderPasswordReset(email: string): Promise<void> {
  console.log('[builder-firebase] Sending password reset', { email });
  await sendPasswordResetEmail(builderAuth(), email);
  console.log('[builder-firebase] Password reset email requested', { email });
}

export function builderAuthErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  console.error('[builder-firebase] Authentication failed', {
    code: code || 'unknown',
    message: error instanceof Error ? error.message : String(error),
  });
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-email') {
    return 'The email or password is incorrect.';
  }
  if (code === 'auth/email-already-in-use') return 'An account with this email already exists. Sign in instead.';
  if (code === 'auth/weak-password') return 'Use a password with at least 6 characters.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Google sign-in was closed before it finished.';
  }
  if (code === 'auth/unauthorized-domain') return 'Google sign-in is not authorized for this domain yet.';
  return 'Sign-in failed. Please try again.';
}
