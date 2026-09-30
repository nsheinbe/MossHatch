/**
 * The words of the waitlist. The consent sentence is shown verbatim by the web form (apps/web/src/ui/waitlistText.ts) and the no-JS
 * page (apps/web/pages/waitlist.html); its SHA-256 is stored with each entry. waitlist.test.ts checks all three copies are equal.
 */
export const CONSENT_TEXT = "Email me about Mosshatch: a link to confirm, my invite when it is my turn, and occasional product news. I can leave with one click.";
export const QUESTION_TEXT = "Would you pay a few dollars for a one-of-a-kind creature designed for your name?";
export const FROM_DEFAULT = "Mosshatch <hello@send.mosshatch.com>";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Mail { subject: string; text: string }

const footer = (unsubscribe: string) => `\n\nJoining the waitlist does not reserve or register a domain name.\nLeave the list with one click: ${unsubscribe}\n\nMosshatch · hello@send.mosshatch.com`;

export function confirmMail(link: string, unsubscribe: string): Mail {
  return {
    subject: "Confirm your place on the Mosshatch waitlist",
    text: `Someone, hopefully you, asked to join the Mosshatch waitlist with this address.\n\nConfirm your place: ${link}\n\nThe link works for 7 days. If you did not ask, ignore this email and nothing more will come.${footer(unsubscribe)}`,
  };
}

export function welcomeMail(place: number, unsubscribe: string): Mail {
  return {
    subject: `You're #${place} in line for Mosshatch`,
    text: `You're on the Mosshatch waitlist. You're #${place} in line.\n\nWe let people in a few at a time. When it is your turn, we email you an invite that works for 14 days.${footer(unsubscribe)}`,
  };
}

export function alreadyMail(place: number, unsubscribe: string): Mail {
  return {
    subject: "You're already on the Mosshatch waitlist",
    text: `Someone asked to join the Mosshatch waitlist with this address. It is already on the list, so there is nothing to do. You're #${place} in line.${footer(unsubscribe)}`,
  };
}

export function inviteMail(link: string, unsubscribe: string): Mail {
  return {
    subject: "Your egg is ready to hatch",
    text: `It is your turn: you can now make a Mosshatch account.\n\nOpen your invite: ${link}\n\nThe invite works once, for 14 days, and only with this email address. Nothing is charged until you choose a name and pay for it.${footer(unsubscribe)}`,
  };
}

/** A small page served from /api/waitlist/* (confirm, unsubscribe, errors). Styled by the public pages' stylesheet; no script. */
export function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<meta name="robots" content="noindex" />
<title>${esc(title)} · Mosshatch</title>
<link rel="stylesheet" href="/commitments.css" />
</head>
<body>
<header class="site"><a class="wordmark" href="/">Mosshatch</a></header>
<main id="main">
<h1>${esc(title)}</h1>
${bodyHtml}
</main>
</body>
</html>
`;
}

export function tokenForm(action: string, token: string, button: string, lead: string): string {
  return `<p>${esc(lead)}</p>
<form method="post" action="${esc(action)}">
<input type="hidden" name="t" value="${esc(token)}" />
<button type="submit" class="wl-btn">${esc(button)}</button>
</form>`;
}

export const para = (s: string) => `<p>${esc(s)}</p>`;
export const homeLink = `<p><a href="/">Back to Mosshatch</a></p>`;
