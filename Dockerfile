FROM node:24.21.0-bookworm-slim

# SmartSpectra's Linux runtime needs glibc and libstdc++ from Debian.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN chown node:node /app
USER node

# Install from the root workspace lockfile for reproducible Linux binaries.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node backend/package.json ./backend/package.json
COPY --chown=node:node frontend/package.json ./frontend/package.json
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .
EXPOSE 4000 5173
CMD ["npm", "run", "dev"]
