/** Persist copies of chat attachments next to aa-chat-history.json for STT retries / restarts. */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MAX_CHAT_AUDIO_ATTACH_BYTES } from "./telegram-voice.js";
import { getChatHistoryFilePath } from "./chat-history-store.js";

export function getChatAttachmentsDir(): string {
  return path.join(path.dirname(getChatHistoryFilePath()), "chat-attachments");
}

export function pathIsInsideChatAttachments(absoluteOrAny: string): boolean {
  const base = path.resolve(getChatAttachmentsDir());
  let resolved = path.resolve(absoluteOrAny);
  try {
    if (fs.existsSync(resolved)) {
      resolved = fs.realpathSync(resolved);
    }
  } catch {
    /* keep resolved */
  }
  const bn = path.resolve(base);
  return resolved === bn || resolved.startsWith(bn + path.sep);
}

/**
 * Writes bytes into `chat-attachments/{uuid}{ext}`; `originalName` is used for extension hint only.
 * @returns absolute path written
 */
export function saveChatAttachmentCopy(originalName: string, data: Buffer): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = typeof originalName === "string" ? originalName.trim() : "";
  if (!trimmed) {
    return { ok: false, error: "fileName empty" };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: "empty data" };
  }
  if (data.length > MAX_CHAT_AUDIO_ATTACH_BYTES) {
    return { ok: false, error: `attachment too large (max ${MAX_CHAT_AUDIO_ATTACH_BYTES} bytes)` };
  }
  let ext = path.extname(trimmed);
  if (ext.length > 16 || ext.includes("..") || !/^\.[\w.-]+$/i.test(ext)) {
    ext = ".bin";
  }
  const dir = getChatAttachmentsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${randomUUID()}${ext}`);
  try {
    fs.writeFileSync(dest, data);
    return { ok: true, path: dest };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
