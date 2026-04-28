#!/usr/bin/env node
/**
 * Minimal Cerebras `POST /v1/chat/completions` smoke test (same shape as published curl).
 * Run: `node scripts/cerebras-chat-example.mjs`
 * Do not commit real tokens — keep this file local or rotate key if leaked.
 */

// --- paste API token between quotes ---
const CEREBRAS_API_KEY = "csk-wnh2e6cykvkhdp6vmcdkxxm9her64cfx5v4x25h223x9vmcw";

const URL = "https://api.cerebras.ai/v1/chat/completions";

const BODY = {
  model: "gpt-oss-120b",
  stream: true,
  max_tokens: 32768,
  temperature: 1,
  top_p: 1,
  reasoning_effort: "medium",
  messages: [{ role: "system", content: "" }],
};

async function main() {
  const key = typeof CEREBRAS_API_KEY === "string" ? CEREBRAS_API_KEY.trim() : "";
  if (!key) {
    console.error("Set CEREBRAS_API_KEY at top of scripts/cerebras-chat-example.mjs");
    process.exit(1);
  }

  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(BODY),
  });

  console.error("HTTP", res.status, res.statusText);

  if (!res.ok) {
    const errText = await res.text();
    console.error(errText);
    process.exit(1);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    console.error("No response body");
    process.exit(1);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trimStart();
      if (payload === "[DONE]") continue;
      try {
        const j = JSON.parse(payload);
        const piece =
          j?.choices?.[0]?.delta?.content ??
          j?.choices?.[0]?.delta?.reasoning_content ??
          "";
        if (typeof piece === "string" && piece.length) {
          process.stdout.write(piece);
        }
      } catch {
        /* ignore bad chunk */
      }
    }
  }
  process.stdout.write("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
