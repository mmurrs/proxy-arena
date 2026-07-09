FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY game.mjs brains.mjs server.mjs ./
COPY public ./public
ENV PORT=3000
ENV APP_PORT=3000
# Baked-in TLS domain so ingress does not depend on encrypted-env delivery
# (the platform preserves the instance IP across upgrades, so this stays valid).
# The KMS env can still override DOMAIN if provided.
ENV DOMAIN=35-223-107-33.sslip.io
ENV ACME_STAGING=false
EXPOSE 3000
CMD ["node", "server.mjs"]
