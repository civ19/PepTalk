import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { auth } from "express-oauth2-jwt-bearer";
import type {
  AccountStore,
  StoredPreparation,
  StoredProject,
} from "../modules/persistence/accountRepository";

type AuthenticatedRequest = Request & { auth?: { payload?: { sub?: string } } };

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function validProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    validText(item.id, 200) &&
    item.id.length > 0 &&
    validText(item.name, 200) &&
    item.name.trim().length > 0 &&
    ["Presentation", "Interview", "Other", "Pitch"].includes(
      String(item.category),
    ) &&
    validText(item.createdAt, 40) &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    (item.contextNotes === undefined || validText(item.contextNotes, 10000)) &&
    (item.files === undefined ||
      (Array.isArray(item.files) && item.files.length <= 5))
  );
}

function validPreparation(value: unknown): value is StoredPreparation {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    validText(item.id, 200) &&
    item.id.length > 0 &&
    validText(item.projectId, 200) &&
    item.projectId.length > 0 &&
    validText(item.createdAt, 40) &&
    Number.isFinite(Date.parse(item.createdAt))
  );
}

export default function accountRoutes(
  store: AccountStore | null,
  authenticate?: RequestHandler,
) {
  const router = Router();
  const domain = process.env.AUTH0_DOMAIN?.trim();
  const audience = process.env.AUTH0_AUDIENCE?.trim();
  if (!store || (!authenticate && (!domain || !audience))) {
    router.use((_req, res) => {
      res
        .status(503)
        .json({ error: "Account storage or Auth0 is not configured." });
    });
    return router;
  }
  router.use(
    authenticate ?? auth({ audience, issuerBaseURL: `https://${domain}/` }),
  );
  const subject = (req: Request) =>
    (req as AuthenticatedRequest).auth?.payload?.sub;
  const guarded =
    (
      handler: (req: Request, res: Response, sub: string) => Promise<void>,
    ): RequestHandler =>
    (req, res, next) => {
      const sub = subject(req);
      if (!sub) {
        res.status(401).json({ error: "Sign in required." });
        return;
      }
      handler(req, res, sub).catch(next);
    };

  router.get(
    "/",
    guarded(async (_req, res, sub) => {
      res.json(await store.load(sub));
    }),
  );
  router.put(
    "/profile",
    guarded(async (req, res, sub) => {
      const { name, email, picture } = req.body ?? {};
      if (![name, email, picture].every((item) => validText(item, 500))) {
        res.status(400).json({ error: "Invalid profile." });
        return;
      }
      await store.saveProfile(sub, { name, email, picture });
      res.sendStatus(204);
    }),
  );
  router.put(
    "/projects/:id",
    guarded(async (req, res, sub) => {
      if (!validProject(req.body) || req.body.id !== req.params.id) {
        res.status(400).json({ error: "Invalid project." });
        return;
      }
      await store.saveProject(sub, req.body);
      res.sendStatus(204);
    }),
  );
  router.delete(
    "/projects/:id",
    guarded(async (req, res, sub) => {
      await store.deleteProject(sub, String(req.params.id));
      res.sendStatus(204);
    }),
  );
  router.put(
    "/preparations/:id",
    guarded(async (req, res, sub) => {
      if (!validPreparation(req.body) || req.body.id !== req.params.id) {
        res.status(400).json({ error: "Invalid preparation." });
        return;
      }
      const saved = await store.savePreparation(sub, req.body);
      if (!saved) {
        res
          .status(404)
          .json({ error: "Project does not belong to this account." });
        return;
      }
      res.sendStatus(204);
    }),
  );
  router.delete(
    "/preparations/:id",
    guarded(async (req, res, sub) => {
      await store.deletePreparation(sub, String(req.params.id));
      res.sendStatus(204);
    }),
  );
  router.use(
    (
      error: Error & { status?: number },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (error.status === 401) {
        res.status(401).json({ error: "Invalid or expired access token." });
        return;
      }
      console.error("[account]", error);
      res.status(503).json({
        error: "Account data could not be saved or loaded. Try again.",
      });
    },
  );
  return router;
}
