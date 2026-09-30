import type { Route } from "../http/types.ts";
import { accountRoutes } from "./account.ts";
import { addressRoutes } from "./addresses.ts";
import { emailActionRoutes } from "./email-actions.ts";
import { loginRoutes } from "./login.ts";
import { recoveryRoutes } from "./recovery.ts";
import { signupRoutes } from "./signup.ts";

/** Every auth route under /api/v1, in one list for `buildRouter()`. */
export const authRoutes: Route[] = [...signupRoutes, ...loginRoutes, ...accountRoutes, ...addressRoutes, ...recoveryRoutes, ...emailActionRoutes];
