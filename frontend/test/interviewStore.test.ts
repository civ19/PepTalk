import { beforeEach, describe, expect, it } from "vitest";
import { useInterviewStore } from "../src/store/interviewStore";

describe("useInterviewStore", () => {
  beforeEach(() => {
    useInterviewStore.getState().reset();
  });

  it("starts idle with no session", () => {
    const state = useInterviewStore.getState();
    expect(state.status).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(state.topic).toBe("");
    expect(state.turns).toEqual([]);
  });

  it("beginSession activates the session and clears previous turns", () => {
    const store = useInterviewStore.getState();
    store.addTurn({ speaker: "candidate", text: "leftover" });

    store.beginSession("abc-123", "Postgres internals");

    const state = useInterviewStore.getState();
    expect(state.status).toBe("active");
    expect(state.sessionId).toBe("abc-123");
    expect(state.topic).toBe("Postgres internals");
    expect(state.turns).toEqual([]);
  });

  it("addTurn appends turns in order", () => {
    const store = useInterviewStore.getState();
    store.addTurn({ speaker: "interviewer", text: "What is MVCC?" });
    store.addTurn({ speaker: "candidate", text: "Multi-version concurrency…" });

    expect(useInterviewStore.getState().turns).toEqual([
      { speaker: "interviewer", text: "What is MVCC?" },
      { speaker: "candidate", text: "Multi-version concurrency…" },
    ]);
  });

  it("reset returns to the initial state", () => {
    const store = useInterviewStore.getState();
    store.beginSession("abc-123", "Postgres internals");
    store.addTurn({ speaker: "interviewer", text: "What is MVCC?" });

    store.reset();

    const state = useInterviewStore.getState();
    expect(state.status).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(state.topic).toBe("");
    expect(state.turns).toEqual([]);
  });
});
