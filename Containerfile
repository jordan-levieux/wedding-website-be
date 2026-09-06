FROM docker.io/library/node:24-alpine as builder

WORKDIR /workspace
RUN apk add --no-cache python3 make gcc g++
COPY package.json .
COPY tsconfig.json .
COPY src/ ./src/

RUN npm install
RUN npm run build

FROM docker.io/library/node:24-alpine
WORKDIR /usr/src/wedding-website
RUN mkdir db
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/dist ./dist

CMD ["node", "dist/index.js"]
