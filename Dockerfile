# Pin the EXACT Node that works. nixpacks' "nodejs_20" crept to 20.20.2, whose
# stricter ESM lexer fails to see the `BN` named export in @coral-xyz/anchor
# (pulled in transitively by @pump-fun/agent-payments-sdk) and crashes at start.
# 20.18.0 resolves it fine.
FROM node:20.18.0

WORKDIR /app

# install deps first for layer caching. --no-audit/--no-fund skip extra network
# round-trips; longer fetch retries ride out a slow registry/CDN instead of hanging.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --no-audit --no-fund --fetch-retries=5 --fetch-retry-maxtimeout=120000

# app source + build the client
COPY . .
RUN npm run build

# Railway injects PORT; the server reads it. bind 0.0.0.0 via RAILWAY_ENVIRONMENT.
CMD ["npm", "start"]
