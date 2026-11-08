/**
 * JARVIS v6.2 — WhatsApp group companion
 * Runtime: Node.js 20+
 *
 * Required packages:
 *   npm install express @supabase/supabase-js
 *
 * Keep all secret environment variables in Render, never in GitHub.
 */

const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "10mb" }));

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const BOT_NAME = "JARVIS";
const BOT_VERSION = "6.2";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const WHAPI_API_TOKEN = process.env.WHAPI_API_TOKEN;
const WHAPI_WEBHOOK_SECRET = process.env.WHAPI_WEBHOOK_SECRET;
const WHAPI_BOT_WHATSAPP_ID = normaliseId(process.env.WHAPI_BOT_WHATSAPP_ID || "");
const WHAPI_API_URL = "https://gate.whapi.cloud";
const CREATOR_WHATSAPP_ID = normaliseId(process.env.CREATOR_WHATSAPP_ID || "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const PROFILE_BUCKET = process.env.PROFILE_BUCKET || "jarvis-profiles";
const REGISTRATION_TOKEN_MINUTES = 30;
const uploadProfileMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "video/mp4"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Use JPG, PNG, WEBP or MP4."));
    cb(null, true);
  }
});

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false }
      })
    : null;

function normaliseId(value) {
  return String(value || "").trim().replace(/^whatsapp:/i, "");
}
function isCreator(senderId) {
  return Boolean(CREATOR_WHATSAPP_ID && normaliseId(senderId) === CREATOR_WHATSAPP_ID);
}
function isGroupChat(chatId) {
  return String(chatId || "").endsWith("@g.us");
}
function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}
function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}
function randomInt(max) {
  return Math.floor(Math.random() * max);
}
function safeJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// -----------------------------------------------------------------------------
// IN-MEMORY RUNTIME STATE (durable records are stored in Supabase)
// -----------------------------------------------------------------------------

const conversations = new Map();
const processedMessages = new Set();
const activeGames = new Map();
const gameTimers = new Map();
const activeTruthDares = new Map();
const activeBattles = new Map();
const localScores = new Map();
const observerState = new Map();
const memberCache = new Map();

function getLocalGroup(groupId) {
  if (!localScores.has(groupId)) {
    localScores.set(groupId, { players: {}, gamesPlayed: 0, observerEnabled: true });
  }
  return localScores.get(groupId);
}

// -----------------------------------------------------------------------------
// DATABASE HELPERS
// -----------------------------------------------------------------------------

async function dbInsert(table, values) {
  if (!supabase) return null;
  const { data, error } = await supabase.from(table).insert(values).select().single();
  if (error) {
    console.error(`DB insert ${table}:`, error.message);
    return null;
  }
  return data;
}
async function dbUpdate(table, values, filters) {
  if (!supabase) return null;
  let query = supabase.from(table).update(values);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { data, error } = await query.select();
  if (error) {
    console.error(`DB update ${table}:`, error.message);
    return null;
  }
  return data;
}
async function dbFindOne(table, filters) {
  if (!supabase) return null;
  let query = supabase.from(table).select("*");
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { data, error } = await query.limit(1);
  if (error) {
    console.error(`DB lookup ${table}:`, error.message);
    return null;
  }
  return data?.[0] || null;
}
async function dbList(table, filters, orderColumn = "created_at", limit = 20) {
  if (!supabase) return [];
  let query = supabase.from(table).select("*").order(orderColumn, { ascending: false }).limit(limit);
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
  const { data, error } = await query;
  if (error) {
    console.error(`DB list ${table}:`, error.message);
    return [];
  }
  return data || [];
}
async function getOrCreateGroup(chatId, groupName = "WhatsApp Group") {
  if (!supabase || !isGroupChat(chatId)) return null;
  let group = await dbFindOne("jarvis_groups", { whatsapp_group_id: chatId });
  if (!group) {
    group = await dbInsert("jarvis_groups", {
      whatsapp_group_id: chatId,
      group_name: cleanText(groupName, 100) || "WhatsApp Group"
    });
  }
  return group;
}
async function getOrCreateMember(groupId, whatsappId, displayName) {
  if (!supabase || !groupId || !whatsappId) return null;
  const cacheKey = `${groupId}:${whatsappId}`;
  let member = memberCache.get(cacheKey) || await dbFindOne("jarvis_members", {
    group_id: groupId, whatsapp_id: whatsappId
  });
  if (!member) {
    member = await dbInsert("jarvis_members", {
      group_id: groupId,
      whatsapp_id: whatsappId,
      display_name: cleanText(displayName, 60) || "Member"
    });
  }
  if (!member) return null;
  const updated = await dbUpdate("jarvis_members", {
    display_name: cleanText(displayName, 60) || "Member",
    last_seen: new Date().toISOString(),
    message_count: Number(member.message_count || 0) + 1
  }, { id: member.id });
  member = { ...member, message_count: Number(member.message_count || 0) + 1 };
  if (updated?.[0]) member = updated[0];
  memberCache.set(cacheKey, member);
  return member;
}
async function addMemberPoints(memberId, points, played = false) {
  if (!supabase || !memberId) return;
  const { data, error } = await supabase.from("jarvis_members").select("*").eq("id", memberId).limit(1);
  if (error || !data?.[0]) return;
  const member = data[0];
  await dbUpdate("jarvis_members", {
    points: Number(member.points || 0) + points,
    games_played: Number(member.games_played || 0) + (played ? 1 : 0)
  }, { id: memberId });
}
async function saveObservation(groupId, type, observation) {
  if (!groupId || !supabase) return;
  await dbInsert("jarvis_observations", {
    group_id: groupId,
    observation_type: type,
    observation: cleanText(observation, 800)
  });
}


// -----------------------------------------------------------------------------
// MEMBER REGISTRATION HELPERS
// -----------------------------------------------------------------------------
function hashRegistrationToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function hasValidMediaSignature(file) {
  const b = file?.buffer;
  if (!b || b.length < 12) return false;
  if (file.mimetype === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (file.mimetype === "image/png") return b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (file.mimetype === "image/webp") return b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
  if (file.mimetype === "video/mp4") return b.toString("ascii", 4, 8) === "ftyp";
  return false;
}

function registrationPageHtml(token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#080d1d">
<title>JARVIS Community · Create profile</title>
<style>
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0%,#172b59 0,transparent 38%),#080d1d;color:#f4f7ff;font:16px system-ui,sans-serif;min-height:100vh;padding:24px 14px}
main{max-width:540px;margin:25px auto;background:#111b34;border:1px solid #26385f;border-radius:24px;padding:25px;box-shadow:0 20px 70px #0008}
.brand{font-size:12px;letter-spacing:3px;color:#8eb8ff;font-weight:800}.orb{width:54px;height:54px;border-radius:18px;background:linear-gradient(135deg,#397bff,#8a5cff);display:grid;place-items:center;font-size:27px;margin-bottom:17px}
h1{font-size:27px;margin:8px 0}p{color:#aab8d3;line-height:1.55}.field{margin-top:19px}label{display:block;font-size:14px;font-weight:700;margin-bottom:8px}
input,select,textarea{width:100%;background:#0b1429;color:#fff;border:1px solid #34476f;border-radius:12px;padding:13px;font:inherit}textarea{min-height:110px;resize:vertical}
.upload{border:1px dashed #536b9a;border-radius:14px;padding:14px;background:#0b1429}.upload input{border:0;padding:7px}.hint{font-size:12px;color:#8f9fbd;margin-top:6px}
.preview{max-width:100%;max-height:230px;border-radius:12px;margin-top:10px;display:none}button{width:100%;border:0;border-radius:13px;padding:15px;margin-top:24px;background:linear-gradient(100deg,#367bff,#7858ef);color:#fff;font-weight:800;font-size:16px}
#status{margin-top:15px;font-size:14px;white-space:pre-wrap}.foot{font-size:12px;color:#8090ae;text-align:center;margin-top:18px}
</style></head><body><main><div class="orb">✦</div><div class="brand">JARVIS COMMUNITY</div>
<h1>Create your member profile</h1><p>Introduce yourself to the group. Your profile will be shared automatically after successful registration.</p>
<form id="profileForm">
<div class="field"><label for="nickname">Nickname *</label><input id="nickname" name="nickname" maxlength="32" required placeholder="What should we call you?"></div>
<div class="field"><label for="vibe">Your vibe <span style="color:#8f9fbd">(optional)</span></label>
<select id="vibe" name="vibe"><option value="">Choose your vibe (optional)</option><option>Funny</option><option>Chill</option><option>Introvert</option><option>Extrovert</option><option>Creative</option><option>Adventurous</option><option>Tech-minded</option><option>Other</option></select></div>
<div class="field"><label for="media">Profile photo or short video *</label><div class="upload">
<input id="media" name="media" type="file" accept="image/jpeg,image/png,image/webp,video/mp4" required>
<div class="hint">JPG, PNG, WEBP or MP4 · Maximum 20 MB</div><img id="imagePreview" class="preview" alt="Image preview"><video id="videoPreview" class="preview" controls playsinline></video></div></div>
<div class="field"><label for="intro">Your short introduction *</label><textarea id="intro" name="intro" maxlength="450" required placeholder="Hey everyone! I'm ... I enjoy ..."></textarea><div class="hint">Up to 450 characters. Keep it friendly and respectful.</div></div>
<div class="field"><label style="font-weight:500"><input type="checkbox" name="consent" value="yes" required style="width:auto;margin-right:8px">I confirm this media and introduction are okay to share with the WhatsApp group.</label></div>
<button id="submitBtn" type="submit">Submit my profile</button><div id="status" role="status"></div></form>
<div class="foot">Your WhatsApp identity is verified through your personal registration link. Your phone number will not be displayed in the group.</div></main>
<script>
const token=${JSON.stringify(token)},form=document.getElementById('profileForm'),media=document.getElementById('media'),img=document.getElementById('imagePreview'),vid=document.getElementById('videoPreview'),statusBox=document.getElementById('status'),btn=document.getElementById('submitBtn');
media.addEventListener('change',()=>{const f=media.files[0];img.style.display='none';vid.style.display='none';if(!f)return;const u=URL.createObjectURL(f);if(f.type.startsWith('image/')){img.src=u;img.style.display='block'}else{vid.src=u;vid.style.display='block'}});
form.addEventListener('submit',async e=>{e.preventDefault();const f=media.files[0];if(!f){statusBox.textContent='Please choose a photo or video.';return}if(f.size>20*1024*1024){statusBox.textContent='Your file is larger than 20 MB.';return}
btn.disabled=true;btn.textContent='Submitting…';statusBox.textContent='Saving your profile securely…';
try{const r=await fetch('/api/register/'+token,{method:'POST',body:new FormData(form)});const result=await r.json();if(!r.ok)throw new Error(result.error||'Registration failed.');form.innerHTML='<div style="text-align:center;padding:25px 0"><div style="font-size:48px">🎉</div><h1>Profile submitted!</h1><p>Your introduction has been sent to the WhatsApp group. Welcome to the JARVIS community.</p></div>'}
catch(err){statusBox.textContent=err.message;btn.disabled=false;btn.textContent='Submit my profile'}});
</script></body></html>`;
}

async function createRegistrationLink(groupId, senderId, senderName) {
  if (!supabase) return { error: "Registration needs Supabase credentials." };
  if (!PUBLIC_BASE_URL) return { error: "Registration link is not configured. Add PUBLIC_BASE_URL to Render." };
  const token = crypto.randomBytes(24).toString("hex");
  const row = await dbInsert("jarvis_registration_tokens", {
    token_hash: hashRegistrationToken(token),
    whatsapp_id: senderId,
    group_whatsapp_id: groupId,
    display_name: cleanText(senderName, 60),
    expires_at: new Date(Date.now() + REGISTRATION_TOKEN_MINUTES * 60000).toISOString()
  });
  return row ? { url: `${PUBLIC_BASE_URL}/register/${token}` } : { error: "Registration tables are missing. Run the supplied Supabase SQL setup." };
}

async function sendWhapiProfileMedia(chatId, mediaUrl, mediaType, caption) {
  if (!WHAPI_API_TOKEN) throw new Error("WHAPI token is missing.");
  const kind = mediaType === "video" ? "video" : "image";
  const response = await fetch(`${WHAPI_API_URL}/messages/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WHAPI_API_TOKEN}` },
    body: JSON.stringify({ to: chatId, media: mediaUrl, caption: String(caption).slice(0, 900) }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `WHAPI ${kind} send failed.`);
  return data;
}

// -----------------------------------------------------------------------------
// JARVIS AI
// -----------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `
You are JARVIS, a fictional young Nigerian AI student and WhatsApp group companion.
CREATOR: Samuel Johnson Ifeoluwa, publicly known as SamCityGo.
Creator's official website: https://samcitygo.kesug.com/
If asked who created you, answer naturally with those facts. Do not invent details.
PERSONALITY: brilliant, witty, playful, sociable, warm, occasionally cheeky and goofy.
Understand Nigerian slang naturally but do not force slang into every sentence.
Speak like a real conversational companion, not a customer-service bot.
GROUP STYLE: concise, socially aware, do not dominate conversations or interrupt needlessly.
SAFETY: suitable for teenagers; no sexual/explicit content, dangerous challenges,
requests for passwords/private data, bullying, threats, or humiliating personal attacks.
Friendly roasts must avoid appearance, family, disability, identity, and personal struggles.
Do not claim to know private traits or infer sensitive characteristics from messages.
Keep replies reasonably short and grounded in the supplied conversation.
`;

async function generateGroqReply(chatId, sender, message, extraInstruction = "") {
  if (!GROQ_API_KEY) throw new Error("Groq API key is missing.");
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  const messages = [
    { role: "system", content: SYSTEM_INSTRUCTION + (extraInstruction ? `\n${extraInstruction}` : "") },
    ...history,
    { role: "user", content: `${sender}: ${message}` }
  ];

  let response, data, requestError;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_completion_tokens: 500,
          temperature: 0.8
        }),
        signal: AbortSignal.timeout(30000)
      });
      data = await response.json().catch(() => ({}));
      if (response.ok) break;
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
    } catch (error) {
      requestError = error;
      if (attempt === 3) break;
    }
    await new Promise(resolve => setTimeout(resolve, 800 * (2 ** attempt)));
  }
  if (!response || !response.ok) {
    throw new Error(data?.error?.message || requestError?.message || "Groq request failed.");
  }
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Groq returned an empty response.");
  history.push(
    { role: "user", content: `${sender}: ${message}` },
    { role: "assistant", content: reply }
  );
  if (history.length > 12) history.splice(0, history.length - 12);
  return reply;
}

// -----------------------------------------------------------------------------
// WHAPI
// -----------------------------------------------------------------------------

async function sendWhatsAppMessage(chatId, message) {
  if (!WHAPI_API_TOKEN) throw new Error("WHAPI token is missing.");
  const body = String(message).slice(0, 4000);
  const mentions = [...new Set([...body.matchAll(/@(\d{7,16})/g)].map(match => match[1]))];
  const payload = { to: chatId, body };
  if (mentions.length && isGroupChat(chatId)) payload.mentions = mentions;
  const response = await fetch(`${WHAPI_API_URL}/messages/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHAPI_API_TOKEN}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || "WhatsApp sending failed.");
  return data;
}

// -----------------------------------------------------------------------------
// ACTIVITIES AND GAMES
// -----------------------------------------------------------------------------

const activities = {
  fun: [
    "Describe your personality using three emojis 😂",
    "If you could visit any country, where would you go?",
    "Invent a new holiday and name it!",
    "If your life were a movie, what would its title be?"
  ],
  truth: [
    "What's the funniest thing that happened to you recently?",
    "What's a skill you wish you had?",
    "What's one thing people misunderstand about you?",
    "What's your favourite childhood memory?"
  ],
  wyr: [
    "Would you rather explore space or the deep ocean?",
    "Would you rather speak every language or play every instrument?",
    "Would you rather travel into the past or the future?"
  ],
  joke: [
    "Why did the computer go to the doctor? It had a virus! 😂",
    "Why was the maths book sad? It had too many problems!",
    "Why did the phone wear glasses? It lost its contacts!"
  ],
  riddle: [
    "What has keys but cannot open locks? A piano.",
    "What gets wetter as it dries? A towel.",
    "What has a face and two hands but no arms? A clock."
  ],
  challenge: [
    "Describe your favourite movie without saying its name.",
    "Create a funny group slogan in ten words or less.",
    "Name five animals in ten seconds.",
    "Tell a story using exactly five words."
  ]
};

const quizQuestions = [
  { q: "Which planet is known as the Red Planet?", a: ["Venus", "Mars", "Jupiter", "Mercury"], correct: 1, answer: "Mars" },
  { q: "How many sides does a hexagon have?", a: ["5", "6", "7", "8"], correct: 1, answer: "6" },
  { q: "What is the largest ocean on Earth?", a: ["Atlantic", "Indian", "Pacific", "Arctic"], correct: 2, answer: "Pacific" },
  { q: "Which gas do plants absorb from the air?", a: ["Oxygen", "Carbon dioxide", "Hydrogen", "Nitrogen"], correct: 1, answer: "Carbon dioxide" },
  { q: "What is 12 × 8?", a: ["86", "92", "96", "108"], correct: 2, answer: "96" }
];

const emojiPuzzles = [
  { emoji: "🦁👑", answer: "lion king" },
  { emoji: "🌧️🐱🐶", answer: "raining cats and dogs" },
  { emoji: "🧊☕", answer: "iced coffee" },
  { emoji: "⭐🐟", answer: "starfish" },
  { emoji: "📚🐛", answer: "bookworm" }
];

const whoAmI = [
  { clue: "I have keys but no locks, and space but no room. What am I?", answer: "keyboard" },
  { clue: "I get smaller every time I take a bath. What am I?", answer: "soap" },
  { clue: "I have a neck but no head. What am I?", answer: "bottle" }
];

const safeDares = [
  "Invent a new handshake and describe it.",
  "Say a tongue twister three times.",
  "Make up a two-line song about this group.",
  "Describe your day using only five emojis.",
  "Give someone in the group a kind, specific compliment."
];
const truthPrompts = [
  "What's a small thing that instantly improves your day?",
  "What skill would you love to learn this year?",
  "What's a funny misunderstanding you've had?",
  "Which fictional world would you visit for one day?",
  "What's something you're proud of learning?"
];

const WORD_BOMB_PAIRS = [
  "FL", "ING", "TION", "AR", "CH", "SH", "TH", "ER", "OU", "EA",
  "ST", "TR", "BR", "PL", "IGHT", "OUND", "AKE", "ALL", "OOK", "END"
];
const TURN_SECONDS = Math.max(8, Math.min(30, Number(process.env.GAME_TURN_SECONDS) || 12));
const START_MIN_PLAYERS = 2;

function cancelGameTimer(chatId) {
  const timer = gameTimers.get(chatId);
  if (timer) clearTimeout(timer);
  gameTimers.delete(chatId);
}
function gameBoard(game) {
  return game.players.map((p, i) => `${i + 1}. ${p.name} ${"❤️".repeat(Math.max(0, p.lives ?? 3))}${p.eliminated ? " ❌" : ""}`).join("\n");
}
function currentPlayer(game) {
  return game.players[game.turnIndex];
}
function findNextAlive(game, fromIndex) {
  for (let step = 1; step <= game.players.length; step++) {
    const index = (fromIndex + step) % game.players.length;
    if (!game.players[index].eliminated) return index;
  }
  return -1;
}
function gameStatus(game) {
  return `\n\n*PLAYERS*\n${gameBoard(game)}`;
}
function armWordBombTimer(chatId) {
  cancelGameTimer(chatId);
  const game = activeGames.get(chatId);
  if (!game || game.status !== "active" || game.type !== "wordbomb") return;
  game.deadline = Date.now() + TURN_SECONDS * 1000;
  const timer = setTimeout(async () => {
    const live = activeGames.get(chatId);
    if (!live || live !== game || live.status !== "active") return;
    const player = currentPlayer(live);
    if (!player) return;
    player.lives -= 1;
    if (player.lives <= 0) player.eliminated = true;
    const alive = live.players.filter(p => !p.eliminated);
    if (alive.length <= 1) {
      activeGames.delete(chatId); cancelGameTimer(chatId);
      const winner = alive[0];
      if (winner?.memberId) await addMemberPoints(winner.memberId, 10, true);
      await sendWhatsAppMessage(chatId, `💣 *WORD BOMB — GAME OVER*\n${player.name} ran out of time and lost a life.\n${winner ? `🏆 Winner: ${winner.name}! +10 points.` : "No winner this round."}`);
      return;
    }
    live.turnIndex = findNextAlive(live, live.turnIndex);
    const next = currentPlayer(live);
    await sendWhatsAppMessage(chatId, `⏰ Time! ${player.name} lost a life.\n${next.name}, your turn! Say a word containing *${live.pair}*. You have ${TURN_SECONDS} seconds.${gameStatus(live)}`);
    armWordBombTimer(chatId);
  }, TURN_SECONDS * 1000);
  if (timer.unref) timer.unref();
  gameTimers.set(chatId, timer);
}
function createMultiplayerGame(chatId, type, starter) {
  const game = {
    type, status: "lobby", hostId: starter.id,
    players: [{ id: starter.id, name: starter.name, memberId: starter.memberId || null, lives: 3, score: 0, eliminated: false }],
    turnIndex: 0, used: [], createdAt: Date.now()
  };
  activeGames.set(chatId, game);
  return game;
}
function gameLobbyText(game) {
  const title = game.type === "wordbomb" ? "💣 WORD BOMB" : `🎮 ${game.type.toUpperCase()}`;
  return `${title}\n<${game.players.length} PLAYER${game.players.length === 1 ? "" : "S"} JOINED>\n\n${game.players.map((p,i)=>`${i+1}. ${p.name}`).join("\n")}\n\nType */join* to participate. Host: type */startgame* when everyone is ready. Minimum ${START_MIN_PLAYERS} players.`;
}
function startQuiz(chatId) {
  const q = pick(quizQuestions);
  const game = activeGames.get(chatId);
  Object.assign(game, { status: "active", question: q.q, options: q.a, answer: q.answer.toLowerCase(), type: "quiz", round: 1 });
  return `🧠 *JARVIS QUICK QUIZ*\n${q.q}\n\n${q.a.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\n${currentPlayer(game).name}, answer with the option number or answer text. ${TURN_SECONDS}s.${gameStatus(game)}`;
}
function startEmoji(chatId) {
  const puzzle = pick(emojiPuzzles);
  const game = activeGames.get(chatId);
  Object.assign(game, { status: "active", answer: puzzle.answer.toLowerCase(), puzzle: puzzle.emoji, type: "emoji" });
  return `🔐 *EMOJI DECODER*\n${puzzle.emoji}\n\n${currentPlayer(game).name}, decode it! ${TURN_SECONDS}s.${gameStatus(game)}`;
}
function startWhoAmI(chatId) {
  const puzzle = pick(whoAmI);
  const game = activeGames.get(chatId);
  Object.assign(game, { status: "active", answer: puzzle.answer.toLowerCase(), clue: puzzle.clue, type: "whoami" });
  return `🕵️ *WHO AM I?*\n${puzzle.clue}\n\n${currentPlayer(game).name}, it's your guessing turn. ${TURN_SECONDS}s.${gameStatus(game)}`;
}
function startWordBomb(chatId) {
  const game = activeGames.get(chatId);
  Object.assign(game, {
    type: "wordbomb", status: "active", pair: pick(WORD_BOMB_PAIRS),
    used: [], turnIndex: randomInt(game.players.length), round: 1
  });
  const player = currentPlayer(game);
  return `💣 *WORD BOMB — LIVE GAME*\n${game.players.length} PLAYERS\n\n*${game.pair}*\n\n@${player.id} (${player.name}), your turn! Send one valid English word containing these letters together. You have ${TURN_SECONDS} seconds.\nNo repeats. Wrong word or timeout costs one life. Last player alive wins.${gameStatus(game)}`;
}
function startChallenge(chatId) {
  const game = activeGames.get(chatId);
  Object.assign(game, { type: "challenge", status: "active", prompt: pick(safeDares), turnIndex: randomInt(game.players.length) });
  return `🎯 *GROUP CHALLENGE*\n${currentPlayer(game).name}, your turn:\n${game.prompt}\n\nComplete it or type /pass. Everyone else can cheer them on.${gameStatus(game)}`;
}
async function validateEnglishWord(word) {
  if (!/^[a-z]{2,24}$/i.test(word)) return false;
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch { return null; }
}
async function finishMultiplayerGame(chatId, winner, reason = "completed") {
  const game = activeGames.get(chatId);
  if (!game) return;
  cancelGameTimer(chatId);
  activeGames.delete(chatId);
  if (winner?.memberId) await addMemberPoints(winner.memberId, game.type === "wordbomb" ? 10 : 5, true);
  const ranking = [...game.players].sort((a,b) => b.score-a.score).map((p,i)=>`${i+1}. ${p.name} — ${p.score} pts`).join("\n");
  return `🏁 *${game.type.toUpperCase()} FINISHED*\n${winner ? `🏆 Winner: ${winner.name}!` : "Game ended."}\n${reason}\n\n${ranking}`;
}
async function handleGameAnswer(chatId, text, senderId, senderName, member) {
  const game = activeGames.get(chatId);
  if (!game || game.status !== "active") return null;
  const playerIndex = game.players.findIndex(p => p.id === senderId && !p.eliminated);
  if (playerIndex < 0) return null;
  if (playerIndex !== game.turnIndex) return `⏳ Not your turn, ${senderName}. It's ${currentPlayer(game)?.name || "another player"}'s turn.`;
  const player = game.players[playerIndex];
  const answer = text.toLowerCase().trim().replace(/^[.!?]+|[.!?]+$/g, "");

  if (game.type === "wordbomb") {
    if (!/^[a-z]{2,24}$/i.test(answer)) return "Send one word only—letters, no spaces or emojis.";
    if (!answer.includes(game.pair.toLowerCase())) return `❌ That word doesn't contain *${game.pair}*. You lose one life.` + await loseWordBombLife(chatId, player);
    if (game.used.includes(answer)) return `🔁 *${answer}* was already used. You lose one life.` + await loseWordBombLife(chatId, player);
    const valid = await validateEnglishWord(answer);
    if (valid === null) return "Dictionary check is temporarily unavailable. Your turn is paused—try again shortly.";
    if (!valid) return `❌ *${answer}* isn't recognised as an English word. You lose one life.` + await loseWordBombLife(chatId, player);
    game.used.push(answer); player.score += 2;
    if (member?.id) await addMemberPoints(member.id, 2, false);
    game.turnIndex = findNextAlive(game, game.turnIndex);
    const next = currentPlayer(game);
    armWordBombTimer(chatId);
    return `✅ Correct! *${answer}* works. ${player.name} +2 points.\n@${next.id} (${next.name}), you're up! Find a word containing *${game.pair}*. ${TURN_SECONDS}s.${gameStatus(game)}`;
  }

  let correct = false;
  if (game.type === "quiz") correct = answer === game.answer || answer === String(game.options.findIndex(x => x.toLowerCase() === game.answer) + 1);
  if (game.type === "emoji" || game.type === "whoami") correct = answer.replace(/[^\w\s]/g, "").includes(game.answer);
  if (correct) {
    player.score += 5;
    const winner = player;
    return `🎉 Correct, ${player.name}! +5 points.\n${await finishMultiplayerGame(chatId, winner, "First correct answer on their turn.")}`;
  }
  if (game.type === "truthgame" || game.type === "daregame" || game.type === "challenge") {
    player.score += 2;
    if (member?.id) await addMemberPoints(member.id, 2, false);
    game.turnIndex = findNextAlive(game, game.turnIndex);
    const next = currentPlayer(game);
    if (!next) { await finishMultiplayerGame(chatId, player); return "Challenge complete!"; }
    game.prompt = game.type === "truthgame" ? pick(truthPrompts) : pick(safeDares);
    return `👏 Turn completed, ${player.name}! +2 points.\n${next.name}, your turn:\n${game.prompt}\nReply /pass if you want to skip.${gameStatus(game)}`;
  }
  return `Not quite, ${player.name}. Try again while your turn is active.`;
}
async function loseWordBombLife(chatId, player) {
  const game = activeGames.get(chatId);
  cancelGameTimer(chatId);
  player.lives -= 1;
  if (player.lives <= 0) player.eliminated = true;
  const alive = game.players.filter(p => !p.eliminated);
  if (alive.length <= 1) {
    const winner = alive[0] || null;
    await finishMultiplayerGame(chatId, winner, `${player.name} was eliminated.`);
    return `\n${player.name} is out! ${winner ? `${winner.name} wins!` : "No winner."}`;
  }
  game.turnIndex = findNextAlive(game, game.turnIndex);
  const next = currentPlayer(game);
  armWordBombTimer(chatId);
  return `\n${player.name} now has ${player.lives} ❤️.\n@${next.id} (${next.name}), your turn! Say a word containing *${game.pair}*. ${TURN_SECONDS}s.${gameStatus(game)}`;
}

// -----------------------------------------------------------------------------
// INDIVIDUAL TRUTH / DARE
// -----------------------------------------------------------------------------

function truthDare(chatId, senderId, kind) {
  const key = `${chatId}:${senderId}`;
  const prompt = kind === "truth" ? pick(truthPrompts) : pick(safeDares);
  activeTruthDares.set(key, { kind, prompt, startedAt: Date.now() });
  return `🎲 *YOUR ${kind.toUpperCase()}*\n${prompt}\n\nReply /pass to skip. This is optional—no pressure.`;
}

// -----------------------------------------------------------------------------
// YAB ARENA (friendly, opt-in)
// -----------------------------------------------------------------------------

async function startBattle(chatId, mode, hostId, hostName) {
  const battle = await dbInsert("jarvis_yab_battles", {
    group_id: (await getOrCreateGroup(chatId))?.id,
    mode,
    status: "waiting",
    battle_data: { participants: [{ id: hostId, name: hostName, score: 0 }], turns: [] }
  });
  const id = battle?.id || `${Date.now()}`;
  activeBattles.set(chatId, {
    id, mode,
    participants: [{ id: hostId, name: hostName, score: 0 }],
    turns: [], startedAt: Date.now()
  });
  return mode === "people_vs_jarvis"
    ? "🔥 *YAB ARENA: PEOPLE VS JARVIS*\nYou're challenging JARVIS. Send a playful roast—keep it friendly. JARVIS will respond. Type /endbattle to finish."
    : "🔥 *YAB ARENA: PEOPLE VS PEOPLE*\nA friendly roast battle is open. Another willing participant can join with /joinbattle. Keep it playful—no personal or sensitive attacks.";
}
async function saveBattle(chatId) {
  const battle = activeBattles.get(chatId);
  if (!battle || !supabase) return;
  await dbUpdate("jarvis_yab_battles", {
    status: "completed",
    battle_data: { participants: battle.participants, turns: battle.turns },
    ended_at: new Date().toISOString()
  }, { id: battle.id });
}

// -----------------------------------------------------------------------------
// GROUP OBSERVER
// -----------------------------------------------------------------------------

async function observeGroupMessage(chatId, senderId, senderName, text, member, groupRow) {
  if (!groupRow || !member) return;
  const local = getLocalGroup(chatId);
  const enabled = groupRow.observer_enabled !== false && local.observerEnabled !== false;
  if (!enabled) return;

  // Only store neutral activity metadata; do not infer personality or sensitive traits.
  if (Math.random() < 0.015) {
    await saveObservation(groupRow.id, "activity", `${senderName} participated in the group conversation.`);
  }

  // JARVIS remains quiet by default. This observer does not auto-reply to ordinary messages.
}

// -----------------------------------------------------------------------------
// COMMANDS
// -----------------------------------------------------------------------------

function helpText() {
  return `🤖 *JARVIS COMMANDS*

🎮 *GAMES*
/games - Game list
/wordbomb - Open Word Bomb lobby
/quiz - Open Quick Quiz lobby
/emoji - Open Emoji Decoder lobby
/whoami - Open Who Am I lobby
/truthgame - Group Truth lobby
/daregame - Group Dare lobby
/join - Join the current game
/startgame - Host starts the game
/endgame - Host ends the game
/truthgame - Personal Truth
/daregame - Personal Dare
/pass - Skip your prompt
/fun - Fun question
/truth - Truth question
/wyr - Would you rather
/joke - Joke
/riddle - Riddle
/challenge - Safe challenge

🔥 *YAB ARENA*
/yabme - People vs JARVIS
/yab - People vs People
/joinbattle - Join open battle
/endbattle - End battle

👤 *MEMBER PROFILE*
/register - Get your private newcomer registration link
/profile - Alias for /register

👥 *GROUP*
/observer on|off - Toggle observer
/suggest <idea> - Suggest an idea
/mediate - Invite voluntary mediation
/stats - Group participation stats
/score - Leaderboard
/chat <message> - Talk with JARVIS
/help - Show commands

👑 Creator-only controls are available to the verified creator.`;
}

async function handleCommand(ctx) {
  const { chatId, senderId, senderName, args, isCreatorUser, member, groupRow } = ctx;
  const command = args[0].toLowerCase();
  const rest = args.slice(1).join(" ").trim();
  const local = getLocalGroup(chatId);

  if (command === "register" || command === "profile") {
    if (!isGroupChat(chatId)) return "Please use /register inside the WhatsApp group where you want your profile announced.";
    const link = await createRegistrationLink(chatId, senderId, senderName);
    if (link.error) return `⚠️ ${link.error}`;
    try {
      await sendWhatsAppMessage(senderId, `👋 Welcome! Here's your personal JARVIS registration link (valid for ${REGISTRATION_TOKEN_MINUTES} minutes):\\n${link.url}\\n\\nOnly you should use this link. Your profile will be shared in the group after submission.`);
      return "📩 I've sent your private registration link. Check your personal WhatsApp chat with me. The link expires in 30 minutes.";
    } catch (error) {
      console.error("Registration DM error:", error.message);
      return "I created your registration link, but couldn't send you a private message. Check that you can receive messages from this WhatsApp number, then try /register again.";
    }
  }

  if (activities[command] && command !== "challenge") return pick(activities[command]);
  if (command === "help" || command === "start") return helpText();
  if (command === "games") return "🎮 *JARVIS MULTIPLAYER GAMES*\n/wordbomb /quiz /emoji /whoami /challenge /truthgame /daregame\nHost starts a lobby with a game command. Everyone else uses /join. Host uses /startgame.";
  if (["wordbomb", "quiz", "emoji", "whoami", "challenge", "truthgame", "daregame"].includes(command)) {
    if (!isGroupChat(chatId)) return "Multiplayer games can only run inside a WhatsApp group.";
    if (activeGames.has(chatId)) return "A game is already open here. Join with /join or finish it with /endgame.";
    const game = createMultiplayerGame(chatId, command, { id: senderId, name: senderName, memberId: member?.id });
    return gameLobbyText(game);
  }
  if (command === "join") {
    const game = activeGames.get(chatId);
    if (!game || game.status !== "lobby") return "There isn't a game lobby open. Start one with /wordbomb, /quiz, /emoji, /whoami, /challenge, /truthgame or /daregame.";
    if (game.players.some(p => p.id === senderId)) return "You're already registered in this game.";
    if (game.players.length >= 20) return "This game is full (20 players maximum).";
    game.players.push({ id: senderId, name: senderName, memberId: member?.id || null, lives: 3, score: 0, eliminated: false });
    return `${senderName} joined!\n${gameLobbyText(game)}`;
  }
  if (command === "startgame") {
    const game = activeGames.get(chatId);
    if (!game || game.status !== "lobby") return "There isn't a game waiting to start.";
    if (game.hostId !== senderId && !isCreatorUser) return "Only the game host can start this game.";
    if (game.players.length < START_MIN_PLAYERS) return "At least two players must join before the game can start.";
    local.gamesPlayed++;
    if (game.type === "wordbomb") { const result = startWordBomb(chatId); armWordBombTimer(chatId); return result; }
    if (game.type === "quiz") return startQuiz(chatId);
    if (game.type === "emoji") return startEmoji(chatId);
    if (game.type === "whoami") return startWhoAmI(chatId);
    if (game.type === "truthgame" || game.type === "daregame") {
      game.status = "active";
      game.kind = game.type === "truthgame" ? "truth" : "dare";
      game.turnIndex = randomInt(game.players.length);
      game.prompt = game.kind === "truth" ? pick(truthPrompts) : pick(safeDares);
      return `🎲 *GROUP ${game.kind.toUpperCase()} OR DARE*\n${currentPlayer(game).name}, your turn:\n${game.prompt}\n\nReply /pass to skip. Participation is optional.${gameStatus(game)}`;
    }
    return startChallenge(chatId);
  }
  if (command === "endgame") {
    const game = activeGames.get(chatId);
    if (!game) return "There isn't an active game.";
    if (game.hostId !== senderId && !isCreatorUser) return "Only the game host can end this game.";
    cancelGameTimer(chatId); activeGames.delete(chatId);
    return `🛑 ${game.type.toUpperCase()} ended by the host.`;
  }
  if (command === "truthgame") return truthDare(chatId, senderId, "truth");
  if (command === "daregame") return truthDare(chatId, senderId, "dare");
  if (command === "pass") {
    const groupGame = activeGames.get(chatId);
    if (groupGame?.status === "active" && ["truthgame", "daregame", "challenge"].includes(groupGame.type)) {
      const player = groupGame.players[groupGame.turnIndex];
      if (player?.id !== senderId) return "It's not your turn to pass.";
      groupGame.turnIndex = findNextAlive(groupGame, groupGame.turnIndex);
      const next = currentPlayer(groupGame);
      if (!next) { activeGames.delete(chatId); return "The group game has ended."; }
      groupGame.prompt = groupGame.type === "truthgame" ? pick(truthPrompts) : pick(safeDares);
      return `⏭️ ${player.name} skipped. No penalty.\n${next.name}, your turn:\n${groupGame.prompt}`;
    }
    const key = `${chatId}:${senderId}`;
    if (activeTruthDares.has(key)) {
      activeTruthDares.delete(key);
      return "No worries—prompt skipped. 👍";
    }
    return "You don't have an active Truth or Dare prompt.";
  }
  if (command === "score") {
    if (!groupRow) return "Leaderboard storage is available in groups.";
    const rows = await dbList("jarvis_members", { group_id: groupRow.id }, "points", 15);
    if (!rows.length) return "No scores yet. Start a game!";
    return "🏆 *JARVIS LEADERBOARD*\n" + rows.map((p, i) => `${i + 1}. ${p.display_name}: ${p.points || 0} pts`).join("\n");
  }
  if (command === "chat") {
    return rest ? generateGroqReply(chatId, senderName, rest) : "What's happening? 😎";
  }
  if (command === "observer") {
    if (!isCreatorUser) return "Only the verified creator can change the observer setting.";
    if (!["on", "off"].includes(rest.toLowerCase())) return "Use /observer on or /observer off.";
    const enabled = rest.toLowerCase() === "on";
    local.observerEnabled = enabled;
    if (groupRow) await dbUpdate("jarvis_groups", { observer_enabled: enabled }, { id: groupRow.id });
    return enabled
      ? "👀 Group observer is ON. I'll quietly track basic participation and game activity; I won't profile members or reply to every message."
      : "👀 Group observer is OFF.";
  }
  if (command === "suggest") {
    if (!rest) return "Use /suggest followed by your idea.";
    if (groupRow) await dbInsert("jarvis_suggestions", {
      group_id: groupRow.id,
      member_id: member?.id || null,
      suggestion: cleanText(rest, 1000)
    });
    return "💡 Suggestion received. Thanks for helping improve the group!";
  }
  if (command === "stats") {
    if (!groupRow) return "Group stats are available inside a WhatsApp group.";
    const rows = await dbList("jarvis_members", { group_id: groupRow.id }, "message_count", 10);
    return rows.length
      ? "📊 *GROUP PARTICIPATION*\n" + rows.map((p, i) => `${i + 1}. ${p.display_name}: ${p.message_count || 0} messages`).join("\n")
      : "No participation data yet.";
  }
  if (command === "mediate") {
    if (!groupRow) return "Mediation is available in groups.";
    const mediation = await dbInsert("jarvis_mediations", {
      group_id: groupRow.id,
      status: "open",
      summary: "Voluntary mediation invitation. Both sides must agree to participate."
    });
    return "🕊️ *JARVIS MEDIATION*\nIf there's a disagreement, the people involved can voluntarily agree to explain their side. I can help summarise both perspectives neutrally and suggest a fair next step. No one is forced to participate.";
  }
  if (command === "yabme") return startBattle(chatId, "people_vs_jarvis", senderId, senderName);
  if (command === "yab") return startBattle(chatId, "people_vs_people", senderId, senderName);
  if (command === "joinbattle") {
    const battle = activeBattles.get(chatId);
    if (!battle || battle.mode !== "people_vs_people") return "There isn't an open People vs People battle.";
    if (battle.participants.some(p => p.id === senderId)) return "You're already in this battle.";
    if (battle.participants.length >= 2) return "This battle already has two participants.";
    battle.participants.push({ id: senderId, name: senderName, score: 0 });
    return `🔥 ${senderName} joined the battle! Both participants can now take turns with playful roasts.`;
  }
  if (command === "endbattle") {
    const battle = activeBattles.get(chatId);
    if (!battle) return "There isn't an active battle.";
    await saveBattle(chatId);
    activeBattles.delete(chatId);
    return "🏁 Battle closed. Keep the jokes friendly!";
  }
  if (command === "owner" || command === "creator") {
    return "I was created by Samuel Johnson Ifeoluwa, popularly known as SamCityGo. He's a young web designer and technology enthusiast.\n🌐 https://samcitygo.kesug.com/";
  }
  if (command === "status" && isCreatorUser) {
    return `JARVIS ${BOT_VERSION}\nSupabase: ${supabase ? "configured" : "missing"}\nGroq: ${GROQ_API_KEY ? "configured" : "missing"}\nWHAPI: ${WHAPI_API_TOKEN ? "configured" : "missing"}`;
  }
  return "I don't recognise that command. Type /help.";
}

// -----------------------------------------------------------------------------
// WHATSAPP MESSAGE HANDLER
// -----------------------------------------------------------------------------

async function handleWhatsAppMessage(message) {
  if (!message || message.from_me === true || message.type !== "text") return;

  const chatId = message.chat_id;
  const senderId = normaliseId(message.from || message.from_id || message.author || "");
  const incomingText = cleanText(message.text?.body, 2000);
  if (!chatId || !incomingText || !senderId) {
    console.warn("WHAPI message missing chat, text, or sender ID. Check actual webhook payload.");
    return;
  }

  const isGroup = isGroupChat(chatId);
  const senderName = cleanText(message.from_name || message.push_name || senderId, 60);
  const creator = isCreator(senderId);
  const isCommand = /^[\/!]/.test(incomingText);
  const mentionRegex = /\bjarvis\b/i;
  const isMentioned = mentionRegex.test(incomingText);
  const quotedAuthor = normaliseId(message.context?.quoted_author || "");
  const isReplyToBot = Boolean(WHAPI_BOT_WHATSAPP_ID && quotedAuthor === WHAPI_BOT_WHATSAPP_ID);

  let groupRow = null;
  let member = null;
  if (isGroup && supabase) {
    groupRow = await getOrCreateGroup(chatId, message.chat_name || "WhatsApp Group");
    if (groupRow) member = await getOrCreateMember(groupRow.id, senderId, senderName);
    await observeGroupMessage(chatId, senderId, senderName, incomingText, member, groupRow);
  }

  // Answers to a running game are accepted without tagging the bot.
  if (isGroup && !isCommand && !isMentioned && !isReplyToBot) {
    const gameReply = await handleGameAnswer(chatId, incomingText, senderId, senderName, member);
    if (gameReply) {
      await sendWhatsAppMessage(chatId, gameReply);
      return;
    }
    const battle = activeBattles.get(chatId);
    if (battle && incomingText.length > 2 && incomingText.length < 400) {
      const safeReply = await generateGroqReply(
        chatId,
        "JARVIS",
        incomingText,
        "You are participating in a friendly, opt-in roast battle. Reply with one short, harmless, playful comeback. Do not insult appearance, family, identity, disability, private struggles, or anything sensitive."
      );
      battle.turns.push({ sender: senderName, text: incomingText, reply: safeReply });
      await sendWhatsAppMessage(chatId, safeReply);
    }
    return;
  }

  if (isGroup && !isCommand && !isMentioned && !isReplyToBot) return;

  let responseText = "";
  if (isCommand) {
    const args = incomingText.slice(1).split(/\s+/).filter(Boolean);
    if (!args.length) return;
    responseText = await handleCommand({
      chatId, senderId, senderName, args,
      isCreatorUser: creator, member, groupRow
    });
  } else {
    const cleanMessage = incomingText.replace(mentionRegex, "").trim();
    if (/who (created|create|made|built) you|who is your creator|who\s*\x27?s your creator|who developed you/i.test(cleanMessage)) {
      responseText = "I was created by Samuel Johnson Ifeoluwa, publicly known as SamCityGo. He's the developer behind me. 🌐 https://samcitygo.kesug.com/";
    } else {
      responseText = cleanMessage
        ? await generateGroqReply(chatId, senderName, cleanMessage)
        : "You called? 😎";
    }
  }

  if (responseText) await sendWhatsAppMessage(chatId, await Promise.resolve(responseText));
}


// -----------------------------------------------------------------------------
// REGISTRATION WEBSITE + API
// -----------------------------------------------------------------------------

app.get("/register/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).send("Invalid registration link.");
  if (!supabase) return res.status(503).send("Registration is temporarily unavailable.");
  const row = await dbFindOne("jarvis_registration_tokens", { token_hash: hashRegistrationToken(token) });
  if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
    return res.status(410).send("This link has expired or has already been used. Send /register in your group for a new link.");
  }
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(registrationPageHtml(token));
});

app.post("/api/register/:token", (req, res, next) => {
  uploadProfileMedia.single("media")(req, res, error => {
    if (error) return res.status(400).json({ error: error.message || "Upload failed." });
    next();
  });
}, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!/^[a-f0-9]{48}$/i.test(token)) return res.status(404).json({ error: "Invalid registration link." });
    if (!supabase) return res.status(503).json({ error: "Registration storage is unavailable." });
    const row = await dbFindOne("jarvis_registration_tokens", { token_hash: hashRegistrationToken(token) });
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: "This link has expired or has already been used. Request a new /register link in your group." });
    }
    const nickname = cleanText(req.body?.nickname, 32);
    const vibe = cleanText(req.body?.vibe, 24);
    const intro = cleanText(req.body?.intro, 450);
    const file = req.file;
    if (!nickname || !intro || !file) return res.status(400).json({ error: "Nickname, introduction and profile media are required." });
    if (req.body?.consent !== "yes") return res.status(400).json({ error: "Please confirm that your media and introduction may be shared with the group." });
    if (!hasValidMediaSignature(file)) return res.status(400).json({ error: "The uploaded file does not match its file type. Please choose a genuine JPG, PNG, WEBP or MP4 file." });
    const mimeToExt = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" };
    const ext = mimeToExt[file.mimetype];
    if (!ext) return res.status(400).json({ error: "Use JPG, PNG, WEBP or MP4." });
    const mediaType = file.mimetype.startsWith("video/") ? "video" : "image";
    const safeGroup = row.group_whatsapp_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeMember = row.whatsapp_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const objectPath = `${safeGroup}/${safeMember}/${crypto.randomUUID()}.${ext}`;
    const { error: storageError } = await supabase.storage.from(PROFILE_BUCKET).upload(objectPath, file.buffer, {
      contentType: file.mimetype, upsert: false, cacheControl: "3600"
    });
    if (storageError) {
      console.error("Profile media upload:", storageError.message);
      return res.status(502).json({ error: "Could not save your media. Check the Supabase profile storage bucket." });
    }
    const { data: signedInfo, error: signedError } = await supabase.storage
      .from(PROFILE_BUCKET).createSignedUrl(objectPath, 600);
    const mediaUrl = signedInfo?.signedUrl;
    if (signedError || !mediaUrl) {
      await supabase.storage.from(PROFILE_BUCKET).remove([objectPath]);
      return res.status(502).json({ error: "Could not create a temporary media link for WhatsApp." });
    }

    const values = {
      group_whatsapp_id: row.group_whatsapp_id,
      whatsapp_id: row.whatsapp_id,
      nickname, vibe: vibe || null, intro,
      media_url: null, media_path: objectPath, media_type: mediaType,
      updated_at: new Date().toISOString()
    };
    const existing = await dbFindOne("jarvis_member_profiles", {
      group_whatsapp_id: row.group_whatsapp_id, whatsapp_id: row.whatsapp_id
    });
    const previousMediaPath = existing?.media_path;
    const saved = existing
      ? (await dbUpdate("jarvis_member_profiles", values, { id: existing.id }))?.[0]
      : await dbInsert("jarvis_member_profiles", values);
    if (!saved) {
      await supabase.storage.from(PROFILE_BUCKET).remove([objectPath]);
      return res.status(502).json({ error: "Profile could not be saved. Please try again." });
    }
    if (previousMediaPath && previousMediaPath !== objectPath) {
      await supabase.storage.from(PROFILE_BUCKET).remove([previousMediaPath]);
    }
    const marked = await dbUpdate("jarvis_registration_tokens", { used_at: new Date().toISOString() }, { id: row.id });
    if (!marked?.length) return res.status(502).json({ error: "Profile saved but the registration link could not be closed. Contact the group administrator." });

    const groupRow = await dbFindOne("jarvis_groups", { whatsapp_group_id: row.group_whatsapp_id });
    if (groupRow) {
      await dbUpdate("jarvis_members", { display_name: nickname }, { group_id: groupRow.id, whatsapp_id: row.whatsapp_id });
      memberCache.delete(`${groupRow.id}:${row.whatsapp_id}`);
    }
    const vibeText = vibe ? `\n✨ Vibe: ${vibe}` : "";
    const caption = `🎉 *NEW MEMBER INTRODUCTION*\n\n👋 Meet *${nickname}*!${vibeText}\n\n${intro}\n\nWelcome to the JARVIS community!`;
    try {
      await sendWhapiProfileMedia(row.group_whatsapp_id, mediaUrl, mediaType, caption);
    } catch (sendError) {
      console.error("Group profile media announcement:", sendError.message);
      await sendWhatsAppMessage(row.group_whatsapp_id, `${caption}\n\nProfile media: ${mediaUrl}`);
    }
    res.json({ success: true, message: "Your profile has been submitted and announced in the group." });
  } catch (error) {
    console.error("Registration submission error:", error.message);
    res.status(500).json({ error: "Something went wrong while saving your profile. Please try again." });
  }
});

// -----------------------------------------------------------------------------
// WHAPI WEBHOOK
// -----------------------------------------------------------------------------

app.post("/whapi/webhook/:secret", (req, res) => {
  if (!WHAPI_WEBHOOK_SECRET) return res.sendStatus(503);
  if (req.params.secret !== WHAPI_WEBHOOK_SECRET) return res.sendStatus(401);

  const messages = req.body?.messages;
  res.sendStatus(200);
  if (!Array.isArray(messages)) return;

  for (const message of messages) {
    const id = message?.id;
    if (id && processedMessages.has(id)) continue;
    if (id) {
      processedMessages.add(id);
      if (processedMessages.size > 5000) {
        processedMessages.delete(processedMessages.values().next().value);
      }
    }
    handleWhatsAppMessage(message).catch(error => {
      console.error("WHAPI PROCESSING ERROR:", error.message);
    });
  }
});

// -----------------------------------------------------------------------------
// HTTP API — existing routes retained
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    bot: BOT_NAME,
    version: BOT_VERSION,
    status: "online",
    ai: GROQ_API_KEY ? "configured" : "missing_api_key",
    provider: "Groq",
    model: GROQ_MODEL,
    whatsapp: WHAPI_API_TOKEN ? "configured" : "missing_token",
    webhook: WHAPI_WEBHOOK_SECRET ? "configured" : "missing_secret",
    botIdentity: WHAPI_BOT_WHATSAPP_ID ? "configured" : "not_configured_reply_detection_disabled",
    database: supabase ? "configured" : "missing_credentials",
    registration: supabase && PUBLIC_BASE_URL ? "configured" : "needs_setup",
    message: "JARVIS is ready!"
  });
});

app.get("/help", (req, res) => {
  res.json({
    bot: BOT_NAME,
    commands: [
      "/help", "/register", "/profile", "/games", "/wordbomb", "/quiz", "/emoji", "/whoami", "/challenge", "/truthgame", "/daregame", "/join", "/startgame", "/endgame",
      "/truthgame", "/daregame", "/pass", "/fun", "/truth", "/wyr",
      "/joke", "/riddle", "/challenge", "/yab", "/yabme",
      "/joinbattle", "/endbattle", "/observer on|off", "/suggest",
      "/mediate", "/stats", "/score", "/chat", "/owner"
    ]
  });
});

app.get("/activity/:type", (req, res) => {
  const type = req.params.type.toLowerCase();
  const list = activities[type];
  if (!list) {
    return res.status(404).json({
      error: "Activity not available",
      available: Object.keys(activities)
    });
  }
  res.json({ bot: BOT_NAME, type, activity: pick(list) });
});

app.post("/score", async (req, res) => {
  const { groupId, player, points } = req.body || {};
  if (
    typeof groupId !== "string" || typeof player !== "string" ||
    typeof points !== "number" || !groupId.trim() || !player.trim() ||
    !Number.isFinite(points) || points < 0 || points > 100
  ) {
    return res.status(400).json({ error: "Provide a groupId, player and valid points (0–100)." });
  }
  const group = getLocalGroup(groupId.trim());
  const name = cleanText(player, 40);
  group.players[name] = (group.players[name] || 0) + points;
  res.json({ success: true, player: name, totalPoints: group.players[name] });
});

app.get("/score/:groupId", async (req, res) => {
  const groupId = req.params.groupId;
  const groupRow = await dbFindOne("jarvis_groups", { whatsapp_group_id: groupId });
  if (groupRow) {
    const rows = await dbList("jarvis_members", { group_id: groupRow.id }, "points", 50);
    return res.json({
      leaderboard: rows.map(p => ({ player: p.display_name, points: p.points || 0 })),
      gamesPlayed: getLocalGroup(groupId).gamesPlayed
    });
  }
  const group = getLocalGroup(groupId);
  const leaderboard = Object.entries(group.players)
    .map(([player, points]) => ({ player, points }))
    .sort((a, b) => b.points - a.points);
  res.json({ leaderboard, gamesPlayed: group.gamesPlayed });
});

app.post("/chat", async (req, res) => {
  try {
    const { message, groupId, player } = req.body || {};
    if (typeof message !== "string" || !message.trim() || message.length > 2000) {
      return res.status(400).json({ error: "Provide a message between 1 and 2000 characters." });
    }
    const chatId = typeof groupId === "string" && groupId.trim() ? groupId.trim().slice(0, 100) : "default";
    const sender = typeof player === "string" && player.trim() ? cleanText(player, 60) : "A group member";
    const reply = await generateGroqReply(chatId, sender, message.trim());
    res.json({ bot: BOT_NAME, provider: "Groq", player: sender, reply });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(502).json({ error: "Something went wrong while processing your message." });
  }
});

// -----------------------------------------------------------------------------
// ERROR HANDLING / START
// -----------------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ error: "Endpoint not found" }));
app.use((error, req, res, next) => {
  console.error("Express error:", error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`${BOT_NAME} ${BOT_VERSION} running on port ${PORT}`);
  console.log("Supabase:", supabase ? "configured" : "not configured");
});
