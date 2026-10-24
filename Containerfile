FROM docker.io/library/node:24-alpine AS builder

WORKDIR /workspace
RUN apk add --no-cache python3 make gcc g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:24-alpine
WORKDIR /usr/src/wedding-website
# the bucket is mounted over db/; the mount must be writable by the node user (uid/gid 1000)
RUN mkdir db && chown node:node db
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/dist ./dist
COPY config/ ./config/
COPY migrations/ ./migrations/
USER node

CMD ["node", "dist/index.js"]
