#!/usr/bin/env node
// Generate background music + voice stings via ElevenLabs.
// Usage: ELEVENLABS_API_KEY=... node scripts/generate-audio.js
//
// Requires Node 18+ (global fetch).

const fs = require('fs');
const path = require('path');

// Load .env if present (no dependency: tiny parser).
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) {
  console.error('Missing ELEVENLABS_API_KEY. Add it to .env or export it.');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, '..', 'public', 'audio');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Dramatic male voice (Adam) — punchy game-show feel.
const VOICE_ID = 'pNInz6obpgDQGcFmaJgB';

const MUSIC_TRACKS = [
  {
    name: 'music-lobby',
    seconds: 30,
    prompt: 'Upbeat playful party game lobby music, light synth and percussion, Kahoot-style waiting room loop, energetic but not overwhelming, instrumental, seamless loop',
  },
  {
    name: 'music-voting',
    seconds: 30,
    prompt: 'Thrilling game-show countdown music, suspenseful pulsing synth bass, ticking percussion, building tension, Kahoot-style quiz round, instrumental loop',
  },
  {
    name: 'music-tension',
    seconds: 15,
    prompt: 'Urgent last-seconds countdown, fast heartbeat percussion, rising synth tension, dramatic ticking clock, final ten seconds of a game show, instrumental',
  },
  {
    name: 'music-victory',
    seconds: 10,
    prompt: 'Triumphant victory fanfare, celebratory brass and synth stab, winner reveal, short cinematic sting, uplifting, instrumental',
  },
  {
    name: 'sfx-elimination',
    seconds: 4,
    prompt: 'Dramatic elimination sting, low descending brass dun-dun-duuun, game show contestant out, short impact, no music tail',
  },
];

const VOICE_LINES = [
  { name: 'vo-vote',         text: 'Vote now!' },
  { name: 'vo-timesup',      text: "Time's up!" },
  { name: 'vo-eliminated',   text: 'Eliminated!' },
  { name: 'vo-winner',       text: 'We have a winner!' },
  { name: 'vo-nehiza',       text: 'Nehiza!' },
  { name: 'vo-zingur',       text: 'Zingur!' },
];

async function generateMusic({ name, seconds, prompt }) {
  const outFile = path.join(OUT_DIR, `${name}.mp3`);
  if (fs.existsSync(outFile)) {
    console.log(`  skip ${name} (exists)`);
    return;
  }
  console.log(`  music: ${name} (${seconds}s)`);
  const res = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      prompt,
      music_length_ms: seconds * 1000,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`music ${name} failed: ${res.status} ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
}

async function generateVoice({ name, text }) {
  const outFile = path.join(OUT_DIR, `${name}.mp3`);
  if (fs.existsSync(outFile)) {
    console.log(`  skip ${name} (exists)`);
    return;
  }
  console.log(`  voice: ${name} ("${text}")`);
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`voice ${name} failed: ${res.status} ${body}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outFile, buf);
}

(async () => {
  console.log('Generating music tracks...');
  for (const t of MUSIC_TRACKS) await generateMusic(t);
  console.log('Generating voice stings...');
  for (const v of VOICE_LINES) await generateVoice(v);
  console.log(`Done. Files in ${OUT_DIR}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
