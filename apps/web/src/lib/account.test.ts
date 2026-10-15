import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
import { api, ApiError } from "./api";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { addPasskey, explain, recoveryPasskey, recoveryRedeem, signIn, signupVerify } from "./account";

beforeEach(() => { vi.resetAllMocks(); });

describe("ST-49 owner ceremonies keep secrets out of agent grants and support cancellation", () => {
  it("ST-49 recovery retries use the cookie ticket, without resubmitting spent codes", async () => {
    vi.mocked(api).mockResolvedValueOnce({ options: {} }).mockResolvedValueOnce({ options: { challenge: "fresh" } }).mockResolvedValueOnce({});
    vi.mocked(startRegistration).mockResolvedValue({ id: "fixture-credential" } as never);
    await recoveryRedeem("owner@example.test", "12345678", "SAVED-CODE");
    await recoveryPasskey();
    expect(vi.mocked(api).mock.calls.map((call) => call[1])).toEqual(["/api/v1/auth/recovery/redeem", "/api/v1/auth/register/options", "/api/v1/auth/register/verify"]);
    expect(api).toHaveBeenNthCalledWith(2, "POST", "/api/v1/auth/register/options", {});
    expect(api).toHaveBeenNthCalledWith(3, "POST", "/api/v1/auth/register/verify", { response: { id: "fixture-credential" } });
  });

  it("ST-49 cancelled passkey prompts do not verify a registration or replay recovery codes", async () => {
    vi.mocked(api).mockResolvedValue({ options: {} });
    vi.mocked(startRegistration).mockRejectedValue(new DOMException("closed", "NotAllowedError"));
    await expect(recoveryPasskey()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(api).toHaveBeenCalledTimes(1);
    expect(explain(new ApiError(400, "invalid_code", "secret-payload"))).not.toContain("secret-payload");
  });

  it("ST-55 adding a passkey uses the exact approved action, and stops after the view is cancelled", async () => {
    vi.mocked(api).mockResolvedValueOnce({ options: {} }).mockResolvedValueOnce({ credential: { id: "new" } });
    vi.mocked(startRegistration).mockResolvedValue({ id: "new" } as never);
    await addPasskey("approved-id");
    expect(api).toHaveBeenLastCalledWith("POST", "/api/v1/passkeys", { registration: { id: "new" } }, { "X-MH-Action-Id": "approved-id" });
    vi.mocked(api).mockClear().mockResolvedValue({ options: {} });
    let active = true;
    vi.mocked(startRegistration).mockImplementation(async () => { active = false; return { id: "abandoned" } as never; });
    await expect(addPasskey("abandoned-id", () => active)).rejects.toMatchObject({ name: "AbortError" });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("ST-51 an abandoned sign-in never posts its assertion", async () => {
    vi.mocked(api).mockResolvedValue({ options: {} });
    let active = true;
    vi.mocked(startAuthentication).mockImplementation(async () => { active = false; return { id: "abandoned" } as never; });
    await expect(signIn(() => active)).rejects.toMatchObject({ name: "AbortError" });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("ST-42 closing sign-up before the prompt completes prevents factor enrollment", async () => {
    vi.mocked(api).mockResolvedValue({ options: {} });
    let active = true;
    vi.mocked(startRegistration).mockImplementation(async () => { active = false; return { id: "abandoned" } as never; });
    await expect(signupVerify("owner@example.test", "12345678", () => active)).rejects.toMatchObject({ name: "AbortError" });
    expect(api).toHaveBeenCalledTimes(1);
  });
});
