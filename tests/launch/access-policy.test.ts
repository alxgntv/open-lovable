import { describe, expect, it } from 'vitest';
import {
  decideLaunchBuilderAccess,
  decidePaidBuilderAccess,
} from '../../lib/auth/access-policy';

const user = { id: '42', email: 'builder@code.market', displayName: 'Builder' };

// ─── Ariadne's Thread [AT-0079] ─────────────────────
// What: Verify paid requests stop without a Code Market session while internal retries continue
// Why:  Login UI alone cannot protect token-spending routes
// Date: 2026-09-30
// Related: [AT-0070] shared→lib/auth/access-policy.ts:decidePaidBuilderAccess, [AT-0071] backend→lib/auth/builder-session.ts:rejectUnauthenticatedPaidRequest
// ─────────────────────────────────────────────────────
describe('builder access policy', () => {
  it('rejects anonymous paid requests', () => {
    expect(decidePaidBuilderAccess({ internal: false, session: { status: 'anonymous' } })).toMatchObject({
      allow: false,
      status: 401,
    });
  });

  it('does not spend tokens while Code Market profile is unavailable', () => {
    expect(decidePaidBuilderAccess({ internal: false, session: { status: 'unavailable' } })).toMatchObject({
      allow: false,
      status: 503,
    });
  });

  it('allows a verified Code Market user', () => {
    expect(decidePaidBuilderAccess({
      internal: false,
      session: { status: 'authenticated', user },
    })).toEqual({ allow: true, actor: 'user', user });
  });

  it('allows internal builder retries without a browser session', () => {
    expect(decidePaidBuilderAccess({ internal: true, session: { status: 'anonymous' } })).toEqual({
      allow: true,
      actor: 'internal',
    });
  });

  it('requires a user for launch creation even when profile lookup fails', () => {
    expect(decideLaunchBuilderAccess({ status: 'unavailable' })).toMatchObject({ allow: false, status: 503 });
    expect(decideLaunchBuilderAccess({ status: 'authenticated', user })).toEqual({
      allow: true,
      actor: 'user',
      user,
    });
  });
});
