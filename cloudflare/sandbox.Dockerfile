# ─── Ariadne's Thread [AT-0007] ─────────────────────
# What: Linux image for one customer Vite sandbox
# Why:  Files() needs sandbox-shim; preinstalled node_modules avoid a 3min npm install per session
# Date: 2026-09-30
# Related: [AT-0008] cloudflare/code-sandbox.ts, [AT-0009] lib/sandbox/providers/cloudflare-provider.ts
# ─────────────────────────────────────────────────────
FROM node:24-trixie-slim

COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

WORKDIR /workspace/app
COPY sandbox-app/package.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund \
  && mkdir -p /workspace/app/src

WORKDIR /workspace

CMD ["sleep", "infinity"]
