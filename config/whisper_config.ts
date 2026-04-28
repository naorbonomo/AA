/** Defaults for local Whisper (Transformers.js / ONNX). */

export const WHISPER_MODEL_SIZES = ["tiny", "small", "base", "medium"] as const;
export type WhisperModelSize = (typeof WHISPER_MODEL_SIZES)[number];

export const WHISPER_DEFAULT_MODEL_SIZE: WhisperModelSize = "base";
export const WHISPER_DEFAULT_QUANTIZED = true;
export const WHISPER_DEFAULT_MULTILINGUAL = true;
