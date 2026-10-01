FROM node:22-bookworm-slim

# ffmpeg for transcoding, python3 to run yt-dlp, node (already here) solves YouTube's JS challenges
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 # PO-token plugin: lets yt-dlp pass YouTube's datacenter-IP check (talks to the bgutil container, see docker-compose.yml)
 && python3 -m pip install --no-cache-dir --break-system-packages bgutil-ytdlp-pot-provider

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV FFMPEG_PATH=/usr/bin/ffmpeg \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    NODE_ENV=production

# Update yt-dlp on every start - YouTube changes often and old versions break
CMD ["sh", "-c", "yt-dlp -U || true; node index.js"]
