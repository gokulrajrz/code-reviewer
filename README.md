# Code Reviewer Agent

An AI-powered Cloudflare Worker that automatically reviews GitHub Pull Requests using Claude 3.5 Sonnet (default) or Gemini 1.5 Pro. Built specifically for codebases using **Feature-Sliced Design (FSD)**, React, Zustand, TanStack Query, and Tailwind CSS.

---

## How It Works

1. A developer opens or updates a PR on GitHub.
2. GitHub sends a webhook event to the Cloudflare Worker URL.
3. The Worker verifies the HMAC-SHA256 signature, fetches the PR diff + full file contents, and sends them to the LLM.
4. The LLM returns a structured markdown review (FSD compliance, severity-tagged findings, code suggestions).
5. The Worker posts the review as a PR comment — all within seconds.

---

## Setup Guide

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Secrets

Set these via Wrangler — they are **never** committed to source control:

```bash
npx wrangler secret put ANTHROPIC_API_KEY     # Claude API key (default model)
npx wrangler secret put GEMINI_API_KEY        # Gemini API key (optional fallback)
npx wrangler secret put GITHUB_TOKEN          # GitHub Fine-Grained PAT
npx wrangler secret put GITHUB_WEBHOOK_SECRET # Secret string you choose for the webhook
```

#### GitHub Token Permissions Required
Create a [Fine-Grained Personal Access Token](https://github.com/settings/tokens?type=beta) with:
- **Repository permissions → Pull Requests**: `Read and Write`
- **Repository permissions → Contents**: `Read` (for fetching file contents)

### 3. Local Development

Copy the secrets template and fill in your keys:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual keys
npm run dev
```

### 4. Deploy to Cloudflare

```bash
npm run deploy
```

After deploy, Wrangler will output your Worker URL:
```
https://code-reviewer.<your-account>.workers.dev
```

### 5. Configure GitHub Webhook

In your React project repository:

1. Go to **Settings → Webhooks → Add webhook**
2. **Payload URL**: `https://code-reviewer.<your-account>.workers.dev/`
3. **Content type**: `application/json`
4. **Secret**: The same value you set for `GITHUB_WEBHOOK_SECRET`
5. **Events**: Select "Let me select individual events" → check **Pull requests** only
6. Click **Add webhook**

---

## Environment Variables

| Variable | Type | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Anthropic API key for Claude |
| `GEMINI_API_KEY` | Secret | Google AI API key for Gemini |
| `GITHUB_TOKEN` | Secret | GitHub PAT for API access |
| `GITHUB_WEBHOOK_SECRET` | Secret | HMAC signature secret |
| `AI_PROVIDER` | Var | `"claude"` (default) or `"gemini"` |

### Switching to Gemini

In `wrangler.jsonc`, change the `vars` block:

```jsonc
"vars": {
  "AI_PROVIDER": "gemini"
}
```

Or override at deploy time:

```bash
npx wrangler deploy --var AI_PROVIDER:gemini
```

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check — returns status, version, active provider |
| `POST` | `/` | GitHub webhook receiver |

---

## Project Structure

```
src/
├── config/
│   ├── constants.ts        # Model names, limits, defaults
│   └── system-prompt.ts    # Detailed LLM system prompt
├── handlers/
│   └── webhook.ts          # Core PR webhook handler
├── lib/
│   ├── github.ts           # GitHub API helpers
│   ├── security.ts         # HMAC-SHA256 signature verification
│   └── llm/
│       ├── claude.ts       # Claude adapter
│       ├── gemini.ts       # Gemini adapter
│       └── index.ts        # Unified LLM dispatcher
├── types/
│   ├── env.ts              # Env interface
│   └── github.ts           # GitHub webhook & API types
└── index.ts                # Worker entry point
```

---

## Cost Estimate

Assuming ~100 PRs/month, ~50k tokens per review:

| Service | Cost/month |
|---|---|
| Cloudflare Workers | **$0** (free tier: 100k req/day) |
| Claude 3.5 Sonnet | ~$15 |
| Gemini 1.5 Pro | ~$6.50 |

---

## Running Tests

```bash
npm run test
```
