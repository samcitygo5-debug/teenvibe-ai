/**
 * JARVIS Personal AI v8.1
 * Public WhatsApp assistant with NEON MD command handoff.
 * Runtime: Node.js 20+
 * Providers: WHAPI.Cloud + Groq + Supabase
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.json({ limit: '30kb' }));

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
const BOT_NAME = 'JARVIS';
const BOT_VERSION = '8.1';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const WHAPI_API_TOKEN = process.env.WHAPI_API_TOKEN;
const WHAPI_WEBHOOK_SECRET = process.env.WHAPI_WEBHOOK_SECRET;
const WHAPI_API_URL = 'https://gate.whapi.cloud';
const CREATOR_WHATSAPP_ID = String(process.env.CREATOR_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const PARTNER_WHATSAPP_ID = String(process.env.PARTNER_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const CREATOR_NAME = String(process.env.CREATOR_DISPLAY_NAME || 'Creator').trim().slice(0, 40);
const PARTNER_NAME = String(process.env.PARTNER_DISPLAY_NAME || 'Partner').trim().slice(0, 40);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_HISTORY_MESSAGES = 20;
const CREATOR_ONLY_ID = idDigits(CREATOR_WHATSAPP_ID);
const neonCommands = [
  'aiapology','aibrainstorm','aicharactergen','aichatbot','aicoach','aicomeback','aicoverletter','aidebug','aiessay','aiex cuse','aifact','aiflashcard','aiinterview','aijoke','ailyricsgen','aimindmap','ainamegen','aiplotgen','aipoemgen','aiproofread','aiquiz','aiquizgen','aiquote','airesume','airiddle','airoast','aisong','aisummarytone','aitranslateformal','aitutor','aiwriter','alibi','ask','captiongen','career','catchphrase','characterai','codeai','compatibility','cursed','debate','debateai','emailgen','explain','gemini','gpt','greenflags','hashtaggen','horoscope','impostor','judge','keywords','metaai','mythbuster','nameai','neon','neonstory','npc','osint','paraphrase','photoai','predict','qwen','ranking','recipegen','redflags','rizz','roast','roastbattle','sentiment','spellcheck','storyai','summarize','therapy','thisorthat','titlegen','trait','triviaai','vibe'
];
let jarvisMuted = false;
const MAX_MESSAGE_LENGTH = 2500;
const MIN_REPLY_INTERVAL_MS = 900;

function idDigits(value) {
  return String(value || '').replace(/^whatsapp:/i, '').split('@')[0].replace(/\D/g, '');
}
function isAllowedUser(senderId) {
  const sender = idDigits(senderId);
  return Boolean(sender && (
    (idDigits(CREATOR_WHATSAPP_ID) && sender === idDigits(CREATOR_WHATSAPP_ID)) ||
    (idDigits(PARTNER_WHATSAPP_ID) && sender === idDigits(PARTNER_WHATSAPP_ID))
  ));
}
function getUserName(senderId) {
  return idDigits(senderId) === idDigits(CREATOR_WHATSAPP_ID) ? CREATOR_NAME : PARTNER_NAME;
}
function isGroupChat(chatId) {
  return String(chatId || '').includes('@g.us');
}
function cleanText(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}
function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

// Private histories are keyed per person. The couple history is a separate,
// intentionally shared conversation. No personal history is copied into it.
const historyCache = new Map();
const processedMessages = new Set();
const lastReplyAt = new Map();

function personalKey(senderId) {
  return `personal:${idDigits(senderId)}`;
}
const COUPLE_KEY = 'couple:shared';

async function loadHistory(key) {
  if (historyCache.has(key)) return historyCache.get(key);
  if (!supabase) {
    const empty = [];
    historyCache.set(key, empty);
    return empty;
  }
  const { data, error } = await supabase
    .from('jarvis_private_conversations')
    .select('messages')
    .eq('conversation_key', key)
    .maybeSingle();
  if (error) {
    console.error('Supabase conversation read:', error.message);
    const empty = [];
    historyCache.set(key, empty);
    return empty;
  }
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  historyCache.set(key, messages);
  return messages;
}

async function saveHistory(key, messages) {
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  historyCache.set(key, trimmed);
  if (!supabase) return false;
  const { error } = await supabase
    .from('jarvis_private_conversations')
    .upsert({
      conversation_key: key,
      messages: trimmed,
      updated_at: new Date().toISOString()
    }, { onConflict: 'conversation_key' });
  if (error) {
    console.error('Supabase conversation save:', error.message);
    return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// AI PERSONALITIES
// -----------------------------------------------------------------------------
const PERSONAL_SYSTEM = `
You are JARVIS, a capable, witty, thoughtful personal AI assistant.
Your creator is Samuel Johnson Ifeoluwa, publicly known as SamCityGo.
Creator website: https://samcitygo.kesug.com/
You may receive private messages or WhatsApp group messages from any participant. Reply in the same chat. Keep each sender’s stored history separate and never reveal one person’s private conversation to another.
Be useful with everyday questions, school learning, coding, technology, writing,
planning, brainstorming and decision support. Explain clearly and adapt to the
user's level. Understand Nigerian English and slang naturally without forcing it.
Be warm, respectful, concise when appropriate, and honest about uncertainty.
Do not claim to perform actions you cannot perform. Never ask for passwords,
verification codes, payment details or other sensitive credentials.
Some users may be teenagers: keep content age-appropriate. No sexual content,
sexualised roleplay, dangerous challenges, illegal instructions or harmful advice.
Do not reveal or imply knowledge of the partner's private conversations.
`;

const COUPLE_SYSTEM = `
You are JARVIS Couples Companion, a supportive AI shared by two authorised users:
${CREATOR_NAME} and ${PARTNER_NAME}.
This is their SHARED conversation. Both people will receive your reply and can
see messages intentionally sent with the /couple command. Be fair to both people;
never take sides, manipulate either person, encourage jealousy, surveillance,
controlling behaviour or pressure. Help them communicate kindly, resolve ordinary
misunderstandings, plan fun activities, create date ideas, ask thoughtful questions,
and celebrate positive moments. Do not claim to know what either person secretly
thinks or feels. Never bring information from either person's private assistant
history into this shared conversation. Respect boundaries and consent.
Keep everything age-appropriate: no sexual content or explicit suggestions.
`;

async function askGroq({ key, system, speaker, text }) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured.');
  const history = await loadHistory(key);
  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: `${speaker}: ${text}` }
  ];
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_completion_tokens: 650,
      temperature: 0.75
    }),
    signal: AbortSignal.timeout(35000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `Groq request failed (${response.status}).`);
  }
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('Groq returned an empty response.');
  history.push(
    { role: 'user', content: `${speaker}: ${text}` },
    { role: 'assistant', content: reply }
  );
  await saveHistory(key, history);
  return reply;
}

// -----------------------------------------------------------------------------
// WHAPI MESSAGING
// -----------------------------------------------------------------------------
async function sendWhatsAppMessage(to, message) {
  if (!WHAPI_API_TOKEN) throw new Error('WHAPI_API_TOKEN is not configured.');
  if (!to) throw new Error('WhatsApp recipient ID is missing.');
  const response = await fetch(`${WHAPI_API_URL}/messages/text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WHAPI_API_TOKEN}`
    },
    body: JSON.stringify({ to, body: String(message).slice(0, 4000) }),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `WHAPI send failed (${response.status}).`);
  return data;
}

async function sendToBoth(message) {
  const recipients = [CREATOR_WHATSAPP_ID, PARTNER_WHATSAPP_ID].filter(Boolean);
  const unique = [...new Map(recipients.map(id => [idDigits(id), id])).values()];
  const results = await Promise.allSettled(unique.map(id => sendWhatsAppMessage(id, message)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.error('Couple message delivery failed:', unique[index], result.reason?.message);
  });
  if (results.every(result => result.status === 'rejected')) {
    throw new Error('Could not deliver the shared reply to either authorised user.');
  }
}

// -----------------------------------------------------------------------------
// COUPLES ACTIVITIES
// -----------------------------------------------------------------------------
const truthQuestions = [
  'What is one small thing that makes you feel appreciated?',
  'What is a favourite memory we have made together?',
  'What is something new you would enjoy learning together?',
  'What is one quality you admire in the other person?',
  'What does a really good day together look like to you?',
  'What is one kind thing we could do for each other this week?'
];
const wouldYouRather = [
  'Would you rather plan a surprise picnic or a movie night at home?',
  'Would you rather explore a new city together or have a cosy game night?',
  'Would you rather exchange handwritten notes or make a shared playlist?',
  'Would you rather cook a new meal together or try a new hobby together?',
  'Would you rather take a nature walk or visit a museum together?'
];
const dateIdeas = [
  'Have a themed movie night and each choose one snack.',
  'Try a two-person drawing challenge and compare the results.',
  'Create a playlist together, with each person adding five songs.',
  'Have a virtual café date and ask each other five fun questions.',
  'Plan a mini photo scavenger hunt around safe, familiar places.',
  'Learn a simple recipe together and rate the results.'
];

function neonHelpMessage() {
  return `🤖 *JARVIS ↔ NEON MD*\n\nI recognise ${neonCommands.length} NEON AI menu command names.\nKnown command: #wordbomb start / #wordbomb stop\n\nTell me what you want in normal language. I will only send a NEON command when its syntax is known; I will not invent missing arguments.`;
}

function detectNeonIntent(text) {
  const t = text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(word ?bomb|wordbomb)\b/.test(t) && /\b(start|play|begin|launch|join)\b/.test(t)) return '#wordbomb start';
  if (/\b(word ?bomb|wordbomb)\b/.test(t) && /\b(stop|end|quit|cancel)\b/.test(t)) return '#wordbomb stop';
  if (/\b(how many|number of|count of)\b/.test(t) && /\b(neon|commands?|codes?)\b/.test(t)) return '__NEON_COUNT__';
  const exact = t.match(/^(?:run |use |start )?#([a-z0-9]+)(?:\s+([\s\S]+))?$/i);
  if (exact) {
    const name = exact[1].toLowerCase();
    if (name === 'wordbomb') return exact[2] ? `#wordbomb ${exact[2].trim()}` : null;
    if (neonCommands.includes(name)) return null; // Arguments/usage are not verified yet.
  }
  return null;
}

async function handleIncomingMessage(message) {
  if (!message || message.from_me === true || message.type !== 'text') return;
  const senderId = String(message.from || message.from_id || message.author || '').trim();
  const chatId = String(message.chat_id || '').trim();
  const text = cleanText(message.text?.body, MAX_MESSAGE_LENGTH);
  if (!senderId || !chatId || !text) return;
  if (message.from_me === true || /^\s*#/.test(text)) return;

  const messageId = message.id;
  if (messageId && processedMessages.has(messageId)) return;
  if (messageId) {
    processedMessages.add(messageId);
    if (processedMessages.size > 5000) processedMessages.delete(processedMessages.values().next().value);
  }

  const senderDigits = idDigits(senderId);
  const isCreator = Boolean(CREATOR_ONLY_ID && senderDigits === CREATOR_ONLY_ID);
  const lower = text.toLowerCase().trim();
  if (isCreator && /^(jarvis\s+)?resume\b/.test(lower)) {
    jarvisMuted = false;
    return sendWhatsAppMessage(chatId, 'JARVIS is active again.');
  }
  if (isCreator && /^(jarvis\s+)?mute\b/.test(lower)) {
    jarvisMuted = true;
    return sendWhatsAppMessage(chatId, 'JARVIS is muted. Say “JARVIS resume” to reactivate.');
  }
  if (jarvisMuted) return;

  const now = Date.now();
  const last = lastReplyAt.get(senderDigits) || 0;
  if (now - last < MIN_REPLY_INTERVAL_MS) return;
  lastReplyAt.set(senderDigits, now);

  if (/\b(neon|jarvis)\b/i.test(text) && /\b(help|commands|menu)\b/i.test(text)) {
    return sendWhatsAppMessage(chatId, neonHelpMessage());
  }
  const handoff = detectNeonIntent(text);
  if (handoff === '__NEON_COUNT__') {
    return sendWhatsAppMessage(chatId, `I recognise ${neonCommands.length} NEON AI menu command names. I have verified usage syntax for Word Bomb start and stop only so far.`);
  }
  if (handoff) {
    await sendWhatsAppMessage(chatId, handoff);
    return;
  }
  if (/\b(word ?bomb|wordbomb)\b/i.test(text) && /\b(play|start|begin|launch)\b/i.test(text)) {
    return sendWhatsAppMessage(chatId, 'I can start NEON Word Bomb with #wordbomb start. I am handing that command to NEON now.');
  }

  const speaker = cleanText(message.from_name || message.push_name || 'WhatsApp user', 60);
  const reply = await askGroq({
    key: personalKey(senderId),
    system: PERSONAL_SYSTEM + `\n\nNEON MD integration: The known NEON AI menu contains ${neonCommands.length} command names: ${neonCommands.join(', ')}. These are command names only, not verified argument formats. Never invent command syntax. Word Bomb commands verified: #wordbomb start and #wordbomb stop. If asked to use another NEON feature, explain that you recognise its name but need its exact usage syntax before issuing it. Do not imitate or start NEON games yourself.`,
    speaker,
    text
  });
  await sendWhatsAppMessage(chatId, reply);
}

// -----------------------------------------------------------------------------
// WEBHOOK AND HEALTH
// -----------------------------------------------------------------------------
app.post('/whapi/webhook/:secret', (req, res) => {
  if (!WHAPI_WEBHOOK_SECRET) return res.sendStatus(503);
  if (req.params.secret !== WHAPI_WEBHOOK_SECRET) return res.sendStatus(401);
  const messages = req.body?.messages;
  res.sendStatus(200);
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    handleIncomingMessage(message).catch(error => {
      console.error('JARVIS MESSAGE ERROR:', error.message);
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    bot: BOT_NAME,
    version: BOT_VERSION,
    status: 'online',
    mode: 'public_assistant_with_neon_handoff',
    access: 'public_private_chats_and_groups',
    neonRecognisedCommands: neonCommands.length,
    groq: GROQ_API_KEY ? 'configured' : 'missing',
    whapi: WHAPI_API_TOKEN ? 'configured' : 'missing',
    webhook: WHAPI_WEBHOOK_SECRET ? 'configured' : 'missing',
    supabase: supabase ? 'configured' : 'missing',
    message: 'JARVIS Personal AI is ready.'
  });
});

app.get('/help', (req, res) => res.json({ bot: BOT_NAME, version: BOT_VERSION, access: 'public', neonRecognisedCommands: neonCommands.length, verifiedNeonSyntax: ['#wordbomb start', '#wordbomb stop'] }));
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((error, req, res, next) => {
  console.error('Express error:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`${BOT_NAME} Personal AI ${BOT_VERSION} running on port ${PORT}`);
  console.log('Groq:', GROQ_API_KEY ? 'configured' : 'missing');
  console.log('WHAPI:', WHAPI_API_TOKEN ? 'configured' : 'missing');
  console.log('Supabase:', supabase ? 'configured' : 'missing');
  console.log('Public access: enabled');
  console.log('NEON command names recognised:', neonCommands.length);
});
