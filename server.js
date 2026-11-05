

const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));

const activities = {
  fun: [
    "Describe your personality using 3 emojis 😂",
    "If you could visit any country, where would you go?",
    "What unusual talent would you like to learn?",
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
    "Would you rather travel into the past or the future?",
    "Would you rather have unlimited books or unlimited games?"
  ],
  joke: [
    "Why did the computer go to the doctor? It had a virus! 😂",
    "Why was the maths book sad? It had too many problems!",
    "Why did the phone wear glasses? It lost its contacts!"
  ],
  riddle: [
    "What has keys but cannot open locks? Answer: A piano.",
    "What gets wetter as it dries? Answer: A towel.",
    "What has a face and two hands but no arms? Answer: A clock."
  ],
  challenge: [
    "Describe your favourite movie without saying its name.",
    "Create a funny group slogan in 10 words or less.",
    "Name five animals in ten seconds.",
    "Tell a story using exactly five words."
  ]
};

const groups = {};

function getGroup(id) {
  if (!groups[id]) {
    groups[id] = { players: {}, gamesPlayed: 0 };
  }
  return groups[id];
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

app.get("/", (req, res) => {
  res.json({
    bot: "TeenVibe AI",
    version: "2.0",
    status: "online",
    message: "The entertainment engine is running!"
  });
});

app.get("/help", (req, res) => {
  res.json({
    bot: "TeenVibe AI",
    commands: [
      "/fun", "/truth", "/wyr", "/joke",
      "/riddle", "/challenge", "/quiz",
      "/team", "/score", "/help"
    ],
    note: "Some commands are planned for the next upgrade."
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

  res.json({
    bot: "TeenVibe AI",
    type,
    activity: pick(list)
  });
});

app.post("/score", (req, res) => {
  const { groupId, player, points } = req.body;

  if (
    typeof groupId !== "string" ||
    typeof player !== "string" ||
    typeof points !== "number" ||
    !groupId.trim() ||
    !player.trim() ||
    !Number.isFinite(points) ||
    points < 0 ||
    points > 100
  ) {
    return res.status(400).json({
      error: "Provide a groupId, player and valid points (0–100)."
    });
  }

  const group = getGroup(groupId.trim());
  const name = player.trim().slice(0, 40);

  group.players[name] = (group.players[name] || 0) + points;

  res.json({
    success: true,
    player: name,
    totalPoints: group.players[name]
  });
});

app.get("/score/:groupId", (req, res) => {
  const group = getGroup(req.params.groupId);
  const leaderboard = Object.entries(group.players)
    .map(([player, points]) => ({ player, points }))
    .sort((a, b) => b.points - a.points);

  res.json({
    leaderboard,
    gamesPlayed: group.gamesPlayed
  });
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.listen(PORT, () => {
  console.log(`TeenVibe AI running on port ${PORT}`);
});
