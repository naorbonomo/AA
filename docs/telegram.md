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
- **Per-chat queue:** one user message is processed at a time per `chat_id`. A hung LLM/stream used to block all later user messages while **scheduler** could still post to Telegram. **Timeout:** `config/telegram_config.ts` → `TELEGRAM_AGENT_REPLY_TIMEOUT_MS` (default 10 min) ends stuck runs with an error reply so queue advances.

## History `source`

- **`aa-telegram-chats/<chat_id>.json`** — each row includes `"source": "telegram"` with `role` / `content` / optional `"atMs"` (wall time for merge order).
- **`aa-chat-history.json`** — new saves set `"source": "app"` for Chat turns and `"source": "scheduler"` for scheduled runs; older rows may omit `source` (treat as app).

## Desktop Chat mirror

- Settings → **Chat & Telegram UI** → enable **Show Telegram transcript in Chat** to merge all `aa-telegram-chats/*.json` into Chat UI (magenta styling, read-only). Does not write Telegram rows into `aa-chat-history.json`.
- **Order:** transcript sorts by **Q→A turns** (user + following assistant per channel), not raw timestamp per row — desktop and Telegram pairs stay adjacent. Same-time turns: **desktop before Telegram**.
- Main process emits **`chat:mirror-refresh`** after each Telegram user/assistant persist (and scheduler Telegram push); Chat tab re-fetches history so mirror stays live without changing pages.

## Scheduler → Telegram

- Jobs have **`deliverDesktop`** (default on) and **`deliverTelegram`** (default off), plus optional **`telegramChatId`**. Engine uses Settings **default Telegram chat id** when `deliverTelegram` is on but job has no id. `schedule_job` tool accepts `deliver_desktop`, `deliver_telegram`, `telegram_chat_id` on create/update.
- **Default chat id** lives in **`aa-user-settings.json`** → `telegram.schedulerDefaultChatId`. If unset, **first inbound Telegram update** (e.g. `/start` or any message) saves that chat’s `chat_id` automatically. Clearing the field in Settings or setting another id stops overwrite until you clear it again.
