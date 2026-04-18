# Contributing Guide

This guide describes how to iterate, construct custom local analyzer plugins, and execute the complete Sandbox platform locally via Cloudflare's `Miniflare` emulator system.

## Local Execution (Miniflare Emulator)

Cloudflare explicitly builds `Miniflare` to perfectly replicate V8 Isolates and Docker Container APIs locally on your development machine.

1. **Setup `.dev.vars`**
   Replicate the `.dev.vars.example` into a local `.dev.vars` file. Fill in your valid API keys. Ensure `AI_PROVIDER` points to an active paid model.
   ```bash
   cp .dev.vars.example .dev.vars
   ```

2. **Run The Emulator**
   Execute the entire stack locally. Wrangler will natively compile `TypeScript`, mock the Message Queues, deploy the isolated Key-Value databases into your RAM, and execute the Webhook listener dynamically on `localhost`.
   ```bash
   npm run dev
   ```

## Creating Custom Local Analyzers

Beyond the native `oxlint`/`semgrep` OS tools executing inside the container, the Edge Worker operates a specialized Map-Reduce syntax validation system via `src/lib/plugins/`.

If you wish to intercept code prior to the LLMs, you can write an `AnalyzerPlugin` interface export tightly coupled to `src/lib/plugin-system.ts`.

Example `suspicious.ts` analyzer:
```typescript
import { AnalyzerPlugin } from '../plugin-system';

export const SuspiciousKeywordAnalyzer: AnalyzerPlugin = {
    name: 'suspicious_detector',
    execute: (chunkContent) => {
        if (chunkContent.includes('TODO: REMOVE')) {
             return [{ severity: 'warning', text: 'Stale TODO comments block production merges' }]
        }
        return [];
    }
}
```

## Cloudflare Limitations Envelope & Subrequests

The code reviewer heavily exploits the absolute architectural peaks of Cloudflare Workers. Developing new features demands complete adherence to Cloudflare's Compute API limitation math:

**Paid Tier Subrequest Constraints:**
* **Limit:** 1000 Subrequests per Worker lifecycle.
* Every external `fetch()` (GitHub API patch, Anthropic map chunk, etc.) uses 1 Subrequest.
* *Why it matters:* Do NOT execute `.map()` loops indiscriminately over API routes. If the worker triggers 1001 subrequests, Cloudflare terminates it instantly without executing cleanup blocks.

**Queue Consumer & Container Timeouts:**
* **Limit:** 15 Minutes.
* *Why it matters:* The Edge Worker Webhook ingest runs for milliseconds, but the Queued `ReviewContainer` spans 15 minutes max. Huge AST Generation algorithms must use heavily parallel architectures, otherwise the sandbox container times out causing `1102` fatal errors.

## Running the Sandbox UI

Test endpoints synchronously using `vitest`:
```bash
npm run test
```
