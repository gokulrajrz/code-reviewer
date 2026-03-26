# Token Usage & Cost Tracking

This code reviewer agent automatically tracks detailed token usage and estimated costs for every PR review.

## Features

- **Per-PR Metrics**: Track tokens and costs for each individual PR review
- **Per-Call Breakdown**: See usage for each LLM call (Map phase chunks + Reduce phase synthesis)
- **Cost Estimation**: Automatic cost calculation based on current provider pricing
- **Repository Statistics**: Aggregate metrics across all reviews in a repository
- **90-Day Retention**: Metrics stored in Cloudflare KV with automatic expiration

## Setup

### 1. Create KV Namespace

```bash
# Create production KV namespace
npx wrangler kv:namespace create USAGE_METRICS

# Create preview namespace for development
npx wrangler kv:namespace create USAGE_METRICS --preview
```

This will output IDs like:
```
{ binding = "USAGE_METRICS", id = "abc123..." }
{ binding = "USAGE_METRICS", preview_id = "xyz789..." }
```

### 2. Update wrangler.jsonc

Replace the placeholder IDs in `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "USAGE_METRICS",
    "id": "abc123...",           // Your production ID
    "preview_id": "xyz789..."    // Your preview ID
  }
]
```

### 3. Generate Types

```bash
npx wrangler types
```

### 4. Deploy

```bash
npx wrangler deploy
```

## API Endpoints

All endpoints return JSON and require no authentication (add your own auth if needed).

### Get Latest PR Usage

Get usage metrics for the most recent review of a PR:

```bash
GET https://your-worker.workers.dev/usage/{owner}/{repo}/pr/{prNumber}
```

Example:
```bash
curl https://code-reviewer.workers.dev/usage/myorg/myrepo/pr/123
```

Response:
```json
{
  "prNumber": 123,
  "repoFullName": "myorg/myrepo",
  "headSha": "abc123...",
  "provider": "claude",
  "startTime": "2026-03-26T10:30:00.000Z",
  "endTime": "2026-03-26T10:32:15.000Z",
  "durationMs": 135000,
  "calls": [
    {
      "phase": "map",
      "chunkLabel": "1/3",
      "model": "claude-sonnet-4-20250514",
      "usage": {
        "inputTokens": 12500,
        "outputTokens": 850,
        "totalTokens": 13350
      },
      "timestamp": "2026-03-26T10:30:45.000Z"
    },
    {
      "phase": "reduce",
      "model": "claude-sonnet-4-20250514",
      "usage": {
        "inputTokens": 3200,
        "outputTokens": 1200,
        "totalTokens": 4400
      },
      "timestamp": "2026-03-26T10:32:10.000Z"
    }
  ],
  "totalInputTokens": 45000,
  "totalOutputTokens": 5500,
  "totalTokens": 50500,
  "estimatedCost": 0.2175,
  "filesReviewed": 12,
  "chunksProcessed": 3,
  "findingsCount": 8,
  "status": "success"
}
```

### Get PR Usage for Specific Commit

```bash
GET https://your-worker.workers.dev/usage/{owner}/{repo}/pr/{prNumber}?sha={commitSha}
```

### List All Reviews for a Repository

```bash
GET https://your-worker.workers.dev/usage/{owner}/{repo}?limit=50
```

Returns an array of all PR usage metrics (default limit: 100, max: 1000).

### Get Repository Statistics

Get aggregate statistics across all reviews:

```bash
GET https://your-worker.workers.dev/usage/{owner}/{repo}/stats
```

Response:
```json
{
  "totalReviews": 45,
  "totalTokens": 2250000,
  "totalCost": 9.75,
  "avgTokensPerReview": 50000,
  "avgCostPerReview": 0.2167,
  "byProvider": {
    "claude": {
      "reviews": 30,
      "tokens": 1500000,
      "cost": 6.50
    },
    "gemini": {
      "reviews": 15,
      "tokens": 750000,
      "cost": 3.25
    }
  }
}
```

## Cost Breakdown

Current pricing (as of March 2026):

### Claude Sonnet 4
- Input: $3.00 per 1M tokens
- Output: $15.00 per 1M tokens

### Gemini 3.1 Pro
- Input: $1.25 per 1M tokens
- Output: $5.00 per 1M tokens

**Update pricing in `src/types/usage.ts`** if provider rates change.

## Usage Metrics Structure

Each PR review stores:

- **Metadata**: PR number, repo, commit SHA, provider, timestamps
- **Performance**: Duration, files reviewed, chunks processed
- **Token Usage**: Input/output tokens per LLM call
- **Cost**: Estimated cost based on provider pricing
- **Status**: `success`, `partial` (some chunks failed), or `failed`

## Storage Keys

Metrics are stored in KV with these key patterns:

- `usage:{repo}:{prNumber}:{sha}` - Specific commit review
- `usage:{repo}:{prNumber}:latest` - Latest review for PR (convenience key)

## Monitoring & Alerts

### Track Monthly Costs

```bash
# Get stats for your main repo
curl https://code-reviewer.workers.dev/usage/myorg/myrepo/stats | jq '.totalCost'
```

### Set Up Budget Alerts

Create a scheduled worker or external cron job to:

1. Query `/usage/{owner}/{repo}/stats` daily
2. Check if `totalCost` exceeds your budget
3. Send alerts via email/Slack/PagerDuty

Example alert script:
```bash
#!/bin/bash
COST=$(curl -s https://code-reviewer.workers.dev/usage/myorg/myrepo/stats | jq -r '.totalCost')
BUDGET=100.00

if (( $(echo "$COST > $BUDGET" | bc -l) )); then
  echo "⚠️ Budget exceeded: \$$COST / \$$BUDGET"
  # Send alert
fi
```

## Optimization Tips

### Reduce Token Usage

1. **Limit file size**: Adjust `MAX_FILE_SIZE_BYTES` in `src/config/constants.ts`
2. **Reduce chunks**: Lower `MAX_LLM_CHUNKS` (trades thoroughness for cost)
3. **Filter files**: Expand `NOISE_EXTENSIONS` to skip more file types
4. **Smaller context**: Reduce `GLOBAL_CONTEXT_BUDGET_CHARS`

### Switch Providers

Gemini is ~60% cheaper than Claude for similar quality:

```bash
npx wrangler deploy --var AI_PROVIDER:gemini
```

### Monitor High-Cost PRs

```bash
# Find most expensive reviews
curl https://code-reviewer.workers.dev/usage/myorg/myrepo | \
  jq 'sort_by(.estimatedCost) | reverse | .[0:10]'
```

## Privacy & Retention

- Metrics stored for **90 days** then auto-deleted
- No code content stored, only metadata and token counts
- Add authentication to endpoints if metrics are sensitive

## Troubleshooting

### No metrics showing up

1. Check KV namespace is bound: `npx wrangler kv:namespace list`
2. Verify IDs in `wrangler.jsonc` match your namespace
3. Check logs: `npx wrangler tail`

### Costs seem wrong

1. Verify pricing in `src/types/usage.ts` matches current provider rates
2. Check provider dashboard for actual usage
3. Token counts are estimates from API responses

### High costs

1. Review `MAX_LLM_CHUNKS` - default is 10 chunks max
2. Check average PR size: large PRs = more tokens
3. Consider switching to Gemini for lower costs
