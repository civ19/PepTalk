export type PracticeCategory = "Presentation" | "Interview" | "Pitch";

export interface FillerWord {
  phrase: string;
  count: number;
  kind: "filler" | "repetition";
}

export interface VitalPoint {
  timeSeconds: number;
  value: number;
  confidence: number;
  stable: boolean;
}

export interface VitalsResult {
  heartRate: VitalPoint[];
  breathingRate: VitalPoint[];
  cameraFacingPercent: number | null;
  cameraFacingSamples: number;
  possibleBreathInterruptions: number;
  hints: string[];
}

export interface PracticeSession {
  id: string;
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
  hasRecording: boolean;
  vitals?: VitalsResult;
}
