# liquidy's image for the lab's work cluster (hack-lab images.yml `liquidy`): the built bot with
# production dependencies only. Settings come from the environment or an env file
# (node --env-file=<file>); see README > Configuration.
ARG NODE_IMAGE=docker.io/library/node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --no-fund --no-audit
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-fund --no-audit

FROM ${NODE_IMAGE}
WORKDIR /opt/liquidy
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# The SQLite file's folder, owned by the runtime user so a new volume inherits it. The environment
# wins over an env file, so DATABASE_PATH here holds unless the deploy sets it.
RUN mkdir -p /var/lib/liquidy && chown 10001:10001 /var/lib/liquidy
ENV NODE_ENV=production DATABASE_PATH=/var/lib/liquidy/liquidy.db
USER 10001:10001
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
