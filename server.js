/**
 * JARVIS Personal AI v8.1
 * Private creator-and-partner assistant with NEON MD command handoff.
 * Runtime: Node.js 20+
 * Providers: Baileys + Groq + Supabase
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.json({ limit: '30kb' }));

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
const BOT_NAME = 'JARVIS';
const BOT_VERSION = '8.2';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const BAILEYS_PRINT_QR = String(process.env.BAILEYS_PRINT_QR || 'false').toLowerCase() === 'true';
const BAILEYS_PAIRING_NUMBER = idDigits(process.env.BAILEYS_PAIRING_NUMBER || '');
let baileysSocket = null;
let baileysConnected = false;
// Optional: set this to JARVIS's WhatsApp number/ID in Render for metadata-based mentions.
const BOT_WHATSAPP_ID = String(process.env.BOT_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const CREATOR_WHATSAPP_ID = String(process.env.CREATOR_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const PARTNER_WHATSAPP_ID = String(process.env.PARTNER_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const CREATOR_NAME = String(process.env.CREATOR_DISPLAY_NAME || 'Samuel Johnson Ifeoluwa (SamCityGo)').trim().slice(0, 60);
const PARTNER_NAME = String(process.env.PARTNER_DISPLAY_NAME || 'Partner').trim().slice(0, 40);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_HISTORY_MESSAGES = 20;
const BAILEYS_AUTH_TABLE = 'jarvis_baileys_auth';
const BAILEYS_AUTH_ID = 'primary';
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
function senderIdCandidates(messageOrId) {
  if (!messageOrId || typeof messageOrId !== 'object') return [idDigits(messageOrId)].filter(Boolean);
  const key = messageOrId.key || messageOrId;
  return [...new Set([key.participantAlt, key.participant, key.remoteJidAlt, key.remoteJid, messageOrId.from]
    .map(idDigits).filter(Boolean))];
}
function isCreator(senderId) {
  const creator = idDigits(CREATOR_WHATSAPP_ID);
  return Boolean(creator && senderIdCandidates(senderId).includes(creator));
}
function isAllowedUser(senderId) {
  // Group participation is open; private chats are not used by this group bot.
  return true;
}

function getUserName(senderId) {
  return isCreator(senderId) ? CREATOR_NAME : PARTNER_NAME;
}
function isGroupChat(chatId) {
  return String(chatId || '').includes('@g.us');
}

// WHAPI payloads may expose mention IDs in different locations depending on
// message type/version. Inspect only common mention fields; do not treat every
// phone-number mention as a JARVIS mention.
function collectMentionIds(value, output = []) {
  if (!value) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectMentionIds(item, output);
    return output;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    output.push(String(value));
    return output;
  }
  if (typeof value === 'object') {
    for (const key of ['id', 'wa_id', 'user', 'jid', 'phone', 'participant']) {
      if (value[key] != null) output.push(String(value[key]));
    }
  }
  return output;
}

function isJarvisMentioned(message, body) {
  // Accept the spellings the creator requested, plus the standard spelling.
  // The boundary allows the 👨‍💻🚀 suffix after @jarvris.
  if (/(?:@)?(?:jarvris|javris|jarvis)(?![a-z0-9_])/iu.test(String(body || ''))) {
    return true;
  }

  const metadata = [
    message?.mentions,
    message?.context?.mentions,
    message?.text?.mentions,
    message?.text?.context?.mentions
  ];
  const mentionedIds = metadata.flatMap(value => collectMentionIds(value));
  const botDigits = idDigits(BOT_WHATSAPP_ID);
  if (!botDigits) return false;
  return mentionedIds.some(value => idDigits(value) === botDigits);
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
JARVIS is SamCityGo's own assistant. Selected compatible feature ideas may be adapted from AzahraBot, developed by Azar Tech; Azar Tech is credited for AzahraBot, not as JARVIS's creator. Never confuse AzahraBot with NEON MD.
You are a WhatsApp group assistant. Reply in the group where you were mentioned. Treat every participant respectfully, do not expose private information, and keep each group history separate. Do not claim to be a human or an administrator.
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
// BAILEYS MESSAGING
// -----------------------------------------------------------------------------
function toJid(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;
  const digits = idDigits(raw);
  return digits ? `${digits}@s.whatsapp.net` : '';
}

async function sendWhatsAppMessage(to, message) {
  if (!baileysSocket || !baileysConnected) throw new Error('JARVIS WhatsApp connection is not ready.');
  const jid = toJid(to);
  if (!jid) throw new Error('WhatsApp recipient JID is missing.');
  return baileysSocket.sendMessage(jid, { text: String(message).slice(0, 4000) });
}

async function sendToBoth(message) {
  const recipients = [...new Set([toJid(CREATOR_WHATSAPP_ID), toJid(PARTNER_WHATSAPP_ID)].filter(Boolean))];
  if (!recipients.length) throw new Error('Creator and partner WhatsApp IDs are not configured.');
  const results = await Promise.allSettled(recipients.map(jid => sendWhatsAppMessage(jid, message)));
  if (results.every(result => result.status === 'rejected')) throw new Error('Could not deliver the shared reply to either authorised user.');
  results.forEach((result, index) => { if (result.status === 'rejected') console.error('Shared message delivery failed:', result.reason?.message); });
}

function extractBaileysText(message) {
  const m = message?.message || {};
  return cleanText(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption || '',
    MAX_MESSAGE_LENGTH
  );
}

// Supabase-backed encrypted Baileys auth state. The service-role key is used
// only as key material; the auth payload itself is AES-256-GCM encrypted before
// it is written to the dedicated, RLS-protected table.
function authEncryptionKey() {
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase service-role key is required for persistent WhatsApp authentication.');
  return crypto.createHash('sha256').update(`JARVIS_BAILEYS_AUTH:${SUPABASE_SERVICE_ROLE_KEY}`).digest();
}
function encryptAuthState(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', authEncryptionKey(), iv);
  const plaintext = JSON.stringify(value, BufferJSON.replacer);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
}
function decryptAuthState(payload, BufferJSON) {
  if (!payload || payload.v !== 1) throw new Error('Stored WhatsApp auth payload is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', authEncryptionKey(), Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext, BufferJSON.reviver);
}
async function useSupabaseAuthState(baileys) {
  if (!supabase) throw new Error('Supabase must be configured to store the WhatsApp session.');
  const { initAuthCreds, BufferJSON } = baileys;
  const { data, error } = await supabase.from(BAILEYS_AUTH_TABLE).select('payload').eq('id', BAILEYS_AUTH_ID).maybeSingle();
  if (error) throw new Error(`Could not load WhatsApp auth from Supabase: ${error.message}`);
  let stored = data?.payload ? decryptAuthState(data.payload, BufferJSON) : null;
  const creds = stored?.creds || initAuthCreds();
  const keys = stored?.keys && typeof stored.keys === 'object' ? stored.keys : {};
  let saveQueue = Promise.resolve();
  const save = () => {
    const snapshot = { creds, keys };
    const payload = encryptAuthState(snapshot);
    saveQueue = saveQueue.then(async () => {
      const result = await supabase.from(BAILEYS_AUTH_TABLE).upsert({
        id: BAILEYS_AUTH_ID, payload, updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (result.error) throw new Error(result.error.message);
    });
    return saveQueue;
  };
  const state = {
    creds,
    keys: {
      async get(type, ids) {
        const category = keys[type] || {};
        const result = {};
        for (const id of ids) {
          let value = category[id];
          if (type === 'app-state-sync-key' && value && baileys.proto?.Message?.AppStateSyncKeyData?.fromObject) {
            value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          if (value !== undefined && value !== null) result[id] = value;
        }
        return result;
      },
      async set(dataToSet) {
        for (const [type, entries] of Object.entries(dataToSet || {})) {
          keys[type] ||= {};
          for (const [id, value] of Object.entries(entries || {})) {
            if (value == null) delete keys[type][id];
            else keys[type][id] = value;
          }
        }
        await save();
      }
    }
  };
  return { state, saveCreds: save };
}

async function startBaileys() {
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { DisconnectReason } = baileys;
  const { state, saveCreds } = await useSupabaseAuthState(baileys);
  let socketForPairing = null;
  baileysSocket = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['JARVIS', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    logger: require('pino')({ level: 'silent' })
  });
  socketForPairing = baileysSocket;
  baileysSocket.ev.on('creds.update', () => saveCreds().catch(error => console.error('WhatsApp auth save failed:', error.message)));
  let pairingRequested = false;
  baileysSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (!pairingRequested && BAILEYS_PAIRING_NUMBER && !state.creds.registered && connection !== 'close') {
      pairingRequested = true;
      try {
        // Allow the socket to finish its initial handshake before requesting a code.
        await new Promise(resolve => setTimeout(resolve, 1800));
        if (!baileysSocket || baileysSocket !== socketForPairing) return;
        const code = await baileysSocket.requestPairingCode(BAILEYS_PAIRING_NUMBER);
        console.log('JARVIS WhatsApp pairing code:', code);
        console.log('Enter it in WhatsApp > Linked Devices > Link with phone number instead.');
      } catch (error) {
        console.error('Could not generate WhatsApp pairing code:', error.message);
        pairingRequested = false;
      }
    }
    if (qr && BAILEYS_PRINT_QR) {
      console.log('Scan this JARVIS QR code using WhatsApp > Linked Devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      baileysConnected = true;
      const ownJid = baileysSocket.user?.id || '';
      console.log('JARVIS WhatsApp connected:', idDigits(ownJid) || 'connected');
    }
    if (connection === 'close') {
      baileysConnected = false;
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status !== DisconnectReason.loggedOut) {
        console.log('WhatsApp connection closed; reconnecting...');
        setTimeout(() => startBaileys().catch(err => console.error('Baileys reconnect failed:', err.message)), 3000);
      } else {
        console.error('WhatsApp session logged out. Remove the auth folder and pair again.');
      }
    }
  });
  baileysSocket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !Array.isArray(messages)) return;
    for (const msg of messages) {
      const chatId = msg.key?.remoteJid || '';
      const senderId = msg.key?.participantAlt || msg.key?.participant || msg.key?.remoteJidAlt || chatId;
      const body = extractBaileysText(msg);
      if (!body || !chatId || msg.key?.fromMe) continue;
      const context = msg.message?.extendedTextMessage?.contextInfo || {};
      const adapted = {
        id: msg.key?.id,
        from: senderId,
        chat_id: chatId,
        from_name: msg.pushName || 'WhatsApp user',
        type: 'text',
        text: { body },
        from_me: false,
        mentions: context.mentionedJid || [],
        // Keep the complete Baileys key so creator matching can inspect
        // participant/alternate JIDs (including LID-to-phone mappings).
        _baileysKey: msg.key
      };
      handleIncomingMessage(adapted).catch(error => console.error('JARVIS MESSAGE ERROR:', error.message));
    }
  });
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
  // Open group access: any participant may invoke JARVIS by name.
  if (!isGroupChat(chatId)) return;

  // In groups, JARVIS only responds when directly mentioned. Private chats
  // continue to work without a mention.
  if (!isJarvisMentioned(message, text)) return;

  const messageId = message.id;
  if (messageId && processedMessages.has(messageId)) return;
  if (messageId) {
    processedMessages.add(messageId);
    if (processedMessages.size > 5000) processedMessages.delete(processedMessages.values().next().value);
  }

  const senderDigits = senderIdCandidates(message._baileysKey || senderId)[0] || idDigits(senderId);
  const creatorMessage = isCreator(message._baileysKey || senderId);
  const lower = text.toLowerCase().trim();
  if (creatorMessage && /^(jarvis\s+)?resume\b/.test(lower)) {
    jarvisMuted = false;
    return sendWhatsAppMessage(chatId, 'JARVIS is active again.');
  }
  if (creatorMessage && /^(jarvis\s+)?mute\b/.test(lower)) {
    jarvisMuted = true;
    return sendWhatsAppMessage(chatId, 'JARVIS is muted. Say “JARVIS resume” to reactivate.');
  }
  if (jarvisMuted) return;

  const now = Date.now();
  const last = lastReplyAt.get(senderDigits) || 0;
  if (now - last < MIN_REPLY_INTERVAL_MS) return;
  lastReplyAt.set(senderDigits, now);

  if (/^(?:\/couple|couple)\b/i.test(text)) {
    const prompt = text.replace(/^(?:\/couple|couple)\b/i, '').trim() || 'Give us a fun, thoughtful question to discuss together.';
    const speaker = getUserName(senderId);
    const reply = await askGroq({ key: COUPLE_KEY, system: COUPLE_SYSTEM, speaker, text: prompt });
    await sendToBoth(reply);
    return;
  }

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

  if (/^(who (made|created) you|who is your creator|who owns you|who built you|who created jarvis)\??$/i.test(text)) {
    return sendWhatsAppMessage(chatId, `I am JARVIS, created by ${CREATOR_NAME}, publicly known as SamCityGo. Official website: https://samcitygo.kesug.com/.

Some compatible feature ideas are being adapted from AzahraBot by Azar Tech, who are credited as AzahraBot's developers. AzahraBot is a feature reference, not my creator. NEON MD remains a separate integration.`);
  }

  const speaker = cleanText(message.from_name || 'Group member', 60);
  const identityContext = creatorMessage
    ? `\n\nAuthenticated sender: ${CREATOR_NAME}. This sender is your verified creator. Address them respectfully as your creator when relevant; do not confuse them with the partner.`
    : `\n\nAuthenticated sender: ${PARTNER_NAME}. This is the authorised partner account, not the creator account.`;
  const reply = await askGroq({
    key: `group:${chatId}`,
    system: PERSONAL_SYSTEM + identityContext + `\n\nAzahraBot context: You are JARVIS, created by Samuel Johnson Ifeoluwa (SamCityGo). AzahraBot by Azar Tech is a separate project and a source of feature references; never claim its developers created JARVIS. Do not claim an AzahraBot feature is installed or executed unless a corresponding JARVIS handler has actually been implemented and called.\n\nNEON MD integration: The known NEON AI menu contains ${neonCommands.length} command names: ${neonCommands.join(', ')}. These are command names only, not verified argument formats. Never invent command syntax. Word Bomb commands verified: #wordbomb start and #wordbomb stop. If asked to use another NEON feature, explain that you recognise its name but need its exact usage syntax before issuing it. Do not imitate or start NEON games yourself.`,
    speaker,
    text
  });
  await sendWhatsAppMessage(chatId, reply);
}

// -----------------------------------------------------------------------------
// HEALTH AND STARTUP
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    bot: BOT_NAME,
    version: BOT_VERSION,
    status: 'online',
    whatsapp: baileysConnected ? 'connected' : 'connecting',
    transport: 'Baileys',
    access: 'open_groups_when_mentioned_creator_only_admin_commands',
    creatorRecognition: CREATOR_WHATSAPP_ID ? 'configured_by_whatsapp_id' : 'missing_creator_whatsapp_id',
    groupReplies: 'enabled_when_bot_name_is_mentioned',
    neonRecognisedCommands: neonCommands.length,
    groq: GROQ_API_KEY ? 'configured' : 'missing',
    supabase: supabase ? 'configured' : 'missing'
  });
});
app.get('/help', (req, res) => res.json({
  bot: BOT_NAME,
  version: BOT_VERSION,
  transport: 'Baileys',
  access: 'open_groups_when_mentioned_creator_only_admin_commands',
  groupReplies: 'Mention JARVIS, JAVRIS or JARVRIS in a group message',
  neonRecognisedCommands: neonCommands.length,
  verifiedNeonSyntax: ['#wordbomb start', '#wordbomb stop']
}));
app.use((req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((error, req, res, next) => {
  console.error('Express error:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error.' });
});

if (!CREATOR_WHATSAPP_ID) console.warn('CONFIG WARNING: CREATOR_WHATSAPP_ID is missing; creator-only admin commands will be unavailable.');
if (!supabase) console.error('CONFIG ERROR: Supabase is required for persistent Baileys authentication.');

app.listen(PORT, () => {
  console.log(`${BOT_NAME} Personal AI ${BOT_VERSION} running on port ${PORT}`);
  console.log('Transport: Baileys');
  console.log('Groq:', GROQ_API_KEY ? 'configured' : 'missing');
  console.log('Supabase:', supabase ? 'configured' : 'missing');
  console.log('Access: open groups when mentioned; creator-only admin commands');
  console.log('Creator identity:', CREATOR_WHATSAPP_ID ? `${CREATOR_NAME} (WhatsApp ID configured)` : 'NOT CONFIGURED');
  console.log('NEON command names recognised:', neonCommands.length);
  startBaileys().catch(error => console.error('Baileys startup failed:', error.message));
});
