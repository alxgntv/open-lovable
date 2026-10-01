import { SandboxProvider, SandboxProviderConfig } from './types';
import { CloudflareProvider } from './providers/cloudflare-provider';
import { E2BProvider } from './providers/e2b-provider';
import { VercelProvider } from './providers/vercel-provider';

export class SandboxFactory {
  static create(provider?: string, config?: SandboxProviderConfig): SandboxProvider {
    // ─── Ariadne's Thread [AT-0010] ─────────────────────
    // What: Default sandbox provider to Cloudflare Sandboxes
    // Why:  Production runs on Workers Paid; E2B is no longer the runtime
    // Date: 2026-09-30
    // Related: [AT-0009] lib/sandbox/providers/cloudflare-provider.ts
    // ─────────────────────────────────────────────────────
    const selectedProvider = provider || process.env.SANDBOX_PROVIDER || 'cloudflare';
    console.log('[SandboxFactory] Creating provider', selectedProvider);

    switch (selectedProvider.toLowerCase()) {
      case 'cloudflare':
        return new CloudflareProvider(config || {});

      case 'e2b':
        return new E2BProvider(config || {});
      
      case 'vercel':
        return new VercelProvider(config || {});
      
      default:
        throw new Error(`Unknown sandbox provider: ${selectedProvider}. Supported providers: cloudflare, e2b, vercel`);
    }
  }
  
  static getAvailableProviders(): string[] {
    return ['cloudflare', 'e2b', 'vercel'];
  }
  
  static isProviderAvailable(provider: string): boolean {
    switch (provider.toLowerCase()) {
      case 'cloudflare':
        return !!process.env.CLOUDFLARE_SANDBOX_URL && !!process.env.CLOUDFLARE_SANDBOX_SECRET;

      case 'e2b':
        return !!process.env.E2B_API_KEY;
      
      case 'vercel':
        // Vercel can use OIDC (automatic) or PAT
        return !!process.env.VERCEL_OIDC_TOKEN || 
               (!!process.env.VERCEL_TOKEN && !!process.env.VERCEL_TEAM_ID && !!process.env.VERCEL_PROJECT_ID);
      
      default:
        return false;
    }
  }
}
