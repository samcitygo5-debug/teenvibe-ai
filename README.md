# JARVIS Baileys migration draft

This draft replaces the WHAPI webhook and HTTP send calls with a Baileys multi-device connection. It retains the existing JARVIS Groq/Supabase conversation code and NEON command handoff logic and explicitly identifies Samuel Johnson Ifeoluwa (SamCityGo) as JARVIS creator. It credits Azar Tech as AzahraBot developers, while treating AzahraBot as a separate feature reference rather than JARVIS creator.

## Required environment variables

Copy `.env.example` into your hosting provider's environment settings and fill in the values. Do not publish `.env`, QR codes, or the `auth_info` folder.

Required: `GROQ_API_KEY`, `CREATOR_WHATSAPP_ID`, `PARTNER_WHATSAPP_ID`. Supabase variables are required for persistent conversation history. `BAILEYS_AUTH_DIR` should point to persistent storage on the host.

## Pairing

Deploy with `BAILEYS_PRINT_QR=true`, view the QR in the host logs, then scan it from WhatsApp > Linked devices. Keep the auth folder persistent across restarts. Never share the QR or auth folder.

## Important status

This is a migration draft, not a production-verified deployment. Baileys 7 is a release-candidate dependency and the WhatsApp pairing, reconnect behavior, and send/receive flow must be tested on the chosen host. The old JARVIS code did not actually enforce its creator/partner allowlist in the incoming handler; this draft enforces it. Only the two configured WhatsApp IDs are allowed to use JARVIS. `/couple` sends a shared reply to both configured users.

NEON's existing verified Word Bomb syntax remains `#wordbomb start` and `#wordbomb stop`. The AzahraBot archive README credits Azar Tech and states it is MIT-licensed. However, its entry point and inspected sample command files are obfuscated, so no AzahraBot command handlers are imported in this draft. AzahraBot feature ideas are not the same as installed, executable handlers. Creator matching retains the complete Baileys message key so alternate participant JIDs can be checked. Set CREATOR_WHATSAPP_ID to the creator's own WhatsApp number in international digits (without +), and PARTNER_WHATSAPP_ID to the partner's number. The bot cannot identify the creator securely from a display name alone.
