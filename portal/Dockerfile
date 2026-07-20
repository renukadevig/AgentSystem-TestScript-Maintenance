# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# TestRun — QA & DesignQA-VLM portal
#
# This is NOT a static site. At runtime the server process:
#   - git-clones a repo and runs `npm install` inside it
#   - spawns the Cypress Electron browser (needs OS graphics libs + xvfb)
#   - writes clones + screenshots to WORKSPACE_DIR
# So it must run as a long-lived container with a real filesystem — it cannot
# run on serverless hosts (Netlify/Vercel/Cloudflare). Any VM or container PaaS
# (a company VM, Coolify, Dokku, Render, Fly.io) works.
#
# We keep the FULL node_modules (no Next "standalone" output) because the app
# invokes ./node_modules/.bin/cypress at runtime.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

# --- System deps: git (cloning) + Cypress/Electron runtime libraries --------
# The Cypress dependency list is from https://on.cypress.io/required-dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      libgtk2.0-0 \
      libgtk-3-0 \
      libgbm-dev \
      libnotify-dev \
      libnss3 \
      libxss1 \
      libasound2 \
      libxtst6 \
      xauth \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

# Cypress caches its downloaded Electron binary here; keep it on a stable path.
ENV CYPRESS_CACHE_FOLDER=/root/.cache/Cypress \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app

# --- Install deps first (better layer caching) ------------------------------
# `npm ci` also downloads the Cypress binary into CYPRESS_CACHE_FOLDER.
COPY package.json package-lock.json ./
RUN npm ci

# --- Build the Next app -----------------------------------------------------
COPY . .
RUN npm run build

# Runtime artifacts (cloned repos + screenshots) live here; mount a volume.
RUN mkdir -p /app/.workspaces
VOLUME ["/app/.workspaces"]

EXPOSE 8080

# `next start` serves the build on $PORT. Secrets are injected at run time via
# --env-file / -e, never baked into the image.
CMD ["npm", "run", "start"]
