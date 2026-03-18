# Code Reviewer Agent

An AI-powered Cloudflare Worker that automatically reviews GitHub Pull Requests using Claude Sonnet (default) or Gemini 1.5 Pro. Built as a **GitHub App** with native Check Runs integration.

---

## 🏗️ Architecture

```
```
GitHub PR Event → Webhook POST → fetch handler
                                   ├── Verify HMAC-SHA256
                                   ├── Get Installation Token (JWT → GitHub API)
                                   ├── Branch filter → Skipped Check Run (grey badge)
                                   └── Allowed branch:
                                       ├── Create Check Run (in_progress / yellow)
                                       └── Push to Cloudflare Queue
                                                  ↓
                                       Queue Consumer (up to 15 min)
                                       ├── Paginated fetch of all PR files (max 300)
                                       ├── Smart Prioritization (classify noise vs code)
                                       ├── Tiered Context:
                                       │    ├── Tier 1 (top 15): Full raw content + Diff patch
                                       │    └── Tier 2 (rest): Diff patch only
                                       ├── Subrequest limits enforced (max 10 chunks)
                                       ├── Sequence LLM calls (Claude / Gemini) w/ AbortSignal teardown
                                       ├── Aggregate findings
                                       ├── Post PR comment as [bot]
                                       └── Update Check Run → success / failure
```

---

## 🌟 Key Features

- **Tiered Review System**: Handles massive PRs (up to 300 files) by sorting files by significance. Top 15 files (`Tier 1`) get full file content fetched for deep architectural review. Remaining files (`Tier 2`) use diff-only context to save subrequests and tokens.
- **Smart Prioritization**: Extracted files are scored based on change size, with bonuses applied to source code (`.ts`, `.py`, etc.), newly-added files, and core application directories (`src/`).
- **Aggressive Noise Filtering**: Automatically ignores >30 extensions (`.lock`, `.svg`, `.map`) and vendor directories (`node_modules/`, `dist/`), saving API costs and LLM context.
- **Execution Limits Protection**: Hard limits on generation chunks (max 10) to mathematically prevent Cloudflare's 50-subrequest free-tier ceiling. `AbortSignal` implementation forcibly tears down hung sockets during LLM timeouts to avoid connection exhaustion cascades.
- **Multi-LLM Support**: Switch seamlessly between Claude 3.5 Sonnet (default) and Gemini 1.5 Pro via environment variables.

---

## Setup Guide

### 1. Install Dependencies

```bash
npm install
```

### 2. Create the GitHub App

1. Go to **GitHub → Settings → Developer Settings → GitHub Apps → New GitHub App**
2. Fill in the details:
   - **App name**: `Rareminds Code Reviewer` (or your preferred name)
   - **Homepage URL**: `https://code-reviewer.<your-account>.workers.dev`
   - **Webhook URL**: `https://code-reviewer.<your-account>.workers.dev`
   - **Webhook secret**: Choose a strong secret string
3. Set **Permissions**:
   - **Checks**: Read & Write
   - **Pull requests**: Read & Write
   - **Contents**: Read
4. **Subscribe to events**: Check **Pull request**
5. Click **Create GitHub App**
6. Note the **App ID** from the settings page
7. Click **Generate a private key** — this downloads a `.pem` file

### 3. Install the App on Your Repository

1. Go to the App settings → **Install App** tab
2. Click **Install** next to your organization/account
3. Select the repositories you want to enable reviews on
4. Note the **Installation ID** from the URL (`github.com/settings/installations/<ID>`)

### 4. Create the Queue

```bash
npx wrangler queues create code-reviewer-queue
```

### 5. Configure Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # Paste the full PEM contents
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 6. Local Development

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual keys
npm run dev
```

### 7. Deploy

```bash
npm run deploy
```

---

## Environment Variables

| Variable | Type | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Anthropic API key for Claude |
| `GEMINI_API_KEY` | Secret | Google AI API key for Gemini |
| `GITHUB_APP_ID` | Secret | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Secret | GitHub App Private Key (PEM format) |
| `GITHUB_APP_INSTALLATION_ID` | Secret | GitHub App Installation ID |
| `GITHUB_WEBHOOK_SECRET` | Secret | Webhook HMAC signature secret |
| `AI_PROVIDER` | Var | `"claude"` (default) or `"gemini"` |
| `ALLOWED_TARGET_BRANCHES` | Var | Comma-separated branches to review (e.g., `"dev,main"`) |

---

## Check Run States

| Scenario | Check Run Badge | Blocks Merge? |
|---|---|---|
| PR targets ignored branch | ⏭️ **Skipped** (grey) | No |
| Review in progress | 🟡 **In Progress** (yellow) | Yes |
| LLM approves | ✅ **Success** (green) | No |
| LLM requests changes | ❌ **Failure** (red) | Yes |
| Pipeline error | ❌ **Failure** (red) | Yes |

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
│   ├── github.ts           # GitHub API helpers (Check Runs, comments)
│   ├── github-auth.ts      # GitHub App JWT + installation tokens
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

## Running Tests

```bash
npm run test
```

---

## Cost Estimate

Assuming ~100 PRs/month, ~50k tokens per review:

| Service | Cost/month |
|---|---|
| Cloudflare Workers | **$0** (free tier: 100k req/day) |
| Claude Sonnet | ~$15 |
| Gemini 1.5 Pro | ~$6.50 |
