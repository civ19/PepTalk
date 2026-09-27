export type PracticeCategory = "Presentation" | "Interview" | "Other" | "Pitch";

export interface ProjectFile {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface PracticeProject {
  id: string;
  name: string;
  category: PracticeCategory;
  createdAt: string;
  contextNotes?: string;
  files?: ProjectFile[];
}

export interface FillerWord {
  phrase: string;
  count: number;
  kind: "filler" | "repetition";
}

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface CoachingReport {
  summary: string;
  strengths: string[];
  priorities: {
    issue: string;
    evidence: string;
    action: string;
    timestampSeconds: number | null;
  }[];
  progressComparedToPrevious: string;
  estimatedPracticesRemaining: { count: number; reason: string };
  suggestedInterviewQuestions: string[];
}

export interface CoachingFeedback {
  id: string;
  generatedAt: string;
  report: CoachingReport;
  /** Complete model text, retained so repeat analyses never replace earlier advice. */
  rawResponse: string;
}

export interface VitalPoint {
  timeSeconds: number;
  value: number;
  confidence: number;
  stable: boolean;
}

export type ExpressionName =
  | "angry"
  | "contempt"
  | "disgust"
  | "fear"
  | "happy"
  | "neutral"
  | "sad"
  | "surprise";

export interface ExpressionShare {
  name: ExpressionName;
  /** Percent of the measured seconds in which this expression scored highest. */
  percent: number;
}

export interface VitalsResult {
  durationSeconds?: number;
  heartRate: VitalPoint[];
  breathingRate: VitalPoint[];
  validation?: { timeSeconds: number; code: number; hint: string }[];
  cameraFacing?: { timeSeconds: number; facing: boolean }[];
  /** Missing on sessions analyzed before expressions were measured. */
  dominantExpression?: ExpressionName | null;
  expressionShares?: ExpressionShare[];
  cameraFacingPercent: number | null;
  cameraFacingSamples: number;
  possibleBreathInterruptions: number;
  hints: string[];
}

export interface PracticeSession {
  id: string;
  projectId?: string;
  title: string;
  category: PracticeCategory;
  createdAt: string;
  durationSeconds: number;
  transcript: string;
  transcriptSource?: "elevenlabs" | "browser" | "manual";
  wordCount: number;
  wordsPerMinute: number;
  fillerCount: number;
  fillerWords?: FillerWord[];
  timedWords?: TimedWord[];
  feedbackHistory?: CoachingFeedback[];
  hasRecording: boolean;
  vitals?: VitalsResult;
}
