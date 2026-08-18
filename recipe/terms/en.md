# Terms of Service

## 1. About this service

This browser-based deployment wizard ("the installer") helps you create or recover an EdgeSonic instance under your own Cloudflare account. By using it, you confirm you own and are authorized to use the Cloudflare account and API token you enter on the following pages. Every Worker, D1 database, and R2 bucket the installer creates or recovers belongs to your own Cloudflare account, not to the operator of this service.

## 2. Data handling

- Browsers can't call the Cloudflare API directly (CORS), so the installer relays its Cloudflare API requests through a stateless backend we operate. The relay only forwards requests and responses as-is — it does not log or persist your API token, R2 keys, or any request content.
- That relay runs on Cloudflare's own platform. As the infrastructure provider, Cloudflare applies its standard platform-level tracking and anti-abuse measures to traffic crossing its network (e.g. CF-Ray request identifiers, rate limiting, bot detection, WAF rules). This processing happens under Cloudflare's own terms and privacy policy, independently of us — we don't control it and can't make any guarantee on Cloudflare's behalf.
- The Cloudflare credentials you enter live only in this browser tab's session storage and are cleared when the tab closes or the deployment finishes, successfully or not. We never collect, forward to a third party, or retain them long-term in any form.

## 3. Resources and data responsibility

- The installer creates or recovers the Worker, D1 database, and R2 bucket named on the following pages. An existing Worker is never overwritten without a separate confirmation.
- If the D1 database or R2 bucket name you enter already exists, the installer reuses it instead of failing. You are responsible for confirming those names aren't already in use on your account, so the installer doesn't attach itself to unrelated data.
- "Recover an existing instance" makes a best effort to preserve data, but we cannot guarantee full recovery from damage caused by user error, concurrent deployments, Cloudflare-side failures, or other factors outside our control — keep your own independent backup of anything that matters.

## 4. Service availability

This installer and its relay are provided as-is, with no guarantee of availability, uptime, or continuity. The service may become temporarily or permanently unavailable due to maintenance, changes on Cloudflare's side, anti-abuse measures being triggered, or other reasons, without prior notice — don't treat it as infrastructure you can permanently depend on.

## 5. Purpose of this service

This installer and its relay are entirely free. They exist only to help you deploy your own EdgeSonic instance. We have never charged for this, and never will. If you paid someone for "access" or a "deployment service" to reach this page, you were scammed — please demand a refund and leave them a bad review.
