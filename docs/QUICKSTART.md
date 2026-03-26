# Usage Tracking - Quick Start Guide

Track token usage and costs for your PR reviews in 3 steps.

## 1. Setup (One-time)

```bash
# Create KV namespaces
npx wrangler kv:namespace create USAGE_METRICS
npx wrangler kv:namespace create USAGE_METRICS --preview

# Update wrangler.jsonc with the IDs from above
# Then generate types and deploy
npx wrangler types
npx wrangler deploy
```

## 2. Query Usage

### Option A: Command Line (Bash)

```bash
# Get stats for your repo
./scripts/check-usage.sh stats myorg myrepo

# Get usage for specific PR
./scripts/check-usage.sh pr myorg myrepo 123

# List recent reviews
./scripts/check-usage.sh list myorg myrepo 20
```

### Option B: TypeScript Client

```bash
# Install dependencies
npm install

# Run usage report
REPO_OWNER=myorg REPO_NAME=myrepo npm run usage-report
```

### Option C: Visual Dashboard

```bash
# Open the HTML dashboard in your browser
open scripts/usage-dashboard.html

# Enter your worker URL and repo details
# Click "Load Data" to see charts and metrics
```

### Option D: Direct API Calls

```bash
# Get PR usage
curl https://your-worker.workers.dev/usage/myorg/myrepo/pr/123

# Get repo statistics
curl https://your-worker.workers.dev/usage/myorg/myrepo/stats

# List all reviews
curl https://your-worker.workers.dev/usage/myorg/myrepo?limit=50
```

## 3. Monitor Costs

### Set Budget Alerts

Create a cron job to check daily costs:

```bash
#!/bin/bash
# check-budget.sh

COST=$(curl -s https://your-worker.workers.dev/usage/myorg/myrepo/stats | jq -r '.totalCost')
BUDGET=100.00

if (( $(echo "$COST > $BUDGET" | bc -l) )); then
  echo "⚠️ Budget exceeded: \$$COST / \$$BUDGET"
  # Send alert (email, Slack, etc.)
fi
```

### Track Monthly Spend

```bash
# Get current month's cost
curl -s https://your-worker.workers.dev/usage/myorg/myrepo/stats | \
  jq '{totalCost, totalReviews, avgCostPerReview}'
```

## API Endpoints Reference

| Endpoint | Description |
|----------|-------------|
| `GET /usage/{owner}/{repo}/pr/{prNumber}` | Latest usage for a PR |
| `GET /usage/{owner}/{repo}/pr/{prNumber}?sha={sha}` | Usage for specific commit |
| `GET /usage/{owner}/{repo}?limit=N` | List N most recent reviews |
| `GET /usage/{owner}/{repo}/stats` | Aggregate statistics |

## What Gets Tracked

Each PR review stores:

- **Token counts**: Input/output tokens per LLM call (Map + Reduce phases)
- **Cost estimate**: Based on current provider pricing
- **Performance**: Duration, files reviewed, chunks processed
- **Metadata**: PR number, commit SHA, provider, timestamp
- **Status**: success, partial (some chunks failed), or failed

## Example Response

```json
{
  "prNumber": 123,
  "repoFullName": "myorg/myrepo",
  "provider": "claude",
  "totalTokens": 50500,
  "estimatedCost": 0.2175,
  "filesReviewed": 12,
  "chunksProcessed": 3,
  "findingsCount": 8,
  "calls": [
    {
      "phase": "map",
      "chunkLabel": "1/3",
      "model": "claude-sonnet-4-20250514",
      "usage": {
        "inputTokens": 12500,
        "outputTokens": 850,
        "totalTokens": 13350
      }
    }
  ]
}
```

## Cost Optimization Tips

1. **Switch to Gemini**: ~60% cheaper than Claude
   ```bash
   npx wrangler deploy --var AI_PROVIDER:gemini
   ```

2. **Reduce chunk limit**: Edit `MAX_LLM_CHUNKS` in `src/config/constants.ts`

3. **Filter more files**: Expand `NOISE_EXTENSIONS` to skip more file types

4. **Limit file size**: Reduce `MAX_FILE_SIZE_BYTES` to skip large files

## Troubleshooting

**No data showing up?**
- Check KV namespace is created: `npx wrangler kv:namespace list`
- Verify IDs in `wrangler.jsonc` match your namespace
- Check logs: `npx wrangler tail`

**Costs seem wrong?**
- Verify pricing in `src/types/usage.ts` matches current rates
- Compare with provider dashboard for actual usage

**Need longer retention?**
- Edit `expirationTtl` in `src/lib/usage-tracker.ts` (default: 90 days)

## Full Documentation

See [USAGE_TRACKING.md](./USAGE_TRACKING.md) for complete documentation.
