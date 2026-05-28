ARG CACHE_BUST=20260527225507
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]

