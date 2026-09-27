import { GoogleGenAI } from '@google/genai';
import { ElevenLabsClient } from 'elevenlabs';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export interface InterviewQuestion {
  id: number;
  question: string;
  expectedKeyPoints: string[];
}

export interface AnswerEvaluation {
  isCorrect: boolean;
  score: number; // 1 to 10
  verdict: 'CORRECT' | 'PARTIALLY_CORRECT' | 'INCORRECT';
  feedback: string;
  strengths: string[];
  missingPoints: string[];
  spokenFeedback: string; // The concise response ElevenLabs reads out loud
}

export interface InterviewSummary {
  totalQuestions: number;
  averageScore: number;
  verdict: 'PASS' | 'NEEDS_WORK' | 'FAIL';
  summaryFeedback: string;
}

export class InterviewEngine {
  private gemini: GoogleGenAI;
  private elevenlabs: ElevenLabsClient;
  private voiceId: string;
  private audioDir: string;

  constructor(voiceId = '21m00Tcm4TlvDq8ikWAM') {
    // Default: 'Rachel' voice
    const geminiKey = process.env.GEMINI_API_KEY;
    const elevenKey = process.env.ELEVENLABS_API_KEY;

    if (!geminiKey) throw new Error('Missing GEMINI_API_KEY');
    if (!elevenKey) throw new Error('Missing ELEVENLABS_API_KEY');

    this.gemini = new GoogleGenAI({ apiKey: geminiKey });
    this.elevenlabs = new ElevenLabsClient({ apiKey: elevenKey });
    this.voiceId = voiceId;

    // Output directory for synthesized interviewer speech
    this.audioDir = path.join(process.cwd(), 'interview_audio');
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
  }

  /**
   * 1A. Generate dynamic questions via Gemini from a topic or job prompt
   */
  async generateQuestionsFromPrompt(prompt: string, count = 3): Promise<InterviewQuestion[]> {
    const aiPrompt = `
      You are an expert technical and behavioral interviewer.
      Generate exactly ${count} interview questions based on this prompt/role: "${prompt}".
      For each question, provide 2-4 critical expected key points the candidate must mention.

      Respond ONLY in valid JSON matching this schema:
      [
        {
          "id": 1,
          "question": "Question text here",
          "expectedKeyPoints": ["point 1", "point 2"]
        }
      ]
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: aiPrompt,
      config: { responseMimeType: 'application/json' },
    });

    return JSON.parse(response.text || '[]') as InterviewQuestion[];
  }

  /**
   * 1B. Parse custom user-provided questions and have Gemini extract rubrics
   */
  async parseCustomQuestions(rawQuestions: string[]): Promise<InterviewQuestion[]> {
    const aiPrompt = `
      The user provided the following interview questions:
      ${JSON.stringify(rawQuestions)}

      Extract each question and generate 2-4 expected key points for grading.
      Respond ONLY in valid JSON matching this schema:
      [
        {
          "id": 1,
          "question": "Question text",
          "expectedKeyPoints": ["point 1", "point 2"]
        }
      ]
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: aiPrompt,
      config: { responseMimeType: 'application/json' },
    });

    return JSON.parse(response.text || '[]') as InterviewQuestion[];
  }

  /**
   * 2. ElevenLabs Text-to-Speech: Convert interviewer questions/feedback into audio
   */
  async synthesizeSpeech(text: string, outputFileName: string): Promise<string> {
    const filePath = path.join(this.audioDir, outputFileName);

    const audioStream = await this.elevenlabs.textToSpeech.convert(this.voiceId, {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.6, similarity_boost: 0.8 },
    });

    const fileStream = fs.createWriteStream(filePath);
    await new Promise<void>((resolve, reject) => {
      audioStream.pipe(fileStream);
      fileStream.on('finish', () => resolve());
      fileStream.on('error', reject);
    });

    return `/audio/${outputFileName}`;
  }

  /**
   * 3. ElevenLabs Speech-to-Text: Transcribe spoken candidate audio if provided
   */
  async transcribeAudioBuffer(audioBuffer: Buffer, mimeType = 'audio/webm'): Promise<string> {
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
    const formData = new FormData();
    formData.append('file', blob, 'answer.webm');
    formData.append('model_id', 'scribe_v1');

    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY! },
      body: formData,
    });

    if (!res.ok) {
      throw new Error(`ElevenLabs STT error: ${res.statusText}`);
    }

    const data = await res.json();
    return data.text || '';
  }

  /**
   * 4. Gemini Answer Evaluation: Grade candidate response against rubric
   */
  async evaluateAnswer(question: InterviewQuestion, candidateAnswer: string): Promise<AnswerEvaluation> {
    const prompt = `
      You are an expert interviewer evaluating a candidate's spoken response.
      
      QUESTION: "${question.question}"
      EXPECTED KEY POINTS: ${JSON.stringify(question.expectedKeyPoints)}
      CANDIDATE ANSWER: "${candidateAnswer}"

      Evaluate if the answer is CORRECT, PARTIALLY_CORRECT, or INCORRECT.
      Score it from 1 to 10.
      Generate a concise "spokenFeedback" (maximum 2 sentences) that sounds natural for a conversational interviewer to say before moving on.

      Respond ONLY in valid JSON matching this schema:
      {
        "isCorrect": boolean,
        "score": number,
        "verdict": "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT",
        "feedback": "Detailed text critique",
        "strengths": ["string"],
        "missingPoints": ["string"],
        "spokenFeedback": "Short spoken response for voice synthesis"
      }
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    return JSON.parse(response.text || '{}') as AnswerEvaluation;
  }

  /**
   * 5. Summarize the complete interview session
   */
  async summarizeSession(evaluations: AnswerEvaluation[]): Promise<InterviewSummary> {
    const avgScore = evaluations.reduce((sum, e) => sum + e.score, 0) / (evaluations.length || 1);

    let verdict: 'PASS' | 'NEEDS_WORK' | 'FAIL' = 'PASS';
    if (avgScore < 5.0) verdict = 'FAIL';
    else if (avgScore < 7.5) verdict = 'NEEDS_WORK';

    const prompt = `
      Summarize the candidate's performance across the entire interview:
      ${JSON.stringify(evaluations)}
      Provide a constructive, 2-3 sentence final summary.
    `;

    const response = await this.gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return {
      totalQuestions: evaluations.length,
      averageScore: Number(avgScore.toFixed(1)),
      verdict,
      summaryFeedback: response.text || 'Interview completed.',
    };
  }
}