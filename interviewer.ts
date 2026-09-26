import { GoogleGenAI } from '@google/genai';
import { ElevenLabsClient } from 'elevenlabs';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline/promises';
import dotenv from 'dotenv';

dotenv.config();

// -------------------------------------------------------------
// Type Definitions
// -------------------------------------------------------------
export interface InterviewQuestion {
  id: number;
  question: string;
  expectedKeyPoints: string[];
}

export interface AnswerEvaluation {
  isCorrect: boolean;
  score: number; // 1 to 10
  feedback: string;
  strengths: string[];
  missingPoints: string[];
  spokenFeedback: string; // Concise script for ElevenLabs to speak
}

export interface InterviewSummary {
  totalQuestions: number;
  averageScore: number;
  overallVerdict: 'PASS' | 'NEEDS_WORK' | 'FAIL';
  summaryFeedback: string;
}

// -------------------------------------------------------------
// AI Interviewer Engine
// -------------------------------------------------------------
export class AIInterviewer {
  private gemini: GoogleGenAI;
  private elevenlabs: ElevenLabsClient;
  private voiceId: string;
  private audioOutputDir: string;

  constructor(voiceId = '21m00Tcm4TlvDq8ikWAM') {
    // Default: 'Rachel' voice
    const geminiKey = process.env.GEMINI_API_KEY;
    const elevenKey = process.env.ELEVENLABS_API_KEY;

    if (!geminiKey) throw new Error('Missing GEMINI_API_KEY in environment');
    if (!elevenKey) throw new Error('Missing ELEVENLABS_API_KEY in environment');

    this.gemini = new GoogleGenAI({ apiKey: geminiKey });
    this.elevenlabs = new ElevenLabsClient({ apiKey: elevenKey });
    this.voiceId = voiceId;

    // Create an output folder for generated audio files
    this.audioOutputDir = path.join(__dirname, 'interview_audio');
    if (!fs.existsSync(this.audioOutputDir)) {
      fs.mkdirSync(this.audioOutputDir, { recursive: true });
    }
  }

  /**
   * 1. Generate questions based on a topic, job description, or prompt
   */
  async generateQuestions(topic: string, count: number = 3): Promise<InterviewQuestion[]> {
    const prompt = `
      You are an expert interviewer. Generate exactly ${count} technical or behavioral interview questions 
      based on the following topic/role: "${topic}".

      Respond ONLY with valid JSON in this exact structure:
      [
        {
          "id": 1,
          "question": "Question text here",
          "expectedKeyPoints": ["key point 1", "key point 2"]
        }
      ]
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text || '[]';
    return JSON.parse(text) as InterviewQuestion[];
  }

  /**
   * 2. ElevenLabs Text-to-Speech: Synthesize text into an audio file
   */
  async speakToFile(text: string, fileName: string): Promise<string> {
    const filePath = path.join(this.audioOutputDir, fileName);

    const audioStream = await this.elevenlabs.textToSpeech.convert(this.voiceId, {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.6,
        similarity_boost: 0.8,
      },
    });

    // Write readable stream to file
    const fileStream = fs.createWriteStream(filePath);
    await new Promise<void>((resolve, reject) => {
      audioStream.pipe(fileStream);
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });

    return filePath;
  }

  /**
   * 3. Evaluate the user's answer with Gemini
   */
  async evaluateAnswer(
    question: InterviewQuestion,
    userAnswer: string
  ): Promise<AnswerEvaluation> {
    const prompt = `
      You are evaluating a candidate's interview answer.
      
      QUESTION: "${question.question}"
      EXPECTED KEY POINTS: ${JSON.stringify(question.expectedKeyPoints)}
      CANDIDATE ANSWER: "${userAnswer}"

      Evaluate whether the candidate answered correctly, fairly, or incorrectly.
      Be objective and constructive. 
      Generate a concise "spokenFeedback" string (1-2 sentences) suitable for text-to-speech feedback.

      Respond ONLY with valid JSON in this exact structure:
      {
        "isCorrect": boolean,
        "score": number (1-10),
        "feedback": "Detailed text feedback here",
        "strengths": ["string"],
        "missingPoints": ["string"],
        "spokenFeedback": "Short spoken response here"
      }
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text || '{}';
    return JSON.parse(text) as AnswerEvaluation;
  }

  /**
   * 4. Generate final score & wrap-up
   */
  async summarizeSession(evaluations: AnswerEvaluation[]): Promise<InterviewSummary> {
    const avgScore =
      evaluations.reduce((sum, e) => sum + e.score, 0) / evaluations.length;

    let verdict: 'PASS' | 'NEEDS_WORK' | 'FAIL' = 'PASS';
    if (avgScore < 5) verdict = 'FAIL';
    else if (avgScore < 7.5) verdict = 'NEEDS_WORK';

    const prompt = `
      Summarize the candidate's interview performance based on these scores and notes:
      ${JSON.stringify(evaluations)}
      Provide a brief 2-sentence wrap-up recommendation.
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return {
      totalQuestions: evaluations.length,
      averageScore: Number(avgScore.toFixed(1)),
      overallVerdict: verdict,
      summaryFeedback: response.text || 'Interview session complete.',
    };
  }
}

// -------------------------------------------------------------
// Interactive CLI Runner (For testing without frontend)
// -------------------------------------------------------------
async function runCLI() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n=============================================');
  console.log('       🎙️  AI INTERVIEWER ENGINE (CLI)');
  console.log('=============================================\n');

  const interviewer = new AIInterviewer();

  const role = await rl.question('Enter interview topic or role (e.g. "React & TypeScript Developer"): ');
  console.log('\n🤖 Gemini is generating interview questions...');
  
  const questions = await interviewer.generateQuestions(role || 'Frontend Developer', 2);
  const evaluations: AnswerEvaluation[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`\n---------------------------------------------`);
    console.log(`Question ${i + 1}/${questions.length}:`);
    console.log(`👉 "${q.question}"`);

    // ElevenLabs speaks the question to disk
    console.log(`🔊 ElevenLabs synthesizing audio...`);
    const qAudioPath = await interviewer.speakToFile(q.question, `question_${i + 1}.mp3`);
    console.log(`   [Audio saved to: ${qAudioPath}]`);

    // User inputs answer in terminal
    const answer = await rl.question('\nYour Answer: ');

    console.log('\n🧠 Gemini evaluating your response...');
    const result = await interviewer.evaluateAnswer(q, answer);

    evaluations.push(result);

    console.log(`\nResult: ${result.isCorrect ? '✅ CORRECT' : '❌ INCORRECT'} (Score: ${result.score}/10)`);
    console.log(`Feedback: ${result.feedback}`);
    if (result.missingPoints.length > 0) {
      console.log(`Missing Concepts: ${result.missingPoints.join(', ')}`);
    }

    // ElevenLabs speaks feedback
    console.log(`\n🔊 Synthesizing spoken feedback...`);
    const fbAudioPath = await interviewer.speakToFile(result.spokenFeedback, `feedback_${i + 1}.mp3`);
    console.log(`   [Audio saved to: ${fbAudioPath}]`);
    console.log(`   Interviewer says: "${result.spokenFeedback}"`);
  }

  // Final summary
  console.log('\n=============================================');
  console.log('              FINAL RESULTS');
  console.log('=============================================');
  const summary = await interviewer.summarizeSession(evaluations);
  console.log(`Total Questions: ${summary.totalQuestions}`);
  console.log(`Average Score:   ${summary.averageScore} / 10`);
  console.log(`Verdict:         ${summary.overallVerdict}`);
  console.log(`Summary:         ${summary.summaryFeedback}\n`);

  rl.close();
}

// Execute CLI directly if run via `npx ts-node interviewer.ts`
if (require.main === module) {
  runCLI().catch(console.error);
}