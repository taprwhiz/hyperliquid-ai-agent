FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm install && npm run build && npm prune --omit=dev

ENV APP_PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
