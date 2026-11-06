/**
 * JARVIS v6.0 — WhatsApp group companion
 * Runtime: Node.js 20+
 *
 * Required packages:
 *   npm install express @supabase/supabase-js
 *
 * Keep all secret environment variables in Render, never in GitHub.
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "20kb" }));

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------

const BOT_NAME = "JARVIS";
const BOT_VERSION = "6.0";
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const WHAPI_API_TOKEN = process.env.WHAPI_API_TOKEN;
const WHAPI_WEBHOOK_SECRET = process.env.WHAPI_WEBHOOK_SECRET;
const WHAPI_API_URL = "https://gate.whapi.cloud";
const CREATOR_WHATSAPP_ID = normaliseId(process.env.CREATOR_WHATSAPP_ID || "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  const response = await fetch(`${WHAPI_API_URL}/messages/text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHAPI_API_TOKEN}`
    },
    body: JSON.stringify({ to: chatId, body: String(message).slice(0, 4000) }),
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

function startQuiz(chatId) {
  const q = pick(quizQuestions);
  activeGames.set(chatId, { type: "quiz", answer: q.answer.toLowerCase(), startedAt: Date.now() });
  return `🧠 *JARVIS QUICK QUIZ*\n${q.q}\n\n${q.a.map((x, i) => `${i + 1}. ${x}`).join("\n")}\n\nReply with the answer or option number.`;
}
function startEmoji(chatId) {
  const p = pick(emojiPuzzles);
  activeGames.set(chatId, { type: "emoji", answer: p.answer, startedAt: Date.now() });
  return `🔐 *EMOJI DECODER*\nDecode this: ${p.emoji}\n\nFirst correct answer wins!`;
}
function startWhoAmI(chatId) {
  const p = pick(whoAmI);
  activeGames.set(chatId, { type: "whoami", answer: p.answer, startedAt: Date.now() });
  return `🕵️ *WHO AM I?*\n${p.clue}\n\nWho can solve it?`;
}
function startWordBomb(chatId) {
  const seedWords = ["planet", "garden", "window", "basket", "market", "pencil", "orange", "school", "thunder", "blanket"];
  const seed = pick(seedWords);
  const start = randomInt(seed.length - 1);
  const pair = seed.slice(start, start + 2).toLowerCase();
  activeGames.set(chatId, { type: "wordbomb", pair, used: [], startedAt: Date.now() });
  return `💣 *WORD BOMB*\nYour letter combination is: *${pair.toUpperCase()}*\n\nSend a valid English word containing those two letters together. One word per message. No repeats!`;
}
async function validateEnglishWord(word) {
  if (!/^[a-z]{2,24}$/i.test(word)) return false;
  try {
    const response = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`,
      { signal: AbortSignal.timeout(5000) }
    );
    return response.ok;
  } catch {
    return null;
  }
}
async function handleGameAnswer(chatId, text, member) {
  const game = activeGames.get(chatId);
  if (!game) return null;
  if (Date.now() - game.startedAt > 120000) {
    activeGames.delete(chatId);
    return "⏰ That round expired. Start another game with /games.";
  }
  const answer = text.toLowerCase().trim();
  if (game.type === "wordbomb") {
    if (!/^[a-z]{2,24}$/i.test(answer)) return null;
    if (!answer.includes(game.pair)) return `Not quite! Your word must contain *${game.pair.toUpperCase()}* together.`;
    if (game.used.includes(answer)) return "That word has already been used. Try another!";
    const valid = await validateEnglishWord(answer);
    if (valid === null) return "I can't reach the dictionary right now. Try again in a moment.";
    if (!valid) return "That doesn't look like a recognised English word. Try another!";
    game.used.push(answer);
    if (member?.id) await addMemberPoints(member.id, 2, true);
    return `💥 Nice one! *${answer}* is valid. +2 points. Keep the words coming!`;
  }
  let correct = false;
  if (game.type === "quiz") correct = answer === game.answer || answer === String(quizQuestions.find(q => q.answer.toLowerCase() === game.answer)?.correct + 1);
  if (game.type === "emoji" || game.type === "whoami") {
    correct = answer.replace(/[^\w\s]/g, "").includes(game.answer);
  }
  if (correct) {
    activeGames.delete(chatId);
    if (member?.id) await addMemberPoints(member.id, 5, true);
    return `🎉 Correct! ${member?.display_name || "Someone"} got it! +5 points.`;
  }
  return null;
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
/wordbomb - Word Bomb
/quiz - Quick Quiz
/emoji - Emoji Decoder
/whoami - Who Am I?
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

  if (activities[command]) return pick(activities[command]);
  if (command === "help" || command === "start") return helpText();
  if (command === "games") return "🎮 *JARVIS GAMES*\n/wordbomb /quiz /emoji /whoami\n/truthgame /daregame\nUse /help for all commands.";
  if (command === "wordbomb") { local.gamesPlayed++; return startWordBomb(chatId); }
  if (command === "quiz") { local.gamesPlayed++; return startQuiz(chatId); }
  if (command === "emoji") { local.gamesPlayed++; return startEmoji(chatId); }
  if (command === "whoami") { local.gamesPlayed++; return startWhoAmI(chatId); }
  if (command === "truthgame") return truthDare(chatId, senderId, "truth");
  if (command === "daregame") return truthDare(chatId, senderId, "dare");
  if (command === "pass") {
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
  const isCommand = incomingText.startsWith("/");
  const mentionRegex = /\bjarvis\b/i;
  const isMentioned = mentionRegex.test(incomingText);

  let groupRow = null;
  let member = null;
  if (isGroup && supabase) {
    groupRow = await getOrCreateGroup(chatId, message.chat_name || "WhatsApp Group");
    if (groupRow) member = await getOrCreateMember(groupRow.id, senderId, senderName);
    await observeGroupMessage(chatId, senderId, senderName, incomingText, member, groupRow);
  }

  // Answers to a running game are accepted without tagging the bot.
  if (isGroup && !isCommand && !isMentioned) {
    const gameReply = await handleGameAnswer(chatId, incomingText, member);
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

  if (isGroup && !isCommand && !isMentioned) return;

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
    responseText = cleanMessage
      ? await generateGroqReply(chatId, senderName, cleanMessage)
      : "You called? 😎";
  }

  if (responseText) await sendWhatsAppMessage(chatId, await Promise.resolve(responseText));
}

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
    database: supabase ? "configured" : "missing_credentials",
    message: "JARVIS is ready!"
  });
});

app.get("/help", (req, res) => {
  res.json({
    bot: BOT_NAME,
    commands: [
      "/help", "/games", "/wordbomb", "/quiz", "/emoji", "/whoami",
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
