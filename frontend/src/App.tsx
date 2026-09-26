import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./App.css";
import {
  deleteRecording,
  getRecording,
  getSessions,
  saveRecording,
  saveSessions,
} from "./services/api";
import type { PracticeCategory, PracticeSession } from "./types/interview";
import { extractMetrics, formatDuration } from "./utils/videoMetrics";

type Page = "overview" | "practice" | "history";
type IconName =
  | "grid"
  | "video"
  | "history"
  | "chart"
  | "arrow"
  | "plus"
  | "play"
  | "stop"
  | "mic"
  | "heart"
  | "spark"
  | "clock"
  | "chevron"
  | "download"
  | "trash"
  | "check"
  | "close"
  | "wave"
  | "camera";

function Icon({
  name,
  size = 20,
  strokeWidth = 1.9,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
}) {
  const paths: Record<IconName, ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    video: (
      <>
        <rect x="3" y="5" width="13" height="14" rx="2" />
        <path d="m16 10 5-3v10l-5-3" />
      </>
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </>
    ),
    chart: (
      <>
        <path d="M3 3v18h18" />
        <path d="m7 16 4-5 4 2 5-7" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14m-6-6 6 6-6 6" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    mic: (
      <>
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8" />
      </>
    ),
    heart: (
      <>
        <path d="M20.5 8.5c0 4.4-8.5 10-8.5 10S3.5 12.9 3.5 8.5a4.5 4.5 0 0 1 8.5-2 4.5 4.5 0 0 1 8.5 2Z" />
        <path d="M5 12h4l2-3 2 6 2-3h4" />
      </>
    ),
    spark: (
      <>
        <path d="m12 2 1.8 7.2L21 11l-7.2 1.8L12 20l-1.8-7.2L3 11l7.2-1.8L12 2ZM19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    chevron: <path d="m9 18 6-6-6-6" />,
    download: (
      <>
        <path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3" />
      </>
    ),
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7M10 11v6m4-6v6" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
    close: <path d="M5 5 19 19M19 5 5 19" />,
    wave: <path d="M2 12h3l2-5 4 10 3-8 2 3h6" />,
    camera: (
      <>
        <path d="M4 7h3l2-3h6l2 3h3v13H4V7Z" />
        <circle cx="12" cy="13" r="3" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}
interface SpeechEngine {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechConstructor = new () => SpeechEngine;

function getSpeechConstructor(): SpeechConstructor | undefined {
  const browser = window as Window & {
    SpeechRecognition?: SpeechConstructor;
    webkitSpeechRecognition?: SpeechConstructor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

const categories: PracticeCategory[] = ["Presentation", "Interview", "Pitch"];
const dateLabel = (date: string) =>
  new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

function TrendChart({ sessions }: { sessions: PracticeSession[] }) {
  const points = [...sessions].reverse().slice(-7);
  if (!points.length) {
    return (
      <div className="chart-empty">
        <div className="chart-empty-icon">
          <Icon name="chart" size={27} />
        </div>
        <strong>Your progress starts here</strong>
        <span>Finish a practice run to see your speaking pace over time.</span>
      </div>
    );
  }
  const max = Math.max(
    180,
    ...points.map((session) => session.wordsPerMinute + 20),
  );
  const coords = points.map((session, index) => ({
    x: points.length === 1 ? 300 : 48 + (index * 504) / (points.length - 1),
    y: 188 - (session.wordsPerMinute / max) * 142,
  }));
  const line = coords.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <div className="trend-chart">
      <div className="chart-y-labels">
        <span>{max}</span>
        <span>{Math.round(max / 2)}</span>
        <span>0</span>
      </div>
      <svg
        viewBox="0 0 600 215"
        role="img"
        aria-label="Words per minute across recent sessions"
        preserveAspectRatio="none"
      >
        <line x1="40" y1="46" x2="570" y2="46" className="gridline" />
        <line x1="40" y1="117" x2="570" y2="117" className="gridline" />
        <line x1="40" y1="188" x2="570" y2="188" className="gridline" />
        {coords.length > 1 && (
          <polyline
            points={line}
            fill="none"
            stroke="#7659e8"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {coords.map((point, index) => (
          <g key={points[index].id}>
            <circle
              cx={point.x}
              cy={point.y}
              r="7"
              fill="#7659e8"
              stroke="white"
              strokeWidth="3"
            />
            <title>
              {points[index].wordsPerMinute} WPM ·{" "}
              {dateLabel(points[index].createdAt)}
            </title>
          </g>
        ))}
      </svg>
      <div className="chart-x-labels">
        <span>{dateLabel(points[0].createdAt)}</span>
        <span>{dateLabel(points[points.length - 1].createdAt)}</span>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: PracticeSession;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="session-row" onClick={onOpen}>
      <span className="session-icon">
        <Icon name="video" size={19} />
      </span>
      <span className="session-info">
        <strong>{session.title}</strong>
        <small>
          {session.category} <span className="dot-sep">·</span>{" "}
          {dateLabel(session.createdAt)}
        </small>
      </span>
      <span className="session-duration">
        {formatDuration(session.durationSeconds)}
      </span>
      <span className="row-chevron">
        <Icon name="chevron" size={18} />
      </span>
    </button>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [sessions, setSessions] = useState<PracticeSession[]>(getSessions);
  const sessionsRef = useRef(sessions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<PracticeCategory>("Presentation");
  const [isRecording, setIsRecording] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [draftTranscript, setDraftTranscript] = useState("");
  const [status, setStatus] = useState("");
  const [speechStatus, setSpeechStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const speechRef = useRef<SpeechEngine | null>(null);
  const transcriptRef = useRef("");
  const startedAtRef = useRef(0);
  const recordingRef = useRef(false);

  const selected =
    sessions.find((session) => session.id === selectedId) ?? null;
  const totalMinutes = Math.round(
    sessions.reduce((total, session) => total + session.durationSeconds, 0) /
      60,
  );
  const averageWpm = sessions.length
    ? Math.round(
        sessions.reduce((total, session) => total + session.wordsPerMinute, 0) /
          sessions.length,
      )
    : 0;
  const liveMetrics = useMemo(
    () => extractMetrics(transcript, elapsed),
    [transcript, elapsed],
  );

  function commitSessions(next: PracticeSession[]) {
    sessionsRef.current = next;
    setSessions(next);
    try {
      saveSessions(next);
    } catch {
      setStatus(
        "Session details could not be saved in this browser. Check available storage.",
      );
    }
  }

  useEffect(() => {
    if (!isRecording) return;
    const timer = window.setInterval(
      () =>
        setElapsed(
          Math.max(1, Math.floor((Date.now() - startedAtRef.current) / 1000)),
        ),
      500,
    );
    return () => window.clearInterval(timer);
  }, [isRecording]);

  useEffect(() => {
    if (!selected?.hasRecording) {
      setRecordingUrl(null);
      setRecordingLoading(false);
      return;
    }
    let active = true;
    let url: string | null = null;
    setRecordingLoading(true);
    getRecording(selected.id)
      .then((blob) => {
        if (active && blob) {
          url = URL.createObjectURL(blob);
          setRecordingUrl(url);
        }
        if (active) setRecordingLoading(false);
      })
      .catch(() => {
        if (active) {
          setRecordingLoading(false);
          setStatus("The recording could not be opened from browser storage.");
        }
      });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
      setRecordingUrl(null);
    };
  }, [selected?.id, selected?.hasRecording]);

  useEffect(
    () => () => {
      recordingRef.current = false;
      speechRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  function navigate(next: Page) {
    if ((isRecording || isSaving) && next !== "practice") {
      setStatus("Finish saving this recording before leaving the studio.");
      return;
    }
    setPage(next);
    setSelectedId(null);
    setStatus("");
  }

  function openSession(id: string, preserveStatus = false) {
    setSelectedId(id);
    const session = sessionsRef.current.find((item) => item.id === id);
    setDraftTranscript(session?.transcript ?? "");
    setPage("history");
    if (!preserveStatus) setStatus("");
  }

  function updateTranscript(value: string) {
    transcriptRef.current = value;
    setTranscript(value);
  }

  async function startRecording() {
    if (!title.trim()) {
      setStatus("Give this practice run a name first.");
      return;
    }
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setStatus(
        "This browser cannot record video. Try a current version of Chrome, Edge, or Safari.",
      );
      return;
    }
    setStatus("");
    setSpeechStatus("");
    setElapsed(0);
    updateTranscript("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
    } catch {
      setStatus(
        "Camera and microphone access is needed to record. Check browser permissions and try again.",
      );
      return;
    }
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder;
    try {
      const preferred = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(
        stream,
        preferred ? { mimeType: preferred } : undefined,
      );
      recorder.start(1000);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("Recording could not start on this device.");
      return;
    }
    recorderRef.current = recorder;
    const currentTitle = title.trim();
    const currentCategory = category;
    startedAtRef.current = Date.now();
    recordingRef.current = true;
    setIsRecording(true);
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - startedAtRef.current) / 1000),
      );
      const id = crypto.randomUUID();
      const blob = new Blob(chunks, {
        type: recorder.mimeType || "video/webm",
      });
      let hasRecording = false;
      try {
        if (blob.size) {
          await saveRecording(id, blob);
          hasRecording = true;
        }
      } catch {
        setStatus(
          "Your session was saved, but browser storage could not keep the video.",
        );
      }
      const text = transcriptRef.current.trim();
      const metrics = extractMetrics(text, durationSeconds);
      const session: PracticeSession = {
        id,
        title: currentTitle,
        category: currentCategory,
        createdAt: new Date().toISOString(),
        durationSeconds,
        transcript: text,
        wordCount: metrics.wordCount,
        wordsPerMinute: metrics.wordsPerMinute,
        fillerCount: metrics.fillerCount,
        hasRecording,
      };
      commitSessions([session, ...sessionsRef.current]);
      setIsSaving(false);
      setTitle("");
      openSession(id, true);
    };
    const Speech = getSpeechConstructor();
    if (Speech) {
      try {
        const speech = new Speech();
        speech.continuous = true;
        speech.interimResults = true;
        speech.lang = "en-US";
        let finalText = "";
        speech.onresult = (event) => {
          let interimText = "";
          for (
            let index = event.resultIndex;
            index < event.results.length;
            index += 1
          ) {
            const result = event.results[index];
            if (result.isFinal) finalText += `${result[0].transcript.trim()} `;
            else interimText += result[0].transcript;
          }
          updateTranscript(`${finalText}${interimText}`.trim());
        };
        speech.onerror = () =>
          setSpeechStatus(
            "Live transcription stopped. You can add a transcript after the run.",
          );
        speech.start();
        speechRef.current = speech;
        setSpeechStatus("Live transcription is on");
      } catch {
        setSpeechStatus(
          "Live transcription is unavailable. You can add a transcript after the run.",
        );
      }
    } else
      setSpeechStatus(
        "Live transcription is unavailable. You can add a transcript after the run.",
      );
  }

  function stopRecording() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setIsRecording(false);
    setIsSaving(true);
    speechRef.current?.stop();
    speechRef.current = null;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function saveEditedTranscript() {
    if (!selected) return;
    const cleaned = draftTranscript.trim();
    const metrics = extractMetrics(cleaned, selected.durationSeconds);
    commitSessions(
      sessions.map((session) =>
        session.id === selected.id
          ? {
              ...session,
              transcript: cleaned,
              wordCount: metrics.wordCount,
              wordsPerMinute: metrics.wordsPerMinute,
              fillerCount: metrics.fillerCount,
            }
          : session,
      ),
    );
    setStatus("Transcript and speech metrics updated.");
  }

  async function downloadSelected() {
    if (!selected) return;
    try {
      const blob = await getRecording(selected.id);
      if (!blob) {
        setStatus("Recording is no longer available in this browser.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `preptalk-${selected.id}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setStatus("Could not download this recording.");
    }
  }

  async function removeSelected() {
    if (
      !selected ||
      !window.confirm(`Delete “${selected.title}” and its recording?`)
    )
      return;
    try {
      await deleteRecording(selected.id);
    } catch {
      /* Metadata can still be removed if the video is missing. */
    }
    commitSessions(sessions.filter((session) => session.id !== selected.id));
    setSelectedId(null);
    setStatus("Session deleted.");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="PrepTalk home"
        >
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          <span>
            prep<span className="brand-accent">talk</span>
            <small>your practice space</small>
          </span>
        </button>
        <div className="nav-heading">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={`nav-item ${page === "overview" ? "active" : ""}`}
            onClick={() => navigate("overview")}
          >
            <Icon name="grid" />
            Overview
          </button>
          <button
            className={`nav-item ${page === "practice" ? "active" : ""}`}
            onClick={() => navigate("practice")}
          >
            <Icon name="video" />
            Practice studio
          </button>
          <button
            className={`nav-item ${page === "history" ? "active" : ""}`}
            onClick={() => navigate("history")}
          >
            <Icon name="history" />
            Session history
            {sessions.length > 0 && (
              <span className="nav-count">{sessions.length}</span>
            )}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon">
              <Icon name="spark" size={18} />
            </span>
            <strong>A little practice goes a long way.</strong>
            <p>Build confidence one run at a time.</p>
          </div>
          <div className="local-profile">
            <span className="avatar">Y</span>
            <span>
              <strong>Your workspace</strong>
              <small>Saved on this device</small>
            </span>
            <span className="profile-dot" />
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark">
              <span />
              <span />
              <span />
            </span>
            preptalk
          </div>
          <div className="breadcrumb">
            Workspace <Icon name="chevron" size={14} />{" "}
            <strong>
              {page === "overview"
                ? "Overview"
                : page === "practice"
                  ? "Practice studio"
                  : "Session history"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <span /> Local workspace
            </span>
            <span className="avatar top-avatar">Y</span>
          </div>
        </header>
        <div className="page-content">
          {status && (
            <div className="status-banner" role="status">
              <span>{status}</span>
              <button
                aria-label="Dismiss message"
                onClick={() => setStatus("")}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {page === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">YOUR DASHBOARD</span>
                  <h1>
                    Make every practice count
                    <span className="heading-dot">.</span>
                  </h1>
                  <p>A calmer, more confident you starts with one rehearsal.</p>
                </div>
                <span className="today-label">
                  <Icon name="clock" size={16} />{" "}
                  {new Date().toLocaleDateString(undefined, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                </span>
              </div>
              <section className="hero-card">
                <div className="hero-copy">
                  <span className="hero-kicker">
                    <span className="hero-kicker-dot" /> YOUR SPACE TO GROW
                  </span>
                  <h2>
                    Great presentations
                    <br />
                    start with practice.
                  </h2>
                  <p>
                    Record a run, reflect on your delivery, and watch yourself
                    improve over time.
                  </p>
                  <button
                    className="button button-white"
                    onClick={() => navigate("practice")}
                  >
                    Start a practice run <Icon name="arrow" size={18} />
                  </button>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="hero-orbit orbit-one" />
                  <div className="hero-orbit orbit-two" />
                  <div className="hero-art-card">
                    <div className="art-card-top">
                      <span className="art-avatar">
                        <Icon name="mic" size={26} />
                      </span>
                      <span className="art-live">
                        <span /> READY TO GO
                      </span>
                    </div>
                    <div className="art-wave">
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                      <i />
                    </div>
                    <div className="art-card-bottom">
                      <span>Find your voice.</span>
                      <span className="art-play">
                        <Icon name="play" size={15} />
                      </span>
                    </div>
                  </div>
                  <div className="floating-spark">
                    <Icon name="spark" size={22} />
                  </div>
                </div>
              </section>
              <section className="stats-grid" aria-label="Practice statistics">
                <div className="stat-card">
                  <span className="stat-icon purple">
                    <Icon name="video" size={21} />
                  </span>
                  <span className="stat-label">Practice sessions</span>
                  <div className="stat-value">
                    {sessions.length.toString().padStart(2, "0")}
                    <span> total</span>
                  </div>
                  <small>Every run is progress</small>
                </div>
                <div className="stat-card">
                  <span className="stat-icon peach">
                    <Icon name="clock" size={21} />
                  </span>
                  <span className="stat-label">Time spent practicing</span>
                  <div className="stat-value">
                    {totalMinutes}
                    <span> min</span>
                  </div>
                  <small>Time invested in yourself</small>
                </div>
                <div className="stat-card">
                  <span className="stat-icon mint">
                    <Icon name="wave" size={21} />
                  </span>
                  <span className="stat-label">Average speaking pace</span>
                  <div className="stat-value">
                    {averageWpm || "—"}
                    <span> {averageWpm ? "WPM" : ""}</span>
                  </div>
                  <small>
                    {averageWpm
                      ? "Words per minute"
                      : "Record to unlock insights"}
                  </small>
                </div>
              </section>
              <div className="dashboard-grid">
                <section className="panel progress-panel">
                  <div className="panel-header">
                    <div>
                      <span className="section-eyebrow">TRACK YOUR GROWTH</span>
                      <h3>Speaking pace</h3>
                    </div>
                    <span className="panel-tag">Last 7 sessions</span>
                  </div>
                  <TrendChart sessions={sessions} />
                </section>
                <section className="panel recent-panel">
                  <div className="panel-header">
                    <div>
                      <span className="section-eyebrow">
                        PICK UP WHERE YOU LEFT OFF
                      </span>
                      <h3>Recent sessions</h3>
                    </div>
                    {sessions.length > 0 && (
                      <button
                        className="text-link"
                        onClick={() => navigate("history")}
                      >
                        View all <Icon name="arrow" size={16} />
                      </button>
                    )}
                  </div>
                  {sessions.length ? (
                    <div className="recent-list">
                      {sessions.slice(0, 3).map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          onOpen={() => openSession(session.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="recent-empty">
                      <span className="recent-empty-icon">
                        <Icon name="video" size={23} />
                      </span>
                      <strong>No sessions yet</strong>
                      <p>Your first recording will appear here.</p>
                      <button
                        className="small-link"
                        onClick={() => navigate("practice")}
                      >
                        Start practicing <Icon name="arrow" size={15} />
                      </button>
                    </div>
                  )}
                </section>
              </div>
              <section className="next-step-card">
                <div className="next-step-icon">
                  <Icon name="spark" size={22} />
                </div>
                <div>
                  <strong>Built for more confident speaking</strong>
                  <p>
                    Practice presentations, pitches, and interviews in one
                    place.
                  </p>
                </div>
                <button onClick={() => navigate("practice")}>
                  Explore the studio <Icon name="arrow" size={16} />
                </button>
              </section>
            </>
          )}
          {page === "practice" && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">PRACTICE STUDIO</span>
                  <h1>
                    Your stage, your pace<span className="heading-dot">.</span>
                  </h1>
                  <p>
                    Set up a run, press record, and speak like you would in the
                    room.
                  </p>
                </div>
              </div>
              <div className="studio-grid">
                <div className="studio-main">
                  <section className="panel setup-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">
                          01 / SET THE SCENE
                        </span>
                        <h3>What are you practicing?</h3>
                      </div>
                    </div>
                    <label className="field-label" htmlFor="session-title">
                      Session name
                    </label>
                    <input
                      id="session-title"
                      className="text-input"
                      type="text"
                      maxLength={80}
                      placeholder="e.g. My demo day presentation"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      disabled={isRecording || isSaving}
                    />
                    <div className="field-label category-label">
                      Practice type
                    </div>
                    <div className="category-options">
                      {categories.map((item) => (
                        <button
                          key={item}
                          className={`category-chip ${category === item ? "selected" : ""}`}
                          onClick={() => setCategory(item)}
                          disabled={isRecording || isSaving}
                        >
                          {item}
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="panel recording-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">
                          02 / RECORD YOUR RUN
                        </span>
                        <h3>Camera preview</h3>
                      </div>
                      <span
                        className={`record-status ${isRecording ? "recording" : ""}`}
                      >
                        <span />
                        {isRecording ? "Recording" : "Ready when you are"}
                      </span>
                    </div>
                    <div
                      className={`camera-stage ${isRecording ? "camera-active" : ""}`}
                    >
                      <video ref={videoRef} autoPlay muted playsInline />
                      {!isRecording && (
                        <div className="camera-placeholder">
                          <span className="camera-placeholder-icon">
                            <Icon name="camera" size={31} />
                          </span>
                          <strong>Your camera preview will appear here</strong>
                          <span>
                            Camera and microphone access begins when you start.
                          </span>
                        </div>
                      )}
                      {isRecording && (
                        <span className="camera-timer">
                          <span /> REC {formatDuration(elapsed)}
                        </span>
                      )}
                    </div>
                    <div className="recording-actions">
                      <div>
                        <strong>
                          {isRecording
                            ? "You’re doing great. Keep going."
                            : isSaving
                              ? "Saving your session…"
                              : "Ready to begin?"}
                        </strong>
                        <small>
                          {isRecording
                            ? "Speak naturally. You can stop whenever you like."
                            : "Find a quiet spot with good lighting."}
                        </small>
                      </div>
                      {isRecording ? (
                        <button
                          className="button button-stop"
                          onClick={stopRecording}
                        >
                          <Icon name="stop" size={17} /> Finish recording
                        </button>
                      ) : (
                        <button
                          className="button button-primary"
                          onClick={startRecording}
                          disabled={isSaving}
                        >
                          <Icon name="video" size={18} /> Start recording
                        </button>
                      )}
                    </div>
                  </section>
                  <section className="panel transcript-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">YOUR WORDS</span>
                        <h3>Live transcript</h3>
                      </div>
                      <span className="panel-tag">
                        Browser speech recognition
                      </span>
                    </div>
                    <p className="helper-copy">
                      {speechStatus ||
                        "When supported by your browser, your words will appear here while you record. You can edit the transcript after saving."}
                    </p>
                    <div className="transcript-preview">
                      {transcript || (
                        <span>
                          Start recording to see your transcript here...
                        </span>
                      )}
                    </div>
                  </section>
                </div>
                <aside className="studio-side">
                  <section className="panel measure-panel">
                    <span className="side-icon">
                      <Icon name="chart" size={22} />
                    </span>
                    <h3>What we can measure</h3>
                    <p>
                      Get a clearer picture of how you speak with every run.
                    </p>
                    <div className="measure-row">
                      <span className="measure-icon">
                        <Icon name="wave" size={17} />
                      </span>
                      <span>
                        <strong>Speaking pace</strong>
                        <small>
                          {isRecording
                            ? `${liveMetrics.wordsPerMinute} words / min`
                            : "Words per minute"}
                        </small>
                      </span>
                      <span className="live-pill">LIVE</span>
                    </div>
                    <div className="measure-row">
                      <span className="measure-icon">
                        <Icon name="mic" size={17} />
                      </span>
                      <span>
                        <strong>Filler words</strong>
                        <small>
                          {isRecording
                            ? `${liveMetrics.fillerCount} detected`
                            : "Um, uh, like & more"}
                        </small>
                      </span>
                      <span className="live-pill">LIVE</span>
                    </div>
                    <div className="measure-row future">
                      <span className="measure-icon">
                        <Icon name="heart" size={17} />
                      </span>
                      <span>
                        <strong>Body signals</strong>
                        <small>Pulse, breathing & expression</small>
                      </span>
                      <span className="soon-pill">SOON</span>
                    </div>
                    <div className="measure-note">
                      <Icon name="spark" size={17} />
                      <span>
                        Presage vitals and AI coaching will appear here when
                        connected.
                      </span>
                    </div>
                  </section>
                  <section className="panel presage-plan">
                    <span className="section-eyebrow">PRESAGE ROADMAP</span>
                    <h3>Body signals to add</h3>
                    <div>
                      <span>Pulse rate</span>
                      <strong>~12s warm-up</strong>
                    </div>
                    <div>
                      <span>Breathing rate</span>
                      <strong>~30s warm-up</strong>
                    </div>
                    <div>
                      <span>HRV</span>
                      <strong>~60s warm-up</strong>
                    </div>
                    <p>
                      Also planned: expression tracking, breathing and relative
                      arterial waveforms, confidence scores (0–100), and
                      measurement stability.
                    </p>
                  </section>
                  <section className="tip-card">
                    <span>✦ A QUICK TIP</span>
                    <h3>Pause. Breathe. Begin.</h3>
                    <p>
                      A short pause before your first sentence helps you settle
                      into your delivery.
                    </p>
                  </section>
                </aside>
              </div>
            </>
          )}
          {page === "history" && (
            <>
              <div className="page-heading history-heading">
                <div>
                  <span className="eyebrow">YOUR PRACTICE LIBRARY</span>
                  <h1>
                    {selected ? "Session review" : "Look how far you’ve come"}
                    <span className="heading-dot">.</span>
                  </h1>
                  <p>
                    {selected
                      ? "Review your recording and the details that matter."
                      : "Every attempt is part of your progress."}
                  </p>
                </div>
                <button
                  className="button button-primary"
                  onClick={() => navigate("practice")}
                >
                  <Icon name="plus" size={18} /> New session
                </button>
              </div>
              {selected ? (
                <div className="review-layout">
                  <div className="review-main">
                    <button
                      className="back-button"
                      onClick={() => setSelectedId(null)}
                    >
                      ← All sessions
                    </button>
                    <section className="panel review-card">
                      <div className="review-title">
                        <div>
                          <span className="section-eyebrow">
                            {selected.category.toUpperCase()} ·{" "}
                            {dateLabel(selected.createdAt)}
                          </span>
                          <h2>{selected.title}</h2>
                        </div>
                        <span className="review-duration">
                          <Icon name="clock" size={17} />{" "}
                          {formatDuration(selected.durationSeconds)}
                        </span>
                      </div>
                      {recordingUrl ? (
                        <video
                          className="playback-video"
                          src={recordingUrl}
                          controls
                          playsInline
                        />
                      ) : (
                        <div className="playback-empty">
                          <Icon name="video" size={27} />
                          <span>
                            {selected.hasRecording
                              ? recordingLoading
                                ? "Loading recording…"
                                : "Recording unavailable in this browser."
                              : "Video was not saved for this session."}
                          </span>
                        </div>
                      )}
                      <div className="review-actions">
                        <button
                          onClick={downloadSelected}
                          disabled={!selected.hasRecording}
                        >
                          <Icon name="download" size={17} /> Download video
                        </button>
                        <button
                          className="danger-action"
                          onClick={removeSelected}
                        >
                          <Icon name="trash" size={17} /> Delete session
                        </button>
                      </div>
                    </section>
                    <section className="panel review-transcript">
                      <div className="panel-header">
                        <div>
                          <span className="section-eyebrow">IN YOUR WORDS</span>
                          <h3>Transcript</h3>
                        </div>
                      </div>
                      <p className="helper-copy">
                        Edit or paste your transcript here. Speech metrics
                        update when you save.
                      </p>
                      <textarea
                        value={draftTranscript}
                        onChange={(event) =>
                          setDraftTranscript(event.target.value)
                        }
                        placeholder="No transcript captured. Paste or type one here to calculate speech metrics."
                      />
                      <button
                        className="button button-outline"
                        onClick={saveEditedTranscript}
                        disabled={
                          draftTranscript.trim() === selected.transcript
                        }
                      >
                        <Icon name="check" size={16} /> Save transcript
                      </button>
                    </section>
                  </div>
                  <aside className="review-side">
                    <section className="panel insights-panel">
                      <div className="panel-header">
                        <div>
                          <span className="section-eyebrow">AT A GLANCE</span>
                          <h3>Speech insights</h3>
                        </div>
                      </div>
                      <div className="insight-metric">
                        <span>Speaking pace</span>
                        <strong>
                          {selected.wordCount ? selected.wordsPerMinute : "—"}{" "}
                          <small>{selected.wordCount ? "WPM" : ""}</small>
                        </strong>
                      </div>
                      <div className="insight-metric">
                        <span>Words spoken</span>
                        <strong>{selected.wordCount}</strong>
                      </div>
                      <div className="insight-metric">
                        <span>Filler words</span>
                        <strong>{selected.fillerCount}</strong>
                      </div>
                      <div className="insight-note">
                        {selected.wordCount
                          ? "Metrics are calculated from the transcript and recording length."
                          : "Add a transcript to unlock speech insights."}
                      </div>
                    </section>
                    <section className="panel future-panel">
                      <span className="side-icon">
                        <Icon name="heart" size={20} />
                      </span>
                      <h3>Body signals</h3>
                      <p>
                        Pulse, HRV, breathing, expression, and confidence are
                        planned for the Presage integration.
                      </p>
                      <span className="soon-pill">COMING SOON</span>
                    </section>
                  </aside>
                </div>
              ) : (
                <section className="panel library-panel">
                  <div className="panel-header">
                    <div>
                      <span className="section-eyebrow">ALL YOUR RUNS</span>
                      <h3>
                        Practice sessions{" "}
                        <span className="count-soft">{sessions.length}</span>
                      </h3>
                    </div>
                  </div>
                  {sessions.length ? (
                    <div className="library-list">
                      {sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          onOpen={() => openSession(session.id)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="library-empty">
                      <span className="library-empty-icon">
                        <Icon name="video" size={30} />
                      </span>
                      <h3>Your story starts with one run</h3>
                      <p>
                        Record your first presentation or interview practice to
                        start building your library.
                      </p>
                      <button
                        className="button button-primary"
                        onClick={() => navigate("practice")}
                      >
                        Start practicing <Icon name="arrow" size={17} />
                      </button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button
            className={page === "overview" ? "active" : ""}
            onClick={() => navigate("overview")}
          >
            <Icon name="grid" size={20} />
            <span>Overview</span>
          </button>
          <button
            className={page === "practice" ? "active" : ""}
            onClick={() => navigate("practice")}
          >
            <Icon name="video" size={20} />
            <span>Practice</span>
          </button>
          <button
            className={page === "history" ? "active" : ""}
            onClick={() => navigate("history")}
          >
            <Icon name="history" size={20} />
            <span>History</span>
          </button>
        </nav>
      </main>
    </div>
  );
}
