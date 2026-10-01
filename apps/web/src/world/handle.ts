import type { World } from "./engine";

/** The one place the UI reaches the imperative world. Set by the canvas host. */
export const handle: { world: World | null } = { world: null };
