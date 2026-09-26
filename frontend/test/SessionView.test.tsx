import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionView } from "../src/components/SessionView";
import { useInterviewStore } from "../src/store/interviewStore";

describe("SessionView", () => {
  beforeEach(() => {
    const store = useInterviewStore.getState();
    store.reset();
    store.beginSession("abc-123", "Postgres internals");
  });

  it("shows a waiting message before any turns", () => {
    render(<SessionView />);

    expect(
      screen.getByText("Waiting for the interviewer to begin…"),
    ).toBeInTheDocument();
  });

  it("renders the transcript in order", () => {
    const store = useInterviewStore.getState();
    store.addTurn({ speaker: "interviewer", text: "What is MVCC?" });
    store.addTurn({ speaker: "candidate", text: "Row versioning." });

    render(<SessionView />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("interviewer: What is MVCC?");
    expect(items[1]).toHaveTextContent("candidate: Row versioning.");
  });
});
