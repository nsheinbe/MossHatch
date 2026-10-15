/** JSON quoting preserves every character; also make invisible direction/format characters visible to the reviewer. */
export function dnsReviewText(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
