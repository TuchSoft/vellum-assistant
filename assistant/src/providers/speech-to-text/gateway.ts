/**
 * Gateway batch transcription.
 *
 * The LLM gateway is the single transport for every inference call, speech to
 * text included: this adapter resolves the same connection and auth the chat
 * and embeddings use, so one credential serves every modality and there is no
 * STT-specific key or credential slot.
 */

import { resolveGatewayEndpoint } from "../../config/llm-catalog.js";
import {
  SttError,
  type SttErrorCategory,
  type SttTranscribeResult,
} from "../../stt/types.js";
import { extensionFromMime } from "./openai-whisper.js";

/** Catalog alias the gateway runs when none is configured. */
export const GATEWAY_STT_DEFAULT_MODEL = "stt";

const DEFAULT_TIMEOUT_MS = 60_000;

/** `{baseUrl}/audio/transcriptions`, tolerating a trailing slash. */
function transcriptionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/audio/transcriptions`;
}

/**
 * Build the multipart body the OpenAI-compatible transcription endpoint
 * expects: the audio as `file` plus the gateway alias as `model`.
 */
export function buildGatewaySttFormData(
  model: string,
  audio: Buffer,
  mimeType: string,
): FormData {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    `audio.${extensionFromMime(mimeType)}`,
  );
  formData.append("model", model);
  return formData;
}

/**
 * Map an HTTP status onto a normalized category. A 400 is only "invalid audio"
 * when the body implicates the payload; otherwise it is a provider error, so
 * callers do not report a bad upload for what is a model or request problem.
 */
function categoryForStatus(status: number, body: string): SttErrorCategory {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate-limit";
  }
  if (status === 413 || status === 415 || status === 422) {
    return "invalid-audio";
  }
  if (status === 400 && /audio|format|file/i.test(body)) {
    return "invalid-audio";
  }
  return "provider-error";
}

/**
 * Transcribe one audio buffer through the gateway.
 *
 * The endpoint is resolved per call so a rotated credential or a re-pointed
 * connection applies without reconstructing the transcriber.
 */
export async function gatewayTranscribeBatch(
  model: string | undefined,
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<SttTranscribeResult> {
  const endpoint = await resolveGatewayEndpoint();
  if (!endpoint) {
    throw new SttError(
      "auth",
      "No LLM gateway connection resolves for speech-to-text. Configure the gateway connection to enable transcription.",
      { userFacing: true },
    );
  }

  const response = await fetch(transcriptionsUrl(endpoint.baseUrl), {
    method: "POST",
    headers: endpoint.headers,
    body: buildGatewaySttFormData(
      model ?? GATEWAY_STT_DEFAULT_MODEL,
      audio,
      mimeType,
    ),
    signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SttError(
      categoryForStatus(response.status, body),
      `Gateway transcription error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const result = (await response.json()) as { text?: string };
  return { text: result.text?.trim() ?? "" };
}
