# Code Reviewer Agent

An AI-powered Cloudflare Worker that automatically reviews GitHub Pull Requests using **Claude 3.5 Sonnet** (default) or **Gemini 1.5 Flash**. Built as a **GitHub App** with native Check Runs integration and **polyglot tech-stack awareness**.

---

## 🏗️ Architecture

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
                                       ├── 🆕 Tech Stack Detection (zero-LLM, static analysis)
                                       ├── 🆕 Per-Chunk Prompt Composition (stack-aware)
                                       ├── 🆕 .codereview.yml Repo Config Override
                                       ├── MAP: Chunk review with composed per-chunk prompts
                                       ├── Deduplicate & Cluster findings
                                       ├── REDUCE: Synthesize with stack-aware synthesizer prompt
                                       ├── Post PR comment as [bot]
                                       └── Update Check Run → success / failure
```

---

## 🌟 Key Features

- **🧠 Tech-Stack-Aware Reviews**: Automatically detects your project's tech stack (languages, frameworks, ecosystem libs, architecture patterns) via static analysis — zero LLM calls. Reviews are tailored to TypeScript, React, Next.js, Zustand, Tailwind, Python, Go, and more.
- **🧩 Modular Prompt System**: 14 independent prompt modules (languages, frameworks, ecosystem, architecture) are dynamically composed per-chunk based on the files being reviewed. No monolithic prompt — only relevant rules are included.
- **⚙️ Per-Repo Configuration**: Drop a `.codereview.yml` in your repo root to override detected stacks, add custom review rules, or ignore specific files/directories.
- **Tiered Review System**: Handles massive PRs (up to 300 files) by sorting files by significance. Top 15 files (`Tier 1`) get full file content fetched for deep review. Remaining files (`Tier 2`) use diff-only context.
- **Smart Prioritization**: Files scored by change size, with bonuses for source code (`.ts`, `.py`, etc.), newly-added files, and core directories (`src/`).
- **Aggressive Noise Filtering**: Automatically ignores 30+ extensions (`.lock`, `.svg`, `.map`) and vendor directories (`node_modules/`, `dist/`).
- **Zoho Cliq Bot Notifications**: Posts Rich-Card PR scorecards to your team's Zoho Cliq channel.
- **Execution Limits Protection**: Hard limits on chunks (max 10) to prevent Cloudflare's 50-subrequest ceiling. `AbortSignal` tears down hung sockets during LLM timeouts.
- **Multi-LLM Support**: Switch between Claude 3.5 Sonnet and Gemini 1.5 Flash via environment variables. Automatic fallback to alternate provider on failure.
- **📊 Token Usage & Cost Tracking**: Automatic per-PR token usage tracking with detailed cost estimates, stored in Cloudflare KV. Query via REST API or the included dashboard.

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

### 5. Create KV Namespace for Usage Tracking

```bash
# Production namespace
npx wrangler kv:namespace create USAGE_METRICS

# Preview namespace for development
npx wrangler kv:namespace create USAGE_METRICS --preview
```

Update the IDs in `wrangler.jsonc` with the output from these commands.

### 6. Configure Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # Paste the full PEM contents
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler secret put CLIQ_CLIENT_ID           # Zoho OAuth Client ID
npx wrangler secret put CLIQ_CLIENT_SECRET       # Zoho OAuth Client Secret
npx wrangler secret put CLIQ_REFRESH_TOKEN       # Zoho OAuth Refresh Token
npx wrangler secret put CLIQ_CHANNEL_ID          # Target Channel/User ID
```

### 7. Generate Types

```bash
npx wrangler types
```

### 8. Local Development

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual keys
npm run dev
```

### 9. Deploy

```bash
npm run deploy
```

---

## Per-Repo Configuration (`.codereview.yml`)

Create a `.codereview.yml` file in your repository root to customize reviews:

```yaml
# Override the auto-detected tech stack
stack:
  languages: [typescript]
  frameworks: [react, nextjs]
  ecosystem: [zustand, tailwind, tanstack-query]
  architecture: [fsd]

# Add custom review rules
rules:
  - "All API calls must go through the `api/` layer, never directly from components"
  - "Use `useQuery` from TanStack Query for all server state — no manual `useEffect` + `fetch`"
  - "Feature slices must not import from other feature slices"

# Ignore specific files or directories
ignore:
  - "*.generated.ts"
  - "legacy/*"
  - "scripts/*"
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
| `CLIQ_CLIENT_ID` | Secret | Zoho OAuth Client ID |
| `CLIQ_CLIENT_SECRET` | Secret | Zoho OAuth Client Secret |
| `CLIQ_REFRESH_TOKEN` | Secret | Zoho OAuth permanent refresh token |
| `CLIQ_CHANNEL_ID` | Secret | Zoho Target ID (Channel, Group Chat, or DM) |
| `CLIQ_BOT_NAME` | Var | Unique Bot Name in `wrangler.jsonc` |
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
│   ├── constants.ts                     # Model names, limits, defaults
│   ├── usage-constants.ts               # Usage tracking config
│   └── prompts/                         # 🆕 Modular prompt system
│       ├── base.ts                      #   Universal review rules
│       ├── output-format.ts             #   JSON output schema
│       ├── composer.ts                  #   Dynamic prompt composition engine
│       ├── languages/
│       │   ├── typescript.ts            #   TypeScript-specific rules
│       │   ├── python.ts               #   Python-specific rules
│       │   └── go.ts                   #   Go-specific rules
│       ├── frameworks/
│       │   ├── react.ts                #   React-specific rules
│       │   ├── nextjs.ts               #   Next.js-specific rules
│       │   └── express.ts              #   Express-specific rules
│       ├── ecosystem/
│       │   ├── zustand.ts              #   Zustand state management rules
│       │   ├── tanstack-query.ts       #   TanStack Query rules
│       │   ├── tailwind.ts             #   Tailwind CSS rules
│       │   └── react-hook-form.ts      #   React Hook Form rules
│       └── architecture/
│           └── fsd.ts                  #   Feature-Sliced Design rules
├── handlers/
│   ├── webhook.ts                       # HTTP Producer (receives webhooks)
│   └── queue.ts                         # Background Consumer (Map-Reduce pipeline)
├── lib/
│   ├── github.ts                        # GitHub API helpers (Check Runs, comments, chunking)
│   ├── github-auth.ts                   # GitHub App JWT + installation tokens
│   ├── security.ts                      # HMAC-SHA256 signature verification
│   ├── stack-detector.ts                # 🆕 6-tier static tech stack detection
│   ├── repo-config.ts                   # 🆕 .codereview.yml fetch, parse, overrides
│   ├── finding-clusters.ts              # Finding deduplication & clustering
│   ├── review-formatter.ts              # Fallback markdown formatter
│   ├── verdict.ts                       # Data-driven verdict engine
│   ├── usage-tracker.ts                 # Token usage & cost tracking
│   ├── logger.ts                        # Structured JSON logging
│   ├── retry.ts                         # Retry with exponential backoff
│   ├── cache.ts                         # KV caching utilities
│   ├── cors.ts                          # CORS middleware
│   ├── errors.ts                        # Typed error hierarchy
│   ├── validation.ts                    # Input validation (250+ lines)
│   ├── plugin-system.ts                 # Analyzer plugin system
│   ├── plugins/                         # Local analyzer plugins
│   └── llm/
│       ├── adapter.ts                   # LLM provider adapter interface
│       ├── adapters/
│       │   ├── claude.ts                # Claude adapter (Anthropic)
│       │   └── gemini.ts               # Gemini adapter (Google AI)
│       ├── index.ts                     # Unified LLM dispatcher with fallback
│       ├── parse-findings.ts            # Defensive JSON parser for LLM output
│       └── error-handler.ts             # LLM error response handler
├── types/
│   ├── env.ts                           # Env interface & ReviewMessage type
│   ├── github.ts                        # GitHub webhook & API types
│   ├── review.ts                        # ReviewFinding, SynthesizerInput types
│   ├── stack.ts                         # 🆕 TechStackProfile types
│   └── usage.ts                         # Usage metrics & pricing types
└── index.ts                             # Worker entry point (ExportedHandler)
```

---

## 📊 Usage Tracking & Cost Monitoring

Track detailed token usage and costs for every PR review. See [docs/README.md](./docs/README.md) for complete documentation.

### Quick Start

Query usage for a specific PR:
```bash
curl https://your-worker.workers.dev/usage/owner/repo/pr/123
```

Get repository statistics:
```bash
curl https://your-worker.workers.dev/usage/owner/repo/stats
```

### Documentation

- **[Quick Start](./docs/QUICKSTART.md)** - Get started in 5 minutes
- **[User Guide](./docs/USER_GUIDE.md)** - Complete API reference
- **[Deployment](./docs/DEPLOYMENT.md)** - Setup instructions
- **[Architecture](./docs/ARCHITECTURE.md)** - Technical details
- **[Runbook](./docs/RUNBOOK.md)** - Operational runbook

---

## Testing

```bash
npm run test
```

---

## Cost Estimate

Assuming ~100 PRs/month, ~50k tokens per review:

| Service | Cost/month |
|---|---|
| Cloudflare Workers | **$0** (free tier: 100k req/day) |
| Claude 3.5 Sonnet | ~$15 |
| Gemini 1.5 Flash | ~$6.50 |
