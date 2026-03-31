# Usage Tracking Architecture

Visual guide to how token usage tracking works in the code reviewer agent.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         GitHub PR Event                          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Webhook Handler                             │
│  • Verify signature                                              │
│  • Create Check Run (in_progress)                                │
│  • Push to Queue                                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Queue Consumer                              │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 1. Fetch & Classify Files                                │   │
│  │    • Tier 1: Full content (top 15 files)                 │   │
│  │    • Tier 2: Diff only (remaining files)                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                     │
│                             ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 2. MAP PHASE: Review Chunks                              │   │
│  │    ┌──────────────────────────────────────────────┐     │   │
│  │    │ For each chunk (max 10):                     │     │   │
│  │    │   • Call LLM (Claude/Gemini)                 │     │   │
│  │    │   • Get findings + token usage ◄─────────────┼─┐   │   │
│  │    │   • Store usage in memory                    │ │   │   │
│  │    └──────────────────────────────────────────────┘ │   │   │
│  └────────────────────────────────────────────────────┼──┘   │
│                             │                          │       │
│                             ▼                          │       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 3. Aggregate & Deduplicate Findings                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                          │       │
│                             ▼                          │       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 4. REDUCE PHASE: Synthesize Review                      │   │
│  │    • Call LLM with all findings                         │   │
│  │    • Get final review + token usage ◄───────────────────┼─┐ │
│  │    • Store usage in memory                              │ │ │
│  └─────────────────────────────────────────────────────────┘ │ │
│                             │                          │     │ │
│                             ▼                          │     │ │
│  ┌─────────────────────────────────────────────────────────┐ │ │
│  │ 5. Post Review & Update Check Run                       │ │ │
│  └─────────────────────────────────────────────────────────┘ │ │
│                             │                          │     │ │
│                             ▼                          │     │ │
│  ┌─────────────────────────────────────────────────────────┐ │ │
│  │ 6. BUILD & STORE USAGE METRICS ◄───────────────────────┼─┘ │
│  │    • Aggregate all LLM call usage                       │   │
│  │    • Calculate total cost                               │   │
│  │    • Build PRUsageMetrics object                        │   │
│  │    • Store in Cloudflare KV                             │   │
│  └────────────────────────┬────────────────────────────────┘   │
└───────────────────────────┼────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare KV Storage                         │
│                                                                   │
│  Keys:                                                            │
│  • usage:{repo}:{pr}:{sha}     → Full metrics                    │
│  • usage:{repo}:{pr}:latest    → Latest review (convenience)     │
│                                                                   │
│  Retention: 90 days (automatic expiration)                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Query via REST API
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Usage Query Endpoints                       │
│                                                                   │
│  GET /usage/{owner}/{repo}/pr/{prNumber}                         │
│  GET /usage/{owner}/{repo}/pr/{prNumber}?sha={sha}              │
│  GET /usage/{owner}/{repo}?limit=N                               │
│  GET /usage/{owner}/{repo}/stats                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Query Tools                                 │
│                                                                   │
│  • Bash Script (check-usage.sh)                                  │
│  • TypeScript Client (usage-client.ts)                           │
│  • Visual Dashboard (usage-dashboard.html)                       │
│  • Direct curl/API calls                                         │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Detail

### 1. LLM Call Tracking

```
┌──────────────────────────────────────────────────────────────┐
│                    callChunkReview()                          │
│                                                                │
│  Input: Code chunk                                             │
│     ↓                                                          │
│  Call LLM API (Claude/Gemini)                                  │
│     ↓                                                          │
│  Response:                                                     │
│  {                                                             │
│    content: "JSON findings",                                   │
│    usage: {                                                    │
│      inputTokens: 12500,                                       │
│      outputTokens: 850,                                        │
│      totalTokens: 13350                                        │
│    }                                                           │
│  }                                                             │
│     ↓                                                          │
│  Store in llmCalls array:                                      │
│  {                                                             │
│    phase: "map",                                               │
│    chunkLabel: "1/3",                                          │
│    model: "claude-sonnet-4-20250514",                          │
│    usage: { ... },                                             │
│    timestamp: "2026-03-26T10:30:45.000Z"                       │
│  }                                                             │
└──────────────────────────────────────────────────────────────┘
```

### 2. Metrics Aggregation

```
┌──────────────────────────────────────────────────────────────┐
│              buildPRUsageMetrics()                            │
│                                                                │
│  Input: llmCalls[] array                                       │
│     ↓                                                          │
│  Aggregate:                                                    │
│  • totalInputTokens = sum(call.usage.inputTokens)             │
│  • totalOutputTokens = sum(call.usage.outputTokens)           │
│  • totalTokens = totalInput + totalOutput                     │
│     ↓                                                          │
│  Calculate Cost:                                               │
│  • inputCost = (totalInput / 1M) × $3.00                      │
│  • outputCost = (totalOutput / 1M) × $15.00                   │
│  • estimatedCost = inputCost + outputCost                     │
│     ↓                                                          │
│  Build PRUsageMetrics:                                         │
│  {                                                             │
│    prNumber, repoFullName, headSha,                            │
│    provider, startTime, endTime, durationMs,                   │
│    calls: [...],                                               │
│    totalInputTokens, totalOutputTokens, totalTokens,           │
│    estimatedCost,                                              │
│    filesReviewed, chunksProcessed, findingsCount,              │
│    status                                                      │
│  }                                                             │
└──────────────────────────────────────────────────────────────┘
```

### 3. KV Storage

```
┌──────────────────────────────────────────────────────────────┐
│              storePRUsageMetrics()                            │
│                                                                │
│  Input: PRUsageMetrics object                                  │
│     ↓                                                          │
│  Store with dual keys:                                         │
│                                                                │
│  Key 1: usage:myorg/myrepo:123:abc123...                      │
│  Value: { ...metrics... }                                      │
│  TTL: 7776000 seconds (90 days)                                │
│                                                                │
│  Key 2: usage:myorg/myrepo:123:latest                         │
│  Value: { ...metrics... }                                      │
│  TTL: 7776000 seconds (90 days)                                │
│                                                                │
│  ✓ Stored successfully                                         │
└──────────────────────────────────────────────────────────────┘
```

## Token Usage Example

### Scenario: PR with 3 chunks

```
Review Timeline:
─────────────────────────────────────────────────────────────

10:30:00  Start review
          ↓
10:30:45  MAP: Chunk 1/3
          Input:  12,500 tokens
          Output:    850 tokens
          Cost:   $0.0503
          ↓
10:31:20  MAP: Chunk 2/3
          Input:  15,200 tokens
          Output:  1,100 tokens
          Cost:   $0.0621
          ↓
10:31:55  MAP: Chunk 3/3
          Input:  11,800 tokens
          Output:    920 tokens
          Cost:   $0.0492
          ↓
10:32:10  REDUCE: Synthesize
          Input:   3,200 tokens
          Output:  1,200 tokens
          Cost:   $0.0276
          ↓
10:32:15  Store metrics
          ─────────────────────────
          Total Input:   42,700 tokens
          Total Output:   4,070 tokens
          Total Tokens:  46,770 tokens
          Total Cost:    $0.1892
          ─────────────────────────
          Files:         12
          Chunks:         3
          Findings:       8
          Duration:     135s
          Status:       success
```

## Cost Calculation

### Claude Sonnet 4 Pricing

```
Input:  $3.00 per 1M tokens
Output: $15.00 per 1M tokens

Example PR:
  Input:  42,700 tokens → (42,700 / 1,000,000) × $3.00  = $0.1281
  Output:  4,070 tokens → (4,070 / 1,000,000) × $15.00 = $0.0611
  ────────────────────────────────────────────────────────────
  Total:                                                  $0.1892
```

### Gemini 3.1 Pro Pricing

```
Input:  $1.25 per 1M tokens
Output: $5.00 per 1M tokens

Same PR with Gemini:
  Input:  42,700 tokens → (42,700 / 1,000,000) × $1.25 = $0.0534
  Output:  4,070 tokens → (4,070 / 1,000,000) × $5.00  = $0.0204
  ────────────────────────────────────────────────────────────
  Total:                                                  $0.0738
  
Savings: $0.1154 (61% cheaper)
```

## Query Patterns

### Pattern 1: Get Latest PR Usage

```
Request:
  GET /usage/myorg/myrepo/pr/123

Flow:
  1. Extract: owner=myorg, repo=myrepo, prNumber=123
  2. Build key: usage:myorg/myrepo:123:latest
  3. KV.get(key)
  4. Parse JSON
  5. Return PRUsageMetrics
```

### Pattern 2: Get Repository Stats

```
Request:
  GET /usage/myorg/myrepo/stats

Flow:
  1. KV.list({ prefix: "usage:myorg/myrepo:" })
  2. Filter out ":latest" keys
  3. Fetch all metrics
  4. Aggregate:
     • totalReviews = count
     • totalTokens = sum(metrics.totalTokens)
     • totalCost = sum(metrics.estimatedCost)
     • avgTokensPerReview = totalTokens / totalReviews
     • avgCostPerReview = totalCost / totalReviews
     • byProvider = group by provider
  5. Return stats object
```

## Performance Characteristics

### Storage
- **Size per review**: ~1KB (JSON)
- **Retention**: 90 days
- **Example**: 100 reviews/month = ~9MB total

### Latency
- **Tracking overhead**: 1-2ms per review
- **KV write**: ~10-50ms (async, non-blocking)
- **KV read**: ~10-50ms per query
- **List operation**: ~100-200ms (depends on count)

### Limits
- **KV free tier**: 100,000 reads/day, 1,000 writes/day
- **Typical usage**: <100 writes/day, <1,000 reads/day
- **Cost**: $0.00 (well within free tier)

## Error Handling

```
┌──────────────────────────────────────────────────────────────┐
│                    Error Scenarios                            │
│                                                                │
│  1. LLM API Failure                                            │
│     • Chunk review fails                                       │
│     • Continue with remaining chunks (graceful degradation)    │
│     • Mark status as "partial"                                 │
│                                                                │
│  2. KV Storage Failure                                         │
│     • Log error                                                │
│     • Review still completes successfully                      │
│     • Non-fatal: usage tracking is optional                    │
│                                                                │
│  3. Query Endpoint Failure                                     │
│     • Return 404 if no data found                              │
│     • Return 500 if KV error                                   │
│     • Does not affect review pipeline                          │
└──────────────────────────────────────────────────────────────┘
```

## Security Considerations

- **No authentication**: Endpoints are public by default
- **No PII**: Only metadata and token counts stored
- **No code content**: Review findings not stored, only counts
- **Automatic expiration**: 90-day TTL prevents indefinite storage

To add authentication, modify `src/index.ts`:

```typescript
// Add auth middleware
if (pathname.startsWith('/usage/')) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader !== `Bearer ${env.USAGE_API_KEY}`) {
    return new Response('Unauthorized', { status: 401 });
  }
}
```
