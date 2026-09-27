// Vercel function: vercel.json rewrites every /api/* request here. The default
// export must be a request handler, so export the built app, not createApp.
import { appFromEnv } from "../backend/src/appFromEnv";

export default appFromEnv().app;
