import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { SttError } from "../../stt/types.js";
import { buildGatewaySttFormData, gatewayTranscribeBatch } from "./gateway.js";

const ENV_URL = "VELLUM_LLM_GATEWAY_URL";
const ENV_KEY = "VELLUM_LLM_GATEWAY_API_KEY";
const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env[ENV_URL],
  key: process.env[ENV_KEY],
};

function restoreEnv(): void {
  if (originalEnv.url === undefined) {
    delete process.env[ENV_URL];
  } else {
    process.env[ENV_URL] = originalEnv.url;
  }
  if (originalEnv.key === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnv.key;
  }
}

beforeEach(() => {
  process.env[ENV_URL] = "http://llm-gateway:4000/v1/";
  process.env[ENV_KEY] = "gw-test-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("buildGatewaySttFormData", () => {
  test("sends the audio as a file and the alias as the model", () => {
    const form = buildGatewaySttFormData(
      "stt",
      Buffer.from("fake-audio"),
      "audio/ogg",
    );

    expect(form.get("model")).toBe("stt");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("audio.ogg");
    expect((file as File).type).toBe("audio/ogg");
  });

  test("derives the filename extension from the MIME type", () => {
    const form = buildGatewaySttFormData(
      "stt",
      Buffer.from("fake-audio"),
      "audio/wav",
    );
    expect((form.get("file") as File).name).toBe("audio.wav");
  });
});

describe("gatewayTranscribeBatch", () => {
  test("posts multipart audio to the gateway with the connection auth", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return new Response(JSON.stringify({ text: "  Hello, world!  " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ) as unknown as typeof fetch;

    const result = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("fake-audio"),
      "audio/ogg",
    );

    expect(result).toEqual({ text: "Hello, world!" });
    expect(capturedUrl).toBe("http://llm-gateway:4000/v1/audio/transcriptions");
    expect(capturedInit?.method).toBe("POST");
    expect(
      (capturedInit?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer gw-test-key");
    const form = capturedInit?.body as FormData;
    expect(form.get("model")).toBe("stt");
    expect(form.get("file")).toBeInstanceOf(File);
  });

  test("defaults to the stt alias when no model is configured", async () => {
    let capturedBody: FormData | undefined;
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as FormData;
        return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    await gatewayTranscribeBatch(undefined, Buffer.from("a"), "audio/wav");

    expect(capturedBody?.get("model")).toBe("stt");
  });

  test("returns empty text for a silent transcription", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("a"),
      "audio/wav",
    );

    expect(result).toEqual({ text: "" });
  });

  test("maps a 401 to an auth SttError", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "invalid key" }), { status: 401 }),
    ) as unknown as typeof fetch;

    const err = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("a"),
      "audio/wav",
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).category).toBe("auth");
    expect((err as SttError).message).toContain("401");
  });

  test("maps a 429 to a rate-limit SttError", async () => {
    globalThis.fetch = mock(
      async () => new Response("slow down", { status: 429 }),
    ) as unknown as typeof fetch;

    const err = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("a"),
      "audio/wav",
    ).catch((error: unknown) => error);

    expect((err as SttError).category).toBe("rate-limit");
  });

  test("maps a 400 naming the audio to invalid-audio", async () => {
    globalThis.fetch = mock(
      async () => new Response("unsupported audio format", { status: 400 }),
    ) as unknown as typeof fetch;

    const err = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("a"),
      "audio/wav",
    ).catch((error: unknown) => error);

    expect((err as SttError).category).toBe("invalid-audio");
  });

  test("maps a model-level 400 to a provider error", async () => {
    globalThis.fetch = mock(
      async () => new Response("model 'stt' not found", { status: 400 }),
    ) as unknown as typeof fetch;

    const err = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("a"),
      "audio/wav",
    ).catch((error: unknown) => error);

    expect((err as SttError).category).toBe("provider-error");
  });

  test("fails with user-facing copy when no gateway connection resolves", async () => {
    delete process.env[ENV_URL];
    delete process.env[ENV_KEY];

    const err = await gatewayTranscribeBatch(
      "stt",
      Buffer.from("a"),
      "audio/wav",
    ).catch((error: unknown) => error);

    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).category).toBe("auth");
    expect((err as SttError).userFacing).toBe(true);
    expect((err as SttError).message).toContain("gateway connection");
  });
});
