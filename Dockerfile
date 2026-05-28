ARG CACHE_BUST=20260528004315
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN ./node_modules/.bin/prisma generate
EXPOSE 3000
CMD ["./node_modules/.bin/ts-node", "--transpile-only", "src/index.ts"]
