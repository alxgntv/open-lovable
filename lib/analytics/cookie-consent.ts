export const COOKIE_CONSENT_STORAGE_KEY = "cm-cookie-consent";
export const COOKIE_CONSENT_EVENT = "cm-cookie-consent-change";

export type CookieConsentStatus = "accepted" | "declined";

export interface CookieConsentRecord {
  status: CookieConsentStatus;
  updatedAt: string;
}

function sharedConsentDomain(): string | undefined {
  const host = window.location.hostname;
  if (host === "code.market" || host.endsWith(".code.market")) return ".code.market";
  return undefined;
}

function readConsentCookie(): CookieConsentStatus | null {
  const prefix = `${COOKIE_CONSENT_STORAGE_KEY}=`;
  const part = document.cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix));
  if (!part) return null;
  const value = decodeURIComponent(part.slice(prefix.length));
  if (value === "accepted" || value === "declined") return value;
  console.log("[cookieConsent] ignoring unknown cookie status", { value });
  return null;
}

function writeConsentCookie(status: CookieConsentStatus): void {
  const domain = sharedConsentDomain();
  const domainPart = domain ? `; domain=${domain}` : "";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_CONSENT_STORAGE_KEY}=${status}; path=/; max-age=31536000; SameSite=Lax${domainPart}${secure}`;
  console.log("[cookieConsent] wrote shared cookie", { status, domain: domain ?? "host-only" });
}

function clearConsentCookie(): void {
  const expire = "Thu, 01 Jan 1970 00:00:00 GMT";
  const host = window.location.hostname;
  const domains = new Set<string | undefined>([undefined, host, `.${host}`]);
  if (host === "code.market" || host.endsWith(".code.market")) domains.add(".code.market");
  for (const domain of domains) {
    const domainPart = domain ? `; domain=${domain}` : "";
    document.cookie = `${COOKIE_CONSENT_STORAGE_KEY}=; expires=${expire}; path=/${domainPart}`;
  }
  console.log("[cookieConsent] cleared shared cookie");
}

export function readCookieConsent(): CookieConsentRecord | null {
  if (typeof window === "undefined") {
    console.log("[cookieConsent] read skipped: no window");
    return null;
  }

  try {
    const raw = window.localStorage.getItem(COOKIE_CONSENT_STORAGE_KEY);
    console.log("[cookieConsent] read raw", { hasValue: Boolean(raw) });
    if (raw) {
      const parsed = JSON.parse(raw) as CookieConsentRecord;
      if (parsed?.status === "accepted" || parsed?.status === "declined") {
        if (readConsentCookie() !== parsed.status) writeConsentCookie(parsed.status);
        return parsed;
      }
      console.log("[cookieConsent] invalid status, ignoring", parsed);
    }

    const cookieStatus = readConsentCookie();
    if (!cookieStatus) return null;
    console.log("[cookieConsent] using shared cookie", { status: cookieStatus });
    return { status: cookieStatus, updatedAt: "" };
  } catch (error) {
    console.error("[cookieConsent] read failed", error);
    return null;
  }
}

export function writeCookieConsent(status: CookieConsentStatus): CookieConsentRecord {
  const record: CookieConsentRecord = {
    status,
    updatedAt: new Date().toISOString(),
  };

  if (typeof window === "undefined") {
    console.log("[cookieConsent] write skipped: no window", status);
    return record;
  }

  try {
    window.localStorage.setItem(COOKIE_CONSENT_STORAGE_KEY, JSON.stringify(record));
    writeConsentCookie(status);
    window.dispatchEvent(new CustomEvent(COOKIE_CONSENT_EVENT, { detail: record }));
    console.log("[cookieConsent] wrote consent", record);
  } catch (error) {
    console.error("[cookieConsent] write failed", error);
  }

  return record;
}

export function clearAnalyticsCookies(): void {
  if (typeof document === "undefined") return;

  const names = document.cookie.split(";").map((part) => part.trim().split("=")[0]);
  const analyticsNames = names.filter(
    (name) => name.startsWith("ph_") || name.startsWith("phc_"),
  );
  console.log("[cookieConsent] clearing analytics cookies", { analyticsNames });

  const expire = "Thu, 01 Jan 1970 00:00:00 GMT";
  const host = window.location.hostname;
  const domains = new Set<string | undefined>([undefined, host, `.${host}`]);
  if (host === "code.market" || host.endsWith(".code.market")) domains.add(".code.market");

  for (const name of analyticsNames) {
    for (const domain of domains) {
      const domainPart = domain ? `; domain=${domain}` : "";
      document.cookie = `${name}=; expires=${expire}; path=/${domainPart}`;
    }
  }
}
