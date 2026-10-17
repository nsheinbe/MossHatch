import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Event = { type?: string; url?: string };
type Send = (event: Event) => Event | null;

/** Loads public/insights.js the way the browser does, and returns the queued beforeSend. */
function beforeSend(href: string): Send {
  const context: { window: { vaq?: [string, Send][] }; location: { href: string }; URL: typeof URL } = {
    window: {},
    location: { href },
    URL,
  };
  vm.runInNewContext(fs.readFileSync("apps/web/public/insights.js", "utf8"), context);
  const fn = context.window.vaq?.find((call) => call[0] === "beforeSend")?.[1];
  if (!fn) throw new Error("beforeSend was not queued");
  return fn;
}

describe("Web Analytics beforeSend", () => {
  const send = beforeSend("https://mosshatch.com/invite?t=secret");

  it("drops the query and hash so a secret in the URL is not part of the page view", () => {
    const out = send({ url: "https://mosshatch.com/invite?t=00000000-0000-4000-8000-000000000000.abcdefghijklmnopqrstuvwxyz0123456789AB#x" });
    expect(out).toMatchObject({ url: "https://mosshatch.com/invite" });
    expect(JSON.stringify(out)).not.toContain("t=");
  });

  it("leaves a URL with no query as it is", () => {
    expect(send({ url: "https://mosshatch.com/" })).toMatchObject({ url: "https://mosshatch.com/" });
    expect(send({ url: "https://mosshatch.com/device" })).toMatchObject({ url: "https://mosshatch.com/device" });
  });

  it("drops an event whose URL cannot be parsed", () => {
    expect(send({ url: "http://[" })).toBeNull();
  });

  it("passes an event that has no URL through", () => {
    expect(send({ type: "event" })).toEqual({ type: "event" });
  });
});
