# Operations Runbook

This manual covers the active day-to-day operations, telemetry querying, and observability tuning for the AI Code Reviewer platform running on Cloudflare.

## Dashboard & Metrics Interfaces

The agent automatically logs granular token budgets, estimated LLM costs, and telemetry on every chunk execution through Cloudflare KV (`USAGE_METRICS`).

### 1. The Visual Dashboard
Located internally at `scripts/usage-dashboard.html`. Open this locally in your browser and bind it to your worker's live HTTP URL. It will automatically generate graphical layouts representing your AI token budget burn rates.

### 2. Checking Current PR Usage
Target a specific Pull Request to diagnose token explosions or Map-Reduce chunking counts:
```bash
curl https://code-reviewer.<YOUR-WORKER>.workers.dev/usage/owner/repo/pr/123
```

### 3. Check Repository Burn-Rates
Aggregates total metrics to see if developers in a specific repo are expending too much AI budget:
```bash
curl https://code-reviewer.<YOUR-WORKER>.workers.dev/usage/owner/repo/stats
```

## Telemetry Payload Structures

Each Pull Request review stores a 90-day ephemeral JSON document that outlines:
- **`Duration`**: Compute time within the `ReviewContainer` limits (Usually 0-30s).
- **`Chunks Processed`**: How many LLM requests the AST Map-Reduce algorithm dispatched.
- **`Provider`**: Indicates if the pipeline leveraged `claude` (Sonnet) or `gemini` (Flash).
- **`Cost`**: Calculated automatically off hardcoded pricing parameters in `src/types/usage.ts`.

## Adjusting Operational Constraints

If the AI budget is burning too violently or you hit Cloudflare limits, adjust the following limits inside `src/config/constants.ts`:

1. **`MAX_LLM_CHUNKS`**
   - *Default*: 50 limits per PR. 
   - *Tuning*: Decrease to 20 if subrequests are consistently blowing up your architecture budget.
2. **`TIER1_MAX_FILES`**
   - *Default*: 100 fully scanned files per PR.
   - *Tuning*: Decrease to prevent gigantic OS Memory dumps during OS Clone stages.
3. **`NOISE_EXTENSIONS`**
   - *Tuning*: Add internally generated vendor formats (`*.swagger.json`, `pnpm-lock.yaml`) to the array so they never get charged to the LLM agent.

## Emergency Kill-Switches & Outages

### Container Memory Leaks (Error 1102)
If Cloudflare reports `1102` (Exceeded Memory Limit) while executing `Oxlint` or `Git`, your worker container has reached its 128MB isolated memory capacity.

**Remediation:**
1. Drop the `TIER1_MAX_FILES` constraint to prevent massive PR clones.
2. Temporarily switch `AI_PROVIDER=gemini` inside `.dev.vars` / Cloudflare Dashboard vars to force smaller execution frames.
3. If necessary, delete the container `Dockerfile` bindings in `wrangler.jsonc` to force the entire system to run within the internal lightweight string-matching Fallback Architecture.

### Cloudflare Key-Value Failure
If the `USAGE_METRICS` namespace enters degraded states, you will see `StorageError` exceptions. The Edge Worker is constructed securely with **Exponential Backoff Retries** under `src/lib/retry.ts`, so no reviews will crash. However, local observability metrics may fail to sync. Verify `npx wrangler tail` to observe dropped metrics.
