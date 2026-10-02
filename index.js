require('dotenv').config();
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);
const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, generateDependencyReport,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType, NoSubscriberBehavior,
} = require('@discordjs/voice');

// ---------- config ----------
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || null;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const COOKIES = process.env.YTDLP_COOKIES || null;
const POT_PROVIDER_URL = process.env.POT_PROVIDER_URL || null; // bgutil PO-token server, see docker-compose.yml
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static') || 'ffmpeg';
const IDLE_LEAVE_MS = 5 * 60 * 1000;   // leave after 5 min with nothing playing
const ALONE_LEAVE_MS = 60 * 1000;      // leave after 1 min alone in the channel
const MAX_PLAYLIST = 100;
const COLORS = { now: 0xff0033, queue: 0x5865f2, file: 0x57f287, info: 0xfee75c };

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ---------- formatting ----------
const fmt = (s) => {
  if (s == null) return 'unknown';
  if (!s) return 'live';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

// "1:02:03" -> seconds; "LIVE"/missing -> 0
const parseLength = (text) => {
  const parts = String(text || '').split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

function progressBar(elapsed, total, size = 14) {
  if (!total) return '🔴 **LIVE**';
  const pos = Math.min(size - 1, Math.max(0, Math.round((elapsed / total) * (size - 1))));
  return '━'.repeat(pos) + '⬤' + '─'.repeat(size - 1 - pos);
}

// "1:30", "90", "2m10s", "+30", "-15" -> absolute seconds (NaN if unparseable)
function parseSeekTarget(text, current) {
  const s = String(text).trim().replace(/\s+/g, '').toLowerCase();
  const rel = /^([+-])(.+)$/.exec(s);
  const body = rel ? rel[2] : s;
  let secs;
  if (/^\d+(:\d{1,2}){1,2}$/.test(body)) secs = parseLength(body);
  else if (/^\d+$/.test(body)) secs = Number(body);
  else if (/^(\d+h)?(\d+m)?(\d+s)?$/.test(body) && body) {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(body);
    secs = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  } else return NaN;
  return rel ? (rel[1] === '+' ? current + secs : current - secs) : secs;
}

const link = (t) => `[${t.title.replace(/[[\]]/g, '')}](${t.url})`;

// ---------- fast YouTube search (powers autocomplete) ----------
const searchCache = new Map(); // query -> { at, results }
const metaCache = new Map();   // video url -> track metadata (lets /play skip yt-dlp for picked results)

async function ytSearch(query, limit = 10) {
  const key = query.trim().toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.results.slice(0, limit);

  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
      query, params: 'EgIQAQ%3D%3D', // videos only
    }),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`YouTube search failed (${res.status})`);
  const data = await res.json();
  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const results = [];
  for (const s of sections) {
    for (const c of s.itemSectionRenderer?.contents ?? []) {
      const v = c.videoRenderer;
      if (!v?.videoId) continue;
      results.push({
        title: v.title?.runs?.map((r) => r.text).join('') || 'Unknown title',
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        duration: parseLength(v.lengthText?.simpleText),
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        channel: v.ownerText?.runs?.[0]?.text || null,
        views: v.shortViewCountText?.simpleText || null,
      });
    }
  }
  searchCache.set(key, { at: Date.now(), results });
  for (const t of results) metaCache.set(t.url, t);
  if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
  if (metaCache.size > 3000) metaCache.delete(metaCache.keys().next().value);
  return results.slice(0, limit);
}

function choiceName(t) {
  const channel = (t.channel || '').slice(0, 24);
  const tail = ` · ${channel} · ${fmt(t.duration)}`;
  const room = 100 - tail.length;
  const title = t.title.length > room ? `${t.title.slice(0, room - 1)}…` : t.title;
  return title + tail;
}

// ---------- yt-dlp (links, playlists, fallback) ----------
function ytArgs(args) {
  // node is used to solve YouTube's JS challenges (required by yt-dlp since late 2025)
  const base = ['--js-runtimes', 'node', '--no-warnings', '--no-playlist'];
  if (COOKIES) base.push('--cookies', COOKIES);
  if (POT_PROVIDER_URL) base.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${POT_PROVIDER_URL}`);
  return [...base, ...args];
}

function ytdlpResolve(query) {
  const isUrl = /^https?:\/\//i.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      ytArgs(['--dump-single-json', '--flat-playlist', '--playlist-end', String(MAX_PLAYLIST), target]),
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          const line = (stderr || '').split('\n').find((l) => l.startsWith('ERROR')) || err.message;
          return reject(new Error(line.replace(/^ERROR:\s*/, '').slice(0, 300)));
        }
        let data;
        try { data = JSON.parse(stdout); } catch { return reject(new Error('Could not parse yt-dlp output')); }
        const entries = (data.entries || [data]).filter((e) => e && (e.id || e.url));
        const tracks = entries.map((e) => ({
          title: e.title || 'Unknown title',
          url: e.webpage_url || (e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`),
          duration: e.duration || 0,
          thumbnail: e.thumbnail || e.thumbnails?.at(-1)?.url || (e.id ? `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg` : null),
          channel: e.uploader || e.channel || null,
        }));
        resolve({ tracks, playlistTitle: isUrl && data._type === 'playlist' ? data.title : null });
      },
    );
  });
}

async function resolveTracks(query) {
  const isUrl = /^https?:\/\//i.test(query);
  if (isUrl && metaCache.has(query)) {
    const meta = metaCache.get(query);
    if (meta.placeholder && meta.direct) await meta.direct.promise; // prefetch in flight: it fills in title/duration
    if (!meta.placeholder) return { tracks: [{ ...meta }], playlistTitle: null };
  }
  if (!isUrl) {
    try {
      const results = await ytSearch(query, 1);
      if (results.length) return { tracks: [{ ...results[0] }], playlistTitle: null };
    } catch (e) {
      console.warn('Fast search failed, falling back to yt-dlp:', e.message);
    }
  }
  return ytdlpResolve(query);
}

// ---------- attached audio files ----------
const AUDIO_EXT = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|wma|aiff?|webm|mp4|mkv|mov)$/i;

function isAudioAttachment(att) {
  const type = att.contentType || '';
  return type.startsWith('audio/') || type.startsWith('video/') || AUDIO_EXT.test(att.name || '');
}

// Reads just the container header via ffmpeg to get the length; resolves undefined if unknown.
function probeDuration(url) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-hide_banner', '-i', url], { timeout: 15_000 }, (_err, _stdout, stderr) => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr || '');
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined);
    });
  });
}

// ---------- direct stream URL prefetch ----------
// yt-dlp's extraction (webpage, player JS, PO token) is the slow part (3-5 s). We do it ahead of time -
// while the user is still looking at the search dropdown, or while a track waits in the queue - and
// store the direct audio URL on the track, so at play time ffmpeg can open it immediately.
const DIRECT_TTL_MS = 4 * 60 * 60 * 1000; // YouTube media URLs expire after ~6 h

function prefetchStream(track) {
  if (!track || track.file) return Promise.resolve(null);
  if (track.direct && Date.now() - track.direct.at < DIRECT_TTL_MS) return track.direct.promise;
  const promise = (async () => {
    const t0 = Date.now();
    const { stdout } = await execFileP(
      YTDLP,
      ytArgs(['-f', 'bestaudio[acodec=opus]/bestaudio/best', '--print',
        '%(title)s|||%(duration)s|||%(uploader)s|||%(id)s|||%(acodec)s|||%(http_headers)j|||%(urls)s', track.url]),
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const [title, duration, uploader, id, acodec, headersJson, urlPart] = stdout.split('|||');
    const url = urlPart.trim().split('\n')[0];
    if (!/^https?:\/\//.test(url)) throw new Error('no direct url');
    const headers = JSON.parse(headersJson.trim());
    if (track.placeholder) { // pasted link: we only knew the URL until now
      Object.assign(track, {
        title: title.trim() || track.url,
        duration: Number(duration) || 0,
        channel: uploader.trim() === 'NA' ? null : uploader.trim(),
        thumbnail: /^[\w-]{11}$/.test(id.trim()) ? `https://i.ytimg.com/vi/${id.trim()}/hqdefault.jpg` : null,
      });
      delete track.placeholder;
    }
    // make sure the URL is actually fetchable from this IP before trusting it at play time
    const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(8_000) });
    await res.body?.cancel();
    if (res.status !== 206 && res.status !== 200) throw new Error(`direct url returned HTTP ${res.status}`);
    console.log(`[prefetch] ${track.title} ready in ${Date.now() - t0} ms (${acodec.trim()})`);
    return { url, opus: acodec.trim() === 'opus', headers };
  })().catch((e) => {
    console.warn(`[prefetch] ${track.title}: ${e.message.split('\n')[0]} - will stream via yt-dlp instead`);
    track.direct = null;
    return null;
  });
  track.direct = { at: Date.now(), promise };
  return promise;
}

// debounce per user: once they pause typing, prefetch the top results (they almost always pick one of those)
const PREFETCH_TOP = 3;
const autocompletePrefetch = new Map();
function schedulePrefetch(userId, tracks) {
  clearTimeout(autocompletePrefetch.get(userId));
  autocompletePrefetch.set(userId, setTimeout(async () => {
    autocompletePrefetch.delete(userId);
    for (const t of tracks.slice(0, PREFETCH_TOP)) {
      prefetchStream(t);
      await new Promise((r) => setTimeout(r, 300)); // stagger so the first pick is ready soonest
    }
  }, 500));
}

// a pasted single-video link: remember it so it can be prefetched before the user even presses Enter
const SINGLE_VIDEO = /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/watch\?(?:[^#]*&)?v=[\w-]{11}|youtu\.be\/[\w-]{11})/i;
function placeholderTrack(url) {
  if (!SINGLE_VIDEO.test(url) || /[?&]list=/.test(url)) return null;
  let t = metaCache.get(url);
  if (!t) {
    t = { title: url, url, duration: undefined, thumbnail: null, channel: null, placeholder: true };
    metaCache.set(url, t);
  }
  return t;
}

// ---------- audio pipeline ----------
// Source -> ffmpeg -> Ogg/Opus, which Discord can play without re-encoding in JS.
//   prefetched direct URL : ffmpeg reads it straight from YouTube (instant start; opus is remuxed, not re-encoded)
//   attached file         : ffmpeg downloads the attachment URL itself
//   fallback              : yt-dlp (best audio) piped into ffmpeg
// `seek` (seconds) uses HTTP range requests on direct URLs/files; on the piped fallback ffmpeg decodes and discards.
function createStream(track, direct, seek = 0) {
  const reconnect = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']; // http(s) inputs only
  const ss = seek > 0 ? ['-ss', String(seek)] : [];
  let input;
  if (track.file) input = [...(/^https?:/i.test(track.url) ? reconnect : []), ...ss, '-i', track.url];
  else if (direct) {
    const hdrs = Object.entries(direct.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    input = [...reconnect, '-headers', hdrs, ...ss, '-i', direct.url];
  } else input = ['-i', 'pipe:0', ...ss];
  const encode = direct?.opus && !track.file
    ? ['-c:a', 'copy']
    : ['-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2'];

  const ff = spawn(FFMPEG, ['-loglevel', 'error', ...input, '-vn', ...encode, '-f', 'ogg', 'pipe:1']);
  ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  for (const s of [ff.stdin, ff.stdout]) s.on('error', () => {});

  let yt = null;
  if (!track.file && !direct) {
    yt = spawn(YTDLP, ytArgs(['-f', 'bestaudio/best', '-o', '-', '-v', track.url]));
    yt.stdout.on('error', () => {});
    yt.stdout.pipe(ff.stdin);
    yt.stderr.on('data', (d) => console.error('[yt-dlp]', d.toString().trim()));
  }
  return {
    stream: ff.stdout,
    kill: () => { yt?.kill('SIGKILL'); ff.kill('SIGKILL'); },
  };
}

// ---------- look & feel ----------
const LOOP = {
  off: { emoji: '➡️', label: 'Loop off', next: 'track' },
  track: { emoji: '🔂', label: 'Loop track', next: 'queue' },
  queue: { emoji: '🔁', label: 'Loop queue', next: 'off' },
};
const SEEK_STEP = 10;
const QUEUE_PAGE = 10;
const PANEL_TICK_MS = 15_000; // live progress refresh on the player panel

function hslToInt(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const [r, g, b] = [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
  return (r << 16) | (g << 8) | b;
}

// every track gets its own vivid accent colour, stable across messages
function trackColor(track) {
  if (track.file) return COLORS.file;
  let h = 0;
  for (const ch of track.url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return hslToInt(h % 360, 0.82, 0.56);
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function statusLine(q) {
  const t = q.current;
  const parts = [q.paused() ? '⏸️ Paused' : '▶️ Playing'];
  if (q.loop !== 'off') parts.push(`${LOOP[q.loop].emoji} ${LOOP[q.loop].label}`);
  parts.push(t.file ? '📎 Attached file' : q.direct?.opus ? '🎧 Opus · direct' : '🎧 Opus');
  return parts.join('  ·  ');
}

function timeline(q) {
  const t = q.current;
  const el = q.elapsed();
  return t.duration
    ? `\`${fmt(el)}\` ${progressBar(el, t.duration)} \`${fmt(t.duration)}\``
    : `\`${fmt(el)}\` ${progressBar(el, 0)}`;
}

function nowPlayingEmbed(q) {
  const t = q.current;
  const upNext = q.tracks.slice(0, 3)
    .map((x, n) => `\`${n + 1}\`  ${clip(x.title, 42)}  ·  \`${fmt(x.duration)}\``)
    .join('\n');
  const e = new EmbedBuilder()
    .setColor(trackColor(t))
    .setAuthor({ name: t.file ? 'NOW PLAYING  ·  ATTACHED FILE' : 'NOW PLAYING', iconURL: t.requester.avatar })
    .setTitle(t.title.slice(0, 256))
    .setURL(t.url)
    .setDescription(`${timeline(q)}\n${statusLine(q)}`)
    .addFields(
      { name: '📺 Channel', value: clip(t.channel || (t.file ? 'Uploaded by requester' : '—'), 40), inline: true },
      { name: '🙋 Requested by', value: `<@${t.requestedBy}>`, inline: true },
      { name: '📋 Queue', value: q.tracks.length ? `${q.tracks.length} track${q.tracks.length === 1 ? '' : 's'}  ·  ${fmt(q.queueDuration())}` : 'empty', inline: true },
      { name: `⏭️ Up next${q.tracks.length > 3 ? `  (+${q.tracks.length - 3} more)` : ''}`, value: upNext || '*Nothing — add more with /play*' },
    )
    .setFooter({ text: `⏪ ⏩ seek ${SEEK_STEP}s  ·  /seek 1:30  ·  loop cycles off → track → queue` })
    .setTimestamp();
  if (t.thumbnail) e.setImage(t.thumbnail);
  return e;
}

function queuedEmbed(q, track, position) {
  const ahead = q.tracks.slice(0, position - 1).reduce((s, t) => s + (t.duration || 0), 0)
    + Math.max(0, (q.current?.duration || 0) - q.elapsed());
  const e = new EmbedBuilder()
    .setColor(trackColor(track))
    .setAuthor({ name: track.file ? 'ADDED TO QUEUE  ·  ATTACHED FILE' : 'ADDED TO QUEUE', iconURL: track.requester.avatar })
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .addFields(
      { name: '⏱️ Duration', value: fmt(track.duration), inline: true },
      { name: '🔢 Position', value: `#${position}`, inline: true },
      { name: '⌛ Plays in', value: `~${fmt(ahead)}`, inline: true },
    );
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
}

function playlistEmbed(title, tracks, requester) {
  return new EmbedBuilder()
    .setColor(COLORS.queue)
    .setAuthor({ name: 'PLAYLIST ADDED', iconURL: requester.avatar })
    .setTitle(title.slice(0, 256))
    .setDescription(`**${tracks.length}** songs  ·  ${fmt(tracks.reduce((s, t) => s + (t.duration || 0), 0))} total\n\n`
      + tracks.slice(0, 5).map((t, n) => `\`${n + 1}\`  ${clip(t.title, 48)}`).join('\n')
      + (tracks.length > 5 ? `\n*…and ${tracks.length - 5} more*` : ''))
    .setThumbnail(tracks[0]?.thumbnail ?? null);
}

function queueEmbed(q, page = 0) {
  const pages = Math.max(1, Math.ceil(q.tracks.length / QUEUE_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const start = page * QUEUE_PAGE;
  const lines = q.tracks.slice(start, start + QUEUE_PAGE).map((t, n) =>
    `\`${String(start + n + 1).padStart(2, '0')}\`  ${link({ ...t, title: clip(t.title, 50) })}  ·  \`${fmt(t.duration)}\`  ·  <@${t.requestedBy}>`);
  const e = new EmbedBuilder()
    .setColor(trackColor(q.current))
    .setAuthor({ name: 'QUEUE' })
    .setDescription((
      `**${q.paused() ? '⏸️' : '▶️'} Now:** ${link(q.current)}\n${timeline(q)}\n\n`
      + (lines.join('\n') || '*Nothing up next — add more with /play*')
    ).slice(0, 4000))
    .setFooter({ text: `Page ${page + 1}/${pages}  ·  ${q.tracks.length} queued  ·  ${fmt(q.queueDuration())} total  ·  ${LOOP[q.loop].label.toLowerCase()}` });
  if (q.current.thumbnail) e.setThumbnail(q.current.thumbnail);
  return { embed: e, page, pages };
}

function queueButtons(page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`q:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId('q:noop').setLabel(`${page + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`q:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(`q:${page}`).setEmoji('🔄').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
  );
}

function controls(q, disabled = false) {
  const paused = q.paused();
  const canSeek = Boolean(q.current?.duration);
  const btn = (id, emoji, label, style, off = disabled) =>
    new ButtonBuilder().setCustomId(`ctl:${id}`).setEmoji(emoji).setLabel(label).setStyle(style).setDisabled(off);
  return [
    new ActionRowBuilder().addComponents(
      btn('pause', paused ? '▶️' : '⏸️', paused ? 'Resume' : 'Pause', paused ? ButtonStyle.Success : ButtonStyle.Secondary),
      btn('skip', '⏭️', 'Skip', ButtonStyle.Primary),
      btn('loop', LOOP[q.loop].emoji, LOOP[q.loop].label, q.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
      btn('shuffle', '🔀', 'Shuffle', ButtonStyle.Secondary),
      btn('stop', '⏹️', 'Stop', ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      btn('back', '⏪', `${SEEK_STEP}s`, ButtonStyle.Secondary, disabled || !canSeek),
      btn('fwd', '⏩', `${SEEK_STEP}s`, ButtonStyle.Secondary, disabled || !canSeek),
      btn('queue', '📋', 'Queue', ButtonStyle.Secondary),
      new ButtonBuilder().setEmoji('🔗').setLabel(q.current?.file ? 'File' : 'YouTube').setStyle(ButtonStyle.Link).setURL(q.current?.url ?? 'https://youtube.com'),
    ),
  ];
}

// ---------- per-server queue ----------
const queues = new Map();

class GuildQueue {
  constructor(guildId, connection, textChannel) {
    this.guildId = guildId;
    this.connection = connection;
    this.text = textChannel;
    this.tracks = [];
    this.current = null;
    this.loop = 'off';       // off | track | queue
    this.proc = null;
    this.direct = null;      // stream info of the current track (null = yt-dlp pipe)
    this.offset = 0;         // seconds the current stream started at (after a seek)
    this.skipping = false;
    this.dropCurrent = false;
    this.loading = null;
    this.idleTimer = null;
    this.aloneTimer = null;
    this.panel = null;       // the latest "Now playing" message (holds the live buttons)
    this.ticker = setInterval(() => this.tick(), PANEL_TICK_MS);

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => this.next());
    this.player.on('error', (e) => {
      console.error('Player error:', e.message);
      this.say(`⚠️ Couldn't play **${this.current?.title ?? 'track'}**, skipping.`);
      this.dropCurrent = true; // don't loop a broken track
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // moved to another channel = reconnecting; otherwise we were kicked
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy());
  }

  say(content) {
    this.text?.send(content).catch(() => {});
  }

  elapsed() {
    const r = this.player.state.resource;
    return this.offset + (r ? r.playbackDuration / 1000 : 0);
  }

  paused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  queueDuration() {
    return this.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  }

  shuffle() {
    for (let n = this.tracks.length - 1; n > 0; n--) {
      const r = Math.floor(Math.random() * (n + 1));
      [this.tracks[n], this.tracks[r]] = [this.tracks[r], this.tracks[n]];
    }
  }

  cycleLoop(mode) {
    this.loop = mode && LOOP[mode] ? mode : LOOP[this.loop].next;
    return this.loop;
  }

  // keep only one live control panel: strip the buttons from the previous one
  retirePanel() {
    const old = this.panel;
    this.panel = null;
    old?.edit({ components: [] }).catch(() => {});
  }

  adoptPanel(msg) {
    this.retirePanel();
    this.panel = msg;
  }

  refreshPanel() {
    this.primeNext();
    if (this.current && this.panel) {
      this.panel.edit({ embeds: [nowPlayingEmbed(this)], components: controls(this) }).catch(() => {});
    }
  }

  // live progress bar on the panel
  tick() {
    if (this.current && !this.loading && !this.paused() && this.panel) {
      this.panel.edit({ embeds: [nowPlayingEmbed(this)] }).catch(() => {});
    }
  }

  // resolve the upcoming track's stream URL in the background so skips and transitions are instant
  primeNext() {
    prefetchStream(this.tracks[0]);
  }

  async next() {
    this.proc?.kill();
    this.proc = null;
    if (this.current && !this.dropCurrent) {
      if (this.loop === 'track' && !this.skipping) this.tracks.unshift(this.current);
      else if (this.loop === 'queue') this.tracks.push(this.current);
    }
    this.skipping = false;
    this.dropCurrent = false;
    this.offset = 0;
    this.direct = null;
    this.retirePanel();

    const track = this.tracks.shift();
    if (!track) {
      this.current = null;
      this.loading = null;
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.say('👋 Nothing playing for a while — leaving the channel.');
        this.destroy();
      }, IDLE_LEAVE_MS);
      return;
    }

    clearTimeout(this.idleTimer);
    this.current = track;
    const token = (this.loading = {});
    const direct = await prefetchStream(track); // instant if already prefetched
    if (this.loading !== token || this.destroyed) return; // skipped/stopped while resolving
    this.loading = null;

    this.direct = direct;
    this.proc = createStream(track, direct);
    this.player.play(createAudioResource(this.proc.stream, { inputType: StreamType.OggOpus }));
    this.primeNext();

    this.text?.send({ embeds: [nowPlayingEmbed(this)], components: controls(this) })
      .then((msg) => { if (this.current === track) this.panel = msg; else msg.edit({ components: [] }).catch(() => {}); })
      .catch(() => {});
  }

  // jump to an absolute position (seconds) in the current track; returns the clamped position
  async seek(seconds) {
    const t = this.current;
    if (!t || this.loading) throw new Error('Nothing is playing yet.');
    if (!t.duration) throw new Error("Can't seek in a live stream.");
    if (!Number.isFinite(seconds)) throw new Error('Give me a time like `1:30`, `90`, `+30` or `-15`.');
    seconds = Math.max(0, Math.min(Math.floor(seconds), Math.floor(t.duration) - 1));
    const direct = t.file ? null : await prefetchStream(t);
    if (this.current !== t || this.destroyed) return seconds;
    const old = this.proc;
    this.proc = createStream(t, direct, seconds);
    this.direct = direct;
    this.offset = seconds;
    this.player.play(createAudioResource(this.proc.stream, { inputType: StreamType.OggOpus })); // replaces the old resource, no Idle fired
    old?.kill();
    return seconds;
  }

  skip() {
    this.skipping = true;
    if (this.loading) { this.loading = null; return this.next(); } // still resolving: move on directly
    this.player.stop(true); // triggers Idle -> next()
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.ticker);
    clearTimeout(this.idleTimer);
    clearTimeout(this.aloneTimer);
    this.tracks = [];
    this.retirePanel();
    this.proc?.kill();
    this.player.stop(true);
    try { this.connection.destroy(); } catch {}
    queues.delete(this.guildId);
  }
}

async function getOrCreateQueue(interaction, voiceChannel) {
  let q = queues.get(interaction.guildId);
  if (q) return q;
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (e) {
    connection.destroy();
    throw new Error('Could not connect to the voice channel (timed out).');
  }
  q = new GuildQueue(interaction.guildId, connection, interaction.channel);
  queues.set(interaction.guildId, q);
  return q;
}

// ---------- slash commands ----------
const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song or playlist from YouTube')
    .addStringOption((o) => o.setName('query').setDescription('Start typing to see results · or paste a link').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('play-file').setDescription('Play an attached audio file')
    .addAttachmentOption((o) => o.setName('file').setDescription('An audio file to play (mp3, wav, flac, ogg, m4a…)').setRequired(true)),
  new SlashCommandBuilder().setName('seek').setDescription('Jump to a position in the current song')
    .addStringOption((o) => o.setName('to').setDescription('1:30 · 90 · 2m10s · +30 · -15').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop, clear the queue and leave'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the player panel'),
  new SlashCommandBuilder().setName('loop').setDescription('Loop the current song or the whole queue')
    .addStringOption((o) => o.setName('mode').setDescription('Leave empty to cycle')
      .addChoices({ name: 'off', value: 'off' }, { name: 'track', value: 'track' }, { name: 'queue', value: 'queue' })),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a song from the queue')
    .addIntegerOption((o) => o.setName('position').setDescription('Position in /queue').setRequired(true).setMinValue(1)),
].map((c) => c.setContexts(InteractionContextType.Guild).toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(generateDependencyReport());
  try {
    if (GUILD_ID) await client.application.commands.set(commands, GUILD_ID);
    else await client.application.commands.set(commands);
    console.log(`Registered ${commands.length} slash commands ${GUILD_ID ? `in guild ${GUILD_ID}` : 'globally'}`);
  } catch (e) {
    console.error('Failed to register commands:', e);
  }
});

const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ---------- autocomplete: live search results while typing ----------
async function handleAutocomplete(i) {
  const focused = i.options.getFocused(true);
  const text = String(focused.value || '').trim();
  const fallback = text.length <= 100 ? [{ name: `🔍 Search "${text}"`.slice(0, 100), value: text }] : [];
  try {
    if (i.commandName !== 'play' || focused.name !== 'query' || !text) return await i.respond([]);
    if (/^https?:\/\//i.test(text)) {
      await i.respond(text.length <= 100 ? [{ name: `🔗 ${text}`.slice(0, 100), value: text }] : []);
      const t = placeholderTrack(text);
      if (t) schedulePrefetch(i.user.id, [t]);
      return;
    }
    const results = await ytSearch(text, 10);
    const choices = results.map((t) => ({ name: choiceName(t), value: t.url }));
    await i.respond(choices.length ? choices : fallback);
    if (results.length) schedulePrefetch(i.user.id, results);
  } catch (e) {
    await i.respond(fallback).catch(() => {});
  }
}

// ---------- buttons on the player panel and the queue ----------
async function handleButton(i) {
  const q = queues.get(i.guildId);
  if (!q || q.destroyed || !q.current) {
    await i.update({ components: [] }).catch(() => {});
    return i.followUp(eph('Nothing is playing.')).catch(() => {});
  }
  if (i.customId.startsWith('q:')) { // queue pagination - anyone may browse
    const { embed, page, pages } = queueEmbed(q, Number(i.customId.slice(2)) || 0);
    return i.update({ embeds: [embed], components: [queueButtons(page, pages)] });
  }
  if (i.member.voice?.channelId !== q.connection.joinConfig.channelId) {
    return i.reply(eph('Join my voice channel to use the controls.'));
  }
  const panel = () => ({ embeds: [nowPlayingEmbed(q)], components: controls(q) });
  switch (i.customId.slice(4)) {
    case 'pause':
      if (q.paused()) q.player.unpause(); else q.player.pause();
      return i.update(panel());
    case 'loop':
      q.cycleLoop();
      return i.update(panel());
    case 'shuffle':
      q.shuffle();
      q.primeNext();
      await i.update(panel());
      return i.followUp(eph(`🔀 Shuffled ${q.tracks.length} tracks.`)).catch(() => {});
    case 'back':
    case 'fwd': {
      await i.deferUpdate();
      await q.seek(q.elapsed() + (i.customId.endsWith('fwd') ? SEEK_STEP : -SEEK_STEP));
      return i.editReply(panel()).catch(() => {});
    }
    case 'queue': {
      const { embed, page, pages } = queueEmbed(q, 0);
      return i.reply({ embeds: [embed], components: [queueButtons(page, pages)], flags: MessageFlags.Ephemeral });
    }
    case 'skip': {
      const title = q.current?.title;
      await i.update({ components: controls(q, true) });
      q.skip();
      return q.say(`⏭️ <@${i.user.id}> skipped **${title}**`);
    }
    case 'stop':
      await i.update({ components: [] });
      q.destroy();
      return q.say(`⏹️ <@${i.user.id}> stopped the music.`);
  }
}

client.on('interactionCreate', async (i) => {
  if (!i.inGuild()) return;
  if (i.isAutocomplete()) return handleAutocomplete(i);
  if (i.isButton() && (i.customId.startsWith('ctl:') || i.customId.startsWith('q:'))) {
    return handleButton(i).catch((e) => {
      console.error('Button error:', e);
      i.followUp(eph(`❌ ${e.message}`)).catch(() => {});
    });
  }
  if (!i.isChatInputCommand()) return;

  const q = queues.get(i.guildId);
  const vc = i.member.voice?.channel;

  // everything except /queue, /nowplaying and the play commands requires being in the bot's channel
  const needsSameChannel = !['queue', 'nowplaying', 'play', 'play-file'].includes(i.commandName);
  if (needsSameChannel) {
    if (!q) return i.reply(eph('Nothing is playing.'));
    if (vc?.id !== q.connection.joinConfig.channelId) return i.reply(eph('Join my voice channel first.'));
  }

  try {
    switch (i.commandName) {
      case 'play':
      case 'play-file': {
        if (!vc) return i.reply(eph('Join a voice channel first.'));
        if (q && q.connection.joinConfig.channelId !== vc.id) {
          return i.reply(eph(`I'm already playing in <#${q.connection.joinConfig.channelId}>.`));
        }
        const perms = vc.permissionsFor(i.guild.members.me);
        if (!perms?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
          return i.reply(eph("I don't have permission to connect/speak in that channel."));
        }
        const file = i.commandName === 'play-file' ? i.options.getAttachment('file', true) : null;
        if (file && !isAudioAttachment(file)) return i.reply(eph("That doesn't look like an audio file (mp3, wav, flac, ogg, m4a…)."));
        await i.deferReply();

        // join the voice channel while the track is being resolved, not after
        const joining = q ? Promise.resolve(q) : getOrCreateQueue(i, vc);
        joining.catch(() => {});

        let tracks = [];
        let playlistTitle = null;
        if (file) {
          tracks.push({
            title: file.name.replace(AUDIO_EXT, ''),
            url: file.url,
            duration: await probeDuration(file.url),
            thumbnail: null,
            channel: null,
            file: true,
          });
        } else {
          ({ tracks, playlistTitle } = await resolveTracks(i.options.getString('query', true)));
        }
        if (!tracks.length) return i.editReply('🔍 Nothing found.');
        prefetchStream(tracks[0]); // start resolving the stream URL now, overlapping with the voice join
        const requester = { id: i.user.id, name: i.member.displayName ?? i.user.username, avatar: i.user.displayAvatarURL({ size: 64 }) };
        tracks.forEach((t) => { t.requestedBy = i.user.id; t.requester = requester; });

        const queue = await joining;
        queue.text = i.channel;
        queue.tracks.push(...tracks);
        const wasIdle = !queue.current;
        if (wasIdle) queue.next(); else queue.refreshPanel();

        if (playlistTitle) return i.editReply({ embeds: [playlistEmbed(playlistTitle, tracks, requester)] });
        if (wasIdle) return i.editReply(`${tracks[0].direct ? '⚡' : '▶️'} Starting **${tracks[0].title}**`);
        return i.editReply({ embeds: [queuedEmbed(queue, tracks[0], queue.tracks.length)] });
      }
      case 'seek': {
        const target = parseSeekTarget(i.options.getString('to', true), q.elapsed());
        await i.deferReply();
        const pos = await q.seek(target);
        q.refreshPanel();
        return i.editReply(`⏩ Jumped to \`${fmt(pos)}\` / \`${fmt(q.current.duration)}\``);
      }
      case 'skip': {
        const title = q.current?.title;
        q.skip();
        return i.reply(`⏭️ Skipped **${title}**.`);
      }
      case 'stop':
        q.destroy();
        return i.reply('⏹️ Stopped and left the channel.');
      case 'pause':
        q.player.pause();
        q.refreshPanel();
        return i.reply('⏸️ Paused.');
      case 'resume':
        q.player.unpause();
        q.refreshPanel();
        return i.reply('▶️ Resumed.');
      case 'loop': {
        const mode = q.cycleLoop(i.options.getString('mode'));
        q.refreshPanel();
        return i.reply(`${LOOP[mode].emoji} ${LOOP[mode].label}.`);
      }
      case 'shuffle':
        q.shuffle();
        q.refreshPanel();
        return i.reply(`🔀 Shuffled ${q.tracks.length} tracks.`);
      case 'remove': {
        const pos = i.options.getInteger('position', true);
        if (pos > q.tracks.length) return i.reply(eph(`There are only ${q.tracks.length} songs in the queue.`));
        const [removed] = q.tracks.splice(pos - 1, 1);
        q.refreshPanel();
        return i.reply(`🗑️ Removed **${removed.title}**.`);
      }
      case 'nowplaying': {
        if (!q?.current) return i.reply(eph('Nothing is playing.'));
        await i.reply({ embeds: [nowPlayingEmbed(q)], components: controls(q) });
        q.adoptPanel(await i.fetchReply()); // this message becomes the live panel
        return;
      }
      case 'queue': {
        if (!q?.current) return i.reply(eph('The queue is empty.'));
        const { embed, page, pages } = queueEmbed(q, (i.options.getInteger('page') ?? 1) - 1);
        return i.reply({ embeds: [embed], components: [queueButtons(page, pages)] });
      }
    }
  } catch (e) {
    console.error(e);
    const msg = `❌ ${e.message}`;
    if (i.deferred || i.replied) i.editReply(msg).catch(() => {});
    else i.reply(eph(msg)).catch(() => {});
  }
});

// leave when everyone else leaves the channel
client.on('voiceStateUpdate', (oldState, newState) => {
  const q = queues.get(oldState.guild.id || newState.guild.id);
  if (!q) return;
  const channel = oldState.guild.channels.cache.get(q.connection.joinConfig.channelId);
  if (!channel) return;
  const humans = channel.members.filter((m) => !m.user.bot).size;
  if (humans === 0 && !q.aloneTimer) {
    q.aloneTimer = setTimeout(() => {
      q.say('👋 Everyone left — see you later.');
      q.destroy();
    }, ALONE_LEAVE_MS);
  } else if (humans > 0 && q.aloneTimer) {
    clearTimeout(q.aloneTimer);
    q.aloneTimer = null;
  }
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
client.login(TOKEN);
