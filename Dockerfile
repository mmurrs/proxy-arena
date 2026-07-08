FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY game.mjs brains.mjs server.mjs ./
COPY public ./public
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
