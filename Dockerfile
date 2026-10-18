# Self-contained: the build context is this directory.
FROM node:24-alpine AS build
WORKDIR /srv

# The versions pinned here are what this image builds and runs with.
# package.json's ranges and pnpm-lock.yaml serve the local `pnpm install`;
# this stage copies neither and installs the exact versions with npm.
#
# LOCAL, not --global: measured 2026-09-05, a bare `npm install --global
# typescript` builds an image that fails at the RUN tsc step below with
# "TS2688: Cannot find type definition file for 'node'" — tsconfig.json's
# `"types": ["node"]` makes tsc look for `@types/node` under a node_modules
# next to the config file (the same self-contained resolution that option
# exists for in the first place), and a global npm install never puts
# anything there. A local, unsaved install of both packages together does.
#
# undici@8.12.2 joins the two here: algolia.ts imports `fetch`
# from it (see the runtime stage's own note on why), and tsc must resolve
# both the module and its own bundled types to compile that file at all —
# measured: without it, this step fails "TS2307: Cannot find module
# 'undici'". Same pinned version as the runtime stage installs below, kept
# in lockstep by hand since this build has no lockfile to enforce it.
RUN npm install --no-save typescript@7.0.2 @types/node@26.4.0 undici@8.12.2

# package.json is needed even though nothing in it is installed FROM it (the
# line above installs the two dependencies directly): its "type": "module" is
# what tells tsc's NodeNext module resolution (and, in the runtime stage,
# Node itself) that these .ts/.js files are ES modules.
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

FROM node:24-alpine
WORKDIR /srv
ENV NODE_ENV=production

# One runtime dependency. node:http and the global fetch this base image
# ships are the whole HTTP server and (almost) the whole HTTP client, but
# undici's MockAgent, used by this package's tests, does not install itself
# as the dispatcher the global fetch reads from: measured under plain `node`
# and under vitest (Node 24.18.0 / undici npm 8.10.0), a mocked request made
# through the bare global `fetch` hit the real network. `algolia.ts`
# therefore imports `fetch` from 'undici', which makes it a runtime
# dependency; MockAgent stays test-only. Pinned for the same reason
# typescript/@types/node are pinned above: this stage has no lockfile to
# resolve a range against.
RUN npm install --no-save undici@8.12.2
COPY package.json ./
COPY --from=build /srv/dist ./dist

# Unprivileged, because this is the process that talks to CeX's unofficial
# Algolia index and parses what comes back. It holds no secret (the app id and
# search key are the public pair CeX's own site ships to every browser), and
# it needs to write nothing: no database, no volume, no cache.
RUN addgroup -g 10001 -S cexplugin \
 && adduser -S -D -H -u 10001 -G cexplugin cexplugin
USER cexplugin

# Documentation only. The compose service publishes NO host port: this
# plugin is reachable from the app over the compose network and from
# nowhere else.
EXPOSE 8000

CMD ["node", "dist/server.js"]
