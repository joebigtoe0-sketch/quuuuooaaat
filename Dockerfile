# Pin the EXACT Node that works. nixpacks' "nodejs_20" crept to 20.20.2, whose
# stricter ESM lexer fails to see the `BN` named export in @coral-xyz/anchor
# (pulled in transitively by @pump-fun/agent-payments-sdk) and crashes at start.
# 20.18.0 resolves it fine.
FROM node:20.18.0

WORKDIR /app

# ---------- PIPER: neural TTS baked into the image ----------
# Riku talks ~4.5h/day. On a metered API that ran ~$4/day on a prepaid balance
# that kept hitting zero and muting him mid-stream; here it is $0/day forever,
# with no key, no rate limit, and no unofficial endpoint anyone can switch off.
# This layer sits ABOVE the npm/app layers so it stays cached across code deploys.
# The smoke test at the end is deliberate: a voice that cannot synthesise should
# fail the BUILD, not surface as a silent stream three hours in.
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_VOICES="en_US-ryan-medium en_US-amy-medium"
RUN set -eux; \
    mkdir -p /opt/piper/voices; \
    curl -fsSL --retry 5 --retry-delay 2 \
      "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
      | tar -xz -C /opt; \
    chmod +x /opt/piper/piper; \
    for v in ${PIPER_VOICES}; do \
      loc="${v%%-*}"; \
      rest="${v#*-}"; \
      name="${rest%%-*}"; \
      qual="${rest##*-}"; \
      lang="${loc%%_*}"; \
      base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${loc}/${name}/${qual}/${v}"; \
      curl -fsSL --retry 5 --retry-delay 2 "${base}.onnx"      -o "/opt/piper/voices/${v}.onnx"; \
      curl -fsSL --retry 5 --retry-delay 2 "${base}.onnx.json" -o "/opt/piper/voices/${v}.onnx.json"; \
    done; \
    echo "piper smoke test" | /opt/piper/piper \
      --model /opt/piper/voices/en_US-ryan-medium.onnx \
      --output_file /tmp/piper-smoke.wav; \
    test -s /tmp/piper-smoke.wav; \
    rm -f /tmp/piper-smoke.wav; \
    du -sh /opt/piper

# Fonts. A Debian base ships almost none, and @napi-rs/canvas renders unnamed
# families as nothing at all — the /pnl card's body text would come out blank.
# Anton (the display face) is registered from the repo; this is the fallback.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core     && rm -rf /var/lib/apt/lists/*

# piper ships libpiper_phonemize + espeak-ng-data next to the binary
ENV LD_LIBRARY_PATH=/opt/piper
ENV ESPEAK_DATA_PATH=/opt/piper/espeak-ng-data

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
