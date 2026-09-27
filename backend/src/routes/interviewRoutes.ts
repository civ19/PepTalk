import { Router, Request, Response } from 'express';
import { InterviewEngine, InterviewQuestion, AnswerEvaluation } from '../modules/interviewer/interviewEngine';

const router = Router();
const engine = new InterviewEngine();

// In-memory state storage for active interviews during the hackathon
interface ActiveInterview {
  sessionId: string;
  questions: InterviewQuestion[];
  currentIndex: number;
  evaluations: AnswerEvaluation[];
}

const activeSessions = new Map<string, ActiveInterview>();

/**
 * POST /api/interview/start
 * Payload: { topic?: string, customQuestions?: string[] }
 */
router.post('/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const { topic, customQuestions } = req.body;
    const sessionId = `session_${Date.now()}`;

    let questions: InterviewQuestion[] = [];
    if (Array.isArray(customQuestions) && customQuestions.length > 0) {
      questions = await engine.parseCustomQuestions(customQuestions);
    } else {
      questions = await engine.generateQuestionsFromPrompt(topic || 'Software Engineering', 3);
    }

    if (!questions.length) {
      res.status(400).json({ error: 'Failed to initialize questions' });
      return;
    }

    // Synthesize audio for the very first question
    const firstAudioUrl = await engine.synthesizeSpeech(
      questions[0].question,
      `${sessionId}_q1.mp3`
    );

    activeSessions.set(sessionId, {
      sessionId,
      questions,
      currentIndex: 0,
      evaluations: [],
    });

    res.json({
      sessionId,
      totalQuestions: questions.length,
      currentQuestion: questions[0],
      audioUrl: firstAudioUrl,
    });
  } catch (err: any) {
    console.error('Error starting interview:', err);
    res.status(500).json({ error: err.message || 'Failed to start interview' });
  }
});

/**
 * POST /api/interview/respond
 * Payload: { sessionId: string, textAnswer?: string } 
 * (Accepts text or audio; transcribes if needed, grades, and speaks next question)
 */
router.post('/respond', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId, textAnswer } = req.body;
    const session = activeSessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Active interview session not found' });
      return;
    }

    const currentQuestion = session.questions[session.currentIndex];
    const candidateAnswer = textAnswer || 'No answer provided.';

    // 1. Grade the answer with Gemini
    const evaluation = await engine.evaluateAnswer(currentQuestion, candidateAnswer);
    session.evaluations.push(evaluation);

    // 2. Synthesize spoken feedback from ElevenLabs
    const feedbackAudioUrl = await engine.synthesizeSpeech(
      evaluation.spokenFeedback,
      `${sessionId}_feedback_${session.currentIndex + 1}.mp3`
    );

    session.currentIndex += 1;
    const isFinished = session.currentIndex >= session.questions.length;

    let nextQuestion = null;
    let nextQuestionAudioUrl = null;

    if (!isFinished) {
      nextQuestion = session.questions[session.currentIndex];
      // Pre-synthesize the next question
      nextQuestionAudioUrl = await engine.synthesizeSpeech(
        nextQuestion.question,
        `${sessionId}_q${session.currentIndex + 1}.mp3`
      );
    }

    res.json({
      evaluation,
      feedbackAudioUrl,
      isFinished,
      nextQuestion,
      nextQuestionAudioUrl,
    });
  } catch (err: any) {
    console.error('Error evaluating response:', err);
    res.status(500).json({ error: err.message || 'Failed to process answer' });
  }
});

/**
 * POST /api/interview/finish
 * Payload: { sessionId: string }
 */
router.post('/finish', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: 'Active interview session not found' });
      return;
    }

    const summary = await engine.summarizeSession(session.evaluations);
    activeSessions.delete(sessionId);

    res.json({ summary, evaluations: session.evaluations });
  } catch (err: any) {
    console.error('Error finalizing interview:', err);
    res.status(500).json({ error: err.message || 'Failed to finalize session' });
  }
});

export default router;