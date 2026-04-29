# Telegram bot (AA)

## 1. BotFather

1. Open Telegram, search **@BotFather**.
2. Send `/newbot` (or use existing bot).
3. Follow prompts → you get a **token** like `123456:ABC-DEF...`.
4. Copy token. Do not share it.

5. **Bot profile photo** (optional): ships as **`resources/telegram-bot-profile.jpg`**. Each **`/start`** triggers a **silent** API sync to that image (nothing extra in the chat). For manual fixes: **`/icon`** sends the file in chat, **`/set_bot_icon`** retries the API, or **@BotFather** → **`/setuserpic`**.

   **Tip:** If the avatar in Telegram still looks old, the API update may already be live — clients cache photos. Try quit Telegram fully, or open the bot in **Telegram Web** / another device.

## 2. Put token in AA

1. **Settings → Secrets → Telegram** paste token, **Save all**  
2. **Restart AA** once after changing token so the bot connects (integration starts at app launch).

## 3. Try it

1. Open your bot in Telegram, tap **Start** (short welcome) or send a normal message.
2. If no reply: token wrong, app not running, or check logs.

## How it runs

- Polling is on by default → bot works while AA window is open.
- Webhook: only if you set `"telegram": { "webhookPort": 8787 }` in `aa-user-settings.json` *and* point `setWebhook` at a public URL (tunnel).
- **Voice:** same Whisper as desktop. **`ffmpeg`** on PATH decodes Telegram voice files (`.oga` / Opus). Install from [ffmpeg.org](https://ffmpeg.org/), restart AA, retry.
- **Agent/tools:** same main-process loop as Chat (`web_search`, `schedule_job`, `stt`, `tts`, …).

## History `source`

- **`aa-telegram-chats/<chat_id>.json`** — each row includes `"source": "telegram"` with `role` / `content`.
- **`aa-chat-history.json`** — new saves set `"source": "app"` for Chat turns and `"source": "scheduler"` for scheduled runs; older rows may omit `source` (treat as app).
