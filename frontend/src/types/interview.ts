export interface InterviewTurn {
  speaker: "interviewer" | "candidate";
  text: string;
}

export interface StartSessionResponse {
  id: string;
}
