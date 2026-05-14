/** Index chat rows + dev payloads into sqlite-vec; text uses lossless UTF-16 partitions only when over chunk limit. */

import fs from "node:fs";
import path from "node:path";

import type { ChatHistoryRow } from "./chat-history-store.js";
import {
  absImageFileToDataUrl,
  createEmbeddingFromParts,
  createEmbeddings,
  losslessUtf16Chunks,
  resolvedLosslessChunkCodeUnits,
  type EmbeddingMultimodalPart,
} from "./embeddings.js";
import {
  ensureEmbeddingVectorStoreOpened,
  getEmbeddingVectorDimension,
  saveEmbeddingText,
  searchEmbeddingSimilar,
  type EmbeddingSearchHit,
} from "./embedding-vector-store.js";

export type EmbeddingEnvelopeV1 = {
  v: 1;
  kind: "text" | "image" | "multimodal";
  conversationId: string;
  sessionLabel?: string;
  role?: string;
  source?: string;
  atMs?: number | null;
  chunkIndex?: number;
  chunkTotal?: number;
  /** Full slice / message text (never cropped for storage). */
  text?: string;
  imagePaths?: string[];
};

export function envelopeJson(e: EmbeddingEnvelopeV1): string {
  return JSON.stringify(e);
}

export function parseEnvelopeJson(body: string): EmbeddingEnvelopeV1 | null {
  try {
    const o = JSON.parse(body) as EmbeddingEnvelopeV1;
    if (o && o.v === 1 && typeof o.conversationId === "string") return o;
  } catch {
    /* ignore */
  }
  return null;
}

function assertVecLength(vec: number[]): void {
  const d = getEmbeddingVectorDimension();
  if (vec.length !== d) {
    throw new Error(`Embedding API returned dimension ${vec.length}, expected ${d} (Settings → Embeddings)`);
  }
}

function combinedRowText(row: ChatHistoryRow): string {
  let t = row.content;
  if (row.reasoning) {
    t += `\n\n--- reasoning ---\n\n${row.reasoning}`;
  }
  if (row.agentTrace) {
    t += `\n\n--- agent trace ---\n\n${row.agentTrace}`;
  }
  return t;
}

export type EmbeddingIndexProgressEvent = {
  step: number;
  total: number;
  label?: string;
};

export async function indexChatHistoryRows(
  rows: ChatHistoryRow[],
  opts: {
    conversationId: string;
    sessionLabel?: string;
    onProgress?: (e: EmbeddingIndexProgressEvent) => void;
  },
): Promise<{ ok: true; indexed: number; errors: string[] } | { ok: false; error: string }> {
  const opened = ensureEmbeddingVectorStoreOpened();
  if (!opened.ok) {
    return { ok: false, error: opened.error };
  }
  const chunkUnits = resolvedLosslessChunkCodeUnits();
  let indexed = 0;
  const errors: string[] = [];

  for (let ri = 0; ri < rows.length; ri += 1) {
    const row = rows[ri];
    const rowMeta = (): Pick<
      EmbeddingEnvelopeV1,
      "v" | "conversationId" | "sessionLabel" | "role" | "source" | "atMs"
    > => ({
      v: 1,
      conversationId: opts.conversationId,
      sessionLabel: opts.sessionLabel,
      role: row.role,
      source: row.source,
      atMs: row.atMs ?? null,
    });

    const fullText = combinedRowText(row);
    const imagePaths: string[] = [];
    if (Array.isArray(row.displayAttachments)) {
      for (const a of row.displayAttachments) {
        if (a.kind === "image" && typeof a.savedPath === "string" && a.savedPath && fs.existsSync(a.savedPath)) {
          imagePaths.push(a.savedPath);
        }
      }
    }

    try {
      if (imagePaths.length > 0 && fullText.length > 0) {
        const parts: EmbeddingMultimodalPart[] = [{ type: "text", text: fullText }];
        for (const ip of imagePaths) {
          parts.push({ type: "image_url", image_url: { url: absImageFileToDataUrl(ip) } });
        }
        const res = await createEmbeddingFromParts({ parts });
        const vec = res.embeddings[0];
        assertVecLength(vec);
        const env: EmbeddingEnvelopeV1 = {
          ...rowMeta(),
          kind: "multimodal",
          text: fullText,
          imagePaths: [...imagePaths],
        };
        saveEmbeddingText(envelopeJson(env), vec);
        indexed += 1;
      } else if (imagePaths.length > 0) {
        for (const ip of imagePaths) {
          const label = `(image) ${path.basename(ip)}`;
          const parts: EmbeddingMultimodalPart[] = [
            { type: "text", text: label },
            { type: "image_url", image_url: { url: absImageFileToDataUrl(ip) } },
          ];
          const res = await createEmbeddingFromParts({ parts });
          const vec = res.embeddings[0];
          assertVecLength(vec);
          const env: EmbeddingEnvelopeV1 = {
            ...rowMeta(),
            kind: "image",
            text: label,
            imagePaths: [ip],
          };
          saveEmbeddingText(envelopeJson(env), vec);
          indexed += 1;
        }
      } else if (fullText.length > 0) {
        const chunks = losslessUtf16Chunks(fullText, chunkUnits);
        const total = chunks.length;
        const emb = await createEmbeddings({ input: chunks });
        if (emb.embeddings.length !== chunks.length) {
          throw new Error(`embeddings batch count ${emb.embeddings.length} !== chunks ${chunks.length}`);
        }
        for (let ci = 0; ci < chunks.length; ci += 1) {
          const vec = emb.embeddings[ci];
          assertVecLength(vec);
          const env: EmbeddingEnvelopeV1 = {
            ...rowMeta(),
            kind: "text",
            text: chunks[ci],
            chunkIndex: ci,
            chunkTotal: total,
          };
          saveEmbeddingText(envelopeJson(env), vec);
          indexed += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`message ${ri} (${row.role}): ${msg}`);
    }
    opts.onProgress?.({
      step: ri + 1,
      total: rows.length,
      label: row.role,
    });
  }

  return { ok: true, indexed, errors };
}

export async function indexDevEmbeddingPayload(opts: {
  conversationId: string;
  text: string;
  imagePath?: string;
  onProgress?: (e: EmbeddingIndexProgressEvent) => void;
}): Promise<{ ok: true; indexed: number } | { ok: false; error: string }> {
  const opened = ensureEmbeddingVectorStoreOpened();
  if (!opened.ok) {
    return { ok: false, error: opened.error };
  }
  const chunkUnits = resolvedLosslessChunkCodeUnits();
  const cid = opts.conversationId.trim() || "dev";
  try {
    let indexed = 0;
    const img =
      typeof opts.imagePath === "string" && opts.imagePath && fs.existsSync(opts.imagePath)
        ? opts.imagePath
        : undefined;

    if (img && opts.text.length > 0) {
      opts.onProgress?.({ step: 1, total: 2, label: "Embedding API…" });
      const parts: EmbeddingMultimodalPart[] = [
        { type: "text", text: opts.text },
        { type: "image_url", image_url: { url: absImageFileToDataUrl(img) } },
      ];
      const res = await createEmbeddingFromParts({ parts });
      assertVecLength(res.embeddings[0]);
      const env: EmbeddingEnvelopeV1 = {
        v: 1,
        kind: "multimodal",
        conversationId: cid,
        text: opts.text,
        imagePaths: [img],
      };
      saveEmbeddingText(envelopeJson(env), res.embeddings[0]);
      indexed = 1;
      opts.onProgress?.({ step: 2, total: 2, label: "Stored" });
    } else if (img) {
      opts.onProgress?.({ step: 1, total: 2, label: "Embedding API…" });
      const label = `(image) ${path.basename(img)}`;
      const parts: EmbeddingMultimodalPart[] = [
        { type: "text", text: label },
        { type: "image_url", image_url: { url: absImageFileToDataUrl(img) } },
      ];
      const res = await createEmbeddingFromParts({ parts });
      assertVecLength(res.embeddings[0]);
      const env: EmbeddingEnvelopeV1 = {
        v: 1,
        kind: "image",
        conversationId: cid,
        text: label,
        imagePaths: [img],
      };
      saveEmbeddingText(envelopeJson(env), res.embeddings[0]);
      indexed = 1;
      opts.onProgress?.({ step: 2, total: 2, label: "Stored" });
    } else if (opts.text.length > 0) {
      const chunks = losslessUtf16Chunks(opts.text, chunkUnits);
      const totalSteps = chunks.length + 1;
      opts.onProgress?.({ step: 1, total: totalSteps, label: "Embedding API…" });
      const emb = await createEmbeddings({ input: chunks });
      if (emb.embeddings.length !== chunks.length) {
        throw new Error(`embeddings batch count ${emb.embeddings.length} !== chunks ${chunks.length}`);
      }
      const total = chunks.length;
      for (let ci = 0; ci < chunks.length; ci += 1) {
        assertVecLength(emb.embeddings[ci]);
        const env: EmbeddingEnvelopeV1 = {
          v: 1,
          kind: "text",
          conversationId: cid,
          text: chunks[ci],
          chunkIndex: ci,
          chunkTotal: total,
        };
        saveEmbeddingText(envelopeJson(env), emb.embeddings[ci]);
        opts.onProgress?.({
          step: ci + 2,
          total: totalSteps,
          label: `Chunk ${ci + 1}/${chunks.length}`,
        });
      }
      indexed = chunks.length;
    } else {
      return { ok: false, error: "Nothing to index (empty text and no image)." };
    }
    return { ok: true, indexed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function searchEmbeddingCorpus(opts: {
  queryText: string;
  imagePath?: string;
  topK: number;
}): Promise<{ ok: true; hits: EmbeddingSearchHit[] } | { ok: false; error: string }> {
  const opened = ensureEmbeddingVectorStoreOpened();
  if (!opened.ok) {
    return { ok: false, error: opened.error };
  }
  try {
    const img =
      typeof opts.imagePath === "string" && opts.imagePath && fs.existsSync(opts.imagePath)
        ? opts.imagePath
        : undefined;

    let vec: number[];
    if (img) {
      const parts: EmbeddingMultimodalPart[] = [];
      if (opts.queryText.length > 0) {
        parts.push({ type: "text", text: opts.queryText });
      }
      parts.push({ type: "image_url", image_url: { url: absImageFileToDataUrl(img) } });
      const r = await createEmbeddingFromParts({ parts });
      vec = r.embeddings[0];
    } else {
      if (opts.queryText.length === 0) {
        return { ok: false, error: "Empty query (need text or image)." };
      }
      const r = await createEmbeddings({ input: opts.queryText });
      vec = r.embeddings[0];
    }
    assertVecLength(vec);
    const hits = searchEmbeddingSimilar(vec, opts.topK);
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
