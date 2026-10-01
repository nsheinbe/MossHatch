// The `registrar` Vercel project's only function (docs/GO-LIVE.md step 3). The bundle is built by scripts/build-registrar.mjs.
// It holds the Openprovider credentials; `web` reaches it only through signed RPC (packages/api/src/registrar-rpc).
import { registrarRpcFromEnv } from "./_bundle.mjs";

let served: ReturnType<typeof registrarRpcFromEnv> | undefined;

export default {
  async fetch(request: Request): Promise<Response> {
    served ??= registrarRpcFromEnv(process.env);
    return served.handler(request);
  },
};
