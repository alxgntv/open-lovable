import { Container } from "@cloudflare/containers";

// ─── Ariadne's Thread [AT-0003] ─────────────────────
// What: Route every request to one Code Market container
// Why:  This app keeps sandbox state in process memory, so it stays a single instance
// Date: 2026-09-30
// Related: [AT-0001] next.config.ts, [AT-0002] Dockerfile
// ─────────────────────────────────────────────────────
export class CodeMarketContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "30m";
}

interface Env {
  CODE_MARKET: {
    getByName(name: string): { fetch(request: Request): Promise<Response> };
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log("[code-market-builder] Forwarding request to container:", request.method, new URL(request.url).pathname);
    return env.CODE_MARKET.getByName("code-market").fetch(request);
  },
};
