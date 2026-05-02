# YouTube transcript tool (`youtube_transcribe`)

Agent tool: pull plain text from a YouTube video. Implemented in **`services/youtube-transcribe-tool.ts`**; registered with the same loop as Chat / Telegram (**`services/agent-runner.ts`**). System prompt preset **`web_search_tools`** / **`tool_select`** documents behavior for the LLM (`config/system_prompts.ts`).

## What it does

| Mode | `transcript_source` | Behavior |
|------|---------------------|----------|
| **Auto** (default if omitted) | `auto` | Try **platform captions** first (no `yt-dlp`). If that fails or is empty, fall back to **download audio + local Whisper** when `yt-dlp` and `ffmpeg` are available. |
| Captions only | `youtube` | Captions / subtitles via [`youtube-transcript`](https://www.npmjs.com/package/youtube-transcript) only. No Whisper fallback in this mode. |
| Local ASR only | `whisper` | Always **best audio** download + decode + **Transformers.js Whisper** (same stack as agent `stt` / desktop Whisper settings). |

Successful tool JSON includes:

- `ok: true`
- `text` — full transcript string (captions flattened to one line with normalized spaces for caption mode)
- `video_id` — 11-character id
- `backend` — `"youtube_captions"` or `"whisper"`
- `transcript_source` — `"auto"`, `"youtube"`, or `"whisper"` (for `auto`, reflects the pipeline that won)

## Parameters

| Argument | Required | Notes |
|----------|----------|--------|
| `url` | Yes | Watch URL, `youtu.be`, Shorts, or bare 11-char id. Query strings (e.g. `&pp=…`) are fine; id is parsed from the URL. |
| `transcript_source` | No | `auto` \| `youtube` \| `whisper`. Default **`auto`**. |
| `language` | No | ISO-639-1 hint (e.g. `en`) for caption fetch and Whisper when set. |
| `max_duration_seconds` | No | **Whisper path only.** Reject download/transcribe if reported duration exceeds this. Default **7200** (2 hours). |

## Dependencies

- **Caption path (`youtube` or auto-first-step):** Network only; uses the `youtube-transcript` package (no `yt-dlp`).
- **Whisper path:** **`yt-dlp`** on [PATH](https://github.com/yt-dlp/yt-dlp) (audio download), **`ffmpeg`** on [PATH](https://ffmpeg.org/) (decode to PCM for Whisper), Whisper model/settings from **Settings → Whisper** (same as `stt`).

## Smoke test (no LLM)

From repo root:

```bash
npm run smoke:youtube-transcribe -- "https://www.youtube.com/watch?v=VIDEO_ID"
```

Optional trailing mode: `auto`, `youtube`, or `whisper` (must be last token):

```bash
npm run smoke:youtube-transcribe -- "https://www.youtube.com/watch?v=VIDEO_ID" youtube
```

With no URL, uses a short default clip. Uses merged settings / secrets init like other smoke scripts; optional **`AA_USER_DATA`** if your config lives outside cwd.

## Limits and caveats

- **Captions** = whatever YouTube exposes (manual or auto-generated); quality varies.
- **Long transcripts** in chat may hit **LLM output token** limits; system prompt instructs the model to honor “raw / full transcript” when you ask; splitting or continuation is provider-dependent.
- **`auto`** after caption failure: Whisper fallback errors combine caption + Whisper messages for debugging.

## Related

- **Whisper:** local ASR config in **`config/user-settings.ts`** / Settings UI.
- **Agent step UI:** Chat trace shows `youtube_transcribe` with mode, URL snippet, backend, preview.
