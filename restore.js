const fs = require('fs');
const path = require('path');

const files = {
  'backend/src/domain/models.ts': `export interface InterviewSession {
  id: string;
  topic: string;
  status: 'active' | 'completed';
}
`,
  'backend/src/modules/feedback/feedbackCorrelator.ts': `export class FeedbackCorrelator {
  correlate(sessionId: string) {
    return { score: 85, notes: 'Good technical depth.' };
  }
}
`,
  'backend/src/modules/storage/storageService.ts': `export class StorageService {
  async saveVideo(sessionId: string, stream: any) {
    return \`/data/videos/\${sessionId}.webm\`;
  }
}
`,
  'backend/src/modules/elevenlabs/elevenLabsService.ts': `export class ElevenLabsService {
  async synthesizeSpeech(text: string) {
    return Buffer.from('mock-audio-data');
  }
}
`,
  'backend/src/modules/presage/presageService.ts': `export class PresageService {
  analyzeFrame(frame: any) {
    return { pulse: 75, stress: 'low' };
  }
}
`,
  'backend/src/modules/persistence/tigerDataRepository.ts': `export class TigerDataRepository {
  async saveSession(session: any) {
    return session.id;
  }
}
`,
  'backend/src/modules/interviewer/grillingEngine.ts': `export class GrillingEngine {
  generateQuestion(topic: string) {
    return \`Tell me about \${topic}\`;
  }
}
`,
  'backend/src/routes/sessionRoutes.ts': `import { Router } from 'express';
const router = Router();
router.post('/', (req, res) => res.json({ id: '123' }));
export default router;
`,
  'backend/src/app.ts': `import express from 'express';
import sessionRoutes from './routes/sessionRoutes';
const app = express();
app.use(express.json());
app.use('/api/sessions', sessionRoutes);
export default app;
`,
  'backend/src/index.ts': `import app from './app';
app.listen(4000, () => console.log('Backend on 4000'));
`,
  'frontend/src/types/interview.ts': `export interface InterviewTurn {
  speaker: 'interviewer' | 'candidate';
  text: string;
}
`,
  'frontend/src/utils/videoMetrics.ts': `export function extractMetrics() {
  return { pulse: 72 };
}
`,
  'frontend/src/services/api.ts': `export async function startSession(topic: string) {
  return { id: '123' };
}
`,
  'frontend/src/App.tsx': `import React from 'react';
export default function App() {
  return <div>PrepTalk - Nested Files Restored</div>;
}
`,
  'frontend/src/main.tsx': `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
`,
  'frontend/src/App.css': `body { background: #f0f0f0; }`
};

for (const [filepath, content] of Object.entries(files)) {
  const fullPath = path.join(__dirname, filepath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log('Restored', filepath);
}
