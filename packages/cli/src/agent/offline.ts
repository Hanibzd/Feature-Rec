import fs from "node:fs";
import path from "node:path";
import { GENERATED_DIR } from "../paths";

/**
 * Known-good scenes that ship in the repo (the "demo safety net"). When there is
 * no API key, or the agent fails, these guarantee the pipeline still produces a
 * polished scene instead of an empty frame.
 */
const KNOWN_GOOD = new Set(["dark-mode-toggle", "invite-members"]);

export function hasOfflineScene(id: string): boolean {
  return KNOWN_GOOD.has(id) && fs.existsSync(path.join(GENERATED_DIR, `${id}.tsx`));
}
