import posthog from "posthog-js";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

// ─── Ariadne's Thread [AT-0097] ─────────────────────
// What: Send builder.code.market events to the same PostHog project as code.market
// Why:  The two frontends run on different servers but must be one analytics project
// Date: 2026-10-01
// Related: front-code-market-new/instrumentation-client.ts:posthog.init
// ─────────────────────────────────────────────────────
if (!posthogKey || !posthogHost) {
  if (process.env.NODE_ENV === "development") {
    const missingVariable = posthogKey
      ? "NEXT_PUBLIC_POSTHOG_HOST"
      : "NEXT_PUBLIC_POSTHOG_KEY";
    console.error(`[posthog] ${missingVariable} is missing, so builder events will not be captured`);
  }
} else {
  // ─── Ariadne's Thread [AT-0103] ─────────────────────
  // What: Capture builder events on every visit, including after a stored cookie Decline
  // Why:  Analytics must be collected without waiting for Accept or stopping on Decline
  // Date: 2026-10-03
  // Related: [AT-0097] instrumentation-client.ts:posthog.init, [AT-0104] frontend→components/analytics/BuilderConsent.tsx:BuilderConsent
  // ─────────────────────────────────────────────────────
  posthog.init(posthogKey, {
    api_host: posthogHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    cross_subdomain_cookie: true,
    debug: process.env.NODE_ENV === "development",
  });
  console.log("[posthog] Builder analytics initialized with capturing always on", {
    host: posthogHost,
    optedOut: posthog.has_opted_out_capturing(),
    explicitConsent: posthog.get_explicit_consent_status(),
  });
  if (posthog.has_opted_out_capturing()) {
    console.log("[posthog] stored opt-out found, opting back in so capturing is never skipped", {
      explicitConsent: posthog.get_explicit_consent_status(),
    });
    posthog.opt_in_capturing({ captureEventName: false });
    console.log("[posthog] stored opt-out cleared", {
      optedOut: posthog.has_opted_out_capturing(),
      optedIn: posthog.has_opted_in_capturing(),
      explicitConsent: posthog.get_explicit_consent_status(),
    });
  }
}
