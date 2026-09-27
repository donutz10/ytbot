require('dotenv').config();
const { spawn, execFile } = require('node:child_process');
const {
  Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, MessageFlags, PermissionFlagsBits, InteractionContextType,
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
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static') || 'ffmpeg';
const IDLE_LEAVE_MS = 5 * 60 * 1000;   // leave after 5 min with nothing playing
const ALONE_LEAVE_MS = 60 * 1000;      // leave after 1 min alone in the channel
const MAX_PLAYLIST = 100;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ---------- yt-dlp helpers ----------
function ytArgs(args) {
  // node is used to solve YouTube's JS challenges (required by yt-dlp since late 2025)
  const base = ['--js-runtimes', 'node', '--no-warnings', '--no-playlist'];
  if (COOKIES) base.push('--cookies', COOKIES);
  return [...base, ...args];
}

function resolveTracks(query) {
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
          thumbnail: e.thumbnail || e.thumbnails?.at(-1)?.url || null,
        }));
        resolve({ tracks, playlistTitle: isUrl && data._type === 'playlist' ? data.title : null });
      },
    );
  });
}

// yt-dlp (best audio) -> ffmpeg -> Ogg/Opus, which Discord can play without re-encoding in JS
function createStream(url) {
  const yt = spawn(YTDLP, ytArgs(['-f', 'bestaudio/best', '-o', '-', '-v', url]));
  const ff = spawn(FFMPEG, [
    '-loglevel', 'error', '-i', 'pipe:0', '-vn',
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1',
  ]);
  yt.stdout.pipe(ff.stdin);
  for (const s of [yt.stdout, ff.stdin, ff.stdout]) s.on('error', () => {});
  yt.stderr.on('data', (d) => console.error('[yt-dlp]', d.toString().trim()));
  ff.stderr.on('data', (d) => console.error('[ffmpeg]', d.toString().trim()));
  return {
    stream: ff.stdout,
    kill: () => { yt.kill('SIGKILL'); ff.kill('SIGKILL'); },
  };
}

const fmt = (s) => {
  if (!s) return 'live';
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

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

  next() {
    this.proc?.kill();
    this.proc = null;
    if (this.loop && this.current && !this.skipping) this.tracks.unshift(this.current);
    this.skipping = false;

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
    this.proc = createStream(track.url);
    this.player.play(createAudioResource(this.proc.stream, { inputType: StreamType.OggOpus }));

    const embed = new EmbedBuilder()
      .setColor(0xff0000)
      .setAuthor({ name: 'Now playing' })
      .setTitle(track.title.slice(0, 256))
      .setURL(track.url)
      .addFields(
        { name: 'Duration', value: fmt(track.duration), inline: true },
        { name: 'Requested by', value: `<@${track.requestedBy}>`, inline: true },
        { name: 'Up next', value: String(this.tracks.length), inline: true },
      );
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    this.text?.send({ embeds: [embed] }).catch(() => {});
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
    .addStringOption((o) => o.setName('query').setDescription('Song name, YouTube link, or playlist link').setRequired(true)),
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

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || !i.inGuild()) return;
  const q = queues.get(i.guildId);
  const vc = i.member.voice?.channel;

  // everything except /queue and /nowplaying requires being in the bot's channel
  const needsSameChannel = !['queue', 'nowplaying', 'play'].includes(i.commandName);
  if (needsSameChannel) {
    if (!q) return i.reply(eph('Nothing is playing.'));
    if (vc?.id !== q.connection.joinConfig.channelId) return i.reply(eph('Join my voice channel first.'));
  }

  try {
    switch (i.commandName) {
      case 'play': {
        if (!vc) return i.reply(eph('Join a voice channel first.'));
        if (q && q.connection.joinConfig.channelId !== vc.id) {
          return i.reply(eph(`I'm already playing in <#${q.connection.joinConfig.channelId}>.`));
        }
        const perms = vc.permissionsFor(i.guild.members.me);
        if (!perms?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
          return i.reply(eph("I don't have permission to connect/speak in that channel."));
        }
        await i.deferReply();
        const query = i.options.getString('query', true);
        const { tracks, playlistTitle } = await resolveTracks(query);
        if (!tracks.length) return i.editReply('🔍 Nothing found.');
        tracks.forEach((t) => { t.requestedBy = i.user.id; });

        const queue = await getOrCreateQueue(i, vc);
        queue.text = i.channel;
        queue.tracks.push(...tracks);
        const wasIdle = !queue.current;
        if (wasIdle) queue.next();

        if (playlistTitle) return i.editReply(`📃 Added **${tracks.length}** songs from **${playlistTitle}**.`);
        return i.editReply(wasIdle ? `▶️ Starting **${tracks[0].title}**` : `➕ Queued **${tracks[0].title}** (#${queue.tracks.length})`);
      }
      case 'skip':
        q.skip();
        return i.reply('⏭️ Skipped.');
      case 'stop':
        q.destroy();
        return i.reply('⏹️ Stopped and left the channel.');
      case 'pause':
        q.player.pause();
        return i.reply('⏸️ Paused.');
      case 'resume':
        q.player.unpause();
        return i.reply('▶️ Resumed.');
      case 'loop':
        q.loop = !q.loop;
        return i.reply(q.loop ? '🔂 Looping the current song.' : '➡️ Loop off.');
      case 'shuffle':
        for (let n = q.tracks.length - 1; n > 0; n--) {
          const r = Math.floor(Math.random() * (n + 1));
          [q.tracks[n], q.tracks[r]] = [q.tracks[r], q.tracks[n]];
        }
        return i.reply('🔀 Shuffled.');
      case 'remove': {
        const pos = i.options.getInteger('position', true);
        if (pos > q.tracks.length) return i.reply(eph(`There are only ${q.tracks.length} songs in the queue.`));
        const [removed] = q.tracks.splice(pos - 1, 1);
        return i.reply(`🗑️ Removed **${removed.title}**.`);
      }
      case 'nowplaying':
        if (!q?.current) return i.reply(eph('Nothing is playing.'));
        return i.reply(`🎵 **${q.current.title}** (${fmt(q.current.duration)})${q.loop ? ' 🔂' : ''}\n${q.current.url}`);
      case 'queue': {
        if (!q?.current) return i.reply(eph('The queue is empty.'));
        const lines = q.tracks.slice(0, 10).map((t, n) => `\`${n + 1}.\` ${t.title} — ${fmt(t.duration)}`);
        const more = q.tracks.length > 10 ? `\n…and ${q.tracks.length - 10} more` : '';
        return i.reply({
          embeds: [new EmbedBuilder().setColor(0xff0000).setTitle('Queue')
            .setDescription(`**Now:** ${q.current.title}\n\n${lines.join('\n') || '_Nothing up next_'}${more}`.slice(0, 4000))],
        });
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
