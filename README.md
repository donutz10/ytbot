# yt-music-bot

A small, self-hosted YouTube music bot for Discord. Slash commands, per-server queues, playlists, loop, shuffle, auto-leave.
Built on discord.js v14 + @discordjs/voice (with DAVE end-to-end voice encryption, which Discord requires since March 2026) and yt-dlp for YouTube.

## Commands
`/play <song name | link | playlist link>` · `/skip` · `/stop` · `/pause` · `/resume` · `/queue` · `/nowplaying` · `/loop` · `/shuffle` · `/remove <position>`

## 1. Create the Discord bot
1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (this is your `DISCORD_TOKEN`, never commit it).
3. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; permissions `Connect`, `Speak`, `Send Messages`, `Embed Links`. Open the URL and add the bot to your server.
   No privileged intents are needed.

## 2. Run it locally (to test)
Requirements: Node.js 22.12+, Python 3, and [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) on your PATH. FFmpeg is bundled via `ffmpeg-static`.
```bash
cp .env.example .env      # paste your token; put your server ID in GUILD_ID for instant commands
npm install
npm start
```

## 3. Host it 24/7 for free
GitHub stores the code (and, via the included Action, builds a Docker image for you at `ghcr.io/<you>/yt-music-bot`), but GitHub itself can't keep a bot online — it needs a machine that's always on. Free options:

**Oracle Cloud "Always Free" VM (recommended)** — a free-forever ARM VM, plenty for a music bot. Needs a card for identity verification (not charged).
1. Create an account at https://www.oracle.com/cloud/free/, then **Compute → Instances → Create**: Ubuntu, shape `VM.Standard.A1.Flex` (1 OCPU / 6 GB is plenty). Save the SSH key.
2. SSH in and run:
```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/<you>/yt-music-bot.git && cd yt-music-bot
cp .env.example .env && nano .env      # paste token
docker compose up -d --build
docker compose logs -f                 # watch it start
```
`restart: unless-stopped` brings it back after crashes and reboots. To update: `git pull && docker compose up -d --build`.

**Your own old PC / Raspberry Pi** — same Docker steps. Bonus: a home IP is much less likely to be blocked by YouTube than a cloud IP.

## If YouTube says "Sign in to confirm you're not a bot"
YouTube often blocks cloud-server IPs. Export cookies from a **throwaway** YouTube account (browser extension "Get cookies.txt LOCALLY"), save as `cookies.txt` next to `docker-compose.yml`, and set `YTDLP_COOKIES=/app/cookies.txt` in `.env`. Don't use your main Google account — it can get flagged.

## Troubleshooting
- **Bot joins but no sound / times out joining:** check logs for the dependency report; `@snazzah/davey` must be listed (it's in package.json).
- **Songs suddenly stop working:** YouTube changed something — restart the container (it runs `yt-dlp -U` on start).
- **Commands don't show up:** set `GUILD_ID` for instant registration; global commands can take a bit.

## Note
Keep this for your own servers. Streaming YouTube this way isn't allowed by YouTube's Terms of Service, which is why the big public music bots (Groovy, Rythm) were shut down — a small private bot is much lower-profile, but that's the risk you're taking.

MIT licensed.
