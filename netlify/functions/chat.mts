import Groq from "groq-sdk";

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response("GROQ_API_KEY not configured", { status: 500 });
  }

  const { messages, model, stream } = await req.json();
  if (!messages || !Array.isArray(messages)) {
    return new Response("Invalid request body", { status: 400 });
  }

  const groq = new Groq({ apiKey });

  // Non-streaming request (used for title generation)
  if (!stream) {
    const response = await groq.chat.completions.create({
      messages,
      model,
      stream: false,
    });
    return Response.json(response);
  }

  // Streaming request — return as SSE
  const completion = await groq.chat.completions.create({
    messages,
    model,
    stream: true,
  });

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ content: delta })}\n\n`),
            );
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
};
