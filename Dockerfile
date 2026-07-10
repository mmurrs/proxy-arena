FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY game.mjs brains.mjs server.mjs signer.mjs gateway.mjs attest.mjs ./
COPY public ./public
# Record the built commit for the /api/verify surface. The verifiable builder
# checks out a detached HEAD, so .git/HEAD holds the raw SHA; fall back to the
# ref file when building from a branch locally.
COPY .git/HEAD .git-HEAD
COPY .git/refs ./.git-refs
RUN sh -c 'if grep -q "^ref:" .git-HEAD; then REF=$(sed "s/^ref: //" .git-HEAD | tr -d "[:space:]"); cp ".git-refs/${REF#refs/}" COMMIT 2>/dev/null || echo unknown > COMMIT; else cp .git-HEAD COMMIT; fi; rm -rf .git-HEAD .git-refs; echo "built commit: $(cat COMMIT)"'
ENV PORT=3000
ENV APP_PORT=3000
# App identity for the verify surface. The app ID is only known after first
# deploy (chicken-egg), so it's baked here and the app is UPGRADED in place
# from then on — upgrades preserve the app ID.
ENV EIGEN_APP_ID=0xF174BC083D3FDE2a9bEae3f34FC31791fb2ca5aE
EXPOSE 3000
CMD ["node", "server.mjs"]
