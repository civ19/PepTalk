import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { initDatabase } from './db';
import { SessionService } from './sessionService';
import { AIInterviewer } from './interviewer';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// Middleware
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' })); // Allows larger batch telemetry payloads

// Serve synthesized speech files (e.g., http://localhost:4000/audio/question_1.mp3)
app.use('/audio', express.static('interview_audio'));

// Initialize TigerData schema & hypertables on startup
initDatabase().catch((err) => {
  console.error('Failed to initialize TigerData database:', err);
});

// Initialize AI Interviewer Engine
const interviewer = new AIInterviewer();

// ============================================================
// 1. ELEVENLABS SCRIBE ROUTE
// ============================================================

/**
 * Mint single-use ephemeral token for browser-side Scribe Realtime STT
 */
app.get('/api/elevenlabs/scribe-token', async (_req: Request, res: Response): Promise<void> => {
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY || '',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    res.json({ token: data.token });
  } catch (error: any) {
    console.error('Failed to generate Scribe token:', error?.message || error);
    res.status(500).json({ error: 'Failed to mint transcription token' });
  }
});

// ============================================================
// 2. AI INTERVIEWER BOT ROUTES (Gemini + ElevenLabs)
// ============================================================

/**
 * Start an interview: Gemini generates questions, ElevenLabs speaks the 1st question
 */
app.post('/api/interview/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const { topic = 'General Software Engineering', count = 3 } = req.body;
    const questions = await interviewer.generateQuestions(topic, count);

    // Synthesize audio for the first question
    await interviewer.speakToFile(questions[0].question, 'question_1.mp3');

    res.json({
      questions,
      firstQuestionAudio: '/audio/question_1.mp3',
    });
  } catch (error: any) {
    console.error('Error starting interview:', error);
    res.status(500).json({ error: 'Failed to generate interview' });
  }
});

/**
 * Evaluate user's answer: Gemini grades response, ElevenLabs speaks audio feedback
 */
app.post('/api/interview/evaluate', async (req: Request, res: Response): Promise<void> => {
  try {
    const { question, userAnswer, questionIndex = 1 } = req.body;

    const evaluation = await interviewer.evaluateAnswer(question, userAnswer);

    // Synthesize audio feedback from the coach
    const feedbackFileName = `feedback_${questionIndex}.mp3`;
    await interviewer.speakToFile(evaluation.spokenFeedback, feedbackFileName);

    res.json({
      evaluation,
      feedbackAudio: `/audio/${feedbackFileName}`,
    });
  } catch (error: any) {
    console.error('Error evaluating answer:', error);
    res.status(500).json({ error: 'Failed to evaluate answer' });
  }
});

// ============================================================
// 3. TIGERDATA TELEMETRY & SESSION ROUTES
// ============================================================

/**
 * Start a practice session: creates session row in TigerData
 */
app.post('/api/sessions/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId, projectId } = req.body;
    const session = await SessionService.createSession(userId, projectId);
    res.json(session);
  } catch (error: any) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * Finalize session: batch inserts raw Presage samples into hypertable,
 * computes 1-second downsampled graph using TigerData time_bucket, and stores it.
 */
/**
 * Finalize session: batch inserts raw Presage samples into hypertable,
 * computes 1-second downsampled graph using TigerData time_bucket, and stores it.
 */
app.post('/api/sessions/:id/telemetry', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string; // 👈 Cast to string
    const { sessionStartTime, samples } = req.body;

    // 1. Batch insert raw sensor stream into hypertable
    await SessionService.insertTelemetryBatch(id, new Date(sessionStartTime), samples);

    // 2. Downsample to 1-second buckets and save to session
    const graphData = await SessionService.finalizeSessionGraph(id);

    res.json({ success: true, graphData });
  } catch (error: any) {
    console.error('Error processing telemetry:', error);
    res.status(500).json({ error: 'Failed to process telemetry' });
  }
});

/**
 * Get user session history (enforces 10-session free limit & provides data for graphs/Gemini)
 */
app.get('/api/users/:userId/history', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.params.userId as string; // 👈 Cast to string
    const history = await SessionService.getUserRecentSessions(userId, 10);
    res.json(history);
  } catch (error: any) {
    console.error('Error fetching user history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});
// ============================================================
// START SERVER
// ============================================================
app.listen(port, () => {
  console.log(`🚀 Stagewise Backend running on http://localhost:${port}`);
});