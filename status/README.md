# Status page

A static status page for Mosshatch (PLAN section 5, Phase 6: "the status page on a provider other than Vercel and AWS"). Two files, no
script, no build step, no third-party request: `index.html` and `status.css`. Nothing here is deployed yet.

## Where to host it

It must stay up when Mosshatch is down, so it cannot share Mosshatch's hosting (Vercel), cloud (AWS) or database (Neon). Pick one:

| Option | Why | Watch |
|---|---|---|
| Cloudflare Pages (recommended) | Free, static, its own CDN, deploys from a Git repository or a direct upload | Use an account that is not the one holding any Mosshatch DNS, so one compromise does not take both |
| GitHub Pages | Free, from a repository in the organisation | Needs a public repository on free plans |
| A hosted status service (Instatus, Better Stack, Atlassian Statuspage) | Subscriber email and uptime checks built in | A monthly cost; copy the wording and states from this page |

Do not host it on Vercel, AWS (including S3 or CloudFront), or anything that routes through the `web` project.

## Address

`status.mosshatch.com` as a CNAME to the host. `mosshatch.com`'s DNS is a single point of failure for that name, so also publish the
host's own address (for example `mosshatch-status.pages.dev`) in the on-call sheet and in support replies.

## Updating it

1. Change the overall line (the `ok`, `degraded` or `down` class, the symbol and the words together).
2. Change each affected part's class, symbol and word. Never show a state by colour alone.
3. Add an incident `<article>` (a commented template is in the page), newest first, with times in UTC. Never delete a past incident.
4. Update the "Last checked by hand" time.

The page carries its own Content-Security-Policy in a `<meta>` tag because the host's headers are not known here. If the host lets
you set headers, send the same policy plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
