import Groq from "groq-sdk";
import type { ChatCompletionContentPart } from "groq-sdk/resources/chat/completions";

const apiKey = (import.meta as any).env.VITE_GROQ_API_KEY as string | undefined;

const groq = apiKey
  ? new Groq({
      apiKey,
      dangerouslyAllowBrowser: true,
    })
  : null;

export async function streamGroqChatCompletion(
  userMessage: string,
  onToken: (token: string) => void,
  liveFrameUrl: string | null = null,
  snapshotUrls: string[] = [],
  history: { role: "user" | "assistant"; text: string }[] = [],
) {
  const messages: any[] = [];

  // Include prior conversation history (text only)
  for (const msg of history) {
    messages.push({
      role: msg.role,
      content: msg.text,
    });
  }

  // Build the current user message with optional images
  const content: ChatCompletionContentPart[] = [];

  [...snapshotUrls].forEach((url, i) => {
    const label = snapshotUrls.length === 1
      ? "[ATTACHED SNAPSHOT: A screenshot the user captured. If the user's message is asking about this snapshot, what they captured, or what is in the screenshot, analyze it fully and answer in detail.]"
      : `[ATTACHED SNAPSHOT ${i + 1} of ${snapshotUrls.length}: If the user's message is asking about the snapshot(s), what they captured, or what is in the screenshot(s), analyze all of them fully and answer in detail.]`;
    content.push({ type: "text", text: label });
    content.push({
      type: "image_url",
      image_url: { url },
    });
  });

  if (liveFrameUrl) {
    content.push({ type: "text", text: "[LIVE PREVIEW: A real-time capture of the user's current screen. If the user's message is asking about the live preview, what is on their screen, or what you can see, analyze this image fully and describe it in detail.]" });
    content.push({
      type: "image_url",
      image_url: { url: liveFrameUrl },
    });
  }

  content.push({ type: "text", text: userMessage });
  messages.push({ role: "user", content });

  if (groq) {
    // Electron — call Groq SDK directly
    const stream = await groq.chat.completions.create({
      messages,
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      stream: true,
    });

    let full = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        full += delta;
        onToken(full);
      }
    }
    return full;
  }

  // Web — stream via serverless function
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const data = JSON.parse(line.slice(6));
          if (data.content) {
            full += data.content;
            onToken(full);
          }
        } catch {}
      }
    }
  }
  return full;
}

/**
 * Transcribe audio using Groq Whisper.
 */
export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  if (groq) {
    const file = new File([audioBlob], "recording.webm", { type: audioBlob.type });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: "whisper-large-v3",
      language: "en",
    });
    return transcription.text;
  }

  const formData = new FormData();
  formData.append("file", audioBlob, "recording.webm");
  const res = await fetch("/api/transcribe", { method: "POST", body: formData });
  if (!res.ok) throw new Error(`Transcribe request failed: ${res.status}`);
  const data = await res.json();
  return data.text;
}

/**
 * Generate speech from text using Groq TTS. Returns a playable audio Blob.
 */
export async function textToSpeech(text: string): Promise<Blob> {
  if (!text.trim()) throw new Error("Empty text for TTS");

  if (groq) {
    const response = await groq.audio.speech.create({
      model: "playai-tts",
      input: text,
      voice: "Fritz-PlayAI",
      response_format: "mp3",
    });
    return await response.blob();
  }

  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: "Fritz-PlayAI" }),
  });
  if (!res.ok) throw new Error(`TTS request failed: ${res.status}`);
  return await res.blob();
}