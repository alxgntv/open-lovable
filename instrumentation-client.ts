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
  posthog.init(posthogKey, {
    api_host: posthogHost,
    defaults: "2026-01-30",
    capture_exceptions: true,
    cross_subdomain_cookie: true,
    debug: process.env.NODE_ENV === "development",
    opt_out_capturing_by_default: true,
  });
  console.log("[posthog] Builder analytics initialized, opted out until cookie consent", { host: posthogHost });
}
