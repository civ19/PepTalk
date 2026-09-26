export interface SpeechMetrics {
  wordCount: number;
  wordsPerMinute: number;
  fillerCount: number;
  fillerBreakdown: { word: string; count: number }[];
}

const fillerPatterns = [
  { word: "um", expression: /\bum\b/gi },
  { word: "uh", expression: /\buh\b/gi },
  { word: "like", expression: /\blike\b/gi },
  { word: "you know", expression: /\byou know\b/gi },
  { word: "actually", expression: /\bactually\b/gi },
];

export function extractMetrics(
  transcript: string,
  durationSeconds = 0,
): SpeechMetrics {
  const wordCount = transcript.trim()
    ? transcript.trim().split(/\s+/).length
    : 0;
  const fillerBreakdown = fillerPatterns
    .map(({ word, expression }) => ({
      word,
      count: [...transcript.matchAll(expression)].length,
    }))
    .filter((item) => item.count > 0);

  return {
    wordCount,
    wordsPerMinute:
      durationSeconds > 0 ? Math.round((wordCount / durationSeconds) * 60) : 0,
    fillerCount: fillerBreakdown.reduce((total, item) => total + item.count, 0),
    fillerBreakdown,
  };
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
