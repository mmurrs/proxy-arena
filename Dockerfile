FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY game.mjs brains.mjs server.mjs signer.mjs ./
COPY public ./public
# Record the built commit for the /api/verify surface. The verifiable builder
# checks out a detached HEAD, so .git/HEAD holds the raw SHA; fall back to the
# ref file when building from a branch locally.
COPY .git/HEAD .git-HEAD
COPY .git/refs ./.git-refs
RUN sh -c 'if grep -q "^ref:" .git-HEAD; then REF=$(sed "s/^ref: //" .git-HEAD | tr -d "[:space:]"); cp ".git-refs/${REF#refs/}" COMMIT 2>/dev/null || echo unknown > COMMIT; else cp .git-HEAD COMMIT; fi; rm -rf .git-HEAD .git-refs; echo "built commit: $(cat COMMIT)"'
ENV PORT=3000
ENV APP_PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
