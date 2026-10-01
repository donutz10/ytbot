require('dotenv').config();
const { spawn, execFile } = require('node:child_process');
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

function progressBar(elapsed, total, size = 16) {
  if (!total) return '🔴 **LIVE**';
  const pos = Math.min(size - 1, Math.max(0, Math.round((elapsed / total) * (size - 1))));
  return '▬'.repeat(pos) + '🔘' + '▬'.repeat(size - 1 - pos);
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
  if (isUrl && metaCache.has(query)) return { tracks: [{ ...metaCache.get(query) }], playlistTitle: null };
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

// ---------- audio pipeline ----------
// yt-dlp (best audio) -> ffmpeg -> Ogg/Opus, which Discord can play without re-encoding in JS.
// Attached files skip yt-dlp: ffmpeg downloads the attachment URL itself.
function createStream(track) {
  const input = track.file
    ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', track.url]
    : ['-i', 'pipe:0'];
  const ff = spawn(FFMPEG, [
    '-loglevel', 'error', ...input, '-vn',
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1',
  ]);
  ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  for (const s of [ff.stdin, ff.stdout]) s.on('error', () => {});

  let yt = null;
  if (!track.file) {
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

// ---------- embeds & buttons ----------
function controls(q, disabled = false) {
  const paused = q.player.state.status === AudioPlayerStatus.Paused;
  const btn = (id, emoji, label, style) =>
    new ButtonBuilder().setCustomId(`ctl:${id}`).setEmoji(emoji).setLabel(label).setStyle(style).setDisabled(disabled);
  return new ActionRowBuilder().addComponents(
    btn('pause', paused ? '▶️' : '⏸️', paused ? 'Resume' : 'Pause', paused ? ButtonStyle.Success : ButtonStyle.Secondary),
    btn('skip', '⏭️', 'Skip', ButtonStyle.Primary),
    btn('loop', '🔂', 'Loop', q.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    btn('shuffle', '🔀', 'Shuffle', ButtonStyle.Secondary),
    btn('stop', '⏹️', 'Stop', ButtonStyle.Danger),
  );
}

function nowPlayingEmbed(q, track) {
  const next = q.tracks[0];
  const e = new EmbedBuilder()
    .setColor(track.file ? COLORS.file : COLORS.now)
    .setAuthor({ name: track.file ? '📎  Now playing · attached file' : '▶️  Now playing' })
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .addFields(
      { name: '⏱️ Duration', value: fmt(track.duration), inline: true },
      { name: '📺 Channel', value: (track.channel || (track.file ? 'Uploaded file' : '—')).slice(0, 64), inline: true },
      { name: '⏭️ Up next', value: next ? `${next.title.slice(0, 48)}${q.tracks.length > 1 ? ` (+${q.tracks.length - 1})` : ''}` : 'Nothing · add with /play', inline: true },
    )
    .setFooter({ text: `Requested by ${track.requester.name}${q.loop ? '  •  🔂 loop on' : ''}`, iconURL: track.requester.avatar })
    .setTimestamp();
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
}

function queuedEmbed(q, track, position) {
  const ahead = q.tracks.slice(0, position - 1).reduce((s, t) => s + (t.duration || 0), 0)
    + Math.max(0, (q.current?.duration || 0) - q.elapsed());
  const e = new EmbedBuilder()
    .setColor(track.file ? COLORS.file : COLORS.queue)
    .setAuthor({ name: track.file ? '📎  Added file to queue' : '➕  Added to queue' })
    .setTitle(track.title.slice(0, 256))
    .setURL(track.url)
    .addFields(
      { name: '⏱️ Duration', value: fmt(track.duration), inline: true },
      { name: '🔢 Position', value: `#${position}`, inline: true },
      { name: '⌛ Plays in', value: `~${fmt(ahead)}`, inline: true },
    )
    .setFooter({ text: `Requested by ${track.requester.name}`, iconURL: track.requester.avatar });
  if (track.thumbnail) e.setThumbnail(track.thumbnail);
  return e;
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
    this.loop = false;
    this.proc = null;
    this.skipping = false;
    this.idleTimer = null;
    this.aloneTimer = null;
    this.panel = null; // the latest "Now playing" message (holds the live buttons)

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => this.next());
    this.player.on('error', (e) => {
      console.error('Player error:', e.message);
      this.say(`⚠️ Couldn't play **${this.current?.title ?? 'track'}**, skipping.`);
      this.skipping = true; // don't loop a broken track
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
    return r ? r.playbackDuration / 1000 : 0;
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

  // keep only one live control panel: strip the buttons from the previous one
  retirePanel() {
    const old = this.panel;
    this.panel = null;
    old?.edit({ components: [] }).catch(() => {});
  }

  refreshPanel() {
    this.panel?.edit({ embeds: [nowPlayingEmbed(this, this.current)], components: [controls(this)] }).catch(() => {});
  }

  next() {
    this.proc?.kill();
    this.proc = null;
    if (this.loop && this.current && !this.skipping) this.tracks.unshift(this.current);
    this.skipping = false;
    this.retirePanel();

    const track = this.tracks.shift();
    if (!track) {
      this.current = null;
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.say('👋 Nothing playing for a while — leaving the channel.');
        this.destroy();
      }, IDLE_LEAVE_MS);
      return;
    }

    clearTimeout(this.idleTimer);
    this.current = track;
    this.proc = createStream(track);
    this.player.play(createAudioResource(this.proc.stream, { inputType: StreamType.OggOpus }));

    this.text?.send({ embeds: [nowPlayingEmbed(this, track)], components: [controls(this)] })
      .then((msg) => { if (this.current === track) this.panel = msg; else msg.edit({ components: [] }).catch(() => {}); })
      .catch(() => {});
  }

  skip() {
    this.skipping = true;
    this.player.stop(true); // triggers Idle -> next()
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
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
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop, clear the queue and leave'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle looping the current song'),
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
      return await i.respond(text.length <= 100 ? [{ name: `🔗 ${text}`.slice(0, 100), value: text }] : []);
    }
    const results = await ytSearch(text, 10);
    const choices = results.map((t) => ({ name: choiceName(t), value: t.url }));
    await i.respond(choices.length ? choices : fallback);
  } catch (e) {
    await i.respond(fallback).catch(() => {});
  }
}

// ---------- buttons on the "Now playing" panel ----------
async function handleButton(i) {
  const q = queues.get(i.guildId);
  if (!q || q.destroyed) {
    await i.update({ components: [] }).catch(() => {});
    return i.followUp(eph('Nothing is playing.')).catch(() => {});
  }
  if (i.member.voice?.channelId !== q.connection.joinConfig.channelId) {
    return i.reply(eph('Join my voice channel to use the controls.'));
  }
  switch (i.customId.slice(4)) {
    case 'pause':
      if (q.paused()) q.player.unpause(); else q.player.pause();
      return i.update({ components: [controls(q)] });
    case 'loop':
      q.loop = !q.loop;
      return i.update({ embeds: [nowPlayingEmbed(q, q.current)], components: [controls(q)] });
    case 'shuffle':
      q.shuffle();
      await i.update({ embeds: [nowPlayingEmbed(q, q.current)], components: [controls(q)] });
      return i.followUp(eph(`🔀 Shuffled ${q.tracks.length} tracks.`)).catch(() => {});
    case 'skip': {
      const title = q.current?.title;
      await i.update({ components: [controls(q, true)] });
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
  if (i.isButton() && i.customId.startsWith('ctl:')) return handleButton(i).catch((e) => console.error('Button error:', e));
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
        let tracks = [];
        let playlistTitle = null;
        if (i.commandName === 'play-file') {
          const file = i.options.getAttachment('file', true);
          if (!isAudioAttachment(file)) return i.reply(eph("That doesn't look like an audio file (mp3, wav, flac, ogg, m4a…)."));
          await i.deferReply();
          tracks.push({
            title: file.name.replace(AUDIO_EXT, ''),
            url: file.url,
            duration: await probeDuration(file.url),
            thumbnail: null,
            channel: null,
            file: true,
          });
        } else {
          await i.deferReply();
          ({ tracks, playlistTitle } = await resolveTracks(i.options.getString('query', true)));
        }
        if (!tracks.length) return i.editReply('🔍 Nothing found.');
        const requester = { id: i.user.id, name: i.member.displayName ?? i.user.username, avatar: i.user.displayAvatarURL({ size: 64 }) };
        tracks.forEach((t) => { t.requestedBy = i.user.id; t.requester = requester; });

        const queue = await getOrCreateQueue(i, vc);
        queue.text = i.channel;
        queue.tracks.push(...tracks);
        const wasIdle = !queue.current;
        if (wasIdle) queue.next(); else queue.refreshPanel();

        if (playlistTitle) {
          return i.editReply({
            embeds: [new EmbedBuilder().setColor(COLORS.queue)
              .setAuthor({ name: '📃  Playlist added' })
              .setTitle(playlistTitle.slice(0, 256))
              .setDescription(`**${tracks.length}** songs · ${fmt(tracks.reduce((s, t) => s + (t.duration || 0), 0))} total`)
              .setFooter({ text: `Requested by ${requester.name}`, iconURL: requester.avatar })],
          });
        }
        if (wasIdle) return i.editReply(`▶️ Starting **${tracks[0].title}**`);
        return i.editReply({ embeds: [queuedEmbed(queue, tracks[0], queue.tracks.length)] });
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
      case 'loop':
        q.loop = !q.loop;
        q.refreshPanel();
        return i.reply(q.loop ? '🔂 Looping the current song.' : '➡️ Loop off.');
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
        const t = q.current;
        const elapsed = q.elapsed();
        const e = new EmbedBuilder()
          .setColor(t.file ? COLORS.file : COLORS.now)
          .setAuthor({ name: q.paused() ? '⏸️  Paused' : '🎵  Now playing' })
          .setTitle(t.title.slice(0, 256))
          .setURL(t.url)
          .setDescription(`${progressBar(elapsed, t.duration)}\n\`${fmt(elapsed)} / ${fmt(t.duration)}\`${q.loop ? '  🔂' : ''}`)
          .addFields(
            { name: '📺 Channel', value: (t.channel || (t.file ? 'Uploaded file' : '—')).slice(0, 64), inline: true },
            { name: '🙋 Requested by', value: `<@${t.requestedBy}>`, inline: true },
            { name: '📋 Queue', value: `${q.tracks.length} track${q.tracks.length === 1 ? '' : 's'} · ${fmt(q.queueDuration())}`, inline: true },
          );
        if (t.thumbnail) e.setThumbnail(t.thumbnail);
        return i.reply({ embeds: [e], components: [controls(q)] });
      }
      case 'queue': {
        if (!q?.current) return i.reply(eph('The queue is empty.'));
        const lines = q.tracks.slice(0, 10).map((t, n) =>
          `\`${String(n + 1).padStart(2, '0')}\`  ${link(t)}  ·  \`${fmt(t.duration)}\`  ·  <@${t.requestedBy}>`);
        const more = q.tracks.length > 10 ? `\n*…and ${q.tracks.length - 10} more*` : '';
        const e = new EmbedBuilder()
          .setColor(COLORS.queue)
          .setAuthor({ name: '📋  Queue' })
          .setDescription((
            `**${q.paused() ? '⏸️' : '▶️'} Now:** ${link(q.current)}\n`
            + `${progressBar(q.elapsed(), q.current.duration, 12)} \`${fmt(q.elapsed())} / ${fmt(q.current.duration)}\`\n\n`
            + `${lines.join('\n') || '*Nothing up next — add more with /play*'}${more}`
          ).slice(0, 4000))
          .setFooter({ text: `${q.tracks.length} queued  •  ${fmt(q.queueDuration())} total  •  loop ${q.loop ? 'on' : 'off'}` });
        if (q.current.thumbnail) e.setThumbnail(q.current.thumbnail);
        return i.reply({ embeds: [e] });
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
