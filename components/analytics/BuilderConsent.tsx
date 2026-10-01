"use client";

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import {
  clearAnalyticsCookies,
  COOKIE_CONSENT_EVENT,
  readCookieConsent,
  writeCookieConsent,
  type CookieConsentRecord,
  type CookieConsentStatus,
} from "@/lib/analytics/cookie-consent";

// ─── Ariadne's Thread [AT-0098] ─────────────────────
// What: Opt the builder into the shared PostHog project only after cookie Accept
// Why:  code.market and builder.code.market must be one project and one consent choice
// Date: 2026-10-01
// Related: [AT-0097] instrumentation-client.ts:posthog.init
// ─────────────────────────────────────────────────────

export default function BuilderConsent() {
  const [consent, setConsent] = useState<CookieConsentRecord | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const sync = () => {
      const next = readCookieConsent();
      console.log("[BuilderConsent] sync consent", next);
      setConsent(next);
      setReady(true);
      if (next?.status === "accepted") {
        posthog.opt_in_capturing();
        console.log("[posthog] opt_in_capturing after cookie Accept");
      } else if (next?.status === "declined") {
        posthog.opt_out_capturing();
        console.log("[posthog] opt_out_capturing after cookie Decline");
      }
    };

    sync();
    window.addEventListener(COOKIE_CONSENT_EVENT, sync);
    return () => window.removeEventListener(COOKIE_CONSENT_EVENT, sync);
  }, []);

  const choose = (status: CookieConsentStatus) => {
    console.log("[BuilderConsent] user chose", status);
    writeCookieConsent(status);
    if (status === "accepted") {
      posthog.opt_in_capturing();
      console.log("[posthog] opt_in_capturing after cookie Accept");
      return;
    }
    posthog.opt_out_capturing();
    clearAnalyticsCookies();
    console.log("[posthog] opt_out_capturing after cookie Decline");
  };

  if (!ready || consent) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-[100] flex justify-center p-16"
      role="dialog"
      aria-label="Cookie consent"
    >
      <div className="flex w-full max-w-560 flex-col gap-12 rounded-16 border border-white/10 bg-[#12171f] p-16 shadow-lg sm:flex-row sm:items-center">
        <p className="flex-1 text-sm text-white/80">
          We use essential cookies to run the site and optional analytics cookies if you allow them.{" "}
          <a
            href="https://code.market/page/cookie-policy"
            className="font-semibold text-white underline underline-offset-2"
          >
            Cookie Policy
          </a>
        </p>
        <div className="flex shrink-0 gap-8">
          <button
            type="button"
            onClick={() => choose("declined")}
            className="flex h-40 items-center justify-center rounded-12 border border-white/20 px-16 text-sm font-semibold text-white"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => choose("accepted")}
            className="flex h-40 items-center justify-center rounded-12 bg-white px-16 text-sm font-semibold text-black"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
