import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import app from "./app";

try {
  loadEnvFile(resolve(__dirname, "../../.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

app.listen(4000, "0.0.0.0", () => console.log("Backend on 4000"));
