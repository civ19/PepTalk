import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ElevenLabsClient } from 'elevenlabs';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(cors({ origin: true }));
app.use(express.json());

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

/**
 * Generates an ephemeral single-use token for Scribe Realtime.
 * The browser uses this token to connect to wss://api.elevenlabs.io without leaking the master API key.
 */
app.get('/api/elevenlabs/scribe-token', async (_req: Request, res: Response): Promise<void> => {
  try {
    const tokenResponse = await elevenlabs.tokens.singleUse.create('realtime_scribe');
    res.json({ token: tokenResponse.token });
  } catch (error: any) {
    console.error('Failed to generate Scribe token:', error?.message || error);
    res.status(500).json({ error: 'Failed to mint transcription token' });
  }
});

app.listen(port, () => {
  console.log(`🚀 Stagewise Backend running on http://localhost:${port}`);
});