'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import BuilderPaywall from '@/components/app/home/BuilderPaywall';
import BuilderLoginModal from '@/components/app/generation/BuilderLoginModal';
import { useBuilderSession } from '@/components/app/generation/useBuilderSession';
import { builderAuth, builderAuthErrorMessage, onAuthStateChanged, signInBuilderWithGoogle } from '@/lib/auth/firebase';

const PAGE_META_TITLE = 'Code Market';
const PAGE_META_DESCRIPTION = 'Re-imagine any website in seconds with AI-powered website builder.';
const BUILDER_HREF = '/generation';
const COMPOSER_DRAFT_KEY = 'builderComposerDraft';

function readComposerDraft(): string {
  if (typeof window === 'undefined') return '';
  try {
    const draft = window.localStorage.getItem(COMPOSER_DRAFT_KEY) || '';
    console.log('[project-home] Read composer draft', { chars: draft.length });
    return draft;
  } catch (error) {
    console.error('[project-home] Could not read composer draft', error);
    return '';
  }
}

// ─── Ariadne's Thread [AT-0094] ─────────────────────
// What: Store the home prompt in localStorage before a Code Market account exists
// Why:  Visitors must be able to type and keep a draft without signing in
// Date: 2026-10-01
// Related: [AT-0091] frontend→components/app/home/ProjectHome.tsx:openBuilder
// ─────────────────────────────────────────────────────
function writeComposerDraft(value: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (!value) {
      window.localStorage.removeItem(COMPOSER_DRAFT_KEY);
      console.log('[project-home] Cleared composer draft');
      return;
    }
    window.localStorage.setItem(COMPOSER_DRAFT_KEY, value);
    console.log('[project-home] Saved composer draft before sign-in', { chars: value.length });
  } catch (error) {
    console.error('[project-home] Could not save composer draft', error);
  }
}

const PRODUCT_TYPE_NAMES = [
  'Website Template',
  'Admin Template',
  'Free Tool',
  'WordPress Plugin',
  'WooCommerce Plugin',
  'WordPress Theme',
  'WooCommerce Theme',
  'BuddyPress Theme',
  'PHP Script',
  '.NET Script',
  'JavaScript Script',
  'HTML5 Script',
  'HTML5 Game',
  'CSS Component',
  'Adobe Edge Animate Template',
  'macOS App',
  'Windows App',
  'Android App',
  'iOS App',
  'Flutter App',
  'Native Web App',
  'Titanium App',
  'Joomla Extension',
  'Drupal Module',
  'Concrete5 Add-on',
  'ExpressionEngine Add-on',
  'Magento Extension',
  'OpenCart Extension',
  'osCommerce Add-on',
  'PrestaShop Module',
  'Ubercart Module',
  'VirtueMart Extension',
  'Zen Cart Plugin',
  'Muse Widget',
  'Bootstrap Skin',
  'Layers WP Style Kit',
  'Blogger Template',
  'Ghost Theme',
  'Tumblr Theme',
  'Joomla Template',
  'Drupal Theme',
  'Concrete5 Theme',
  'HubSpot Theme',
  'MODX Theme',
  'Moodle Theme',
  'Webflow Template',
  'Weebly Theme',
  'VirtueMart Theme',
  'Shopify Theme',
  'Magento Theme',
  'BigCommerce Theme',
  'OpenCart Theme',
  'PrestaShop Theme',
  'Zen Cart Template',
  'phpBB Theme',
  'Vanilla Forums Theme',
  'vBulletin Theme',
  'Next.js Template',
  'Nuxt.js Template',
  'Gatsby Template',
  'SvelteKit Template',
  'Eleventy Template',
  'Jekyll Theme',
  'HTML Template',
  'Landing Page Template',
  'Unbounce Template',
  'Email Template',
  'Elementor Template Kit',
] as const;

const CARD_LOOKS = [
  { art: 'bg-[#c9b09a]', light: true },
  { art: 'bg-[#1e4d73]', light: false },
  { art: 'bg-[#d4653a]', light: false },
  { art: 'bg-[#5c3d78]', light: false },
  { art: 'bg-[#151b2b]', light: false },
  { art: 'bg-[#f2e534]', light: true },
  { art: 'bg-[#1c6b66]', light: false },
  { art: 'bg-[#f3eee6]', light: true },
  { art: 'bg-[#a33b3b]', light: false },
  { art: 'bg-[#2d6a4f]', light: false },
  { art: 'bg-[#e7b4c6]', light: true },
  { art: 'bg-[#243056]', light: false },
  { art: 'bg-[#ef9f2a]', light: true },
] as const;

// ─── Ariadne's Thread [AT-0089] ─────────────────────
// What: Build one home card for every catalog product type
// Why:  The style grid is replaced by the product types the home should show
// Date: 2026-10-01
// Related: [AT-0088] frontend→components/app/home/ProjectHome.tsx:ProjectHome
// ─────────────────────────────────────────────────────
const CODE_MARKET_EXAMPLES: Record<string, string> = {
  'Website Template': 'https://code.market/site-templates',
  'Admin Template': 'https://code.market/site-templates/admin-templates',
  'Free Tool': 'https://code.market/',
  'WordPress Plugin': 'https://code.market/wordpress',
  'WooCommerce Plugin': 'https://code.market/wordpress/ecommerce/woocommerce',
  'WordPress Theme': 'https://code.market/wordpress',
  'WooCommerce Theme': 'https://code.market/wordpress/ecommerce/woocommerce',
  'BuddyPress Theme': 'https://code.market/wordpress/buddypress',
  'PHP Script': 'https://code.market/php-scripts',
  '.NET Script': 'https://code.market/net',
  'JavaScript Script': 'https://code.market/javascript',
  'HTML5 Script': 'https://code.market/html5',
  'HTML5 Game': 'https://code.market/html5/games',
  'CSS Component': 'https://code.market/css',
  'Adobe Edge Animate Template': 'https://code.market/edge-animate-templates',
  'macOS App': 'https://code.market/apps/mac',
  'Windows App': 'https://code.market/apps/windows',
  'Android App': 'https://code.market/mobile/android',
  'iOS App': 'https://code.market/mobile/ios',
  'Flutter App': 'https://code.market/mobile/flutter',
  'Native Web App': 'https://code.market/mobile/native-web',
  'Titanium App': 'https://code.market/mobile/titanium',
  'Joomla Extension': 'https://code.market/plugins/joomla',
  'Drupal Module': 'https://code.market/plugins/drupal',
  'Concrete5 Add-on': 'https://code.market/plugins/concrete5',
  'ExpressionEngine Add-on': 'https://code.market/plugins/expressionengine',
  'Magento Extension': 'https://code.market/plugins/magento-extensions',
  'OpenCart Extension': 'https://code.market/plugins/opencart',
  'osCommerce Add-on': 'https://code.market/plugins/oscommerce',
  'PrestaShop Module': 'https://code.market/plugins/prestashop',
  'Ubercart Module': 'https://code.market/plugins/ubercart',
  'VirtueMart Extension': 'https://code.market/plugins/virtuemart',
  'Zen Cart Plugin': 'https://code.market/plugins/zen-cart',
  'Muse Widget': 'https://code.market/plugins/muse-widgets',
  'Bootstrap Skin': 'https://code.market/skins/bootstrap',
  'Layers WP Style Kit': 'https://code.market/skins/layers-wp-style-kits',
  'Blogger Template': 'https://code.market/blogging/blogger',
  'Ghost Theme': 'https://code.market/blogging/ghost-themes',
  'Tumblr Theme': 'https://code.market/blogging/tumblr',
  'Joomla Template': 'https://code.market/cms-themes/joomla',
  'Drupal Theme': 'https://code.market/cms-themes/drupal',
  'Concrete5 Theme': 'https://code.market/cms-themes/concrete5',
  'HubSpot Theme': 'https://code.market/cms-themes/hubspot-cms-hub',
  'MODX Theme': 'https://code.market/cms-themes/modx-themes',
  'Moodle Theme': 'https://code.market/cms-themes/moodle',
  'Webflow Template': 'https://code.market/cms-themes/webflow',
  'Weebly Theme': 'https://code.market/cms-themes/weebly',
  'VirtueMart Theme': 'https://code.market/cms-themes/joomla/virtuemart',
  'Shopify Theme': 'https://code.market/ecommerce/shopify',
  'Magento Theme': 'https://code.market/ecommerce/magento',
  'BigCommerce Theme': 'https://code.market/ecommerce/bigcommerce',
  'OpenCart Theme': 'https://code.market/ecommerce/opencart',
  'PrestaShop Theme': 'https://code.market/ecommerce/prestashop',
  'Zen Cart Template': 'https://code.market/ecommerce/zen-cart',
  'phpBB Theme': 'https://code.market/forums/phpbb',
  'Vanilla Forums Theme': 'https://code.market/forums/vanilla',
  'vBulletin Theme': 'https://code.market/forums/vbulletin',
  'Next.js Template': 'https://code.market/jamstack/next-js',
  'Nuxt.js Template': 'https://code.market/jamstack/nuxt-js',
  'Gatsby Template': 'https://code.market/jamstack/gatsby-js',
  'SvelteKit Template': 'https://code.market/jamstack/sveltekit',
  'Eleventy Template': 'https://code.market/jamstack/eleventy',
  'Jekyll Theme': 'https://code.market/jamstack/jekyll',
  'HTML Template': 'https://code.market/site-templates',
  'Landing Page Template': 'https://code.market/marketing/landing-pages',
  'Unbounce Template': 'https://code.market/marketing/unbounce-landing-pages',
  'Email Template': 'https://code.market/marketing/email-templates',
  'Elementor Template Kit': 'https://code.market/template-kits/elementor',
};

const CODE_MARKET_EXAMPLE_COUNTS: Record<string, { url: string; count: number }> = {
  'Website Template': { url: 'https://code.market/category/app-landing-page', count: 7 },
  'Admin Template': { url: 'https://code.market/category/admin-dashboard', count: 4 },
  'Free Tool': { url: 'https://code.market/category/free', count: 118 },
  'WordPress Plugin': { url: 'https://code.market/category/wordpress/plugins', count: 30 },
  'WooCommerce Plugin': { url: 'https://code.market/category/wordpress/woocommerce', count: 1329 },
  'WordPress Theme': { url: 'https://code.market/category/wordpress-theme', count: 7 },
  'WooCommerce Theme': { url: 'https://code.market/category/wordpress/woocommerce', count: 1329 },
  'PHP Script': { url: 'https://code.market/category/php-script', count: 14 },
  'JavaScript Script': { url: 'https://code.market/category/react', count: 22 },
  'HTML5 Script': { url: 'https://code.market/category/html5-game', count: 10 },
  'HTML5 Game': { url: 'https://code.market/category/html5-game', count: 10 },
  'CSS Component': { url: 'https://code.market/category/bootstrap', count: 1185 },
  'Android App': { url: 'https://code.market/category/android', count: 7045 },
  'iOS App': { url: 'https://code.market/category/ios', count: 2302 },
  'Flutter App': { url: 'https://code.market/category/flutter-app', count: 24 },
  'Native Web App': { url: 'https://code.market/category/react', count: 22 },
  'Bootstrap Skin': { url: 'https://code.market/category/bootstrap', count: 1185 },
  'Blogger Template': { url: 'https://code.market/category/blogger', count: 3 },
  'Ghost Theme': { url: 'https://code.market/category/ghost-theme', count: 59 },
  'Moodle Theme': { url: 'https://code.market/category/moodle-theme', count: 15 },
  'Shopify Theme': { url: 'https://code.market/category/shopify-template', count: 6 },
  'Next.js Template': { url: 'https://code.market/category/nextjs', count: 62 },
  'Nuxt.js Template': { url: 'https://code.market/category/nuxtjs', count: 12 },
  'Gatsby Template': { url: 'https://code.market/category/gatsbyjs', count: 23 },
  'HTML Template': { url: 'https://code.market/category/bootstrap', count: 1185 },
  'Landing Page Template': { url: 'https://code.market/category/app-landing-page', count: 7 },
  'Elementor Template Kit': { url: 'https://code.market/category/wordpress/plugins', count: 30 },
};

function codeMarketExamplesUrl(title: string): string {
  return CODE_MARKET_EXAMPLE_COUNTS[title]?.url || CODE_MARKET_EXAMPLES[title] || 'https://code.market/';
}

function codeMarketExampleCount(title: string): number | null {
  return CODE_MARKET_EXAMPLE_COUNTS[title]?.count ?? null;
}

const PRODUCT_TYPES = PRODUCT_TYPE_NAMES.map((title, index) => {
  const parts = title.split(' ');
  const detail = parts.at(-1) === 'Kit' && parts.length >= 2 ? parts.slice(-2).join(' ') : parts.at(-1) || title;
  const look = CARD_LOOKS[index % CARD_LOOKS.length];
  return {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    title,
    detail,
    art: look.art,
    light: look.light,
    shape: index % 6,
    examplesUrl: codeMarketExamplesUrl(title),
    exampleCount: codeMarketExampleCount(title),
  };
});

function welcomeName(displayName?: string): string | null {
  const trimmed = displayName?.trim();
  if (!trimmed || trimmed.includes('@')) return null;
  const token = trimmed.split(/\s+/)[0];
  return token || null;
}

function HomeMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function LinkMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M14 11a5 5 0 0 0-7.1-.1l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PromptMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 6h14M5 12h9M5 18h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function PreviewMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 9h18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.16.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

function CollapseMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 7 10 12l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 7 14 12l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Ariadne's Thread [AT-0088] ─────────────────────
// What: Render the Code Market home in the referenced dark dashboard layout
// Why:  The first screen should introduce sign-in, a URL rebuild, a prompt, and the builder without inventing a second product
// Date: 2026-10-01
// Related: [AT-0087] frontend→app/page.tsx:Page, [AT-0073] frontend→components/app/generation/BuilderLoginModal.tsx:BuilderLoginModal, [AT-0005] app/page.tsx:Page
// ─────────────────────────────────────────────────────
export default function ProjectHome() {
  const router = useRouter();
  const builderSession = useBuilderSession();
  const sessionRef = useRef(builderSession);
  sessionRef.current = builderSession;
  const pendingHrefRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [composerPrompt, setComposerPrompt] = useState('');
  const [firebasePhotoUrl, setFirebasePhotoUrl] = useState('');
  const [firebasePhotoFailed, setFirebasePhotoFailed] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const name = welcomeName(builderSession.user?.displayName);
  const signedIn = Boolean(builderSession.user);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(builderAuth(), (user) => {
      const photoURL = user?.photoURL || '';
      console.log('[project-home] Firebase profile photo', {
        hasUser: Boolean(user),
        hasPhoto: Boolean(photoURL),
      });
      setFirebasePhotoFailed(false);
      setFirebasePhotoUrl(photoURL);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const draft = readComposerDraft();
    if (!draft) return;
    setComposerPrompt(draft);
    console.log('[project-home] Restored composer draft before sign-in', { chars: draft.length });
  }, []);

  useEffect(() => {
    console.log('[project-home] Code Market home mounted', {
      loading: builderSession.loading,
      authenticated: signedIn,
      hasDisplayName: Boolean(name),
      productTypes: PRODUCT_TYPES.length,
    });
  }, [builderSession.loading, signedIn, name]);

  // ─── Ariadne's Thread [AT-0091] ─────────────────────
  // What: Open Code Market sign-in before any home action when no session exists
  // Why:  Build, Create, and Open Builder were navigating into generation without an account
  // Date: 2026-10-01
  // Related: [AT-0074] frontend→app/generation/page.tsx:ensureBuilderSignedIn, [AT-0088] components/app/home/ProjectHome.tsx:ProjectHome
  // ─────────────────────────────────────────────────────
  const openBuilder = (from: string, event?: { preventDefault: () => void }) => {
    event?.preventDefault();
    console.log('[project-home] Builder action requested', {
      from,
      loading: sessionRef.current.loading,
      authenticated: Boolean(sessionRef.current.user),
    });
    void (async () => {
      const startedAt = Date.now();
      while (sessionRef.current.loading && Date.now() - startedAt < 5000) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      if (!sessionRef.current.user) {
        pendingHrefRef.current = BUILDER_HREF;
        console.log('[project-home] Sign-in required before action', { from, href: BUILDER_HREF });
        setLoginOpen(true);
        return;
      }
      if (sessionRef.current.user.paidPlan !== true) {
        console.log('[project-home] Paid plan required before action', { from, userId: sessionRef.current.user.id });
        setPaywallOpen(true);
        return;
      }
      console.log('[project-home] Opening builder', { from, href: BUILDER_HREF });
      router.push(BUILDER_HREF);
    })();
  };

  const rememberComposerPrompt = (value: string) => {
    setComposerPrompt(value);
    writeComposerDraft(value);
  };

  const insertProductPrompt = (title: string) => {
    const insertion = `Build for me ${title} which: `;
    const current = composerRef.current?.value ?? composerPrompt;
    const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${insertion}` : insertion;
    rememberComposerPrompt(next);
    console.log('[project-home] Inserted product prompt without sign-in', { title, chars: next.length });
    window.requestAnimationFrame(() => {
      const field = composerRef.current;
      if (!field) return;
      field.focus();
      field.setSelectionRange(next.length, next.length);
      field.scrollIntoView({ block: 'center' });
    });
  };

  const openSignIn = (from: string) => {
    console.log('[project-home] Opening Code Market sign-in', { from });
    setLoginOpen(true);
  };

  // ─── Ariadne's Thread [AT-0090] ─────────────────────
  // What: Sign the home setup card in with the existing Google Builder flow
  // Why:  The first step should start Google directly instead of opening the email form
  // Date: 2026-10-01
  // Related: [AT-0068] frontend→lib/auth/firebase.ts:signInBuilderWithGoogle, [AT-0088] components/app/home/ProjectHome.tsx:ProjectHome
  // ─────────────────────────────────────────────────────
  const signInWithGoogle = async () => {
    setGoogleSubmitting(true);
    setGoogleError(null);
    console.log('[project-home] Google sign-in started');
    try {
      const credential = await signInBuilderWithGoogle();
      const idToken = await credential.user.getIdToken(true);
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
      const user = await builderSession.refresh();
      console.log('[project-home] Google sign-in completed', { userId: user?.id ?? null });
    } catch (error) {
      const message = error instanceof Error && !('code' in error)
        ? error.message
        : builderAuthErrorMessage(error);
      console.error('[project-home] Google sign-in failed', { message });
      setGoogleError(message);
    } finally {
      setGoogleSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#0c0f14] text-white">
      {paywallOpen && (
        <BuilderPaywall onClose={() => setPaywallOpen(false)} />
      )}
      <BuilderLoginModal
        open={loginOpen}
        onClose={() => {
          console.log('[project-home] Sign-in closed');
          pendingHrefRef.current = null;
          setLoginOpen(false);
        }}
        onSuccess={async () => {
          setLoginOpen(false);
          const user = await builderSession.refresh();
          const next = pendingHrefRef.current;
          pendingHrefRef.current = null;
          console.log('[project-home] Sign-in completed', { userId: user?.id ?? null, paidPlan: user?.paidPlan === true, next });
          if (user && next && user.paidPlan !== true) {
            console.log('[project-home] Paid plan required after sign-in', { next });
            setPaywallOpen(true);
            return;
          }
          if (user && next) router.push(next);
        }}
      />

      <aside className="hidden w-72 shrink-0 flex-col items-center justify-between border-r border-white/6 bg-[#10141b] py-16 lg:flex">
        <div className="flex flex-col items-center gap-18">
          <Link href="/" className="rounded-12" aria-label={PAGE_META_TITLE}>
            <Image
              src="/codemarket-logo.png"
              alt={PAGE_META_TITLE}
              title={PAGE_META_TITLE}
              description={PAGE_META_DESCRIPTION}
              width={36}
              height={36}
              className="h-36 w-36 rounded-10 object-cover"
            />
          </Link>
          <a
            href="https://code.market"
            onClick={() => console.log('[project-home] Opening Code Market home', { href: 'https://code.market' })}
            className="flex h-40 w-40 items-center justify-center rounded-12 bg-[#123844] text-[#7fd0ea]"
            title="Home"
          >
            <HomeMark />
          </a>
        </div>
        <div className="flex flex-col items-center gap-12">
          <button
            type="button"
            className="flex h-36 w-36 items-center justify-center rounded-10 text-[#9aa3b2] hover:bg-white/6 hover:text-white"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            onClick={() => {
              setSidebarOpen((open) => {
                console.log('[project-home] Sidebar visibility changed', { open: !open });
                return !open;
              });
            }}
          >
            <CollapseMark />
          </button>
          <button
            type="button"
            className="flex h-36 w-36 items-center justify-center overflow-hidden rounded-full bg-[#243041] text-[13px] font-semibold text-white"
            title={signedIn ? `Sign out ${builderSession.user?.email || ''}`.trim() : 'Sign in'}
            onClick={() => {
              if (signedIn) {
                console.log('[project-home] Signing out from home rail');
                void builderSession.logout();
                return;
              }
              openSignIn('rail-avatar');
            }}
          >
            {signedIn && firebasePhotoUrl && !firebasePhotoFailed ? (
              <img
                src={firebasePhotoUrl}
                alt={PAGE_META_TITLE}
                title={PAGE_META_TITLE}
                description={PAGE_META_DESCRIPTION}
                className="h-36 w-36 object-cover"
                onError={() => {
                  console.error('[project-home] Firebase profile photo failed to load');
                  setFirebasePhotoFailed(true);
                }}
              />
            ) : (
              (name || builderSession.user?.email || 'C').slice(0, 1).toUpperCase()
            )}
          </button>
        </div>
      </aside>

      {sidebarOpen && (
        <aside className="hidden w-248 shrink-0 flex-col border-r border-white/6 bg-[#12171f] px-14 py-16 lg:flex">
          <nav className="flex flex-col gap-4">
            <Link href="/" aria-current="page" className="flex items-center gap-8 rounded-12 bg-[#14384a] px-10 py-8 text-[14px] text-white">
              <HomeMark />
              Home
            </Link>
          </nav>
          <div className="mt-22 px-10">
            <p className="text-[11px] font-semibold tracking-[0.08em] text-[#7f8b9c]">RECENTS</p>
            <p className="mt-10 text-[13px] leading-[18px] text-[#8b97a8]">No saved builds yet</p>
          </div>
        </aside>
      )}

      <main className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="pointer-events-none absolute right-0 top-80 h-320 w-420 bg-[radial-gradient(circle_at_center,rgba(36,120,140,0.28),transparent_68%)]" />
        <div className="relative mx-auto flex w-full max-w-[1120px] flex-col px-20 py-20 lg:px-36 lg:py-28">
          <div className="mb-20 flex items-center justify-between lg:hidden">
            <Link href="/" className="flex items-center gap-8">
              <Image
                src="/codemarket-logo.png"
                alt={PAGE_META_TITLE}
                title={PAGE_META_TITLE}
                description={PAGE_META_DESCRIPTION}
                width={32}
                height={32}
                className="h-32 w-32 rounded-8 object-cover"
              />
              <span className="text-[15px] font-semibold">code.market</span>
            </Link>
            <Link
              href={BUILDER_HREF}
              onClick={(event) => openBuilder('mobile-header', event)}
              className="rounded-full bg-white px-14 py-8 text-[13px] font-medium text-[#111]"
            >
              Open Builder
            </Link>
          </div>

          <div className="mb-28 hidden justify-end lg:flex">
            <Link
              href={BUILDER_HREF}
              onClick={(event) => openBuilder('header', event)}
              className="inline-flex items-center gap-8 rounded-full border border-white/10 bg-[#1a212c] px-14 py-8 text-[13px] text-white hover:bg-[#222a36]"
            >
              <Image
                src="/codemarket-logo.png"
                alt={PAGE_META_TITLE}
                title={PAGE_META_TITLE}
                description={PAGE_META_DESCRIPTION}
                width={18}
                height={18}
                className="h-18 w-18 rounded-4 object-cover"
              />
              Open Builder
            </Link>
          </div>

          <h1 className="text-center text-[34px] font-medium tracking-[-0.03em] text-white">
            Welcome to {'{c}'} Builder
          </h1>

          <div className="mx-auto mt-28 w-full max-w-[760px]">
            <p className="text-center text-[16px] leading-[24px] text-[#9aa3b2]">
              AI builder for specific tools at the enterprise level using specific technologies. What other builders can't.
            </p>
            <form
              className="mt-22 rounded-24 border border-white/10 bg-[#12171f] px-16 py-14"
              onSubmit={(event) => {
                event.preventDefault();
                const prompt = composerPrompt.trim();
                console.log('[project-home] Composer submitted', {
                  promptChars: prompt.length,
                });
                if (!prompt) return;
                openBuilder('composer');
              }}
            >
              <textarea
                ref={composerRef}
                value={composerPrompt}
                onChange={(event) => rememberComposerPrompt(event.target.value)}
                placeholder="An app that..."
                rows={2}
                className="w-full resize-none bg-transparent text-[15px] leading-[22px] text-white caret-white outline-none placeholder:text-[#8b8b8b]"
              />
              <div className="mt-8 flex items-center justify-end gap-8">
                  <button
                    type="submit"
                    disabled={!composerPrompt.trim()}
                    className={`rounded-full px-12 py-6 text-[14px] font-medium transition-colors ${composerPrompt.trim() ? 'bg-white text-[#161616] hover:bg-white/90' : 'cursor-default text-[#5c5c5c]'}`}
                  >
                    Build
                  </button>
              </div>
            </form>
          </div>

          <div className="mt-28 grid grid-cols-1 gap-12 md:grid-cols-2 xl:grid-cols-4">
            <article className={`rounded-16 border p-16 ${signedIn ? 'border-white/10 bg-[#171d27]' : 'border-[#3cb4e6] bg-[#15202b] shadow-[0_0_0_1px_rgba(60,180,230,0.25)]'}`}>
              <div className="mb-10 flex items-center justify-between text-[11px] tracking-[0.08em] text-[#8ea0b3]">
                <span className={`inline-flex h-18 w-18 items-center justify-center rounded-full border ${signedIn ? 'border-[#3cb4e6] text-[#3cb4e6]' : 'border-[#3cb4e6]'}`}>
                  {signedIn ? '✓' : ''}
                </span>
                STEP 1
              </div>
              <h2 className="text-[16px] font-semibold">Sign in to {'{c}'} Builder</h2>
              <p className="mt-8 min-h-60 text-[13px] leading-[18px] text-[#b7c3d1]">
                The builder uses your Code Market account before a site can be generated.
              </p>
              {(googleError || builderSession.error) && (
                <p className="mb-8 text-[12px] leading-[16px] text-[#ffb4b4]">{googleError || builderSession.error}</p>
              )}
              {!signedIn && (
                <button
                  type="button"
                  disabled={builderSession.loading || googleSubmitting}
                  onClick={() => void signInWithGoogle()}
                  className="mt-12 flex w-full items-center justify-center gap-8 rounded-full bg-white px-14 py-8 text-[13px] font-medium text-[#161616] hover:bg-white/90 disabled:cursor-wait disabled:opacity-70"
                >
                  <GoogleMark />
                  {builderSession.loading ? 'Checking session' : 'Continue with Google'}
                </button>
              )}
            </article>

            <SetupStep
              index={2}
              title="Ask to build something"
              body="Add a URL in the builder when you want that site rebuilt."
              icon={<LinkMark />}
              active={signedIn}
              locked={!signedIn}
              lockText=""
              actionLabel="Open Builder"
              href={BUILDER_HREF}
              onOpen={(event) => openBuilder('step-2', event)}
            />
            <SetupStep
              index={3}
              title="Review Work"
              body="Or tell the builder what to build, without a source URL."
              icon={<PromptMark />}
              locked={!signedIn}
              lockText=""
            />
            <SetupStep
              index={4}
              title="Host ready product"
              body="The live preview starts in the builder after a URL or a prompt."
              icon={<PreviewMark />}
              locked
              lockText="Unlocks in the builder after a URL or a prompt"
              onLocked={signedIn ? undefined : () => openBuilder('step-4')}
            />
          </div>

          <div className="mt-28 mb-14 flex items-end justify-between gap-12">
            <h2 className="text-[15px] font-medium text-white">What you can build with {'{c}'} Builder</h2>
          </div>

          <div className="grid grid-cols-1 gap-14 sm:grid-cols-2 xl:grid-cols-3">
            {PRODUCT_TYPES.map((product) => (
              <article
                key={product.id}
                className="group relative block h-188 overflow-hidden rounded-18"
              >
                <div className={`absolute inset-0 transition duration-200 group-hover:scale-[1.03] ${product.art}`} />
                <ProductShapes variant={product.shape} />
                <div className={`absolute inset-0 ${product.light ? 'bg-gradient-to-t from-black/10 via-transparent to-black/5' : 'bg-gradient-to-t from-black/45 via-black/10 to-black/25'}`} />
                <div className="absolute left-16 top-14 right-16">
                  <p className={`text-[20px] font-semibold leading-[24px] ${product.light ? 'text-[#161616]' : 'text-white'}`}>{product.title}</p>
                  <p className={`mt-4 text-[13px] ${product.light ? 'text-[#161616]/75' : 'text-white/80'}`}>{product.detail}</p>
                </div>
                <div className="absolute bottom-14 left-16 flex gap-8">
                  <button
                    type="button"
                    onClick={() => insertProductPrompt(product.title)}
                    className="rounded-full bg-white/92 px-14 py-7 text-[13px] font-medium text-[#1a1a1a]"
                  >
                    Build
                  </button>
                  <a
                    href={product.examplesUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => console.log('[project-home] Opening Code Market examples', { title: product.title, href: product.examplesUrl })}
                    className="rounded-full bg-white/92 px-14 py-7 text-[13px] font-medium text-[#1a1a1a]"
                  >
                    {product.exampleCount == null ? 'Examples' : `Examples · ${product.exampleCount.toLocaleString('en-US')}`}
                  </a>
                </div>
              </article>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function SetupStep({
  index,
  title,
  body,
  icon,
  active = false,
  locked,
  lockText,
  actionLabel,
  href,
  onOpen,
  onLocked,
}: {
  index: number;
  title: string;
  body: string;
  icon: ReactNode;
  active?: boolean;
  locked: boolean;
  lockText: string;
  actionLabel?: string;
  href?: string;
  onOpen?: (event: { preventDefault: () => void }) => void;
  onLocked?: () => void;
}) {
  const showLockedAction = Boolean(locked && onLocked && lockText);
  const showLockedText = Boolean((locked || !href) && lockText && !showLockedAction);
  const showOpen = Boolean(!locked && href);
  return (
    <article className={`rounded-16 border p-16 ${active ? 'border-[#3cb4e6] bg-[#15202b] shadow-[0_0_0_1px_rgba(60,180,230,0.25)]' : 'border-white/8 bg-[#171d27]'}`}>
      <div className="mb-10 flex items-center justify-between text-[11px] tracking-[0.08em] text-[#8ea0b3]">
        <span className="text-[#9aa6b5]">{icon}</span>
        STEP {index}
      </div>
      <h2 className="text-[16px] font-semibold text-white/90">{title}</h2>
      <p className="mt-8 min-h-60 text-[13px] leading-[18px] text-[#9aa6b5]">{body}</p>
      {showLockedAction && (
        <button
          type="button"
          onClick={onLocked}
          className="mt-12 text-left text-[12px] text-[#7f8b9c] hover:text-white"
        >
          {lockText}
        </button>
      )}
      {showLockedText && (
        <p className="mt-12 text-[12px] text-[#7f8b9c]">{lockText}</p>
      )}
      {showOpen && href && (
        <Link
          href={href}
          onClick={onOpen}
          className="mt-12 block rounded-full bg-white px-14 py-8 text-center text-[13px] font-medium text-[#161616] hover:bg-white/90"
        >
          {actionLabel}
        </Link>
      )}
    </article>
  );
}

function ProductShapes({ variant }: { variant: number }) {
  if (variant === 0) {
    return (
      <>
        <div className="absolute bottom-18 right-18 h-78 w-110 rounded-14 bg-white/75" />
        <div className="absolute bottom-30 right-28 h-10 w-70 rounded-full bg-black/15" />
        <div className="absolute bottom-44 right-28 h-8 w-48 rounded-full bg-white/50" />
      </>
    );
  }
  if (variant === 1) {
    return (
      <>
        <div className="absolute bottom-16 right-16 h-96 w-140 rounded-12 border border-white/30 bg-black/25" />
        <div className="absolute bottom-30 right-28 h-16 w-56 rounded-4 bg-white/70" />
        <div className="absolute bottom-52 right-28 h-8 w-80 rounded-4 bg-white/30" />
      </>
    );
  }
  if (variant === 2) {
    return (
      <>
        <div className="absolute -right-10 bottom-8 h-100 w-100 rounded-full bg-white/35" />
        <div className="absolute bottom-20 right-48 h-64 w-64 rounded-full bg-black/20" />
      </>
    );
  }
  if (variant === 3) {
    return (
      <>
        <div className="absolute bottom-10 right-10 h-110 w-80 rotate-6 rounded-16 bg-white/70" />
        <div className="absolute bottom-24 right-36 h-70 w-50 -rotate-6 rounded-12 bg-black/25" />
      </>
    );
  }
  if (variant === 4) {
    return (
      <>
        <div className="absolute bottom-16 right-16 h-100 w-150 rounded-12 border border-white/30 bg-black/30" />
        <div className="absolute bottom-36 right-32 h-28 w-70 rounded-8 bg-white/20" />
        <div className="absolute bottom-72 right-32 h-8 w-90 rounded-full bg-white/60" />
      </>
    );
  }
  return (
    <>
      <div className="absolute bottom-14 right-14 h-90 w-120 border-2 border-black/70 bg-white/80" />
      <div className="absolute bottom-28 right-28 h-20 w-70 bg-black/70" />
      <div className="absolute bottom-54 right-28 h-8 w-48 bg-black/50" />
    </>
  );
}
