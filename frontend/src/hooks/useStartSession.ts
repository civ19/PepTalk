import { useMutation } from "@tanstack/react-query";
import { startSession } from "../services/api";
import { useInterviewStore } from "../store/interviewStore";

export function useStartSession() {
  const beginSession = useInterviewStore((state) => state.beginSession);

  return useMutation({
    mutationFn: (topic: string) => startSession(topic),
    onSuccess: (session, topic) => {
      beginSession(session.id, topic);
    },
  });
}
