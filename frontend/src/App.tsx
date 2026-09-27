import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import "./App.css";
import HistoryProgressCharts from "./components/HistoryProgressCharts";
import {
  analyzeTranscript,
  analyzeVitals,
  deleteAllRecordings,
  deleteRecording,
  getRecording,
  getSavedProjects,
  getSessions,
  saveRecording,
  saveProjects,
  saveSessions,
  transcribeRecording,
} from "./services/api";
import type {
  PracticeCategory,
  PracticeProject,
  PracticeSession,
} from "./types/interview";
import { extractMetrics, formatDuration } from "./utils/videoMetrics";
import { confidenceFor, samePractice } from "./utils/confidence";
import { breathingNote, dominantExpression } from "./utils/bodySignals";
import { projectIdFor, projectsFor, sessionsInProject } from "./utils/projects";
import { trendFor } from "./utils/trends";

type Page = "overview" | "practice" | "recording" | "history";
const pagePath: Record<Exclude<Page, "recording">, string> = {
  overview: "/",
  practice: "/practice",
  history: "/history",
};

function pageFromPath(path: string): Page {
  if (path === "/history") return "history";
  if (path.startsWith("/practice")) return "practice";
  return "overview";
}
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
  const points = trendFor(sessions, "pace").slice(-7);
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
  const max = Math.max(180, ...points.map((point) => point.value + 20));
  const coords = points.map((session, index) => ({
    x: points.length === 1 ? 300 : 48 + (index * 504) / (points.length - 1),
    y: 188 - (session.value / max) * 142,
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
            stroke="#598fe8"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {coords.map((point, index) => (
          <g key={points[index].session.id}>
            <circle
              cx={point.x}
              cy={point.y}
              r="7"
              fill="#598fe8"
              stroke="white"
              strokeWidth="3"
            />
            <title>
              {Math.round(points[index].value)} WPM ·{" "}
              {dateLabel(points[index].session.createdAt)}
            </title>
          </g>
        ))}
      </svg>
      <div className="chart-x-labels">
        <span>{dateLabel(points[0].session.createdAt)}</span>
        <span>{dateLabel(points[points.length - 1].session.createdAt)}</span>
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

function ProjectCards({
  projects,
  sessions,
  activeId,
  onSelect,
}: {
  projects: PracticeProject[];
  sessions: PracticeSession[];
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  if (!projects.length) return null;
  return (
    <div className="project-grid" aria-label="Practice projects">
      {projects.map((project) => {
        const attempts = sessionsInProject(sessions, project.id).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        const scored = trendFor(attempts, "confidence").map(
          (point) => point.value,
        );
        const latest = scored.at(-1) ?? null;
        const change = scored.length > 1 ? latest! - scored[0] : null;
        const stage =
          latest === null
            ? "unscored"
            : latest < 50
              ? "red"
              : latest < 75
                ? "yellow"
                : "green";
        return (
          <button
            key={project.id}
            type="button"
            className={`project-card ${activeId === project.id ? "active" : ""}`}
            onClick={() => onSelect(project.id)}
          >
            <span className="project-card-top">
              <span className="project-category">{project.category}</span>
              <span>
                {attempts.length} {attempts.length === 1 ? "run" : "runs"}
              </span>
            </span>
            <strong>{project.name}</strong>
            <span className="project-stage">
              <i className={`stage-dot ${stage}`} />
              {latest === null
                ? "Awaiting first score"
                : `${latest}/100 · ${stage === "red" ? "Build" : stage === "yellow" ? "Develop" : "Strong"}`}
            </span>
            <span className="project-scale" aria-hidden="true">
              <i className="scale-red" />
              <i className="scale-yellow" />
              <i className="scale-green" />
              {latest !== null && <b style={{ left: `${latest}%` }} />}
            </span>
            <small>
              {change === null
                ? "Record more runs to see improvement"
                : `${change > 0 ? "+" : ""}${change} points since first scored run`}
            </small>
          </button>
        );
      })}
    </div>
  );
}

function PracticeProgress({
  session,
  sessions,
  projectName,
}: {
  session: PracticeSession;
  sessions: PracticeSession[];
  projectName: string;
}) {
  const attempts = sessions
    .filter((item) => samePractice(item, session))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const currentIndex = attempts.findIndex((item) => item.id === session.id);
  const previous = currentIndex > 0 ? attempts[currentIndex - 1] : null;
  const currentScore = confidenceFor(session);
  const previousScore = previous ? confidenceFor(previous).score : null;
  const delta =
    currentScore.score !== null && previousScore !== null
      ? currentScore.score - previousScore
      : null;
  return (
    <section className="panel progress-panel">
      <span className="section-eyebrow">THIS PRACTICE</span>
      <h3>Overall confidence estimate</h3>
      <p className="helper-copy">
        A practice score from available speech and body signals. It does not
        measure how you feel.
      </p>
      <div className="confidence-value">
        {currentScore.score ?? "—"}
        <small>
          {currentScore.score !== null
            ? "/ 100"
            : "Add a transcript or body data"}
        </small>
      </div>
      <div
        className="confidence-scale"
        role="img"
        aria-label={
          currentScore.score === null
            ? "No score yet"
            : `Confidence estimate ${currentScore.score} out of 100, ${currentScore.stage} stage`
        }
      >
        <span className="scale-red" />
        <span className="scale-yellow" />
        <span className="scale-green" />
        {currentScore.score !== null && (
          <i
            className="scale-marker current"
            style={{ left: `${currentScore.score}%` }}
            title={`This attempt: ${currentScore.score}`}
          />
        )}
        {previousScore !== null && (
          <i
            className="scale-marker previous"
            style={{ left: `${previousScore}%` }}
            title={`Previous attempt: ${previousScore}`}
          />
        )}
      </div>
      <div className="scale-labels">
        <span>Build</span>
        <span>Develop</span>
        <span>Strong</span>
      </div>
      <p className="progress-comparison">
        Attempt {currentIndex + 1} of {attempts.length} in “{projectName}”
        {delta !== null
          ? ` · ${delta > 0 ? "+" : ""}${delta} points vs previous attempt`
          : " · First scored attempt"}
      </p>
      {attempts.length > 1 && (
        <div
          className="attempt-history"
          aria-label="Scores for this practice over time"
        >
          {attempts.map((item, index) => {
            const score = confidenceFor(item).score;
            return (
              <div
                key={item.id}
                className={
                  item.id === session.id ? "attempt active" : "attempt"
                }
                title={`Attempt ${index + 1}: ${score ?? "no score"}`}
              >
                <span style={{ height: `${score ?? 3}%` }} />
                <small>{index + 1}</small>
              </div>
            );
          })}
        </div>
      )}
      {currentScore.factors.length > 0 && (
        <div className="confidence-factors">
          {currentScore.factors.map((factor) => (
            <div key={factor.name}>
              <span>{factor.name}</span>
              <strong>{factor.score}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function VitalSummary({
  session,
  onRetry,
  busy,
}: {
  session: PracticeSession;
  onRetry: () => void;
  busy: boolean;
}) {
  const vitals = session.vitals;
  const reliable = (
    points: NonNullable<PracticeSession["vitals"]>["heartRate"],
  ) =>
    points.filter(
      (point) => point.stable && point.confidence >= 60 && point.value > 0,
    );
  const average = (
    points: NonNullable<PracticeSession["vitals"]>["heartRate"],
  ) => {
    const good = reliable(points);
    return good.length
      ? Math.round(
          good.reduce((sum, point) => sum + point.value, 0) / good.length,
        )
      : null;
  };
  const pulse = vitals ? average(vitals.heartRate) : null;
  const breath = vitals ? average(vitals.breathingRate) : null;
  const breathingHelp = breathingNote(session);
  const expression = dominantExpression(vitals);
  const trend = (
    points: NonNullable<PracticeSession["vitals"]>["heartRate"],
    name: string,
  ) => {
    const good = reliable(points);
    if (good.length < 2) return null;
    const values = good.map((point) => point.value);
    const min = Math.min(...values);
    const range = Math.max(1, Math.max(...values) - min);
    const first = good[0].timeSeconds;
    const seconds = Math.max(1, good[good.length - 1].timeSeconds - first);
    const coordinates = good
      .map(
        (point) =>
          `${Math.round(((point.timeSeconds - first) / seconds) * 240)},${Math.round(40 - ((point.value - min) / range) * 32)}`,
      )
      .join(" ");
    return (
      <div className="vital-trend">
        <svg
          viewBox="0 0 240 48"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${name} over this recording`}
        >
          <polyline
            points={coordinates}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </svg>
        <small>{good.length} stable readings</small>
      </div>
    );
  };
  return (
    <section className="panel vitals-panel">
      <span className="side-icon">
        <Icon name="heart" size={20} />
      </span>
      <h3>
        Body signals <small>Presage</small>
      </h3>
      {vitals?.durationSeconds ? (
        <p className="vital-hints">
          {vitals.durationSeconds} seconds analyzed ·{" "}
          {reliable(vitals.heartRate).length} reliable pulse readings ·{" "}
          {reliable(vitals.breathingRate).length} reliable breathing readings
        </p>
      ) : null}
      <div className="vital-row">
        <span>Heart rate</span>
        <strong>
          {pulse ?? "—"} <small>{pulse !== null ? "bpm" : ""}</small>
        </strong>
      </div>
      {vitals && trend(vitals.heartRate, "Heart rate")}
      <div className="vital-row">
        <span>Breathing rate</span>
        <strong>
          {breath ?? "—"} <small>{breath !== null ? "breaths/min" : ""}</small>
        </strong>
      </div>
      {vitals && trend(vitals.breathingRate, "Breathing rate")}
      {breathingHelp ? <p className="vital-hints">{breathingHelp}</p> : null}
      <div className="vital-row">
        <span>Camera-facing estimate</span>
        <strong>
          {vitals?.cameraFacingPercent ?? "—"}
          <small>{vitals?.cameraFacingPercent != null ? "%" : ""}</small>
        </strong>
      </div>
      <div className="vital-row">
        <span>Dominant expression</span>
        <strong>
          {expression?.label ?? "—"}{" "}
          <small>
            {expression ? `${expression.percent}% of the time` : ""}
          </small>
        </strong>
      </div>
      {expression?.others.length ? (
        <p className="vital-hints">Also: {expression.others.join(" · ")}</p>
      ) : null}
      <div className="vital-row">
        <span>Possible breath interruptions</span>
        <strong>{vitals?.possibleBreathInterruptions ?? "—"}</strong>
      </div>
      {session.category === "Interview" ? (
        <p>Interview practice uses a stronger camera-facing target (65%).</p>
      ) : (
        <p>
          {session.category} practice uses a looser camera-facing target.
          Looking at notes or across an audience is normal.
        </p>
      )}
      <p>
        Camera-facing is a rough face-landmark cue, not verified eye contact.
        Breathing measurements during speech can be unreliable; interruptions
        are prompts to review the video. The dominant expression is the one
        Presage scored highest for the most seconds; it describes your face, not
        how you feel.
      </p>
      {vitals?.hints?.length ? (
        <p className="vital-hints">Framing tips: {vitals.hints.join(" · ")}</p>
      ) : null}
      <button
        className="button button-outline"
        onClick={onRetry}
        disabled={!session.hasRecording || busy}
      >
        {busy
          ? "Analyzing…"
          : vitals
            ? "Reanalyze with Presage"
            : "Analyze with Presage"}
      </button>
    </section>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>(() =>
    pageFromPath(window.location.pathname),
  );
  const [sessions, setSessions] = useState<PracticeSession[]>(getSessions);
  const [savedProjects, setSavedProjects] =
    useState<PracticeProject[]>(getSavedProjects);
  const projects = useMemo(
    () => projectsFor(sessions, savedProjects),
    [sessions, savedProjects],
  );
  const [projectId, setProjectId] = useState("");
  const [historyProjectId, setHistoryProjectId] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const sessionsRef = useRef(sessions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [deletingRecordings, setDeletingRecordings] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<PracticeCategory>("Presentation");
  const [isRecording, setIsRecording] = useState(false);
  const [isRequesting, setIsRequesting] = useState(false);
  const [hasPreview, setHasPreview] = useState(false);
  const [setupConfirmed, setSetupConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isAnalyzingVitals, setIsAnalyzingVitals] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("preptalk.theme");
    return saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  });
  const logoSrc =
    theme === "dark" ? "/dark-mode-icon.png" : "/light-mode-icon.png";
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [draftTranscript, setDraftTranscript] = useState("");
  const [status, setStatus] = useState("");
  const [speechStatus, setSpeechStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const popoutRef = useRef<HTMLElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const speechRef = useRef<SpeechEngine | null>(null);
  const transcriptRef = useRef("");
  const startedAtRef = useRef(0);
  const recordingRef = useRef(false);
  const captureRequestedRef = useRef(false);

  const selected =
    sessions.find((session) => session.id === selectedId) ?? null;
  const selectedProject = projects.find((project) => project.id === projectId);
  const activeHistoryProject =
    projects.find((project) => project.id === historyProjectId) ?? projects[0];
  const projectSessions = activeHistoryProject
    ? sessionsInProject(sessions, activeHistoryProject.id)
    : [];
  const totalMinutes = Math.round(
    sessions.reduce((total, session) => total + session.durationSeconds, 0) /
      60,
  );
  const measuredPace = trendFor(sessions, "pace");
  const averageWpm = measuredPace.length
    ? Math.round(
        measuredPace.reduce((total, point) => total + point.value, 0) /
          measuredPace.length,
      )
    : 0;
  const liveMetrics = useMemo(
    () => extractMetrics(transcript, elapsed),
    [transcript, elapsed],
  );

  const commitSessions = useCallback((next: PracticeSession[]) => {
    sessionsRef.current = next;
    setSessions(next);
    try {
      saveSessions(next);
      return true;
    } catch {
      setStatus(
        "Session details could not be saved in this browser. Check available storage.",
      );
      return false;
    }
  }, []);

  useEffect(() => {
    if (
      projects.length &&
      !projects.some((project) => project.id === projectId)
    ) {
      setProjectId(projects[0].id);
    }
  }, [projects, projectId]);

  function createProject() {
    const name = newProjectName.trim();
    if (!name) {
      setStatus("Give your project a name first.");
      return;
    }
    const project: PracticeProject = {
      id: crypto.randomUUID(),
      name,
      category,
      createdAt: new Date().toISOString(),
    };
    const next = [project, ...savedProjects];
    try {
      saveProjects(next);
    } catch {
      setStatus(
        "The project could not be saved in this browser. Check available storage.",
      );
      return;
    }
    setSavedProjects(next);
    setProjectId(project.id);
    setHistoryProjectId(project.id);
    setNewProjectName("");
    setCreatingProject(false);
    setStatus("");
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0c172b" : "#f4f8ff");
    document.querySelector('link[rel="icon"]')?.setAttribute("href", logoSrc);
    localStorage.setItem("preptalk.theme", theme);
  }, [theme, logoSrc]);

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

  useEffect(() => {
    if (window.location.pathname === "/practice/record") {
      window.history.replaceState(null, "", "/practice");
    }
  }, []);

  useEffect(() => {
    if (page !== "recording") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    popoutRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [page]);

  useEffect(() => {
    const onPopState = () => {
      if (recordingRef.current || isRequesting || isSaving) {
        window.history.pushState(null, "", "/practice/record");
        setStatus("Finish this recording before leaving the studio.");
        return;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setHasPreview(false);
        setSetupConfirmed(false);
      }
      setPage(pageFromPath(window.location.pathname));
      setSelectedId(null);
      setStatus("");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isRequesting, isSaving]);

  function navigate(next: Page) {
    if (next === "recording") return;
    if (isRecording || isRequesting || isSaving) {
      setStatus("Finish saving this recording before leaving the studio.");
      return;
    }
    if (page === "recording") {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setHasPreview(false);
      setSetupConfirmed(false);
    }
    if (window.location.pathname !== pagePath[next]) {
      window.history.pushState(null, "", pagePath[next]);
    }
    setPage(next);
    setSelectedId(null);
    setStatus("");
  }

  const openSession = useCallback((id: string, preserveStatus = false) => {
    setSelectedId(id);
    const session = sessionsRef.current.find((item) => item.id === id);
    if (session) setHistoryProjectId(projectIdFor(session));
    setDraftTranscript(session?.transcript ?? "");
    window.history.pushState(null, "", "/history");
    setPage("history");
    if (!preserveStatus) setStatus("");
  }, []);

  const updateTranscript = useCallback((value: string) => {
    transcriptRef.current = value;
    setTranscript(value);
  }, []);

  function enterRecording() {
    if (!selectedProject) {
      setStatus("Choose or create a project first.");
      return;
    }
    if (!title.trim()) {
      setStatus("Give this practice run a name first.");
      return;
    }
    captureRequestedRef.current = true;
    setIsRequesting(true);
    setSetupConfirmed(false);
    setHasPreview(false);
    window.history.pushState(null, "", "/practice/record");
    setPage("recording");
    setStatus("");
  }

  const openPreview = useCallback(async () => {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setStatus(
        "This browser cannot record video. Try a current version of Chrome, Edge, or Safari.",
      );
      setIsRequesting(false);
      return;
    }
    setIsRequesting(true);
    setStatus("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      stream.getVideoTracks()[0]?.addEventListener(
        "ended",
        () => {
          setHasPreview(false);
          setSetupConfirmed(false);
        },
        { once: true },
      );
      setHasPreview(true);
      setSetupConfirmed(false);
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus(
        "Camera and microphone access is needed. Check browser permissions and try again.",
      );
      setHasPreview(false);
    } finally {
      setIsRequesting(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!setupConfirmed) {
      setStatus("Confirm your camera setup before starting a recording.");
      return;
    }
    const currentProject = projects.find((project) => project.id === projectId);
    if (!currentProject) {
      setStatus("Choose or create a project first.");
      setIsRequesting(false);
      return;
    }
    if (!title.trim()) {
      setStatus("Give this practice run a name first.");
      setIsRequesting(false);
      return;
    }
    const stream = streamRef.current;
    if (
      !stream ||
      stream.getVideoTracks().some((track) => track.readyState !== "live")
    ) {
      setSetupConfirmed(false);
      setStatus(
        "The camera disconnected. Reopen the preview and confirm your setup again.",
      );
      return;
    }
    setStatus("");
    setSpeechStatus("");
    setElapsed(0);
    updateTranscript("");
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
      setHasPreview(false);
      setSetupConfirmed(false);
      setStatus("Recording could not start on this device.");
      setIsRequesting(false);
      return;
    }
    recorderRef.current = recorder;
    const currentTitle = title.trim();
    const currentCategory = currentProject.category;
    const currentProjectId = currentProject.id;
    startedAtRef.current = Date.now();
    recordingRef.current = true;
    setIsRecording(true);
    setIsRequesting(false);
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
      let text = transcriptRef.current.trim();
      let transcriptSource: PracticeSession["transcriptSource"] = text
        ? "browser"
        : undefined;
      let fillerWords: PracticeSession["fillerWords"];
      let vitals: PracticeSession["vitals"];
      const initialMetrics = extractMetrics(text, durationSeconds);
      const initialSession: PracticeSession = {
        id,
        title: currentTitle,
        category: currentCategory,
        projectId: currentProjectId,
        createdAt: new Date().toISOString(),
        durationSeconds,
        transcript: text,
        transcriptSource,
        wordCount: initialMetrics.wordCount,
        wordsPerMinute: initialMetrics.wordsPerMinute,
        fillerCount: initialMetrics.fillerCount,
        hasRecording,
      };
      commitSessions([initialSession, ...sessionsRef.current]);
      setIsSaving(false);
      setTitle("");
      openSession(id, true);
      if (blob.size) {
        setStatus(
          "Recording saved. ElevenLabs, Gemini, and Presage are analyzing it.",
        );
        const [transcription, bodyAnalysis] = await Promise.allSettled([
          transcribeRecording(blob),
          analyzeVitals(blob, initialSession),
        ]);
        const messages: string[] = [];
        if (transcription.status === "fulfilled") {
          const result = transcription.value;
          text = result.text.trim();
          transcriptSource = "elevenlabs";
          fillerWords = result.fillerWords ?? undefined;
          messages.push(
            result.analysisError
              ? `Transcript ready. ${result.analysisError}`
              : "Transcript and Gemini analysis ready.",
          );
        } else {
          messages.push(
            transcription.reason instanceof Error
              ? transcription.reason.message
              : "Transcription failed.",
          );
        }
        if (bodyAnalysis.status === "fulfilled") {
          vitals = bodyAnalysis.value;
          messages.push("Presage body signals ready.");
        } else
          messages.push(
            bodyAnalysis.reason instanceof Error
              ? bodyAnalysis.reason.message
              : "Presage analysis failed.",
          );
        setStatus(messages.join(" "));
      }
      const metrics = extractMetrics(text, durationSeconds);
      const transcriptIsUnchanged =
        sessionsRef.current.find((session) => session.id === id)?.transcript ===
        initialSession.transcript;
      commitSessions(
        sessionsRef.current.map((session) =>
          session.id === id
            ? {
                ...session,
                ...(transcriptIsUnchanged
                  ? {
                      transcript: text,
                      transcriptSource,
                      wordCount: metrics.wordCount,
                      wordsPerMinute: metrics.wordsPerMinute,
                      fillerCount: fillerWords
                        ? fillerWords.reduce((sum, item) => sum + item.count, 0)
                        : metrics.fillerCount,
                      fillerWords,
                    }
                  : {}),
                vitals,
              }
            : session,
        ),
      );
      if (transcriptIsUnchanged) setDraftTranscript(text);
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
  }, [
    setupConfirmed,
    projects,
    projectId,
    commitSessions,
    openSession,
    title,
    updateTranscript,
  ]);

  useEffect(() => {
    if (page !== "recording" || !captureRequestedRef.current) return;
    captureRequestedRef.current = false;
    void openPreview();
  }, [page, openPreview]);

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
    setHasPreview(false);
    setSetupConfirmed(false);
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
              transcriptSource: "manual" as const,
              wordCount: metrics.wordCount,
              wordsPerMinute: metrics.wordsPerMinute,
              fillerCount: metrics.fillerCount,
              fillerWords: undefined,
            }
          : session,
      ),
    );
    setStatus(
      "Transcript updated. Run Gemini analysis again for this version.",
    );
  }

  async function retryTranscription() {
    if (!selected?.hasRecording) return;
    setIsTranscribing(true);
    try {
      const blob = await getRecording(selected.id);
      if (!blob) throw new Error("Recording unavailable in this browser.");
      const result = await transcribeRecording(blob);
      const text = result.text.trim();
      const metrics = extractMetrics(text, selected.durationSeconds);
      commitSessions(
        sessions.map((session) =>
          session.id === selected.id
            ? {
                ...session,
                transcript: text,
                transcriptSource: "elevenlabs" as const,
                wordCount: metrics.wordCount,
                wordsPerMinute: metrics.wordsPerMinute,
                fillerCount: result.fillerWords
                  ? result.fillerWords.reduce(
                      (sum, item) => sum + item.count,
                      0,
                    )
                  : metrics.fillerCount,
                fillerWords: result.fillerWords ?? undefined,
              }
            : session,
        ),
      );
      setDraftTranscript(text);
      setStatus(
        result.analysisError
          ? `Transcript ready. ${result.analysisError}`
          : "Transcript and Gemini filler analysis are ready.",
      );
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Transcription failed.",
      );
    } finally {
      setIsTranscribing(false);
    }
  }

  async function retryFillerAnalysis() {
    if (!selected?.transcript.trim()) return;
    const sessionId = selected.id;
    const text = selected.transcript;
    setIsAnalyzing(true);
    try {
      const fillerWords = await analyzeTranscript(text);
      commitSessions(
        sessionsRef.current.map((session) =>
          session.id === sessionId && session.transcript === text
            ? {
                ...session,
                fillerWords,
                fillerCount: fillerWords.reduce(
                  (sum, item) => sum + item.count,
                  0,
                ),
              }
            : session,
        ),
      );
      setStatus("Gemini filler analysis is ready.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Filler analysis failed.",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function retryVitals() {
    if (!selected?.hasRecording) return;
    const sessionId = selected.id;
    setIsAnalyzingVitals(true);
    try {
      const blob = await getRecording(sessionId);
      if (!blob) throw new Error("Recording unavailable in this browser.");
      const vitals = await analyzeVitals(blob, selected);
      commitSessions(
        sessionsRef.current.map((session) =>
          session.id === sessionId ? { ...session, vitals } : session,
        ),
      );
      setStatus("Presage body signals are ready.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Presage analysis failed.",
      );
    } finally {
      setIsAnalyzingVitals(false);
    }
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

  async function removeAllRecordings() {
    if (
      deletingRecordings ||
      !window.confirm(
        "Delete every saved video in this browser? Session notes and scores will remain.",
      )
    )
      return;
    setDeletingRecordings(true);
    try {
      await deleteAllRecordings();
      const saved = commitSessions(
        sessionsRef.current.map((session) => ({
          ...session,
          hasRecording: false,
        })),
      );
      setRecordingUrl(null);
      if (saved)
        setStatus(
          "All saved videos were deleted from this browser. Session notes and scores remain.",
        );
    } catch {
      setStatus("Could not delete the saved videos. Please try again.");
    } finally {
      setDeletingRecordings(false);
    }
  }

  return (
    <div className="app-shell" inert={page === "recording"}>
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="PrepTalk home"
        >
          <img className="brand-image" src={logoSrc} alt="" />
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
            className={`nav-item ${page === "practice" || page === "recording" ? "active" : ""}`}
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
            <img className="brand-image" src={logoSrc} alt="preppt." />
          </div>
          <div className="breadcrumb">
            Workspace <Icon name="chevron" size={14} />{" "}
            <strong>
              {page === "overview"
                ? "Overview"
                : page === "practice"
                  ? "Practice studio"
                  : page === "recording"
                    ? "Recording"
                    : "Session history"}
            </strong>
          </div>
          <div className="topbar-right">
            <button
              className="theme-toggle"
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            >
              {theme === "dark" ? "☀ Light" : "☾ Dark"}
            </button>
            <span className="local-badge">
              <span /> Local workspace
            </span>
            <span className="avatar top-avatar">Y</span>
          </div>
        </header>
        <div className="page-content">
          {status && page !== "recording" && (
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
                  <span className="stat-icon blue">
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
              {projects.length > 0 && (
                <section className="projects-section">
                  <div className="panel-header">
                    <div>
                      <span className="section-eyebrow">YOUR PROJECTS</span>
                      <h3>Keep improving, one project at a time</h3>
                    </div>
                  </div>
                  <ProjectCards
                    projects={projects}
                    sessions={sessions}
                    onSelect={(id) => {
                      setHistoryProjectId(id);
                      navigate("history");
                    }}
                  />
                </section>
              )}
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
          {(page === "practice" || page === "recording") && (
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
                    <label className="field-label" htmlFor="project-select">
                      Project
                    </label>
                    <div className="project-select-row">
                      <select
                        id="project-select"
                        className="text-input"
                        value={selectedProject?.id ?? ""}
                        onChange={(event) => {
                          setProjectId(event.target.value);
                          setCreatingProject(false);
                        }}
                        disabled={isRecording || isSaving}
                      >
                        {!projects.length && (
                          <option value="">Create your first project</option>
                        )}
                        {projects.map((project) => (
                          <option value={project.id} key={project.id}>
                            {project.name} · {project.category}
                          </option>
                        ))}
                      </select>
                      <button
                        className="button button-outline"
                        type="button"
                        onClick={() => setCreatingProject((value) => !value)}
                        disabled={isRecording || isSaving}
                      >
                        <Icon name="plus" size={16} /> New project
                      </button>
                    </div>
                    {creatingProject && (
                      <div className="new-project-form">
                        <label
                          className="field-label"
                          htmlFor="new-project-name"
                        >
                          Project name
                        </label>
                        <input
                          id="new-project-name"
                          className="text-input"
                          type="text"
                          maxLength={80}
                          placeholder="e.g. Summer internship interview"
                          value={newProjectName}
                          onChange={(event) =>
                            setNewProjectName(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") createProject();
                          }}
                        />
                        <div className="field-label category-label">
                          Practice type
                        </div>
                        <div className="category-options">
                          {categories.map((item) => (
                            <button
                              key={item}
                              type="button"
                              className={`category-chip ${category === item ? "selected" : ""}`}
                              onClick={() => setCategory(item)}
                            >
                              {item}
                            </button>
                          ))}
                        </div>
                        <button
                          className="button button-primary"
                          type="button"
                          onClick={createProject}
                        >
                          Create project
                        </button>
                      </div>
                    )}
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
                      list="previous-practice-titles"
                    />
                    <datalist id="previous-practice-titles">
                      {[
                        ...new Set(
                          sessions
                            .filter((item) => projectIdFor(item) === projectId)
                            .map((item) => item.title),
                        ),
                      ].map((item) => (
                        <option key={item} value={item} />
                      ))}
                    </datalist>
                    <p className="helper-copy">
                      Each run in this project contributes to its progress over
                      time.
                    </p>
                    {selectedProject && (
                      <p className="project-type">
                        Practice type: {selectedProject.category}
                      </p>
                    )}
                  </section>
                  <section className="panel recording-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">
                          02 / RECORD YOUR RUN
                        </span>
                        <h3>Ready for the camera?</h3>
                      </div>
                      <span className="record-status">
                        <span /> Camera is off
                      </span>
                    </div>
                    <div className="camera-stage">
                      <div className="camera-placeholder">
                        <span className="camera-placeholder-icon">
                          <Icon name="camera" size={31} />
                        </span>
                        <strong>Your recording space is one step away</strong>
                        <span>
                          The next page asks for camera and microphone access.
                        </span>
                      </div>
                    </div>
                    <div className="recording-actions">
                      <div>
                        <strong>Ready to begin?</strong>
                        <small>Recording starts after you allow access.</small>
                      </div>
                      <button
                        className="button button-primary"
                        onClick={enterRecording}
                      >
                        <Icon name="camera" size={18} /> Open camera setup
                      </button>
                    </div>
                  </section>
                  <section className="panel transcript-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">AFTER YOUR RUN</span>
                        <h3>Transcript and insights</h3>
                      </div>
                      <span className="panel-tag">ElevenLabs Scribe v2</span>
                    </div>
                    <p className="helper-copy">
                      After recording, ElevenLabs turns your speech into a
                      transcript. You can review and edit it with your video.
                    </p>
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
                    <div className="measure-row">
                      <span className="measure-icon">
                        <Icon name="heart" size={17} />
                      </span>
                      <span>
                        <strong>Body signals</strong>
                        <small>Pulse, breathing & camera-facing estimate</small>
                      </span>
                      <span className="panel-tag">AFTER RUN</span>
                    </div>
                    <div className="measure-note">
                      <Icon name="spark" size={17} />
                      <span>
                        Presage analyzes the saved video. Longer recordings give
                        pulse and breathing time to warm up.
                      </span>
                    </div>
                  </section>
                  <section className="panel presage-plan">
                    <span className="section-eyebrow">
                      PRESAGE BODY SIGNALS
                    </span>
                    <h3>What to expect</h3>
                    <div>
                      <span>Pulse rate</span>
                      <strong>~12s warm-up</strong>
                    </div>
                    <div>
                      <span>Breathing rate</span>
                      <strong>~30s warm-up</strong>
                    </div>
                    <p>
                      Keep your face and upper chest in frame. Unstable
                      measurements are excluded from the confidence estimate.
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
          {page === "recording" &&
            createPortal(
              <div className="recording-popout-backdrop">
                <section
                  ref={popoutRef}
                  className="recording-popout"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="recording-popout-title"
                  aria-describedby="recording-popout-description"
                  tabIndex={-1}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Escape" &&
                      !isRecording &&
                      !isRequesting &&
                      !isSaving
                    ) {
                      event.preventDefault();
                      navigate("practice");
                    }
                  }}
                >
                  <header className="recording-popout-header">
                    <div>
                      <span className="section-eyebrow">RECORDING STUDIO</span>
                      <h2 id="recording-popout-title">
                        {title || "Your practice run"}
                      </h2>
                      <p id="recording-popout-description">
                        Check your lighting and framing, then start the
                        recording when you are ready.
                      </p>
                    </div>
                    <button
                      className="popout-close"
                      type="button"
                      aria-label="Close recording window"
                      onClick={() => navigate("practice")}
                      disabled={isRecording || isRequesting || isSaving}
                    >
                      <Icon name="close" size={20} />
                    </button>
                  </header>
                  {status && (
                    <div
                      className="status-banner popout-status-banner"
                      role="status"
                    >
                      <span>{status}</span>
                      <button
                        type="button"
                        aria-label="Dismiss message"
                        onClick={() => setStatus("")}
                      >
                        <Icon name="close" size={16} />
                      </button>
                    </div>
                  )}
                  <div className="recording-popout-body">
                    <div className="recording-camera-column">
                      <div className="recording-popout-toolbar">
                        <span
                          className={`record-status ${isRecording ? "recording" : ""}`}
                        >
                          <span />
                          {isRecording
                            ? "Recording"
                            : isRequesting
                              ? "Waiting for permission"
                              : isSaving
                                ? "Processing"
                                : hasPreview
                                  ? "Camera preview"
                                  : "Camera is off"}
                        </span>
                        <span className="framing-label">FRAMING GUIDE</span>
                      </div>
                      <div className="camera-stage popout-camera-stage">
                        <video ref={videoRef} autoPlay muted playsInline />
                        {hasPreview && (
                          <>
                            <div
                              className="chest-framing-guide"
                              aria-hidden="true"
                            >
                              <span>HEAD + UPPER CHEST</span>
                            </div>
                            {isRecording && (
                              <span className="camera-timer">
                                <span /> REC {formatDuration(elapsed)}
                              </span>
                            )}
                          </>
                        )}
                        {!hasPreview && (
                          <div className="camera-placeholder">
                            <span className="camera-placeholder-icon">
                              <Icon name="camera" size={31} />
                            </span>
                            <strong>
                              {isRequesting
                                ? "Allow access in your browser"
                                : isSaving
                                  ? "Saving your recording"
                                  : "Camera is off"}
                            </strong>
                            <span>
                              {isRequesting
                                ? "Your browser will ask for camera and microphone permission."
                                : isSaving
                                  ? "ElevenLabs, Gemini, and Presage are preparing your results."
                                  : "Use the button below to open the preview."}
                            </span>
                          </div>
                        )}
                      </div>
                      {hasPreview && !isRecording && !isSaving && (
                        <label className="camera-confirmation">
                          <input
                            type="checkbox"
                            checked={setupConfirmed}
                            onChange={(event) =>
                              setSetupConfirmed(event.target.checked)
                            }
                          />
                          <span>
                            My face and upper chest are visible, and the
                            lighting is even.
                          </span>
                        </label>
                      )}
                      <div className="recording-popout-footer">
                        <div className="framing-instruction">
                          <Icon name="camera" size={18} />
                          <span>
                            {isRecording
                              ? "Keep your head and upper chest in frame."
                              : "Use the preview to check your setup before recording."}
                          </span>
                        </div>
                        {isRecording ? (
                          <button
                            className="button button-stop"
                            onClick={stopRecording}
                          >
                            <Icon name="stop" size={17} /> Finish recording
                          </button>
                        ) : !hasPreview ? (
                          <button
                            className="button button-primary"
                            onClick={() => void openPreview()}
                            disabled={isRequesting || isSaving}
                          >
                            <Icon name="camera" size={18} />
                            {isRequesting
                              ? "Waiting…"
                              : isSaving
                                ? "Processing…"
                                : "Open camera preview"}
                          </button>
                        ) : (
                          <button
                            className="button button-primary"
                            onClick={() => void startRecording()}
                            disabled={!setupConfirmed || isSaving}
                          >
                            <Icon name="video" size={18} /> Start recording
                          </button>
                        )}
                      </div>
                    </div>
                    <aside className="recording-popout-side">
                      <section className="popout-side-card">
                        <span className="section-eyebrow">YOUR WORDS</span>
                        <h3>Live preview</h3>
                        <p>
                          {speechStatus ||
                            "Browser speech recognition may show a preview. ElevenLabs creates the saved transcript after you finish."}
                        </p>
                        <div className="transcript-preview">
                          {transcript || (
                            <span>
                              Your words will appear here if browser speech
                              recognition is available.
                            </span>
                          )}
                        </div>
                      </section>
                      <section className="popout-side-card popout-metrics">
                        <span className="section-eyebrow">LIVE ESTIMATES</span>
                        <h3>Speaking insights</h3>
                        <div className="insight-metric">
                          <span>Speaking pace</span>
                          <strong>
                            {liveMetrics.wordsPerMinute} <small>WPM</small>
                          </strong>
                        </div>
                        <div className="insight-metric">
                          <span>Filler words</span>
                          <strong>{liveMetrics.fillerCount}</strong>
                        </div>
                        <p>
                          Final insights use the ElevenLabs transcript and
                          Gemini analysis.
                        </p>
                      </section>
                    </aside>
                  </div>
                </section>
              </div>,
              document.body,
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
                <div className="history-heading-actions">
                  <button
                    className="button button-outline"
                    onClick={() => void removeAllRecordings()}
                    disabled={deletingRecordings}
                  >
                    <Icon name="trash" size={17} />{" "}
                    {deletingRecordings
                      ? "Deleting videos…"
                      : "Delete all videos"}
                  </button>
                  <button
                    className="button button-primary"
                    onClick={() => navigate("practice")}
                  >
                    <Icon name="plus" size={18} /> New session
                  </button>
                </div>
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
                          onClick={() => void retryTranscription()}
                          disabled={
                            !selected.hasRecording ||
                            isTranscribing ||
                            isAnalyzing
                          }
                        >
                          <Icon name="mic" size={17} />
                          {isTranscribing
                            ? "Transcribing…"
                            : "Transcribe with ElevenLabs"}
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
                        {selected.transcriptSource && (
                          <span className="panel-tag">
                            {selected.transcriptSource === "elevenlabs"
                              ? "ElevenLabs Scribe v2"
                              : selected.transcriptSource === "browser"
                                ? "Browser preview"
                                : "Edited by you"}
                          </span>
                        )}
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
                          draftTranscript.trim() === selected.transcript ||
                          isAnalyzing ||
                          isTranscribing
                        }
                      >
                        <Icon name="check" size={16} /> Save transcript
                      </button>
                    </section>
                  </div>
                  <aside className="review-side">
                    <PracticeProgress
                      session={selected}
                      sessions={sessions}
                      projectName={
                        projects.find(
                          (project) => project.id === projectIdFor(selected),
                        )?.name ?? selected.title
                      }
                    />
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
                      {selected.fillerWords && (
                        <div className="filler-list">
                          {selected.fillerWords.length ? (
                            selected.fillerWords.map((item) => (
                              <div
                                className="filler-row"
                                key={`${item.kind}-${item.phrase}`}
                              >
                                <span>{item.phrase}</span>
                                <small>
                                  {item.kind === "repetition"
                                    ? "Repeated words"
                                    : "Filler"}
                                </small>
                                <strong>×{item.count}</strong>
                              </div>
                            ))
                          ) : (
                            <p>
                              Gemini found no filler words in this transcript.
                            </p>
                          )}
                        </div>
                      )}
                      {selected.transcript && (
                        <button
                          className="button button-outline analyze-button"
                          onClick={() => void retryFillerAnalysis()}
                          disabled={
                            isAnalyzing ||
                            isTranscribing ||
                            draftTranscript.trim() !== selected.transcript
                          }
                        >
                          <Icon name="spark" size={16} />
                          {isAnalyzing
                            ? "Analyzing…"
                            : selected.fillerWords
                              ? "Reanalyze with Gemini"
                              : "Analyze fillers with Gemini"}
                        </button>
                      )}
                      <div className="insight-note">
                        {selected.wordCount
                          ? selected.fillerWords
                            ? "Gemini uses context to identify filler phrases and repeated words. Speaking pace uses the transcript and recording length."
                            : "Filler count is a basic local estimate until Gemini analysis is available. Speaking pace uses the transcript and recording length."
                          : "Add a transcript to unlock speech insights."}
                      </div>
                    </section>
                    <VitalSummary
                      session={selected}
                      onRetry={() => void retryVitals()}
                      busy={isAnalyzingVitals}
                    />
                  </aside>
                </div>
              ) : (
                <>
                  <section className="projects-section">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">YOUR PROJECTS</span>
                        <h3>Choose a project to see your progress</h3>
                      </div>
                      <button
                        className="text-link"
                        onClick={() => {
                          setCreatingProject(true);
                          navigate("practice");
                        }}
                      >
                        New project <Icon name="plus" size={16} />
                      </button>
                    </div>
                    <ProjectCards
                      projects={projects}
                      sessions={sessions}
                      activeId={activeHistoryProject?.id}
                      onSelect={setHistoryProjectId}
                    />
                  </section>
                  <section className="panel library-panel">
                    <div className="panel-header">
                      <div>
                        <span className="section-eyebrow">
                          {activeHistoryProject?.name.toUpperCase() ??
                            "YOUR RUNS"}
                        </span>
                        <h3>
                          Practice sessions{" "}
                          <span className="count-soft">
                            {projectSessions.length}
                          </span>
                        </h3>
                      </div>
                    </div>
                    {projectSessions.length ? (
                      <div className="library-list">
                        {projectSessions.map((session) => (
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
                          Record your first presentation or interview practice
                          to start building your library.
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
                </>
              )}
              {activeHistoryProject && (
                <HistoryProgressCharts
                  sessions={projectSessions}
                  projectName={activeHistoryProject.name}
                />
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
            className={
              page === "practice" || page === "recording" ? "active" : ""
            }
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
