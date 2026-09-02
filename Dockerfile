# Single image, two roles: the "app" service runs `next start` (the web
# dashboard + API), the "worker" service runs the background scheduler loop
# (scripts/worker.ts via tsx) — see docker-compose.yml for how each is started.
FROM node:20-alpine
WORKDIR /app

# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]
