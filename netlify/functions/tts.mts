import Groq from "groq-sdk";

// Handles /api/tts (text -> speech audio).
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response("GROQ_API_KEY not configured", { status: 500 });
  }

  const { text, voice = "Fritz-PlayAI" } = await req.json();
  if (!text?.trim()) {
    return new Response("Empty text", { status: 400 });
  }

  const groq = new Groq({ apiKey });

  const response = await groq.audio.speech.create({
    model: "playai-tts",
    input: text,
    voice,
    response_format: "mp3",
  });

  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();

  return new Response(arrayBuffer, {
    headers: { "Content-Type": "audio/mpeg" },
  });
};
