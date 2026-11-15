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
const { spawnSync } = require('child_process');
const qrcode = require('qrcode-terminal');

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.use(express.json({ limit: '30kb' }));

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
const BOT_NAME = 'JARVIS';
const BOT_VERSION = '8.3-green-api';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const BAILEYS_PRINT_QR = String(process.env.BAILEYS_PRINT_QR || 'false').toLowerCase() === 'true';
const BAILEYS_PAIRING_NUMBER = idDigits(process.env.BAILEYS_PAIRING_NUMBER || '');
let baileysSocket = null;
let baileysConnected = false;
let baileysDownloadMediaMessage = null;
// Optional: set this to JARVIS's WhatsApp number/ID in Render for metadata-based mentions.
const BOT_WHATSAPP_ID = String(process.env.BOT_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const CREATOR_WHATSAPP_ID = String(process.env.CREATOR_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const PARTNER_WHATSAPP_ID = String(process.env.PARTNER_WHATSAPP_ID || '').trim().replace(/^whatsapp:/i, '');
const CREATOR_NAME = String(process.env.CREATOR_DISPLAY_NAME || 'Samuel Johnson Ifeoluwa (SamCityGo)').trim().slice(0, 60);
const PARTNER_NAME = String(process.env.PARTNER_DISPLAY_NAME || 'Partner').trim().slice(0, 40);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GREEN_API_URL = String(process.env.GREEN_API_URL || process.env.apiUrl || '').replace(/\/$/, '');
const GREEN_API_MEDIA_URL = String(process.env.GREEN_API_MEDIA_URL || process.env.mediaUrl || GREEN_API_URL).replace(/\/$/, '');
const GREEN_API_INSTANCE_ID = String(process.env.GREEN_API_INSTANCE_ID || process.env.idInstance || '').trim();
const GREEN_API_TOKEN = String(process.env.GREEN_API_TOKEN || process.env.apiTokenInstance || '').trim();
const GREEN_API_ENABLED = Boolean(GREEN_API_URL && GREEN_API_INSTANCE_ID && GREEN_API_TOKEN);
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

// Reviewed Azahra-style extensions. These run inside JARVIS's existing socket,
// permissions, history and backend; the untrusted/obfuscated Azahra loader is
// intentionally not executed as a second WhatsApp bot.
const azahraTruths = [
  'What is one small thing that always improves your mood?',
  'What skill would you learn instantly if you could?',
  'What is a goal you want to complete this year?',
  'What is one quality you value in a friend?'
];
const azahraDares = [
  'Send a sincere compliment to someone in the group.',
  'Describe your day using only three words.',
  'Share one useful tip you recently learned.',
  'Let the group choose a harmless nickname for you for five minutes.'
];
const azahraTrivia = [
  ['What is the largest planet in our solar system?', 'Jupiter'],
  ['How many sides does a hexagon have?', 'Six'],
  ['What is the chemical symbol for gold?', 'Au'],
  ['Which ocean is the largest?', 'Pacific Ocean']
];
const azahraQuotes = [
  'Small progress is still progress.',
  'A clear plan turns a large task into small steps.',
  'Consistency is more useful than occasional perfection.',
  'Kindness and confidence can exist together.'
];
function azahraExtensionMenu() {
  return [
    '*JARVIS EXTENSIONS*',
    '',
    '*Available now*',
    '• calculate, truth, dare, trivia/quiz',
    '• number guess, hangman, rock-paper-scissors, 8-ball',
    '• tic-tac-toe, word scramble, anagram, word chain',
    '• guess-the-flag, hand cricket',
    '• joke, fact, quote, riddle',
    '• coin flip, dice roll, choose',
    '• reverse, uppercase, lowercase',
    '• reply to an image/video: make sticker',
    '• anime reactions: hug, kiss, cuddle, pat, slap, poke, dance, wave, wink and more',
    '• JARVIS AI conversation and couple mode',
    '',
    '*Recognised from Azahra, not ported yet*',
    '• play/chatmusic, ytmp3, ytmp4 and audio FX',
    '• advanced image tools and logo/ephoto tools',
    '• full games, economy, cards and Pokémon',
    '• sports, weather and external downloaders',
    '',
    'Ask JARVIS naturally. In groups, mention JARVIS first.'
  ].join('\n');
}

function calculateExpression(input) {
  const expression = String(input || '')
    .replace(/(what is|calculate|calc|equals?|please|can you|of)/gi, '')
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '')
    .replace(/\bplus\b/gi, '+').replace(/\bminus\b/gi, '-')
    .replace(/\btimes\b/gi, '*').replace(/\bdivided by\b/gi, '/')
    .replace(/[^0-9+\-*/().%\s]/g, '').trim();
  if (!expression || !/^[0-9+\-*/().%\s]+$/.test(expression)) return null;
  try {
    // The whitelist above excludes identifiers, property access and calls.
    const result = Function(`"use strict"; return (${expression})`)();
    return Number.isFinite(result) ? result : null;
  } catch (_) {
    return null;
  }
}

const gameSessions = new Map();

function runLocalGame(text, chatId) {
  const raw = cleanText(text, MAX_MESSAGE_LENGTH);
  const t = raw.toLowerCase().trim();
  const key = String(chatId || 'global');
  const session = gameSessions.get(key);
  if (/\b(?:start|play)\s+(?:a\s+)?word\s*chain\b/i.test(t)) {
    const first = pick(['apple', 'river', 'tiger', 'music', 'ocean']);
    gameSessions.set(key, { type: 'wordchain', last: first, used: new Set([first]) });
    return `Word chain started with *${first}*. Reply with a word beginning with *${first.slice(-1).toUpperCase()}*.`;
  }
  if (session?.type === 'wordchain' && /^[a-z]+$/i.test(t)) {
    const word = t.toLowerCase();
    if (word.length < 2) return 'Use a word with at least two letters.';
    if (word[0] !== session.last.slice(-1)) return `Your word must begin with *${session.last.slice(-1).toUpperCase()}*.`;
    if (session.used.has(word)) return 'That word was already used. Try another one.';
    session.used.add(word);
    session.last = word;
    const replies = { a: 'ant', b: 'boat', c: 'cloud', d: 'drum', e: 'eagle', f: 'forest', g: 'garden', h: 'house', i: 'island', j: 'jungle', k: 'kite', l: 'lemon', m: 'mountain', n: 'night', o: 'orange', p: 'piano', q: 'queen', r: 'robot', s: 'star', t: 'train', u: 'umbrella', v: 'violet', w: 'window', x: 'xylophone', y: 'yellow', z: 'zebra' };
    const bot = replies[word.slice(-1)] || `${word.slice(-1)}word`;
    session.used.add(bot); session.last = bot;
    return `Good word: ${word}. My word: *${bot}*. Your turn with a word beginning with *${bot.slice(-1).toUpperCase()}*.`;
  }
  if (/\b(?:start|play)\s+(?:an?\s+)?anagram\b/i.test(t)) {
    const word = pick(['javascript', 'whatsapp', 'supabase', 'computer', 'rainbow', 'football']);
    gameSessions.set(key, { type: 'anagram', word });
    return `Anagram: *${word.split('').sort(() => Math.random() - 0.5).join('')}*. What is the word?`;
  }
  if (session?.type === 'anagram' && /^[a-z]+$/.test(t)) {
    if (t === session.word) { gameSessions.delete(key); return 'Correct! You solved the anagram.'; }
    return 'Not correct yet. Try another answer or say “stop game”.';
  }
  if (/\b(?:start|play)\s+(?:tic[- ]?tac[- ]?toe|ttt)\b/i.test(t)) {
    gameSessions.set(key, { type: 'ttt', board: Array(9).fill('') });
    return 'Tic-Tac-Toe started. You are X. Choose a square from 1 to 9: 1 2 3 / 4 5 6 / 7 8 9';
  }
  if (session?.type === 'ttt' && /^[1-9]$/.test(t)) {
    const board = session.board; const position = Number(t) - 1;
    if (board[position]) return 'That square is occupied. Choose another number from 1 to 9.';
    board[position] = 'X';
    const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const won = mark => wins.some(line => line.every(index => board[index] === mark));
    if (won('X')) { gameSessions.delete(key); return 'You win! Tic-Tac-Toe finished.'; }
    if (board.every(Boolean)) { gameSessions.delete(key); return 'Draw! Tic-Tac-Toe finished.'; }
    const free = board.map((value, index) => value ? -1 : index).filter(index => index >= 0);
    board[pick(free)] = 'O';
    if (won('O')) { gameSessions.delete(key); return `I win this round. Board: ${board.map((v, i) => v || i + 1).join(' ')}`; }
    return `Board: ${board.map((v, i) => v || i + 1).join(' ')}. Your turn.`;
  }
  if (/\b(?:start|play)\s+(?:word\s+)?scramble\b/i.test(t)) {
    const word = pick(['javascript', 'whatsapp', 'supabase', 'computer', 'rainbow', 'football']);
    gameSessions.set(key, { type: 'scramble', word });
    return `Word scramble: *${word.split('').sort(() => Math.random() - 0.5).join('')}*\nWhat is the original word?`;
  }
  if (session?.type === 'scramble' && /^[a-z]+$/.test(t)) {
    if (t === session.word) { gameSessions.delete(key); return 'Correct! You solved the scramble.'; }
    return 'Not quite—try again, or say “stop game”.';
  }
  if (/\b(?:start|play)\s+(?:guess\s+the\s+)?flag\b/i.test(t)) {
    const flag = pick([['🇳🇬', 'nigeria'], ['🇬🇧', 'united kingdom'], ['🇯🇵', 'japan'], ['🇧🇷', 'brazil'], ['🇨🇦', 'canada']]);
    gameSessions.set(key, { type: 'flag', answer: flag[1] });
    return `Guess the country: ${flag[0]}`;
  }
  if (session?.type === 'flag' && /^[a-z ]+$/i.test(t)) {
    if (t === session.answer) { gameSessions.delete(key); return 'Correct! You guessed the flag.'; }
    return 'Not quite. Try another country or say “stop game”.';
  }
  if (/\b(?:start|play)\s+(?:hand\s*)?cricket\b/i.test(t)) {
    gameSessions.set(key, { type: 'cricket', player: 0, bot: 0 });
    return 'Hand cricket started. Choose a number from 1 to 6. Matching numbers mean you are out.';
  }
  if (session?.type === 'cricket' && /^[1-6]$/.test(t)) {
    const player = Number(t); const bot = 1 + Math.floor(Math.random() * 6);
    if (player === bot) {
      const result = session.player > session.bot ? 'You win!' : session.player < session.bot ? 'I win!' : 'It is a draw!';
      gameSessions.delete(key);
      return `You: ${player}, JARVIS: ${bot}. Out! Score: you ${session.player}, me ${session.bot}. ${result}`;
    }
    session.player += player; session.bot += bot;
    return `You: ${player}, JARVIS: ${bot}. Score: you ${session.player}, me ${session.bot}. Continue or say “stop game”.`;
  }
  if (/\b(?:stop|quit|cancel)\s+(?:game|guess|hangman)\b/i.test(t)) {
    gameSessions.delete(key);
    return 'Game stopped.';
  }
  if (/\b(?:start|play)\s+(?:a\s+)?(?:number\s+)?guess(?:ing)?\s*game\b/i.test(t)) {
    gameSessions.set(key, { type: 'guess', target: 1 + Math.floor(Math.random() * 100), tries: 0 });
    return 'Guessing game started. I picked a number from 1 to 100. Say a number.';
  }
  if (session?.type === 'guess' && /^\d{1,3}$/.test(t)) {
    const number = Number(t);
    if (number < 1 || number > 100) return 'Choose a number from 1 to 100.';
    session.tries += 1;
    if (number === session.target) {
      gameSessions.delete(key);
      return `Correct! You got it in ${session.tries} ${session.tries === 1 ? 'try' : 'tries'}.`;
    }
    return `${number < session.target ? 'Higher' : 'Lower'} — try again.`;
  }
  if (/\b(?:start|play)\s+(?:hangman|word\s+game)\b/i.test(t)) {
    const word = pick(['javascript', 'whatsapp', 'supabase', 'computer', 'rainbow', 'football']);
    gameSessions.set(key, { type: 'hangman', word, guessed: new Set(), misses: 0 });
    return `Hangman started.\n${word.replace(/[a-z]/g, '_ ')}\nGuess one letter at a time.`;
  }
  if (session?.type === 'hangman' && /^[a-z]$/i.test(t)) {
    if (session.guessed.has(t)) return 'You already tried that letter.';
    session.guessed.add(t);
    if (!session.word.includes(t)) session.misses += 1;
    const display = [...session.word].map(ch => session.guessed.has(ch) ? ch : '_').join(' ');
    if ([...session.word].every(ch => session.guessed.has(ch))) {
      gameSessions.delete(key);
      return `You won! The word was *${session.word}*.`;
    }
    if (session.misses >= 6) {
      gameSessions.delete(key);
      return `Game over. The word was *${session.word}*.`;
    }
    return `${display}\nMisses: ${session.misses}/6`;
  }
  if (/\b(?:rock paper scissors|rps)\b/i.test(t)) {
    const choices = ['rock', 'paper', 'scissors'];
    const user = choices.find(choice => t.includes(choice));
    if (!user) return 'Choose rock, paper, or scissors.';
    const bot = pick(choices);
    const win = (user === 'rock' && bot === 'scissors') || (user === 'paper' && bot === 'rock') || (user === 'scissors' && bot === 'paper');
    return `You: ${user}\nJARVIS: ${bot}\nResult: ${user === bot ? 'draw' : win ? 'you win' : 'I win'}.`;
  }
  if (/\b(?:8ball|magic 8 ball|ask the 8 ball)\b/i.test(t)) {
    return `8-ball: ${pick(['Yes.', 'No.', 'Probably.', 'Ask again later.', 'Definitely.', 'I would not count on it.'])}`;
  }
  return null;
}

function runAzahraExtension(text, chatId) {
  const raw = cleanText(text, MAX_MESSAGE_LENGTH);
  const t = raw.toLowerCase().trim();
  if (/^(?:azahra\s+)?(?:help|menu|features)$/i.test(t)) return azahraExtensionMenu();
  const gameReply = runLocalGame(raw, chatId);
  if (gameReply) return gameReply;
  const reaction = raw.match(/\b(hug|kiss|cuddle|pat|slap|poke|bite|bonk|dance|cry|blush|happy|highfive|facepalm|smile|wave|wink|yeet|glomp|handhold|nom|kick)\b(?:\s+@?([\w .-]+))?/i);
  if (reaction) {
    const action = reaction[1].toLowerCase();
    const target = reaction[2] ? ` @${reaction[2].trim()}` : '';
    const phrases = { hug: 'gives a warm hug to', kiss: 'gives a friendly kiss to', cuddle: 'cuddles', pat: 'pats', slap: 'slaps', poke: 'pokes', bite: 'playfully bites', bonk: 'bonks', dance: 'dances with', cry: 'cries with', blush: 'blushes at', happy: 'celebrates with', highfive: 'high-fives', facepalm: 'facepalms at', smile: 'smiles at', wave: 'waves to', wink: 'winks at', yeet: 'yeets', glomp: 'glomps', handhold: 'holds hands with', nom: 'gives a playful nom to', kick: 'playfully kicks' };
    return `JARVIS ${phrases[action]}${target}.`;
  }
  if (/\b(?:calculate|calc|what is)\b/i.test(t) && /[0-9]/.test(t)) {
    const result = calculateExpression(raw);
    if (result !== null) return `Answer: ${result}`;
  }
  if (/\btruth\b/i.test(t)) return `Truth: ${pick(azahraTruths)}`;
  if (/\bdare\b/i.test(t)) return `Dare: ${pick(azahraDares)}`;
  if (/\b(?:trivia|quiz)\b/i.test(t)) {
    const [question, answer] = pick(azahraTrivia);
    return `Trivia: ${question}\nAnswer: ${answer}`;
  }
  if (/\b(?:joke|make me laugh)\b/i.test(t)) return pick([
    'Why did the developer go broke? Because they used up all their cache.',
    'I told my code I needed space. It gave me a new directory.',
    'My bugs and I have an understanding: I find them, and they keep me humble.'
  ]);
  if (/\bfact\b/i.test(t)) return pick([
    'Honey never spoils when it is stored properly.',
    'Octopuses have three hearts.',
    'Bananas are botanically berries, but strawberries are not.'
  ]);
  if (/\b(?:quote|motivation)\b/i.test(t)) return `“${pick(azahraQuotes)}”`;
  if (/\briddle\b/i.test(t)) return 'Riddle: I have keys but no locks and space but no room. What am I?\nAnswer: A keyboard.';
  if (/\b(?:flip a coin|coin flip|heads or tails)\b/i.test(t)) return `Coin: ${Math.random() < 0.5 ? 'Heads' : 'Tails'}`;
  if (/\b(?:roll|throw)\s+(?:a\s+)?(?:die|dice)\b/i.test(t)) return `Dice: ${1 + Math.floor(Math.random() * 6)}`;
  const choose = raw.match(/\bchoose\s+(?:between\s+)?(.+)/i);
  if (choose) {
    const options = choose[1].split(/\s+or\s+|,|\s+\/\s+/i).map(value => cleanText(value)).filter(Boolean);
    if (options.length >= 2) return `I choose: ${pick(options)}`;
  }
  const transform = raw.match(/\b(reverse|uppercase|lowercase)\s+(?:this\s+|text\s+)?(.+)/i);
  if (transform) {
    const value = transform[2].trim();
    if (transform[1].toLowerCase() === 'reverse') return value.split('').reverse().join('');
    if (transform[1].toLowerCase() === 'uppercase') return value.toUpperCase();
    return value.toLowerCase();
  }
  return null;
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
  if (GREEN_API_ENABLED) {
    const chatId = toGreenChatId(to);
    if (!chatId) throw new Error('Green-API recipient chat ID is missing.');
    const response = await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_INSTANCE_ID}/sendMessage/${GREEN_API_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message: String(message).slice(0, 20000) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.message || `Green-API sendMessage failed (${response.status}).`);
    return data;
  }
  if (!baileysSocket || !baileysConnected) throw new Error('JARVIS WhatsApp connection is not ready.');
  const jid = toJid(to);
  if (!jid) throw new Error('WhatsApp recipient JID is missing.');
  return baileysSocket.sendMessage(jid, { text: String(message).slice(0, 4000) });
}

function toGreenChatId(value) {
  const raw = String(value || '').trim();
  if (raw.endsWith('@g.us') || raw.endsWith('@c.us')) return raw;
  const digits = idDigits(raw);
  return digits ? `${digits}@c.us` : '';
}

async function sendWhatsAppSticker(to, sourceMessage) {
  if (!baileysSocket || !baileysConnected || !baileysDownloadMediaMessage) throw new Error('Sticker media support is not ready.');
  const input = await baileysDownloadMediaMessage(sourceMessage, 'buffer', {});
  const converted = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0', '-c:v', 'libwebp', '-f', 'webp', 'pipe:1'], { input, maxBuffer: 12 * 1024 * 1024 });
  if (converted.status !== 0 || !converted.stdout?.length) throw new Error('Could not convert the media to a WhatsApp sticker.');
  return baileysSocket.sendMessage(toJid(to), { sticker: converted.stdout });
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
function encryptAuthState(value, BufferJSON) {
  if (!BufferJSON?.replacer) throw new Error('Baileys BufferJSON serializer is unavailable.');
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
    const payload = encryptAuthState(snapshot, BufferJSON);
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

let greenApiPolling = false;
async function startGreenApi() {
  greenApiPolling = true;
  console.log('Transport: Green-API');
  try {
    const stateResponse = await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_INSTANCE_ID}/getStateInstance/${GREEN_API_TOKEN}`);
    const stateData = await stateResponse.json().catch(() => ({}));
    console.log('Green-API instance state:', stateData.stateInstance || stateData.message || `HTTP ${stateResponse.status}`);
    baileysConnected = stateResponse.ok && stateData.stateInstance === 'authorized';
    if (!baileysConnected) console.error('Green-API is not authorized or cannot be reached. Authorize the instance in the Green-API console.');
  } catch (error) {
    console.error('Green-API state check failed:', error.message);
  }
  while (greenApiPolling) {
    try {
      const response = await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_INSTANCE_ID}/receiveNotification/${GREEN_API_TOKEN}?receiveTimeout=25`);
      if (response.status === 200) {
        const notification = await response.json().catch(() => null);
        const body = notification?.body || {};
        if (notification?.receiptId != null) {
          await fetch(`${GREEN_API_URL}/waInstance${GREEN_API_INSTANCE_ID}/deleteNotification/${GREEN_API_TOKEN}/${notification.receiptId}`, { method: 'DELETE' });
        }
        console.log('Green-API notification received:', body.typeWebhook || 'unknown');
        if (body.typeWebhook === 'incomingMessageReceived') {
          const sender = body.senderData || {};
          const msgData = body.messageData || {};
          const text = cleanText(msgData.textMessageData?.textMessage || msgData.extendedTextMessageData?.text || msgData.extendedTextMessageData?.textMessage || msgData.caption || '', MAX_MESSAGE_LENGTH);
          const chatId = sender.chatId || '';
          console.log('Green-API incoming message:', { chatId, messageType: msgData.typeMessage, hasText: Boolean(text) });
          if (text && chatId && !body.senderData?.sender?.includes(GREEN_API_INSTANCE_ID)) {
            handleIncomingMessage({ id: body.idMessage, from: sender.sender || chatId, chat_id: chatId, from_name: sender.senderName || 'WhatsApp user', type: 'text', text: { body: text }, from_me: false, mentions: [], hasMedia: false }).catch(error => console.error('JARVIS GREEN-API ERROR:', error.message));
          }
        }
      } else if (response.status !== 502 && response.status !== 408) {
        console.error('Green-API receiveNotification failed:', response.status);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } catch (error) {
      console.error('Green-API polling error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

async function startBaileys() {
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { DisconnectReason } = baileys;
  baileysDownloadMediaMessage = baileys.downloadMediaMessage;
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
        rawBaileysMessage: msg,
        hasMedia: Boolean(msg.message?.imageMessage || msg.message?.videoMessage),
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

  if (message.hasMedia && /\b(?:make|turn|convert)\b.*\bsticker\b|\bsticker\b.*\b(?:make|turn|convert)\b/i.test(text)) {
    try {
      await sendWhatsAppSticker(chatId, message.rawBaileysMessage);
      return;
    } catch (error) {
      return sendWhatsAppMessage(chatId, `Sticker conversion failed: ${error.message}`);
    }
  }

  const extensionReply = runAzahraExtension(text, chatId);
  if (extensionReply) return sendWhatsAppMessage(chatId, extensionReply);

  if (/^(?:\/couple|couple)\b/i.test(text)) {
    const prompt = text.replace(/^(?:\/couple|couple)\b/i, '').trim() || 'Give us a fun, thoughtful question to discuss together.';
    const speaker = getUserName(senderId);
    const reply = await askGroq({ key: COUPLE_KEY, system: COUPLE_SYSTEM, speaker, text: prompt });
    await sendToBoth(reply);
    return;
  }

  if (/^(who (made|created) you|who is your creator|who owns you|who built you|who created jarvis)\??$/i.test(text)) {
    return sendWhatsAppMessage(chatId, `I am JARVIS, created by ${CREATOR_NAME}, publicly known as SamCityGo. Official website: https://samcitygo.kesug.com/.

 Some compatible feature ideas are being adapted from AzahraBot by Azar Tech, who are credited as AzahraBot's developers. AzahraBot is a feature reference, not my creator.`);
  }

  const speaker = cleanText(message.from_name || 'Group member', 60);
  const identityContext = creatorMessage
    ? `\n\nAuthenticated sender: ${CREATOR_NAME}. This sender is your verified creator. Address them respectfully as your creator when relevant; do not confuse them with the partner.`
    : `\n\nAuthenticated sender: ${PARTNER_NAME}. This is the authorised partner account, not the creator account.`;
  const reply = await askGroq({
    key: `group:${chatId}`,
    system: PERSONAL_SYSTEM + identityContext + `\n\nAzahraBot context: You are JARVIS, created by Samuel Johnson Ifeoluwa (SamCityGo). AzahraBot by Azar Tech is a separate project and a source of feature references; never claim its developers created JARVIS. Do not claim an AzahraBot feature is installed or executed unless a corresponding JARVIS handler has actually been implemented and called.`,
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
    transport: GREEN_API_ENABLED ? 'Green-API' : 'Baileys',
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
  transport: GREEN_API_ENABLED ? 'Green-API' : 'Baileys',
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
  console.log('Transport:', GREEN_API_ENABLED ? 'Green-API' : 'Baileys');
  console.log('Groq:', GROQ_API_KEY ? 'configured' : 'missing');
  console.log('Supabase:', supabase ? 'configured' : 'missing');
  console.log('Access: open groups when mentioned; creator-only admin commands');
  console.log('Creator identity:', CREATOR_WHATSAPP_ID ? `${CREATOR_NAME} (WhatsApp ID configured)` : 'NOT CONFIGURED');
  console.log('NEON command names recognised:', neonCommands.length);
  if (GREEN_API_ENABLED) startGreenApi().catch(error => console.error('Green-API startup failed:', error.message));
  else startBaileys().catch(error => console.error('Baileys startup failed:', error.message));
});
