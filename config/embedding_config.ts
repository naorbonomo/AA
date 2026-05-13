/** Fixed width for `vec0` virtual table — must match embedding API output length (Qwen3-Embedding-4B full dim). */

export const EMBEDDING_DEFAULT_VEC_DIMENSION = 2560;

/** Default `model` in `POST /v1/embeddings` when user-settings + env omit it. */
export const EMBEDDING_DEFAULT_MODEL_ID = "text-embedding-qwen3-embedding-4b";
