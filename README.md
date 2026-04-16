# @paid-ai/embed-example

Reference integration app for the [`@paid-ai/embed`](https://github.com/paid-ai/embed) SDK. Shows how to mint JWTs server-side, render value receipts via the embed SDK, and handle share-auth flows (login redirect + silent token refresh).

## Prerequisites

- Node.js 20+ (22 recommended)
- A Paid organization with at least one value receipt
- An API key from **Settings > API keys**
- A share-auth signing secret from **Settings > Share auth**

## Quick start

```bash
git clone https://github.com/paid-ai/embed-example.git
cd embed-example
npm install
cp .env.example .env.local   # then fill in your credentials
npm start
```

Open [http://localhost:3943](http://localhost:3943) and follow the guided steps.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PAID_API_BASE` | Yes | Paid API URL (default: `https://api.agentpaid.io`) |
| `PAID_APP_BASE` | Yes | Paid app URL (default: `https://app.paid.ai`) |
| `PAID_API_KEY` | Yes | API key from **Settings > API keys** |
| `PAID_SHARE_AUTH_SECRET` | Yes | HS256 signing secret from **Settings > Share auth** |
| `PAID_SHARE_AUTH_ISSUER` | No | JWT issuer claim (default: `"paid"`) |
| `PAID_SHARE_AUTH_AUDIENCE` | No | JWT audience claim (omit if not configured) |
| `PORT` | No | Server port (default: `3943`) |

## What this app demonstrates

- **Server-side JWT minting** — `src/server.ts` signs JWTs for the share-auth flow using `jsonwebtoken`
- **Embed SDK usage** — `public/index.html` loads the [`@paid-ai/embed`](https://www.npmjs.com/package/@paid-ai/embed) SDK via a `<script>` tag and calls `renderValueReceipt`
- **Login redirect flow** — `/auth/share-login` simulates your app's login page for the share-auth redirect
- **Silent token refresh** — `/api/share-token/refresh` shows how to issue fresh tokens for long-lived embeds
- **API proxy pattern** — backend routes proxy calls to the Paid API so your API key never reaches the browser

## Files

| File | Purpose |
|---|---|
| `src/server.ts` | Express server with all backend integration code |
| `public/index.html` | Frontend with guided walkthrough and live embed demos |
| `.env.example` | Template for environment configuration |

## Related

- [`@paid-ai/embed`](https://github.com/paid-ai/embed) — the embed SDK this app integrates
- [npm: @paid-ai/embed](https://www.npmjs.com/package/@paid-ai/embed) — SDK on npm

## License

MIT
