# Code Reviewer Agent

An AI-powered Cloudflare Worker that automatically reviews GitHub Pull Requests using Claude 3.5 Sonnet (default) or Gemini 1.5 Pro. Built specifically for codebases using **Feature-Sliced Design (FSD)**, React, Zustand, TanStack Query, and Tailwind CSS.

---

## 🏗️ High-Performance Architecture (Queues)

This agent uses a decoupled **Producer/Consumer** architecture using **Cloudflare Queues** to bypass the standard 30-second webhook execution limit on the Workers Free Tier:

1. **Webhook Handler (Producer)**: Receives the GitHub webhook, verifies the HMAC signature, and instantly pushes the PR details into a queue.
2. **Background Worker (Consumer)**: A background process that triggers when a message is added to the queue. It performs the heavy lifting: fetching diffs, assembling full-file context (~1M tokens), calling the LLM, and posting the comment.
3. **Execution Limits**: On the Cloudflare Free Tier, this background consumer enjoys a **15-minute** execution window, allowing for deep, opinionated reviews of even the largest PRs without timing out.

---

## Setup Guide

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Infrastructure (Queues)

Create the queue in your Cloudflare account:
```bash
npx wrangler queues create code-reviewer-queue
```

### 3. Configure Secrets

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

### 4. Local Development

Copy the secrets template and fill in your keys:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual keys
npm run dev
```

### 5. Deploy to Cloudflare

```bash
npm run deploy
```

### 6. Configure GitHub Webhook

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

---

## Endpoints

| Method | Path | Handler | Description |
|---|---|---|---|
| `GET` | `/` | `fetch()` | Health check — returns status, version, active provider |
| `POST` | `/` | `fetch()` | GitHub webhook receiver — pushes to queue |
| `N/A` | `queue()` | `queue()` | Background Queue Consumer — executes LLM review |

---

## Configuration & Usage

### 1. Switching Models

The agent defaults to **Claude 3.5 Sonnet**. To switch to **Gemini 1.5 Pro**:

1. Ensure `GEMINI_API_KEY` is set via `wrangler secret put`.
2. Update the provider:
   ```bash
   npx wrangler deploy --var AI_PROVIDER:gemini
   ```

### 2. Monitoring & Logs

To see the agent working in real-time (webhook reception + background LLM processing):

```bash
npx wrangler tail
```

---

## Project Structure

```
src/
├── config/
│   ├── constants.ts        # Model names, limits, defaults
│   └── system-prompt.ts    # Detailed LLM system prompt
├── handlers/
│   ├── webhook.ts          # HTTP Producer (receives webhooks)
│   └── queue.ts            # Background Consumer (executes LLM)
├── lib/
│   ├── github.ts           # GitHub API helpers
│   ├── security.ts         # HMAC-SHA256 signature verification
│   └── llm/
│       ├── claude.ts       # Claude adapter
│       ├── gemini.ts       # Gemini adapter
│       └── index.ts        # Unified LLM dispatcher
├── types/
│   ├── env.ts              # Env interface & ReviewMessage type
│   └── github.ts           # GitHub webhook & API types
└── index.ts                # Worker entry point (ExportedHandler)
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
