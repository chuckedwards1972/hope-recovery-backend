FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN chmod +x node_modules/.bin/prisma
COPY . .
RUN node_modules/.bin/prisma generate
EXPOSE 3000
CMD ["npx", "ts-node", "--transpile-only", "src/index.ts"]