// /api/sessions: recording sessions. While recording, the browser PUTs each
// MediaRecorder chunk; POST .../finish stores the video; GET .../recording
// streams it back with Range support so the player can seek.

import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  RecordingError,
  type RecordingService,
} from "../modules/storage/recordingService";

// MediaRecorder sends a chunk about every second; this leaves plenty of room.
const CHUNK_LIMIT = "50mb";

type SessionRequest = Request<{ id: string }>;
type Handler = (req: SessionRequest, res: Response) => Promise<void>;

/** Express 4 doesn't catch rejected promises; this passes them to the error handler. */
const route =
  (handler: Handler) =>
  (req: SessionRequest, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };

export default function createSessionRoutes(
  recordings: RecordingService | null,
): Router {
  const router = Router();

  if (!recordings) {
    router.use((_req, res) => {
      res.status(503).json({
        error:
          "Recordings are off because DATABASE_URL is not set (see .env.example).",
      });
    });
    return router;
  }

  router.post(
    "/",
    route(async (_req, res) => {
      res.status(201).json({ id: await recordings.createSession() });
    }),
  );

  router.put(
    "/:id/recording",
    express.raw({
      // MediaRecorder types look like video/webm;codecs=vp9,opus, which the
      // default matcher rejects (unquoted comma), so match the prefix instead.
      type: (req) => /^video\//i.test(req.headers["content-type"] ?? ""),
      limit: CHUNK_LIMIT,
    }),
    route(async (req, res) => {
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) {
        throw new RecordingError(
          415,
          "Recordings must be video/webm or video/mp4.",
        );
      }
      await recordings.append(
        req.params.id,
        req.get("content-type") ?? "",
        body,
      );
      res.status(204).end();
    }),
  );

  router.post(
    "/:id/finish",
    route(async (req, res) => {
      res.json(await recordings.finish(req.params.id));
    }),
  );

  router.get(
    "/:id/recording",
    route(async (req, res) => {
      const { root, key } = await recordings.recordingFile(req.params.id);
      // sendFile answers Range requests with 206 and refuses paths that leave root.
      res.sendFile(key, { root });
    }),
  );

  router.delete(
    "/:id",
    route(async (req, res) => {
      await recordings.delete(req.params.id);
      res.status(204).end();
    }),
  );

  router.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof RecordingError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (
        /relation "(practice_sessions|media_objects)" does not exist/.test(
          message,
        )
      ) {
        console.error(
          `[sessions] ${message}. Run \`npm run db:migrate\` first.`,
        );
        res.status(503).json({
          error: "The Tiger Data tables are missing. Run npm run db:migrate.",
        });
        return;
      }
      // Body-parser and sendFile errors carry their own status; Express's handler sends them.
      next(err);
    },
  );

  return router;
}
