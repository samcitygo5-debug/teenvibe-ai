/**
 * JARVIS Personal AI v7.0
 * Two authorised users; separate private assistants + one shared couples space.
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
const BOT_VERSION = '8.0';
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
const mutedUsers = new Set();

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
You are speaking in a PRIVATE one-to-one chat with the authorised user only.
Be useful with everyday questions, school learning, coding, technology, writing,
planning, brainstorming and decision support. Explain clearly and adapt to the
user's level. Understand Nigerian English and slang naturally without forcing it.
Be warm, respectful, concise when appropriate, and honest about uncertainty.
Do not claim to perform actions you cannot perform. Never ask for passwords,
verification codes, payment details or other sensitive credentials.
The user may be a teenager: keep content age-appropriate. No sexual content,
sexualised roleplay, dangerous challenges, illegal instructions or harmful advice.
Do not reveal or imply knowledge of the partner's private conversations.
NEON MD handles WhatsApp bot commands and games. Do not invent NEON command syntax.
If asked about a NEON feature whose exact command is not verified, say you need its
correct syntax rather than guessing.
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
// NATURAL-LANGUAGE CONTROL
// -----------------------------------------------------------------------------
// JARVIS has no slash-command system. NEON MD owns its own command menu.
// Only these two Word Bomb forms have been verified by the user.
function getVerifiedNeonCommand(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(start|begin|launch)\b.*\b(word\s*bomb|wordbomb)\b|\b(word\s*bomb|wordbomb)\b.*\b(start|begin|launch)\b/.test(value)) {
    return '#wordbomb start';
  }
  if (/\b(stop|end|cancel)\b.*\b(word\s*bomb|wordbomb)\b|\b(word\s*bomb|wordbomb)\b.*\b(stop|end|cancel)\b/.test(value)) {
    return '#wordbomb stop';
  }
  return null;
}

async function handleAuthorisedMessage(message) {
  if (!message || message.from_me === true || message.type !== 'text') return;
  const senderId = String(message.from || message.from_id || message.author || '').trim();
  const chatId = String(message.chat_id || '').trim();
  const text = cleanText(message.text?.body, MAX_MESSAGE_LENGTH);
  if (!senderId || !chatId || !text) return;

  // JARVIS is no longer a group bot. Ignore every group and every non-authorised DM.
  if (isGroupChat(chatId) || !isAllowedUser(senderId)) return;
  if (idDigits(chatId) && idDigits(chatId) !== idDigits(senderId)) return;

  const messageId = message.id;
  if (messageId && processedMessages.has(messageId)) return;
  if (messageId) {
    processedMessages.add(messageId);
    if (processedMessages.size > 5000) processedMessages.delete(processedMessages.values().next().value);
  }

  const senderName = getUserName(senderId);
  const now = Date.now();
  const last = lastReplyAt.get(idDigits(senderId)) || 0;
  if (now - last < MIN_REPLY_INTERVAL_MS) return;
  lastReplyAt.set(idDigits(senderId), now);

  const trimmed = text.trim();
  const lower = trimmed.toLowerCase().replace(/[.!?]+$/g, '').trim();

  // Mute/resume are natural-language controls, not slash commands.
  if (/^(jarvis[, ]+)?(mute|go quiet|stay quiet)$/.test(lower)) {
    mutedUsers.add(idDigits(senderId));
    return sendWhatsAppMessage(senderId, 'JARVIS is muted. Say “JARVIS resume” when you want me back.');
  }
  if (/^(jarvis[, ]+)?(resume|unmute|come back)$/.test(lower)) {
    const wasMuted = mutedUsers.delete(idDigits(senderId));
    return sendWhatsAppMessage(senderId, wasMuted ? 'JARVIS is active again.' : 'JARVIS is already active.');
  }
  if (mutedUsers.has(idDigits(senderId))) return;

  // NEON's own prefixed commands belong to NEON. JARVIS does not process them.
  if (trimmed.startsWith('#') || trimmed.startsWith('.')) return;

  // Only send a NEON command when its exact syntax has been verified.
  const neonCommand = getVerifiedNeonCommand(trimmed);
  if (neonCommand) {
    await sendWhatsAppMessage(chatId, neonCommand);
    return;
  }

  // No JARVIS slash commands: ordinary messages go directly to the AI assistant.
  // Ordinary direct messages always use an isolated, one-person history.
  const reply = await askGroq({
    key: personalKey(senderId),
    system: PERSONAL_SYSTEM,
    speaker: senderName,
    text: trimmed
  });
  await sendWhatsAppMessage(senderId, reply);
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
    handleAuthorisedMessage(message).catch(error => {
      console.error('JARVIS MESSAGE ERROR:', error.message);
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    bot: BOT_NAME,
    version: BOT_VERSION,
    status: 'online',
    mode: 'personal_ai_with_neon_command_handoff',
    authorisedUsersConfigured: Boolean(CREATOR_WHATSAPP_ID && PARTNER_WHATSAPP_ID),
    groq: GROQ_API_KEY ? 'configured' : 'missing',
    whapi: WHAPI_API_TOKEN ? 'configured' : 'missing',
    webhook: WHAPI_WEBHOOK_SECRET ? 'configured' : 'missing',
    supabase: supabase ? 'configured' : 'missing',
    message: 'JARVIS Personal AI is ready. NEON MD owns bot commands.'
  });
});

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
  console.log('Creator WhatsApp ID:', CREATOR_WHATSAPP_ID ? 'configured' : 'missing');
  console.log('Partner WhatsApp ID:', PARTNER_WHATSAPP_ID ? 'configured' : 'missing');
});
