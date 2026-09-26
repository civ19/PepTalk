import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { useInterviewStore } from "../src/store/interviewStore";
import { renderWithProviders } from "./renderWithProviders";

describe("App", () => {
  beforeEach(() => {
    useInterviewStore.getState().reset();
  });

  it("disables the start button until a topic is entered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    const startButton = screen.getByRole("button", { name: "Start interview" });
    expect(startButton).toBeDisabled();

    await user.type(screen.getByLabelText(/grilled on/i), "   ");
    expect(startButton).toBeDisabled();

    await user.type(screen.getByLabelText(/grilled on/i), "React internals");
    expect(startButton).toBeEnabled();
  });

  it("starts a session and shows the session view", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(Response.json({ id: "abc-123" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.type(screen.getByLabelText(/grilled on/i), "  React internals ");
    await user.click(screen.getByRole("button", { name: "Start interview" }));

    expect(
      await screen.findByRole("heading", { name: "React internals" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Session abc-123")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows an error and stays on the form when the backend fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.type(screen.getByLabelText(/grilled on/i), "React internals");
    await user.click(screen.getByRole("button", { name: "Start interview" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not start the session: Request to /sessions failed with status 500",
    );
    expect(useInterviewStore.getState().status).toBe("idle");
  });

  it("returns to the topic form when the session is ended", async () => {
    useInterviewStore.getState().beginSession("abc-123", "React internals");
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "End session" }));

    expect(screen.getByLabelText(/grilled on/i)).toBeInTheDocument();
    expect(useInterviewStore.getState().status).toBe("idle");
  });
});
