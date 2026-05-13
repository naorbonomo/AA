/**
 * Smoke: sqlite-vec round-trip (temp userData, tiny dim via env).
 * Run: AA_EMBEDDING_VEC_DIM=8 tsx tests/embedding-vector-store.smoke.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  closeEmbeddingVectorStore,
  initializeEmbeddingVectorStore,
  listEmbeddingBodies,
  loadEmbeddingRow,
  saveEmbeddingText,
} from "../services/embedding-vector-store.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-embed-"));
process.env.AA_EMBEDDING_VEC_DIM = "8";

initializeEmbeddingVectorStore({ userDataDir: tmp });

const v = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const id = saveEmbeddingText("hello sqlite-vec", v);
const row = loadEmbeddingRow(id);
if (!row) throw new Error("loadEmbeddingRow returned null");
if (row.body !== "hello sqlite-vec") throw new Error("body mismatch");
for (let i = 0; i < v.length; i += 1) {
  if (Math.abs(row.embedding[i] - v[i]) > 1e-6) throw new Error(`vec[${i}] mismatch`);
}
const listed = listEmbeddingBodies(10);
if (listed.length !== 1 || listed[0].rowid !== id) throw new Error("list mismatch");

closeEmbeddingVectorStore();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("embedding-vector-store smoke ok");
