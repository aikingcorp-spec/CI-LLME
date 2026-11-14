import { readFileSync } from "node:fs";
import { resolveWorkerHealthFile, workerHealthIsFresh } from "./health.js";

try {
  process.exitCode = workerHealthIsFresh(
    JSON.parse(readFileSync(resolveWorkerHealthFile(), "utf8")),
  )
    ? 0
    : 1;
} catch {
  process.exitCode = 1;
}
