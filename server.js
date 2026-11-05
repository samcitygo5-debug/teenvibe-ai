
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const activities = {
  fun: [
    "Describe your personality using only 3 emojis 😂",
    "If you could teleport anywhere, where would you go?",
    "Who in this group would survive a zombie movie?"
  ],
  truth: [
    "What's the funniest thing you've ever done?",
    "What's one talent nobody knows you have?",
    "What's your most embarrassing funny moment?"
  ],
  wyr: [
    "Would you rather read minds or become invisible?",
    "Would you rather travel into the past or future?",
    "Would you rather have unlimited food or unlimited travel?"
  ],
  joke: [
    "Why did the computer go to the doctor? It had a virus! 😂",
    "Why was the maths book sad? It had too many problems!"
  ],
  riddle: [
    "What has keys but cannot open locks? Answer: A piano.",
    "What gets wetter as it dries? Answer: A towel."
  ]
};

app.get("/", (req, res) => {
  res.json({
    bot: "TeenVibe AI",
    status: "online",
    message: "Your entertainment engine is running!"
  });
});

app.get("/activity/:type", (req, res) => {
  const type = req.params.type.toLowerCase();
  const list = activities[type];

  if (!list) {
    return res.status(404).json({
      error: "Activity not found",
      available: Object.keys(activities)
    });
  }

  const random = Math.floor(Math.random() * list.length);

  res.json({
    type,
    activity: list[random]
  });
});

app.get("/help", (req, res) => {
  res.json({
    commands: [
      "/fun",
      "/truth",
      "/wyr",
      "/joke",
      "/riddle"
    ]
  });
});

app.listen(PORT, () => {
  console.log(`TeenVibe AI running on port ${PORT}`);
});
