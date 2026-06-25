// scripts/lib/secrets.mjs
// Loads local, gitignored secrets (e.g. the z.ai / GLM API key) and injects them
// into engine configs. Keys live in .storm-secrets.json at the repo root — never
// committed (see .gitignore) and never logged.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = fileURLToPath(new URL('../../.storm-secrets.json', import.meta.url));

// Missing file or malformed JSON -> {} so Storm still runs the engines that don't
// need a secret. Never throws.
export function loadSecrets(secretsPath = DEFAULT_PATH) {
  try {
    return JSON.parse(readFileSync(secretsPath, 'utf8'));
  } catch {
    return {};
  }
}

// Pure: returns a new engines array with the glm engine carrying apiKey (from
// secrets.glmApiKey). Other engines pass through untouched. Input is not mutated.
export function injectSecrets(engines, secrets = {}) {
  return engines.map((e) => {
    if (e.id === 'glm' && secrets.glmApiKey) return { ...e, apiKey: secrets.glmApiKey };
    if (e.id === 'gemini' && secrets.openrouterApiKey) return { ...e, apiKey: secrets.openrouterApiKey };
    return e;
  });
}
