import { create } from "zustand";
import type { InterviewTurn } from "../types/interview";

export type InterviewStatus = "idle" | "active";

interface InterviewData {
  status: InterviewStatus;
  sessionId: string | null;
  topic: string;
  turns: InterviewTurn[];
}

interface InterviewActions {
  beginSession: (sessionId: string, topic: string) => void;
  addTurn: (turn: InterviewTurn) => void;
  reset: () => void;
}

type InterviewState = InterviewData & InterviewActions;

const initialState: InterviewData = {
  status: "idle",
  sessionId: null,
  topic: "",
  turns: [],
};

export const useInterviewStore = create<InterviewState>()((set) => ({
  ...initialState,
  beginSession: (sessionId, topic) => {
    set({ status: "active", sessionId, topic, turns: [] });
  },
  addTurn: (turn) => {
    set((state) => ({ turns: [...state.turns, turn] }));
  },
  reset: () => {
    set(initialState);
  },
}));
