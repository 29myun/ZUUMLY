import Groq from "groq-sdk";
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "groq-sdk/resources/chat/completions";

type HistoryMessage = {
  role: "user" | "assistant";
  text: string;
};

const API_KEY = import.meta.env.VITE_GROQ_API_KEY as string | undefined;

const CHAT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const TRANSCRIBE_MODEL = "whisper-large-v3";
const TTS_MODEL = "playai-tts";
const TTS_VOICE = "Fritz-PlayAI";

const CHAT_API_PATH = "/api/chat";
const TRANSCRIBE_API_PATH = "/api/transcribe";
const TTS_API_PATH = "/api/tts";

const ATTACHED_SNAPSHOT_SINGLE_LABEL =
  "[ATTACHED SNAPSHOT: A screenshot the user captured. If the user's message is asking about this snapshot, what they captured, or what is in the screenshot, analyze it fully and answer in detail.]";

const LIVE_PREVIEW_LABEL =
  "[LIVE PREVIEW: A real-time capture of the user's current screen. If the user's message is asking about the live preview, what is on their screen, or what you can see, analyze this image fully and describe it in detail.]";

// Desktop can call Groq directly. Web deploys can fall back to /api Netlify functions.
const groq = API_KEY
  ? new Groq({
      apiKey: API_KEY,
      dangerouslyAllowBrowser: true,
    })
  : null;

/** Receive response tokens incrementally instead of waiting for a full response. */
export async function streamGroqChatCompletion(
  userMessage: string,
  onToken: (token: string) => void,
  liveFrameUrl: string | null = null,
  snapshotUrls: string[] = [],
  history: HistoryMessage[] = [],
): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    ...buildHistoryMessages(history),
    {
      role: "user",
      content: buildUserContent(userMessage, liveFrameUrl, snapshotUrls),
    },
  ];

  if (groq) {
    return streamFromGroq(messages, onToken);
  }

  return streamFromServerless(messages, onToken);
}

function buildHistoryMessages(history: HistoryMessage[]): ChatCompletionMessageParam[] {
  return history.map((msg) => ({
    role: msg.role,
    content: msg.text,
  }));
}

function buildUserContent(
  userMessage: string,
  liveFrameUrl: string | null,
  snapshotUrls: string[],
): ChatCompletionContentPart[] {
  const content: ChatCompletionContentPart[] = [];

  snapshotUrls.forEach((url, index) => {
    content.push({ type: "text", text: buildSnapshotLabel(index, snapshotUrls.length) });
    content.push({
      type: "image_url",
      image_url: { url },
    });
  });

  if (liveFrameUrl) {
    content.push({ type: "text", text: LIVE_PREVIEW_LABEL });
    content.push({
      type: "image_url",
      image_url: { url: liveFrameUrl },
    });
  }

  content.push({ type: "text", text: userMessage });
  return content;
}

function buildSnapshotLabel(index: number, total: number): string {
  if (total === 1) {
    return ATTACHED_SNAPSHOT_SINGLE_LABEL;
  }

  return (
    "[ATTACHED SNAPSHOT " +
    String(index + 1) +
    " of " +
    String(total) +
    ": If the user's message is asking about the snapshot(s), what they captured, or what is in the screenshot(s), analyze all of them fully and answer in detail.]"
  );
}

async function streamFromGroq(
  messages: ChatCompletionMessageParam[],
  onToken: (token: string) => void,
): Promise<string> {
  const stream = await groq!.chat.completions.create({
    messages,
    model: CHAT_MODEL,
    stream: true,
  });

  let fullText = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      fullText += delta;
      onToken(fullText);
    }
  }

  return fullText;
}

async function streamFromServerless(
  messages: ChatCompletionMessageParam[],
  onToken: (token: string) => void,
): Promise<string> {
  const response = await fetch(CHAT_API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      model: CHAT_MODEL,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error("Chat request failed: " + String(response.status));
  }

  if (!response.body) {
    throw new Error("Chat response body is empty.");
  }

  return readSseStream(response.body.getReader(), onToken);
}

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onToken: (token: string) => void,
): Promise<string> {
  // Parse Server-Sent Events emitted by netlify/functions/chat.mts.
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const chunk = extractSseContent(line);
      if (chunk) {
        fullText += chunk;
        onToken(fullText);
      }
    }
  }

  return fullText;
}

function extractSseContent(line: string): string | null {
  if (!line.startsWith("data: ") || line === "data: [DONE]") {
    return null;
  }

  try {
    const payload = JSON.parse(line.slice(6));
    return typeof payload.content === "string" ? payload.content : null;
  } catch {
    return null;
  }
}

/** Transcribe audio using Groq Whisper. (Speech -> Text)*/
export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  if (groq) {
    const file = new File([audioBlob], "recording.webm", { type: audioBlob.type });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: TRANSCRIBE_MODEL,
      language: "en",
    });
    return transcription.text;
  }

  const formData = new FormData();
  formData.append("file", audioBlob, "recording.webm");

  const response = await fetch(TRANSCRIBE_API_PATH, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Transcribe request failed: " + String(response.status));
  }

  const data = await response.json();
  return data.text;
}

/** Generate speech from text using Groq TTS. Returns a playable audio blob. (Text -> Speech)*/
export async function textToSpeech(text: string): Promise<Blob> {
  if (!text.trim()) {
    throw new Error("Empty text for TTS");
  }

  if (groq) {
    const response = await groq.audio.speech.create({
      model: TTS_MODEL,
      input: text,
      voice: TTS_VOICE,
      response_format: "mp3",
    });
    return await response.blob();
  }

  const response = await fetch(TTS_API_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: TTS_VOICE }),
  });

  if (!response.ok) {
    throw new Error("TTS request failed: " + String(response.status));
  }

  return await response.blob();
}