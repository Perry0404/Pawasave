# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# PawaSave frontend — production image for self-hosting (Coolify / Docker / any VPS).
# Multi-stage: install deps → build (standalone) → run a tiny non-root runtime.
# Build context is this `frontend/` directory (set Coolify "Base Directory" = frontend).
#
# ⚠️  NEXT_PUBLIC_* vars are inlined into the CLIENT bundle at BUILD time — they must
#     be present as build args / build-time env, NOT just at runtime. Coolify injects
#     configured env into the build automatically; for a raw `docker build` pass them
#     with --build-arg. Server-only secrets (SUPABASE_SERVICE_ROLE_KEY, CUSTODY_*, …)
#     are read at RUNTIME only — never bake those into the image.
# ─────────────────────────────────────────────────────────────────────────────

# ── deps: install node_modules against the lockfile ──────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# libc compat for some native deps (e.g. anything pulling in node-gyp builds)
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

# ── builder: compile the Next.js standalone bundle ───────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* build args (client-visible). Add any others you set; the full list
# lives in the env checklist. Coolify passes these in automatically when configured.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_BASE_RPC_URL
ARG NEXT_PUBLIC_KYC_ENABLED
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
ARG NEXT_PUBLIC_BRIDGE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_BASE_RPC_URL=$NEXT_PUBLIC_BASE_RPC_URL \
    NEXT_PUBLIC_KYC_ENABLED=$NEXT_PUBLIC_KYC_ENABLED \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY \
    NEXT_PUBLIC_BRIDGE_URL=$NEXT_PUBLIC_BRIDGE_URL \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── runner: minimal non-root runtime, no node_modules needed ─────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output: server.js + a pruned node_modules, plus static assets & public/.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Simple healthcheck so Coolify/Docker can tell the app is actually serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
