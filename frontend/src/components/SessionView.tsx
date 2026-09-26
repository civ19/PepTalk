import { useInterviewStore } from "../store/interviewStore";

export function SessionView() {
  const sessionId = useInterviewStore((state) => state.sessionId);
  const topic = useInterviewStore((state) => state.topic);
  const turns = useInterviewStore((state) => state.turns);
  const reset = useInterviewStore((state) => state.reset);

  return (
    <section className="space-y-6">
      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">
          Session {sessionId}
        </p>
        <h2 className="mt-1 text-lg font-semibold">{topic}</h2>
      </div>

      {turns.length === 0 ? (
        <p className="text-sm text-slate-500">
          Waiting for the interviewer to begin…
        </p>
      ) : (
        <ol className="space-y-3">
          {turns.map((turn, index) => (
            <li
              key={index}
              className={
                turn.speaker === "interviewer"
                  ? "rounded-lg bg-indigo-50 p-3 text-sm"
                  : "rounded-lg bg-slate-100 p-3 text-sm"
              }
            >
              <span className="font-medium capitalize">{turn.speaker}:</span>{" "}
              {turn.text}
            </li>
          ))}
        </ol>
      )}

      <button
        type="button"
        onClick={reset}
        className="rounded-lg px-4 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-100"
      >
        End session
      </button>
    </section>
  );
}
