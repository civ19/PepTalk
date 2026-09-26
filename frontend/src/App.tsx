import { SessionView } from "./components/SessionView";
import { TopicForm } from "./components/TopicForm";
import { useInterviewStore } from "./store/interviewStore";

export default function App() {
  const status = useInterviewStore((state) => state.status);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-4 py-4">
          <h1 className="text-xl font-semibold">PrepTalk</h1>
          <p className="text-sm text-slate-500">
            Get grilled before the real interview does it.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {status === "idle" ? <TopicForm /> : <SessionView />}
      </main>
    </div>
  );
}
