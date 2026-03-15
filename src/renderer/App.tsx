import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamGroqChatCompletion, transcribeAudio } from "./services/model";
import LandingPage from "./pages/LandingPage";
import AuthPage from "./pages/AuthPage";
import SettingsPage from "./pages/SettingsPage";
import { login, logout, onAuthChange, signup, type AppUser } from "./services/auth";
import {
  createChat,
  deleteChat,
  saveMessages,
  subscribeToChats,
  type Chat,
  type ChatMessage,
} from "./services/chatService";

type Page = "landing" | "login" | "signup" | "app" | "settings";
type Point = { x: number; y: number };
type Selection = { x: number; y: number; width: number; height: number };
type Snapshot = { path: string | null; dataUrl: string };
type CallStatus = "idle" | "listening" | "thinking" | "speaking";
type CaptureResult = { dataUrl: string | null; error: string | null };

const MODEL_LABEL = "llama-4-scout";
const SCALE_OPTIONS = ["50", "75", "100", "125", "150"];
const DEFAULT_LEFT_WIDTH = 420;
const MIN_LEFT_WIDTH = 280;
const MIN_MAIN_WIDTH = 360;
const MIN_SELECTION_SIZE = 6;
const CHAT_FALLBACK_CONTEXT =
  "[No live screen preview is currently running. The user has not shared their screen yet, so you cannot see anything. Respond based on the text alone.]";
const CALL_FALLBACK_CONTEXT = "[No live screen preview is currently running.]";

function loadStoredTheme(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }

  return localStorage.getItem("theme") === "dark";
}

function loadStoredLeftWidth(): number {
  if (typeof localStorage === "undefined") {
    return DEFAULT_LEFT_WIDTH;
  }

  const savedWidth = localStorage.getItem("leftWidth");
  return savedWidth ? Number(savedWidth) : DEFAULT_LEFT_WIDTH;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hasUsableSelection(selection: Selection | null): selection is Selection {
  return (
    selection !== null &&
    selection.width >= MIN_SELECTION_SIZE &&
    selection.height >= MIN_SELECTION_SIZE
  );
}

function stopMediaStream(mediaStream: MediaStream | null): void {
  mediaStream?.getTracks().forEach((track) => track.stop());
}

function addScreenContext(
  message: string,
  frame: string | null,
  fallbackContext: string,
): string {
  return frame ? message : `${fallbackContext}\n\n${message}`;
}

function isRenderableChatMessage(
  message: ChatMessage | null | undefined,
): message is ChatMessage {
  return Boolean(
    message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.text === "string",
  );
}

export default function App() {
  // Routing/auth/theme state.
  const [page, setPage] = useState<Page>("landing");
  const [user, setUser] = useState<AppUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dark, setDark] = useState(loadStoredTheme);

  // Screen capture + snapshot state.
  const [prompt, setPrompt] = useState("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [regionSelectActive, setRegionSelectActive] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [previewScale, setPreviewScale] = useState("100");
  const [snapshotScale, setSnapshotScale] = useState("100");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [attachedSnapshots, setAttachedSnapshots] = useState<string[]>([]);
  const [lastLiveFrame, setLastLiveFrame] = useState<string | null>(null);

  // Voice call lifecycle state.
  const [callActive, setCallActive] = useState(false);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [callTranscript, setCallTranscript] = useState("");
  const [callLinkedToChat, setCallLinkedToChat] = useState(false);

  // Chat/session state.
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chatLog, setChatLog] = useState<ChatMessage[]>([]);
  const [chatListOpen, setChatListOpen] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);

  const [leftWidth, setLeftWidth] = useState(loadStoredLeftWidth);

  // Refs for media handles and mutable values that should not trigger rerenders.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const callAudioRef = useRef<{ stop: () => void } | null>(null);
  const silentCtxRef = useRef<AudioContext | null>(null);
  const isDragging = useRef(false);
  const skipNextChatLoad = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const regionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const toggleTheme = () => setDark((previous) => !previous);
  const hasRegionPreview = stream !== null && hasUsableSelection(selection) && !isSelecting;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    const unsubscribe = onAuthChange((firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        setPage("app");
      }
      setAuthLoading(false);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setActiveChatId(null);
      setChatLog([]);
      return;
    }

    const unsubscribe = subscribeToChats(user.uid, (userChats) => {
      setChats(userChats);
    });

    return unsubscribe;
  }, [user]);

  useEffect(() => {
    if (skipNextChatLoad.current) {
      skipNextChatLoad.current = false;
      return;
    }

    if (!activeChatId) {
      setChatLog([]);
      return;
    }

    const activeChat = chats.find((chat) => chat.id === activeChatId);
    if (activeChat) {
      setChatLog(activeChat.messages);
    }
  }, [activeChatId, chats]);

  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatLog, aiLoading]);

  useEffect(() => {
    return () => {
      stopMediaStream(streamRef.current);
    };
  }, []);

  useEffect(() => {
    window.screenAssist?.onScreenSelection((rect) => {
      setSelection(rect);
    });
  }, []);

  const getVideoRect = () => {
    const video = videoRef.current;
    const preview = previewRef.current;
    if (!video || !preview || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    const previewRect = preview.getBoundingClientRect();
    const videoAspect = video.videoWidth / video.videoHeight;
    const previewAspect = previewRect.width / previewRect.height;

    let renderWidth: number;
    let renderHeight: number;
    let offsetX: number;
    let offsetY: number;

    if (videoAspect > previewAspect) {
      renderWidth = previewRect.width;
      renderHeight = previewRect.width / videoAspect;
      offsetX = 0;
      offsetY = (previewRect.height - renderHeight) / 2;
    } else {
      renderHeight = previewRect.height;
      renderWidth = previewRect.height * videoAspect;
      offsetX = (previewRect.width - renderWidth) / 2;
      offsetY = 0;
    }

    return {
      offsetX,
      offsetY,
      width: renderWidth,
      height: renderHeight,
    };
  };

  useEffect(() => {
    if (!stream || !hasUsableSelection(selection)) {
      return;
    }

    const video = videoRef.current;
    const canvas = regionCanvasRef.current;
    const preview = previewRef.current;
    if (!video || !canvas || !preview) {
      return;
    }

    const videoRect = getVideoRect();
    const previewRect = preview.getBoundingClientRect();
    const contentWidth = videoRect ? videoRect.width : previewRect.width;
    const contentHeight = videoRect ? videoRect.height : previewRect.height;
    const normalizedX = selection.x / contentWidth;
    const normalizedY = selection.y / contentHeight;
    const normalizedWidth = selection.width / contentWidth;
    const normalizedHeight = selection.height / contentHeight;

    let previousWidth = 0;
    let previousHeight = 0;
    let frameId = 0;

    // Keep repainting the selected region so the cropped preview stays live.
    const drawRegion = () => {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        frameId = requestAnimationFrame(drawRegion);
        return;
      }

      const sourceX = Math.round(normalizedX * video.videoWidth);
      const sourceY = Math.round(normalizedY * video.videoHeight);
      const sourceWidth = Math.round(normalizedWidth * video.videoWidth);
      const sourceHeight = Math.round(normalizedHeight * video.videoHeight);

      if (sourceWidth !== previousWidth || sourceHeight !== previousHeight) {
        canvas.width = sourceWidth;
        canvas.height = sourceHeight;
        previousWidth = sourceWidth;
        previousHeight = sourceHeight;
      }

      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          sourceWidth,
          sourceHeight,
        );
      }

      frameId = requestAnimationFrame(drawRegion);
    };

    frameId = requestAnimationFrame(drawRegion);
    return () => cancelAnimationFrame(frameId);
  }, [selection, stream]);

  const captureFullFrame = (): CaptureResult => {
    const video = videoRef.current;
    if (!video || !stream || video.videoWidth === 0 || video.videoHeight === 0) {
      return { dataUrl: null, error: "Video is not ready yet." };
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      return { dataUrl: null, error: "Canvas is unavailable." };
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/png"), error: null };
  };

  const captureSelectionFrame = (targetSelection: Selection): CaptureResult => {
    const video = videoRef.current;
    if (!video || !stream || video.videoWidth === 0 || video.videoHeight === 0) {
      return { dataUrl: null, error: "Video is not ready yet." };
    }

    const videoRect = getVideoRect();
    if (!videoRect || videoRect.width === 0 || videoRect.height === 0) {
      return { dataUrl: null, error: "Preview not ready." };
    }

    const scaleX = video.videoWidth / videoRect.width;
    const scaleY = video.videoHeight / videoRect.height;
    const sourceX = Math.round(targetSelection.x * scaleX);
    const sourceY = Math.round(targetSelection.y * scaleY);
    const sourceWidth = Math.round(targetSelection.width * scaleX);
    const sourceHeight = Math.round(targetSelection.height * scaleY);

    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      return { dataUrl: null, error: "Canvas is unavailable." };
    }

    context.drawImage(
      video,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight,
    );

    return { dataUrl: canvas.toDataURL("image/png"), error: null };
  };

  const captureCurrentFrame = (): string | null => {
    if (hasRegionPreview && selection) {
      return captureSelectionFrame(selection).dataUrl;
    }

    return captureFullFrame().dataUrl;
  };

  const persistChatMessages = (chatId: string) => {
    const currentChat = chats.find((chat) => chat.id === chatId);
    setChatLog((latestMessages) => {
      void saveMessages(chatId, latestMessages, currentChat?.title).catch(() => {});
      return latestMessages;
    });
  };

  const ensureActiveChat = async (): Promise<string | null> => {
    // Create a chat lazily so text and voice flows can share the same helper.
    if (activeChatId) {
      return activeChatId;
    }

    if (!user) {
      return null;
    }

    try {
      const newChatId = await createChat(user.uid);
      skipNextChatLoad.current = true;
      setActiveChatId(newChatId);
      return newChatId;
    } catch {
      return null;
    }
  };

  const updateAssistantMessage = (assistantIndex: number, text: string) => {
    setChatLog((previousLog) => {
      const updatedLog = [...previousLog];
      updatedLog[assistantIndex] = { role: "assistant", text };
      return updatedLog;
    });
  };

  const appendSnapshot = (dataUrl: string) => {
    const nextSnapshot: Snapshot = { path: null, dataUrl };
    setSnapshots((previousSnapshots) => [...previousSnapshots, nextSnapshot]);

    const saveSnapshotPromise = window.screenAssist?.saveSnapshot(dataUrl);
    if (!saveSnapshotPromise) {
      return;
    }

    void saveSnapshotPromise.then((savedPath) => {
      nextSnapshot.path = savedPath;
      setSnapshots((previousSnapshots) => [...previousSnapshots]);
    });
  };

  const startCaptureWithSystemPicker = async () => {
    setCaptureError(null);
    stopMediaStream(streamRef.current);

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

    mediaStream.getVideoTracks()[0]?.addEventListener("ended", () => {
      setStream(null);
      streamRef.current = null;
      setSelection(null);
      setRegionSelectActive(false);
    });
  };

  const stopCapture = () => {
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setSelection(null);
    setRegionSelectActive(false);
    window.screenAssist?.restoreWindow();
  };

  const takeSnapshot = () => {
    setCaptureError(null);
    if (!stream || !videoRef.current) {
      setCaptureError("Start capture before taking a snapshot.");
      return;
    }

    setLastLiveFrame(captureFullFrame().dataUrl);

    if (selection && !hasUsableSelection(selection)) {
      setCaptureError("Selection is too small.");
      return;
    }

    const capture = selection ? captureSelectionFrame(selection) : captureFullFrame();
    if (!capture.dataUrl) {
      setCaptureError(capture.error ?? "Unable to capture snapshot.");
      return;
    }

    appendSnapshot(capture.dataUrl);
  };

  const getPointerPoint = (event: React.PointerEvent<HTMLDivElement>): Point => {
    const layerRect = event.currentTarget.getBoundingClientRect();
    const videoRect = getVideoRect();

    if (!videoRect) {
      return {
        x: clamp(event.clientX - layerRect.left, 0, layerRect.width),
        y: clamp(event.clientY - layerRect.top, 0, layerRect.height),
      };
    }

    return {
      x: clamp(event.clientX - layerRect.left - videoRect.offsetX, 0, videoRect.width),
      y: clamp(event.clientY - layerRect.top - videoRect.offsetY, 0, videoRect.height),
    };
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

  const handleNewChat = async () => {
    if (!user) {
      return;
    }

    const newChatId = await createChat(user.uid);
    setActiveChatId(newChatId);
    setChatLog([]);
  };

  const handleSelectChat = (chatId: string) => {
    setActiveChatId(chatId);
    const selectedChat = chats.find((chat) => chat.id === chatId);
    if (selectedChat) {
      setChatLog(selectedChat.messages);
    }
  };

  const handleDeleteChat = async (chatId: string) => {
    await deleteChat(chatId);
    if (activeChatId === chatId) {
      setActiveChatId(null);
      setChatLog([]);
    }
  };

  const stopCallAudio = () => {
    if (!callAudioRef.current) {
      return;
    }

    try {
      callAudioRef.current.stop();
    } catch {}

    callAudioRef.current = null;
  };

  const startCall = async () => {
    try {
      if (!silentCtxRef.current) {
        const audioContext = new AudioContext();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0;
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.start();
        silentCtxRef.current = audioContext;
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

    stopCallAudio();
    stopMediaStream(micStreamRef.current);
    micStreamRef.current = null;

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
    if (!micStream) {
      return;
    }

    audioChunksRef.current = [];
    const recorder = new MediaRecorder(micStream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = async () => {
      // Once recording ends, run STT -> LLM response -> optional chat save -> TTS playback.
      const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      audioChunksRef.current = [];
      if (audioBlob.size < 100) {
        setCallStatus("idle");
        return;
      }

      setCallStatus("thinking");

      try {
        const transcript = await transcribeAudio(audioBlob);
        if (!transcript.trim()) {
          setCallStatus("idle");
          return;
        }

        setCallTranscript(transcript);

        let chatId: string | null = null;
        let assistantIndex = -1;
        if (callLinkedToChat) {
          const updatedLog = [...chatLog, { role: "user", text: transcript } as ChatMessage];
          assistantIndex = updatedLog.length;
          setChatLog([...updatedLog, { role: "assistant", text: "" }]);
          chatId = await ensureActiveChat();
        }

        const frame = captureCurrentFrame() || lastLiveFrame;
        const responseText = await streamGroqChatCompletion(
          addScreenContext(transcript, frame, CALL_FALLBACK_CONTEXT),
          (soFar) => {
            if (callLinkedToChat && assistantIndex >= 0) {
              updateAssistantMessage(assistantIndex, soFar);
            }
          },
          frame,
          attachedSnapshots,
          chatLog,
          true,
        );

        if (callLinkedToChat && chatId) {
          persistChatMessages(chatId);
        }

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
            if (callActive) {
              setCallStatus("idle");
            }
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
          const message = error instanceof Error ? error.message : String(error);
          setChatLog((previousLog) => [
            ...previousLog,
            { role: "assistant", text: `Error: ${message}` },
          ]);
        }
        setCallStatus("idle");
      }
    };

    recorder.start();
    setCallStatus("listening");
  };

  const stopListening = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const handleSend = async () => {
    if (!prompt.trim()) {
      return;
    }

    const userText = prompt.trim();
    setPrompt("");

    const chatId = await ensureActiveChat();
    const updatedLog = [...chatLog, { role: "user", text: userText } as ChatMessage];
    const assistantIndex = updatedLog.length;
    setChatLog([...updatedLog, { role: "assistant", text: "" }]);
    setAiLoading(true);

    try {
      const frame = captureCurrentFrame() || lastLiveFrame;
      await streamGroqChatCompletion(
        addScreenContext(userText, frame, CHAT_FALLBACK_CONTEXT),
        (soFar) => {
          updateAssistantMessage(assistantIndex, soFar);
        },
        frame,
        attachedSnapshots,
        chatLog,
      );
    } catch (error) {
      console.error("Groq chat error:", error);
      const message = error instanceof Error ? error.message : String(error);
      updateAssistantMessage(assistantIndex, `Error: ${message}`);
    } finally {
      setAiLoading(false);
      if (chatId) {
        persistChatMessages(chatId);
      }
    }
  };

  const clearAllSnapshots = () => {
    snapshots.forEach((snapshot) => {
      if (snapshot.path) {
        window.screenAssist?.deleteSnapshot(snapshot.path);
      }
    });

    setSnapshots([]);
    setAttachedSnapshots([]);
  };

  const toggleSnapshotAttachment = (dataUrl: string) => {
    setAttachedSnapshots((previousUrls) =>
      previousUrls.includes(dataUrl)
        ? previousUrls.filter((url) => url !== dataUrl)
        : [...previousUrls, dataUrl],
    );
  };

  const removeAttachedSnapshot = (dataUrl: string) => {
    setAttachedSnapshots((previousUrls) => previousUrls.filter((url) => url !== dataUrl));
  };

  const deleteSnapshotAtIndex = (index: number) => {
    const snapshot = snapshots[index];
    if (!snapshot) {
      return;
    }

    if (snapshot.path) {
      window.screenAssist?.deleteSnapshot(snapshot.path);
    }

    setAttachedSnapshots((previousUrls) =>
      previousUrls.filter((url) => url !== snapshot.dataUrl),
    );
    setSnapshots((previousSnapshots) =>
      previousSnapshots.filter((_, snapshotIndex) => snapshotIndex !== index),
    );
  };

  const handleDividerPointerDown = useCallback((event: React.PointerEvent) => {
    isDragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handleDividerPointerMove = useCallback((event: React.PointerEvent) => {
    if (!isDragging.current) {
      return;
    }

    const newWidth = clamp(
      event.clientX,
      MIN_LEFT_WIDTH,
      window.innerWidth - MIN_MAIN_WIDTH,
    );
    setLeftWidth(newWidth);
  }, []);

  const handleDividerPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!isDragging.current) {
        return;
      }

      isDragging.current = false;
      event.currentTarget.releasePointerCapture(event.pointerId);
      localStorage.setItem("leftWidth", String(leftWidth));
    },
    [leftWidth],
  );

  const handleSignOut = async () => {
    await logout();
    setUser(null);
    setPage("landing");
  };

  const handleAccountDeleted = () => {
    setUser(null);
    setPage("landing");
  };

  // Keep page routing readable by splitting big JSX chunks into render helpers.
  const renderScaleOptions = () =>
    SCALE_OPTIONS.map((value) => (
      <option key={value} value={value}>
        {value}%
      </option>
    ));

  const renderVoiceCallOverlay = () => {
    if (!callActive) {
      return null;
    }

    return (
      <div className="call-overlay">
        <div className="call-status-ring" data-status={callStatus} />
        <span className="call-status-label">
          {callStatus === "idle" && "Ready - tap mic to talk"}
          {callStatus === "listening" && "Listening..."}
          {callStatus === "thinking" && "Thinking..."}
          {callStatus === "speaking" && "Speaking..."}
        </span>
        {callTranscript && <p className="call-transcript">"{callTranscript}"</p>}
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
                stopCallAudio();
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
            onChange={(event) => setCallLinkedToChat(event.target.checked)}
          />
          <span>Link to chat</span>
        </label>
      </div>
    );
  };

  const renderChatListPanel = () => (
    <section className="panel chat-list-panel">
      <div className="panel-header">
        <h2
          onClick={() => setChatListOpen((previous) => !previous)}
          style={{ cursor: "pointer" }}
        >
          Chats {chatListOpen ? "▾" : "▸"}
        </h2>
        <button
          className="primary small"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            void handleNewChat();
          }}
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
          {chats.map((chat) => (
            <div
              key={chat.id}
              className={`chat-list-item ${chat.id === activeChatId ? "active" : ""}`}
              onClick={() => handleSelectChat(chat.id)}
            >
              <span className="chat-list-title">{chat.title}</span>
              <button
                className="chat-list-delete"
                title="Delete chat"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDeleteChat(chat.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );

  const renderChatPanel = () => (
    <section className={`panel chat-panel${!user ? " chat-panel-medium" : ""}`}>
      <div className="panel-header">
        <h2>Chat</h2>
        {!user && chatLog.length > 0 && (
          <button
            className="danger small"
            style={{ marginLeft: "auto" }}
            onClick={() => setChatLog([])}
          >
            Clear Chat
          </button>
        )}
      </div>
      <div className="chat-log">
        {chatLog.filter(isRenderableChatMessage).length === 0 && (
          <p className="muted" style={{ textAlign: "center", padding: 16 }}>
          </p>
        )}
        {chatLog.filter(isRenderableChatMessage).map((message, index) => (
          <div key={index} className={`chat-bubble ${message.role}`}>
            <span className="chat-role">
              {message.role === "user" ? "You" : MODEL_LABEL}
            </span>
            {message.role === "assistant" ? (
              <div className="markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.text}
                </ReactMarkdown>
              </div>
            ) : (
              <p>{message.text}</p>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {attachedSnapshots.length > 0 && (
        <div className="attached-snapshot-badge">
          {attachedSnapshots.map((url, index) => (
            <div key={index} className="attached-snapshot-item">
              <img src={url} alt={`Attached ${index + 1}`} />
              <button
                className="attached-snapshot-remove"
                onClick={() => removeAttachedSnapshot(url)}
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
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder="Describe what you need help with..."
          rows={3}
        />
        <button
          className="primary send-btn"
          disabled={!prompt.trim() || aiLoading}
          onClick={() => {
            void handleSend();
          }}
        >
          {aiLoading ? "Sending..." : "Send"}
        </button>
      </div>

    </section>
  );

  const renderPreviewPanel = () => {
    const videoRect = getVideoRect();

    return (
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
                className={regionSelectActive ? "primary small" : "ghost small"}
                onClick={() => setRegionSelectActive((previous) => !previous)}
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
            style={{ pointerEvents: regionSelectActive && stream ? "auto" : "none" }}
          />
          {selection && !hasRegionPreview && (
            <div
              className="selection-box"
              style={{
                left: `${selection.x + (videoRect?.offsetX ?? 0)}px`,
                top: `${selection.y + (videoRect?.offsetY ?? 0)}px`,
                width: `${selection.width}px`,
                height: `${selection.height}px`,
              }}
            />
          )}
          {!stream && (
            <div className="preview-empty">Choose a source to see your screen here.</div>
          )}
          {stream && regionSelectActive && !selection && (
            <div className="preview-hint">Click and drag to select a region.</div>
          )}
        </div>

        <div className="panel-footer">
          <button
            className={callActive ? "danger small" : "ghost small"}
            style={{ marginLeft: 8 }}
            onClick={callActive ? endCall : () => void startCall()}
            disabled={aiLoading}
          >
            {callActive ? "End Call" : "🎙️ Call"}
          </button>
          <select
            className="scale-select"
            value={previewScale}
            onChange={(event) => setPreviewScale(event.target.value)}
          >
            {renderScaleOptions()}
          </select>
        </div>

        {renderVoiceCallOverlay()}
      </section>
    );
  };

  const renderSnapshotsPanel = () => {
    if (snapshots.length === 0) {
      return null;
    }

    return (
      <section className="panel">
        <div className="panel-header">
          <h2>Snapshots</h2>
          <div style={{ flex: 1 }} />
          <button className="danger small" onClick={clearAllSnapshots}>
            Clear all
          </button>
        </div>

        <div className="snapshot-gallery">
          {snapshots.map((snapshot, index) => (
            <div
              key={index}
              className={`snapshot-thumb ${attachedSnapshots.includes(snapshot.dataUrl) ? "attached" : ""}`}
            >
              <img
                src={snapshot.dataUrl}
                alt={`Snapshot ${index + 1}`}
                style={{ height: `${(120 * Number(snapshotScale)) / 100}px` }}
              />
              <div className="snapshot-thumb-actions">
                <button
                  className="ghost small"
                  title="Attach to chat"
                  onClick={() => toggleSnapshotAttachment(snapshot.dataUrl)}
                >
                  {attachedSnapshots.includes(snapshot.dataUrl) ? "Detach" : "Attach"}
                </button>
                <button
                  className="danger small"
                  title="Delete snapshot"
                  onClick={() => deleteSnapshotAtIndex(index)}
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
            onChange={(event) => setSnapshotScale(event.target.value)}
          >
            {renderScaleOptions()}
          </select>
        </div>
      </section>
    );
  };

  const renderAppShell = () => (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="logo">ZUUMLY</h1>
          <span className="badge">BCIT Hackathon 2026</span>
        </div>
        <div className="topbar-right">
          <span className={`dot ${stream ? "live" : ""}`} />
          <span className="topbar-status">{stream ? "Capturing" : "Not capturing"}</span>
          {user && (
            <button className="ghost small" onClick={() => setPage("settings")}>
              ⚙️ Settings
            </button>
          )}
          {!user && (
            <>
              <button
                className="theme-toggle"
                onClick={toggleTheme}
                title={dark ? "Switch to light mode" : "Switch to dark mode"}
              >
                {dark ? "☀️" : "🌙"}
              </button>
              <button className="ghost small" onClick={() => setPage("login")}>
                Login
              </button>
              <button className="primary small" onClick={() => setPage("signup")}>
                Sign Up
              </button>
            </>
          )}
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar" style={{ width: leftWidth }}>
          <section className="panel">
            <button className="primary" onClick={() => void startCaptureWithSystemPicker()}>
              Choose source
            </button>
          </section>
          {user && renderChatListPanel()}
          {renderChatPanel()}
        </aside>

        <div
          className="resize-divider"
          onPointerDown={handleDividerPointerDown}
          onPointerMove={handleDividerPointerMove}
          onPointerUp={handleDividerPointerUp}
        />

        <main className="main">
          {renderPreviewPanel()}
          {renderSnapshotsPanel()}
        </main>
      </div>
    </div>
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
        onToggleTheme={toggleTheme}
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
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (page === "settings" && user) {
    return (
      <SettingsPage
        user={user}
        dark={dark}
        onToggleTheme={toggleTheme}
        onBack={() => setPage("app")}
        onSignOut={handleSignOut}
        onAccountDeleted={handleAccountDeleted}
        onChatsCleared={() => {
          setChats([]);
          setActiveChatId(null);
          setChatLog([]);
        }}
      />
    );
  }

  return renderAppShell();
}
