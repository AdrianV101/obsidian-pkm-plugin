// Preloaded with `node --import` by tests/server-health.test.js: every OpenAI call
// answers like an account with no credits left.
import { QUOTA_BODY } from "./fake-openai.js";

globalThis.fetch = async () => new globalThis.Response(QUOTA_BODY, { status: 429 });
