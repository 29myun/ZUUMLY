import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamGroqChatCompletion, transcribeAudio } from "./model";
import LandingPage from "./LandingPage";
import AuthPage from "./AuthPage";
import SettingsPage from "./SettingsPage";
import { login, signup, logout, onAuthChange, type AppUser } from "./auth";
import {
  subscribeToChats,
  createChat,
  saveMessages,
  deleteChat,
  type Chat,
  type ChatMessage,
} from "./chatService";

type Selection = { x: number; y: number; width: number; height: number };

export default function App() {
  const [page, setPage] = useState<"landing" | "login" | "signup" | "app" | "settings">(
    "landing",
  );
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [dark, setDark] = useState(() => {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("theme") === "dark";
    }
    return false;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  // Listen for Firebase auth state changes
  useEffect(() => {
    const unsubscribe = onAuthChange((fbUser) => {
      setUser(fbUser);
      if (fbUser) {
        setPage("app");
      }
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  const [prompt, setPrompt] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [regionSelectActive, setRegionSelectActive] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [previewScale, setPreviewScale] = useState("100");
  const [snapshotScale, setSnapshotScale] = useState("100");
  const [snapshots, setSnapshots] = useState<{ path: string | null; dataUrl: string }[]>([]);
  const [attachedSnapshots, setAttachedSnapshots] = useState<string[]>([]);
  const [lastLiveFrame, setLastLiveFrame] = useState<string | null>(null);
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [aiLoading, setAiLoading] = useState(false);

  // Voice call state
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [callTranscript, setCallTranscript] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const callAudioRef = useRef<{ stop: () => void } | null>(null);
  const [callLinkedToChat, setCallLinkedToChat] = useState(false);

  // Multi-chat state
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatListOpen, setChatListOpen] = useState(true);

  // Subscribe to user's chats
  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribeToChats(user.uid, (userChats) => {
      setChats(userChats);
    });
    return unsubscribe;
  }, [user]);

  // When switching chats, load messages from the chat object
  const skipNextChatLoad = useRef(false);
  useEffect(() => {
    if (skipNextChatLoad.current) {
      skipNextChatLoad.current = false;
      return;
    }
    if (!activeChatId) {
      setChatLog([]);
      return;
    }
    const chat = chats.find((c) => c.id === activeChatId);
    if (chat) {
      setChatLog(chat.messages);
    }
  }, [activeChatId]);

  const handleNewChat = async () => {
    if (!user) return;
    const id = await createChat(user.uid);
    setActiveChatId(id);
    setChatLog([]);
  };

  const handleSelectChat = (chatId: string) => {
    setActiveChatId(chatId);
    const chat = chats.find((c) => c.id === chatId);
    if (chat) setChatLog(chat.messages);
  };

  const handleDeleteChat = async (chatId: string) => {
    await deleteChat(chatId);
    if (activeChatId === chatId) {
      setActiveChatId(null);
      setChatLog([]);
    }
  };

  const [leftWidth, setLeftWidth] = useState(() => {
    const saved = localStorage.getItem("leftWidth");
    return saved ? Number(saved) : 420;
  });
  const isDragging = useRef(false);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const regionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog, aiLoading]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const useSystemPicker = async () => {
    setCaptureError(null);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }

    const mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });

    setStream(mediaStream);
    streamRef.current = mediaStream;
    setSelection(null);

    if (videoRef.current) {
      videoRef.current.srcObject = mediaStream;
      await videoRef.current.play();
    }

    mediaStream.getVideoTracks()[0].addEventListener("ended", () => {
      setStream(null);
      streamRef.current = null;
      setSelection(null);
      setRegionSelectActive(false);
    });
  };

  useEffect(() => {
    window.screenAssist?.onScreenSelection((rect) => {
      setSelection(rect);
    });
  }, []);

  const stopCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    setStream(null);
    setSelection(null);

    window.screenAssist?.restoreWindow();
  };

  const captureFullFrame = (): string | null => {
    const video = videoRef.current;
    if (!video || !stream || video.videoWidth === 0) return null;
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  };

  const takeSnapshot = () => {
    setCaptureError(null);
    if (!stream || !videoRef.current) {
      setCaptureError("Start capture before taking a snapshot.");
      return;
    }

    setLastLiveFrame(captureFullFrame());

    const video = videoRef.current;
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      setCaptureError("Video is not ready yet.");
      return;
    }

    if (selection && previewRef.current) {
      if (selection.width < 6 || selection.height < 6) {
        setCaptureError("Selection is too small.");
        return;
      }

      const vr = getVideoRect();
      if (!vr || vr.width === 0 || vr.height === 0) {
        setCaptureError("Preview not ready.");
        return;
      }

      const scaleX = video.videoWidth / vr.width;
      const scaleY = video.videoHeight / vr.height;
      const sx = Math.round(selection.x * scaleX);
      const sy = Math.round(selection.y * scaleY);
      const sw = Math.round(selection.width * scaleX);
      const sh = Math.round(selection.height * scaleY);

      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setCaptureError("Canvas is unavailable.");
        return;
      }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      const dataUrl = canvas.toDataURL("image/png");
      const newSnap = { path: null as string | null, dataUrl };
      setSnapshots((prev) => [...prev, newSnap]);
      window.screenAssist?.saveSnapshot(dataUrl).then((p) => {
        newSnap.path = p;
        setSnapshots((prev) => [...prev]);
      });
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setCaptureError("Canvas is unavailable.");
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/png");
    const newSnap = { path: null as string | null, dataUrl };
    setSnapshots((prev) => [...prev, newSnap]);
    window.screenAssist?.saveSnapshot(dataUrl).then((p) => {
      newSnap.path = p;
      setSnapshots((prev) => [...prev]);
    });
  };

  const getVideoRect = () => {
    const video = videoRef.current;
    const preview = previewRef.current;
    if (
      !video ||
      !preview ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return null;
    }
    const previewRect = preview.getBoundingClientRect();
    const videoAspect = video.videoWidth / video.videoHeight;
    const previewAspect = previewRect.width / previewRect.height;

    let renderW: number, renderH: number, offsetX: number, offsetY: number;
    if (videoAspect > previewAspect) {
      renderW = previewRect.width;
      renderH = previewRect.width / videoAspect;
      offsetX = 0;
      offsetY = (previewRect.height - renderH) / 2;
    } else {
      renderH = previewRect.height;
      renderW = previewRect.height * videoAspect;
      offsetX = (previewRect.width - renderW) / 2;
      offsetY = 0;
    }
    return { offsetX, offsetY, width: renderW, height: renderH };
  };

  const getPointerPoint = (
    event: React.PointerEvent<HTMLDivElement>,
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const vr = getVideoRect();
    if (!vr) {
      const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
      const y = Math.min(Math.max(0, event.clientY - rect.top), rect.height);
      return { x, y };
    }
    const x = Math.min(
      Math.max(0, event.clientX - rect.left - vr.offsetX),
      vr.width,
    );
    const y = Math.min(
      Math.max(0, event.clientY - rect.top - vr.offsetY),
      vr.height,
    );
    return { x, y };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!regionSelectActive || !stream) {
      return;
    }
    const point = getPointerPoint(event);
    setDragStart(point);
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
    setIsSelecting(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isSelecting || !dragStart) {
      return;
    }
    const point = getPointerPoint(event);
    const x = Math.min(dragStart.x, point.x);
    const y = Math.min(dragStart.y, point.y);
    const width = Math.abs(point.x - dragStart.x);
    const height = Math.abs(point.y - dragStart.y);
    setSelection({ x, y, width, height });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isSelecting) {
      return;
    }
    setIsSelecting(false);
    setRegionSelectActive(false);
    setDragStart(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const clearSelection = () => {
    setSelection(null);
    setRegionSelectActive(false);
  };

  const captureCurrentFrame = (): string | null => {
    const video = videoRef.current;
    if (!video || !stream || video.videoWidth === 0) return null;

    if (hasRegionPreview && selection) {
      const vr = getVideoRect();
      const preview = previewRef.current;
      if (vr && preview) {
        const contentW = vr.width;
        const contentH = vr.height;
        const scaleX = video.videoWidth / contentW;
        const scaleY = video.videoHeight / contentH;
        const sx = Math.round(selection.x * scaleX);
        const sy = Math.round(selection.y * scaleY);
        const sw = Math.round(selection.width * scaleX);
        const sh = Math.round(selection.height * scaleY);
        const c = document.createElement("canvas");
        c.width = sw;
        c.height = sh;
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
          return c.toDataURL("image/png");
        }
      }
    }

    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  };

  // ── Voice call handlers ──────────────────────────────────

  // Keep a persistent silent AudioContext so Windows treats us as "media"
  // instead of "communications" — prevents system volume ducking.
  const silentCtxRef = useRef<AudioContext | null>(null);

  const startCall = async () => {
    try {
      // Establish a "media" audio session BEFORE requesting the mic.
      // This prevents Windows from switching to "communications" mode
      // and resetting the system volume.
      if (!silentCtxRef.current) {
        const actx = new AudioContext();
        const osc = actx.createOscillator();
        const gain = actx.createGain();
        gain.gain.value = 0; // completely silent
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.start();
        silentCtxRef.current = actx;
      }

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      micStreamRef.current = micStream;
      setCallActive(true);
      setCallStatus("idle");
      setCallTranscript("");
    } catch {
      setCaptureError("Microphone access denied.");
    }
  };

  const endCall = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (callAudioRef.current) {
      try { callAudioRef.current.stop(); } catch {}
      callAudioRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (silentCtxRef.current) {
      silentCtxRef.current.close().catch(() => {});
      silentCtxRef.current = null;
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setCallActive(false);
    setCallStatus("idle");
    setCallTranscript("");
  };

  const startListening = () => {
    const micStream = micStreamRef.current;
    if (!micStream) return;

    audioChunksRef.current = [];
    const recorder = new MediaRecorder(micStream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      audioChunksRef.current = [];
      if (audioBlob.size < 100) return; // too short, ignore

      setCallStatus("thinking");
      try {
        // 1. Transcribe
        const transcript = await transcribeAudio(audioBlob);
        if (!transcript.trim()) {
          setCallStatus("idle");
          return;
        }
        setCallTranscript(transcript);

        // Only write to chat log if linked
        if (callLinkedToChat) {
          setChatLog((prev) => [...prev, { role: "user", text: transcript }]);
        }

        // Auto-create chat if linked
        let chatId: string | null = null;
        if (callLinkedToChat) {
          chatId = activeChatId;
          if (!chatId && user) {
            try {
              chatId = await createChat(user.uid);
              skipNextChatLoad.current = true;
              setActiveChatId(chatId);
            } catch { chatId = null; }
          }
        }

        // 2. Get LLM response
        let assistantIdx = -1;
        if (callLinkedToChat) {
          assistantIdx = chatLog.length + 1;
          setChatLog((prev) => [...prev, { role: "assistant", text: "" }]);
        }

        const frame = captureCurrentFrame() || lastLiveFrame;
        const fullPrompt = frame
          ? transcript
          : `[No live screen preview is currently running.]\n\n${transcript}`;

        const responseText = await streamGroqChatCompletion(
          fullPrompt,
          (soFar) => {
            if (callLinkedToChat && assistantIdx >= 0) {
              setChatLog((prev) => {
                const updated = [...prev];
                updated[assistantIdx] = { role: "assistant", text: soFar };
                return updated;
              });
            }
          },
          frame,
          attachedSnapshots,
          chatLog,
        );

        // Save to Firestore
        if (callLinkedToChat && chatId) {
          const currentChat = chats.find((c) => c.id === chatId);
          setChatLog((latest) => {
            saveMessages(chatId, latest, currentChat?.title).catch(() => {});
            return latest;
          });
        }

        // 3. Text-to-speech via browser SpeechSynthesis
        setCallStatus("speaking");
        const utterance = new SpeechSynthesisUtterance(responseText);
        utterance.rate = 1;
        utterance.pitch = 1;

        callAudioRef.current = {
          stop: () => speechSynthesis.cancel(),
        };
        await new Promise<void>((resolve) => {
          utterance.onend = () => {
            callAudioRef.current = null;
            if (callActive) setCallStatus("idle");
            resolve();
          };
          utterance.onerror = () => {
            callAudioRef.current = null;
            setCallStatus("idle");
            resolve();
          };
          speechSynthesis.speak(utterance);
        });
      } catch (error) {
        console.error("Voice call error:", error);
        if (callLinkedToChat) {
          const msg = error instanceof Error ? error.message : String(error);
          setChatLog((prev) => [
            ...prev,
            { role: "assistant", text: `Error: ${msg}` },
          ]);
        }
        setCallStatus("idle");
      }
    };

    recorder.start();
    setCallStatus("listening");
  };

  const stopListening = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const handleSend = async () => {
    if (!prompt.trim()) return;
    const userText = prompt.trim();
    setPrompt("");

    let chatId = activeChatId;
    if (!chatId && user) {
      try {
        chatId = await createChat(user.uid);
        skipNextChatLoad.current = true;
        setActiveChatId(chatId);
      } catch {
        chatId = null;
      }
    }

    setChatLog((prev) => [...prev, { role: "user", text: userText }]);
    setAiLoading(true);
    const assistantIdx = chatLog.length + 1;
    setChatLog((prev) => [...prev, { role: "assistant", text: "" }]);
    try {
      const frame = captureCurrentFrame() || lastLiveFrame;
      const fullPrompt = frame
        ? userText
        : `[No live screen preview is currently running. The user has not shared their screen yet, so you cannot see anything. Respond based on the text alone.]\n\n${userText}`;
      await streamGroqChatCompletion(
        fullPrompt,
        (soFar) => {
          setChatLog((prev) => {
            const updated = [...prev];
            updated[assistantIdx] = { role: "assistant", text: soFar };
            return updated;
          });
        },
        frame,
        attachedSnapshots,
        chatLog,
      );
    } catch (error) {
      console.error("Groq chat error:", error);
      const msg = error instanceof Error ? error.message : String(error);
      setChatLog((prev) => {
        const updated = [...prev];
        updated[assistantIdx] = {
          role: "assistant",
          text: `Error: ${msg}`,
        };
        return updated;
      });
    } finally {
      setAiLoading(false);
      if (chatId) {
        const currentChat = chats.find((c) => c.id === chatId);
        setChatLog((latest) => {
          saveMessages(chatId, latest, currentChat?.title).catch(() => {});
          return latest;
        });
      }
    }
  };

  useEffect(() => {
    if (!selection || !stream) return;
    if (selection.width < 6 || selection.height < 6) return;

    const video = videoRef.current;
    const canvas = regionCanvasRef.current;
    const preview = previewRef.current;
    if (!video || !canvas || !preview) return;

    const vr = getVideoRect();
    const previewRect = preview.getBoundingClientRect();
    const contentW = vr ? vr.width : previewRect.width;
    const contentH = vr ? vr.height : previewRect.height;
    const nx = selection.x / contentW;
    const ny = selection.y / contentH;
    const nw = selection.width / contentW;
    const nh = selection.height / contentH;

    let prevSw = 0,
      prevSh = 0;
    let frameId: number;

    const drawRegion = () => {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        frameId = requestAnimationFrame(drawRegion);
        return;
      }

      const sx = Math.round(nx * video.videoWidth);
      const sy = Math.round(ny * video.videoHeight);
      const sw = Math.round(nw * video.videoWidth);
      const sh = Math.round(nh * video.videoHeight);

      if (sw !== prevSw || sh !== prevSh) {
        canvas.width = sw;
        canvas.height = sh;
        prevSw = sw;
        prevSh = sh;
      }

      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      }

      frameId = requestAnimationFrame(drawRegion);
    };

    frameId = requestAnimationFrame(drawRegion);
    return () => cancelAnimationFrame(frameId);
  }, [selection, stream]);

  const hasRegionPreview =
    stream !== null &&
    selection !== null &&
    selection.width >= 6 &&
    selection.height >= 6 &&
    !isSelecting;

  const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
    isDragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handleDividerPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const newWidth = Math.min(
      Math.max(280, e.clientX),
      window.innerWidth - 360,
    );
    setLeftWidth(newWidth);
  }, []);

  const handleDividerPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      localStorage.setItem("leftWidth", String(leftWidth));
    },
    [leftWidth],
  );

  if (authLoading) {
    return null;
  }

  if (page === "landing") {
    return (
      <LandingPage
        onGetStarted={() => setPage("app")}
        onLogin={() => setPage("login")}
        onSignup={() => setPage("signup")}
        dark={dark}
        onToggleTheme={() => setDark((prev) => !prev)}
      />
    );
  }

  if (page === "login" || page === "signup") {
    return (
      <AuthPage
        mode={page}
        onSwitchMode={() => setPage(page === "login" ? "signup" : "login")}
        onLogin={async (email, password) => {
          await login(email, password);
        }}
        onSignup={async (name, email, password) => {
          await signup(name, email, password);
        }}
        onBack={() => setPage("landing")}
        dark={dark}
        onToggleTheme={() => setDark((prev) => !prev)}
      />
    );
  }

  if (page === "settings" && user) {
    return (
      <SettingsPage
        user={user}
        dark={dark}
        onToggleTheme={() => setDark((prev) => !prev)}
        onBack={() => setPage("app")}
        onSignOut={async () => {
          await logout();
          setUser(null);
          setPage("landing");
        }}
        onAccountDeleted={() => {
          setUser(null);
          setPage("landing");
        }}
        onChatsCleared={() => {
          setChats([]);
          setActiveChatId(null);
          setChatLog([]);
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="logo">ZUUMLY</h1>
          <span className="badge">BCIT Hackathon 2026</span>
        </div>
        <div className="topbar-right">
          <span className={`dot ${stream ? "live" : ""}`} />
          <span className="topbar-status">
            {stream ? "Capturing" : "Not capturing"}
          </span>
          {user && (
            <button
              className="ghost small"
              onClick={() => setPage("settings")}
            >
              ⚙️ Settings
            </button>
          )}
          {!user && (
            <>
              <button
                className="theme-toggle"
                onClick={() => setDark((prev) => !prev)}
                title={dark ? "Switch to light mode" : "Switch to dark mode"}
              >
                {dark ? "☀️" : "🌙"}
              </button>
              <button
                className="ghost small"
                onClick={() => setPage("login")}
              >
                Login
              </button>
              <button
                className="primary small"
                onClick={() => setPage("signup")}
              >
                Sign Up
              </button>
            </>
          )}
        </div>
      </header>

      <div className="layout">
        {/* ── Left panel: source picker + AI chat ── */}
        <aside className="sidebar" style={{ width: leftWidth }}>
          <section className="panel">
            <button className="primary" onClick={useSystemPicker}>
              Choose source
            </button>
          </section>
          {/* ── Chat list ── */}
          <section className="panel chat-list-panel">
            <div className="panel-header">
              <h2
                onClick={() => setChatListOpen(!chatListOpen)}
                style={{ cursor: "pointer" }}
              >
                Chats {chatListOpen ? "▾" : "▸"}
              </h2>
              <button
                className="primary small"
                style={{ marginLeft: "auto" }}
                onClick={handleNewChat}
              >
                + New
              </button>
            </div>
            {chatListOpen && (
              <div className="chat-list">
                {chats.length === 0 && (
                  <p
                    className="muted"
                    style={{
                      textAlign: "center",
                      padding: 8,
                      fontSize: "0.82rem",
                    }}
                  >
                  </p>
                )}
                {chats.map((c) => (
                  <div
                    key={c.id}
                    className={`chat-list-item ${c.id === activeChatId ? "active" : ""}`}
                    onClick={() => handleSelectChat(c.id)}
                  >
                    <span className="chat-list-title">{c.title}</span>
                    <button
                      className="chat-list-delete"
                      title="Delete chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteChat(c.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel chat-panel">
            <h2>Chat</h2>
            <div className="chat-log">
              {chatLog.length === 0 && (
                <p
                  className="muted"
                  style={{ textAlign: "center", padding: 16 }}
                >
                </p>
              )}
              {chatLog.map((msg, i) => (
                <div key={i} className={`chat-bubble ${msg.role}`}>
                  <span className="chat-role">
                    {msg.role === "user" ? "You" : "Assistant"}
                  </span>
                  {msg.role === "assistant" ? (
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p>{msg.text}</p>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            {attachedSnapshots.length > 0 && (
              <div className="attached-snapshot-badge">
                {attachedSnapshots.map((url, i) => (
                  <div key={i} className="attached-snapshot-item">
                    <img src={url} alt={`Attached ${i + 1}`} />
                    <button
                      className="attached-snapshot-remove"
                      onClick={() =>
                        setAttachedSnapshots((prev) => prev.filter((u) => u !== url))
                      }
                      title="Remove attachment"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-input-wrapper">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Describe what you need help with..."
                rows={3}
              />
              <button
                className="primary send-btn"
                disabled={!prompt.trim() || aiLoading}
                onClick={handleSend}
              >
                {aiLoading ? "Sending..." : "Send"}
              </button>
            </div>
            <button
              className={callActive ? "danger small" : "ghost small"}
              style={{ alignSelf: "center", marginTop: 4 }}
              onClick={callActive ? endCall : startCall}
              disabled={aiLoading}
            >
              {callActive ? "End Call" : "🎙️ Call"}
            </button>

            {/* ── Voice call overlay ── */}
            {callActive && (
              <div className="call-overlay">
                <div className="call-status-ring" data-status={callStatus} />
                <span className="call-status-label">
                  {callStatus === "idle" && "Ready — tap mic to talk"}
                  {callStatus === "listening" && "Listening..."}
                  {callStatus === "thinking" && "Thinking..."}
                  {callStatus === "speaking" && "Speaking..."}
                </span>
                {callTranscript && (
                  <p className="call-transcript">"{callTranscript}"</p>
                )}
                <div className="call-actions">
                  {callStatus === "idle" && (
                    <button className="call-mic-btn" onClick={startListening}>
                      🎙️
                    </button>
                  )}
                  {callStatus === "listening" && (
                    <button className="call-mic-btn recording" onClick={stopListening}>
                      ⏹️
                    </button>
                  )}
                  {callStatus === "speaking" && (
                    <button
                      className="ghost small"
                      onClick={() => {
                        if (callAudioRef.current) {
                          try { callAudioRef.current.stop(); } catch {}
                          callAudioRef.current = null;
                        }
                        setCallStatus("idle");
                      }}
                    >
                      Skip
                    </button>
                  )}
                </div>
                <label className="call-link-toggle">
                  <input
                    type="checkbox"
                    checked={callLinkedToChat}
                    onChange={(e) => setCallLinkedToChat(e.target.checked)}
                  />
                  <span>Link to chat</span>
                </label>
                <button className="danger small" onClick={endCall}>
                  End Call
                </button>
              </div>
            )}
          </section>
        </aside>

        {/* ── Resize divider ── */}
        <div
          className="resize-divider"
          onPointerDown={handleDividerPointerDown}
          onPointerMove={handleDividerPointerMove}
          onPointerUp={handleDividerPointerUp}
        />

        {/* ── Right area: live preview ── */}
        <main className="main">
          <section className="panel preview-panel">
            <div className="panel-header">
              <h2>Live Preview</h2>
              {stream && <span className="pill live-pill">Live</span>}
              <div style={{ flex: 1 }} />
              {stream && (
                <button className="danger small" onClick={stopCapture}>
                  Stop
                </button>
              )}
            </div>
            {stream && (
              <div className="actions">
                <button className="primary small" onClick={takeSnapshot}>
                  Snapshot
                </button>
                {selection && (
                  <button className="ghost small" onClick={clearSelection}>
                    Reset region
                  </button>
                )}
                {stream && !selection && (
                  <button
                    className={
                      regionSelectActive ? "primary small" : "ghost small"
                    }
                    onClick={() => setRegionSelectActive(!regionSelectActive)}
                  >
                    {regionSelectActive ? "Drawing..." : "Select region"}
                  </button>
                )}
              </div>
            )}
            {captureError && <p className="error">{captureError}</p>}
            <div
              className="preview"
              ref={previewRef}
              style={{ height: `${(400 * Number(previewScale)) / 100}px` }}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                style={{ display: hasRegionPreview ? "none" : undefined }}
              />
              <canvas
                ref={regionCanvasRef}
                className="region-canvas"
                style={{ display: hasRegionPreview ? "block" : "none" }}
              />
              <div
                className="selection-layer"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                style={{
                  pointerEvents: regionSelectActive && stream ? "auto" : "none",
                }}
              />
              {selection && !hasRegionPreview && (
                <div
                  className="selection-box"
                  style={{
                    left: `${selection.x + (getVideoRect()?.offsetX ?? 0)}px`,
                    top: `${selection.y + (getVideoRect()?.offsetY ?? 0)}px`,
                    width: `${selection.width}px`,
                    height: `${selection.height}px`,
                  }}
                />
              )}
              {!stream && (
                <div className="preview-empty">
                  Choose a source to see your screen here.
                </div>
              )}
              {stream && regionSelectActive && !selection && (
                <div className="preview-hint">
                  Click and drag to select a region.
                </div>
              )}
            </div>
            <div className="panel-footer">
              <select
                className="scale-select"
                value={previewScale}
                onChange={(e) => setPreviewScale(e.target.value)}
              >
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100">100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
              </select>
            </div>
          </section>

          {snapshots.length > 0 && (
            <section className="panel">
              <div className="panel-header">
                <h2>Snapshots</h2>
                <div style={{ flex: 1 }} />
                <button
                  className="danger small"
                  onClick={() => {
                    snapshots.forEach((s) => {
                      if (s.path) window.screenAssist?.deleteSnapshot(s.path);
                    });
                    setSnapshots([]);
                    setAttachedSnapshots([]);
                  }}
                >
                  Clear all
                </button>
              </div>
              <div className="snapshot-gallery">
                {snapshots.map((s, i) => (
                  <div
                    key={i}
                    className={`snapshot-thumb ${attachedSnapshots.includes(s.dataUrl) ? "attached" : ""}`}
                  >
                    <img
                      src={s.dataUrl}
                      alt={`Snapshot ${i + 1}`}
                      style={{
                        height: `${(120 * Number(snapshotScale)) / 100}px`,
                      }}
                    />
                    <div className="snapshot-thumb-actions">
                      <button
                        className="ghost small"
                        title="Attach to chat"
                        onClick={() =>
                          setAttachedSnapshots((prev) =>
                            prev.includes(s.dataUrl)
                              ? prev.filter((u) => u !== s.dataUrl)
                              : [...prev, s.dataUrl],
                          )
                        }
                      >
                        {attachedSnapshots.includes(s.dataUrl) ? "Detach" : "Attach"}
                      </button>
                      <button
                        className="danger small"
                        title="Delete snapshot"
                        onClick={() => {
                          if (s.path) window.screenAssist?.deleteSnapshot(s.path);
                          setAttachedSnapshots((prev) => prev.filter((u) => u !== s.dataUrl));
                          setSnapshots((prev) => prev.filter((_, j) => j !== i));
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="panel-footer">
                <select
                  className="scale-select"
                  value={snapshotScale}
                  onChange={(e) => setSnapshotScale(e.target.value)}
                >
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100">100%</option>
                  <option value="125">125%</option>
                  <option value="150">150%</option>
                </select>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
