import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ElevenLabsClient } from 'elevenlabs';
import { AIInterviewer } from './interviewer'; // 👈 Import your interviewer engine

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: true }));
app.use(express.json());

// Serve the generated audio files so frontend can play them:
// http://localhost:4000/audio/question_1.mp3
app.use('/audio', express.static('interview_audio'));

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

// Initialize the interview brain
const interviewer = new AIInterviewer();

// 1. Existing Scribe Token Endpoint
app.get('/api/elevenlabs/scribe-token', async (_req: Request, res: Response): Promise<void> => {
  try {
    const tokenResponse = await elevenlabs.tokens.singleUse.create('realtime_scribe');
    res.json({ token: tokenResponse.token });
  } catch (error: any) {
    console.error('Failed to generate Scribe token:', error?.message || error);
    res.status(500).json({ error: 'Failed to mint transcription token' });
  }
});

// 2. NEW: Start Interview -> Generates Questions + Audio
app.post('/api/interview/start', async (req: Request, res: Response): Promise<void> => {
  try {
    const { topic = 'General Software Engineering', count = 3 } = req.body;
    const questions = await interviewer.generateQuestions(topic, count);

    // Generate speech for the first question
    await interviewer.speakToFile(questions[0].question, 'question_1.mp3');

    res.json({
      questions,
      firstQuestionAudio: '/audio/question_1.mp3'
    });
  } catch (error: any) {
    console.error('Error starting interview:', error);
    res.status(500).json({ error: 'Failed to generate interview' });
  }
});

// 3. NEW: Submit Answer -> Gemini Grades It + ElevenLabs Speaks Feedback
app.post('/api/interview/evaluate', async (req: Request, res: Response): Promise<void> => {
  try {
    const { question, userAnswer, questionIndex } = req.body;
    
    // Gemini evaluation
    const evaluation = await interviewer.evaluateAnswer(question, userAnswer);

    // Synthesize spoken feedback
    const feedbackFileName = `feedback_${questionIndex}.mp3`;
    await interviewer.speakToFile(evaluation.spokenFeedback, feedbackFileName);

    res.json({
      evaluation,
      feedbackAudio: `/audio/${feedbackFileName}`
    });
  } catch (error: any) {
    console.error('Error evaluating answer:', error);
    res.status(500).json({ error: 'Failed to evaluate answer' });
  }
});

app.listen(port, () => {
  console.log(`🚀 Stagewise Backend running on http://localhost:${port}`);
});