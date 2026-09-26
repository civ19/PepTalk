export type PracticeCategory = "Presentation" | "Interview" | "Pitch";

export interface PracticeSession {
  id: string;
  title: string;
  category: PracticeCategory;
  createdAt: string;
  durationSeconds: number;
  transcript: string;
  wordCount: number;
  wordsPerMinute: number;
  fillerCount: number;
  hasRecording: boolean;
}
