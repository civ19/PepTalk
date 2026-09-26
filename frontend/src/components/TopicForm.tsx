import { useState } from "react";
import { useStartSession } from "../hooks/useStartSession";

export function TopicForm() {
  const [topic, setTopic] = useState("");
  const { mutate, isPending, error } = useStartSession();
  const trimmedTopic = topic.trim();

  return (
    <form
      className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmedTopic) {
          mutate(trimmedTopic);
        }
      }}
    >
      <div className="space-y-2">
        <label htmlFor="topic" className="block text-sm font-medium">
          What do you want to be grilled on?
        </label>
        <textarea
          id="topic"
          rows={5}
          value={topic}
          onChange={(event) => {
            setTopic(event.target.value);
          }}
          placeholder="e.g. Senior backend role — distributed systems, Postgres internals, and system design trade-offs"
          className="block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-xs placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          Could not start the session: {error.message}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending || !trimmedTopic}
        className="inline-flex items-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? "Starting…" : "Start interview"}
      </button>
    </form>
  );
}
