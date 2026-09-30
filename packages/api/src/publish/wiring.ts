import type { Mode } from "../ports.ts";
import type { PublishServices } from "./service.ts";
import { MemoryCardStorage, MemoryCardsSite, VercelBlobStorage, VercelDeployHook } from "./storage.ts";
import { FakeWebRisk, GoogleWebRisk } from "./screen.ts";

/**
 * Publish adapters from the environment. The real ones need all three settings (Blob token, Web Risk key, cards deploy hook);
 * local development gets the in-memory fakes; anything else gets nothing, and the publish routes answer 503 rather than guess.
 */
export function publishFromEnv(env: Record<string, string | undefined>, mode: Mode): PublishServices | undefined {
  const cardsOrigin = env.CARDS_ORIGIN ?? "https://hatchkind.com";
  if (env.BLOB_READ_WRITE_TOKEN && env.WEB_RISK_API_KEY && env.CARDS_DEPLOY_HOOK_URL) {
    return { storage: new VercelBlobStorage({ token: env.BLOB_READ_WRITE_TOKEN }), webRisk: new GoogleWebRisk(env.WEB_RISK_API_KEY), site: new VercelDeployHook(env.CARDS_DEPLOY_HOOK_URL), cardsOrigin };
  }
  if (mode === "local") return { storage: new MemoryCardStorage(), webRisk: new FakeWebRisk(), site: new MemoryCardsSite(), cardsOrigin };
  return undefined;
}
