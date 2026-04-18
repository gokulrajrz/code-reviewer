# Code Reviewer Agent

An Enterprise-grade AI Code Reviewer agent powered by **Cloudflare Workers** and an ephemeral **Docker Container Sandbox**. Automatically review your GitHub Pull Requests using **Claude 3.5 Sonnet** (default) or **Gemini 1.5 Flash**. 

Built natively as a GitHub App, it delivers perfectly composited tech-stack-aware reviews directly via GitHub Check Runs telemetry.

---

## 🏗️ Architecture: Dual-Compute Model

This project operates on a heavily parallelized Dual-Compute pipeline:

1. **The Edge Worker (Isolate):** A heavily secured, incredibly fast routing tier handling Webhook ingestion (HMAC-SHA256 verified), PR queuing, JWT App Authentication, usage metrics tracking, and rate-limiting.
2. **The Review Sandbox (Docker Container):** Ephemeral Node.js containers orchestrated dynamically by Cloudflare. Handles heavy OS-level dependencies required for massive AST analysis: `git clone`, `tree-sitter`, `Biome`, `Oxlint`, and `Semgrep`.

```
GitHub PR Event → Webhook POST → Worker Isolate Tier
                                   ├── Verify Signature
                                   ├── Push to Queue (code-reviewer-queue)
                                   └── Return 202 Accepted
                                        ↓
                         Worker Queue Consumer (Up to 15 min runtime)
                                   └── Dispatch `ReviewContainer` Durable Object
                                        ↓
                           Container Sandbox (Hono/Docker)
                                   ├── 📦 Git Clone (Shallow depth)
                                   ├── 🌳 Tree-Sitter AST Blast Radius computation
                                   ├── 🛡️ Execute SAST (Semgrep, Oxlint, Biome)
                                   ├── 🧠 MAP Primary LLM Review Pass
                                   ├── 🕵️ MAP Verification LLM Agent (Kill false positives)
                                   └── Live Patch GitHub Check Runs Progress
                                        ↓
                         Worker Reducer Fallback
                                   ├── Deduplicate & Synthesize Findings
                                   └── Post PR Comment via GitHub API
```

---

## 🌟 Capabilities

- **🧠 Ephemeral Container Checkouts**: Pulls your raw repository into an isolated sandbox to run native CLI operations.
- **🌳 AST Dependency Trees**: Generates a Tree-sitter powered codebase "blast radius" context so the LLM perfectly understands function relationships across unaffected files.
- **🛡️ SAST & Linter Guards**: Natively executes `oxlint`, `biome`, and `semgrep` alongside the AI agents to guarantee mathematically correct syntax validations.
- **🕵️ Multi-Agent Verification**: Every LLM critique is violently challenged by a secondary **Verification Agent** to aggressively eliminate LLM hallucinated false positives.
- **⚙️ `.codereview.yml` Overrides**: Fully bypass zero-LLM tech stack inferences by throwing a `.codereview.yml` into your repo to enforce your team's custom codebase architecture standards.
- **📊 Metric Observability**: Complete JSON logging, REST APIs, and automated token counting budget thresholds.
- **💼 Zoho Cliq**: Pushes custom Rich-Card payloads to Cliq groups to announce merge-blocking check run outcomes. 

---

## 📖 Complete Documentation Setup

For deep architectural implementation, operational maintenance, and detailed plugin configuration, view the standardized manuals inside the `docs/` folder:

1. **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — Comprehensive visualization of the Worker Queue ↔ Container Hono bridge.
2. **[docs/CONFIGURATION.md](./docs/CONFIGURATION.md)** — Guide on implementing the `.codereview.yml` inside your repository, writing custom rules arrays, and configuring ignore paths.
3. **[docs/INTEGRATIONS.md](./docs/INTEGRATIONS.md)** — Setting up Zoho Cliq bots, Slack payloads, and OAuth database user-mapping.
4. **[docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)** — Information for OSS Maintainers (Local Miniflare Testing, `.dev.vars` configs, Cloudflare Subrequest limits).
5. **[docs/OPERATIONS.md](./docs/README.md)** — Managing production LLM API token quotas, querying usage costs, checking Check Run error logs, and metrics observability.

---

## 🚀 Setup & Deployment

To deploy this entire multi-tier system to your own Cloudflare environment, strictly follow this execution order:

### 1. Requirements

Ensure you have a Cloudflare Account attached to a **Workers Paid Plan**. The heavy OS-level dependencies executed within the ephemeral sandbox significantly crush the Free-tier 50-subrequest ceilings (we leverage the Paid Plan's 1000 subrequest boundaries).

### 2. Environment Setup

```bash
# Clone and install
npm install
```

### 3. Build & Compile The Container Sandbox [CRITICAL 🛑]

The Cloudflare Container runs independently in Docker from the Javascript `dist/` directory. **You MUST transpile your TypeScript logic before deploying the worker.**

```bash
cd container/
npm run build
cd ..
```

*Warning: If you skip running `npm run build` inside the container folder, Cloudflare will build the Docker container using stale JavaScript files, breaking GitHub progress updates and telemetry!*

### 4. Create the Infrastructure Bindings

Configure the Cloudflare Message Queue and the isolated memory Key-Value namespaces:

```bash
npx wrangler queues create code-reviewer-queue

npx wrangler kv:namespace create USAGE_METRICS
npx wrangler kv:namespace create AUTH_KV
npx wrangler kv:namespace create CACHE_KV
npx wrangler kv:namespace create DEDUP_KV
```

Paste the generated Binding IDs directly into your `wrangler.jsonc` file.

### 5. Configure GitHub App & Secure Secrets

Register a GitHub App on your Developer Settings with *Checks (Read/Write)* and *Pull requests (Read/Write)* permissions. Subscribe it to *Pull request* webhook events.

Save all heavily secured production secrets natively into Cloudflare (DO NOT place these in plain-text configs):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY

# Paste the raw generated PEM file text string verbatim
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   

npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 6. Generate Types & Ignite Deploy

Create the isolated TypeScript environment boundaries, then push the Worker, Queue Consumers, and Container Registry securely to Cloudflare.

```bash
npx wrangler types
npx wrangler deploy
```

---

## 💸 Cost Structure

Because the Worker isolates natively chunk payloads within the container, processing massively bloated Pull Requests guarantees highly optimized Token budgeting.

| Provider | Cost Benchmark (per 1 Million Tokens) |
|---|---|
| **Cloudflare Runtime** | **$0.00** (Bounded perfectly within generic routing compute thresholds) |
| **Claude 3.5 Sonnet** | ~$3.00 Input / ~$15.00 Output |
| **Gemini 1.5 Flash** | ~$0.075 Input / ~$0.30 Output |
