import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  getDocs,
  serverTimestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import Groq from "groq-sdk";

const isElectron =
  typeof window !== "undefined" && !!(window as any).screenAssist;

const groq = isElectron
  ? new Groq({
      apiKey: import.meta.env.VITE_GROQ_API_KEY,
      dangerouslyAllowBrowser: true,
    })
  : null;

export type ChatMessage = { role: "user" | "assistant"; text: string };

export type Chat = {
  id: string;
  title: string;
  createdAt: number;
  messages: ChatMessage[];
};

const chatsRef = collection(db, "chats");

/** Subscribe to all chats for a user, ordered newest-first. */
export function subscribeToChats(
  uid: string,
  callback: (chats: Chat[]) => void,
): Unsubscribe {
  const q = query(chatsRef, where("uid", "==", uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => {
    const chats: Chat[] = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        title: data.title ?? "New Chat",
        createdAt: data.createdAt?.toMillis?.() ?? Date.now(),
        messages: data.messages ?? [],
      };
    });
    callback(chats);
  });
}

/** Create a new empty chat and return its id. */
export async function createChat(uid: string): Promise<string> {
  const docRef = await addDoc(chatsRef, {
    uid,
    title: "New Chat",
    messages: [],
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

/** Generate a short title by asking Groq to summarize the first exchange. */
async function generateTitle(userMsg: string, assistantMsg: string): Promise<string> {
  const titleMessages = [
    {
      role: "system" as const,
      content: "Summarize the following conversation into a short title (max 6 words). Reply with only the title, no quotes or punctuation at the end.",
    },
    {
      role: "user" as const,
      content: `User: ${userMsg}\nAssistant: ${assistantMsg}`,
    },
  ];

  try {
    if (groq) {
      const response = await groq.chat.completions.create({
        messages: titleMessages,
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        stream: false,
      });
      const title = response.choices[0]?.message?.content?.trim();
      return title || "New Chat";
    }

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: titleMessages,
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Title request failed: ${res.status}`);
    const data = await res.json();
    const title = data.choices[0]?.message?.content?.trim();
    return title || "New Chat";
  } catch {
    return userMsg.slice(0, 40) + (userMsg.length > 40 ? "…" : "");
  }
}

/** Save the message array for a chat. Generates a title via Groq on the first exchange. */
export async function saveMessages(
  chatId: string,
  messages: ChatMessage[],
  currentTitle?: string,
): Promise<void> {
  const firstUser = messages.find((m) => m.role === "user");
  const firstAssistant = messages.find((m) => m.role === "assistant" && m.text.trim());

  const needsTitle = !currentTitle || currentTitle === "New Chat";

  const update: Record<string, unknown> = { messages };

  if (needsTitle && firstUser && firstAssistant) {
    update.title = await generateTitle(firstUser.text, firstAssistant.text);
  }

  await updateDoc(doc(db, "chats", chatId), update);
}

/** Delete a chat. */
export async function deleteChat(chatId: string): Promise<void> {
  await deleteDoc(doc(db, "chats", chatId));
}

/** Delete all chats for a user. */
export async function deleteAllChats(uid: string): Promise<void> {
  const q = query(chatsRef, where("uid", "==", uid));
  const snap = await getDocs(q);
  const deletes = snap.docs.map((d) => deleteDoc(d.ref));
  await Promise.all(deletes);
}
