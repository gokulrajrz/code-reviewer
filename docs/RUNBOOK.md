# Code Reviewer Operational Runbook

## Overview
This runbook provides operational guidance for monitoring, troubleshooting, and maintaining the Code Reviewer Cloudflare Worker.

---

## Health Check Endpoints

### Simple Health Check (Backward Compatible)
```
GET /
```

**Response:**
```json
{
  "status": "ok",
  "service": "code-reviewer-agent",
  "version": "1.0.0",
  "provider": "claude"
}
```

### Detailed Health Check
```
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "code-reviewer-agent",
  "version": "1.0.0",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "uptime": 3600,
  "dependencies": [
    {
      "name": "kv",
      "status": "healthy",
      "latencyMs": 45,
      "lastChecked": "2026-01-01T00:00:00.000Z"
    },
    {
      "name": "github-api",
      "status": "healthy",
      "latencyMs": 123,
      "lastChecked": "2026-01-01T00:00:00.000Z"
    },
    {
      "name": "llm-claude",
      "status": "healthy",
      "latencyMs": 89,
      "lastChecked": "2026-01-01T00:00:00.000Z"
    },
    {
      "name": "queue",
      "status": "healthy",
      "latencyMs": 1,
      "lastChecked": "2026-01-01T00:00:00.000Z"
    }
  ],
  "checks": {
    "total": 4,
    "passed": 4,
    "failed": 0
  }
}
```

### Metrics Endpoint
```
GET /metrics
GET /metrics?format=prometheus
GET /metrics?period=24h
```

**JSON Response:**
```json
{
  "timestamp": "2026-01-01T00:00:00.000Z",
  "period": "24h",
  "requests": {
    "total": 150,
    "byMethod": { "GET": 100, "POST": 50 },
    "byStatus": { "200": 140, "500": 10 },
    "errors": 10
  },
  "queue": {
    "messagesProcessed": 45,
    "messagesFailed": 2,
    "avgProcessingTimeMs": 0
  },
  "business": {
    "prsReviewed": 45,
    "reviewsFailed": 2,
    "avgChunksPerPR": 3,
    "avgFindingsPerPR": 7
  },
  "circuitBreakers": {
    "github": { "state": "closed", "failures": 0 },
    "anthropic": { "state": "closed", "failures": 0 },
    "gemini": { "state": "closed", "failures": 0 }
  }
}
```

---

## Common Issues & Resolution

### Issue: Health Check Returns "degraded" Status

**Symptoms:**
- `/health` returns status `degraded` or `unhealthy`
- One or more dependencies show `unhealthy` or `degraded`

**Diagnosis:**
```bash
# Check specific dependency
curl https://your-worker.workers.dev/health | jq '.dependencies[] | select(.status != "healthy")'
```

**Resolution:**

1. **KV Unhealthy:**
   - Check KV namespace binding in wrangler config
   - Verify `USAGE_METRICS` binding is configured
   - Check Cloudflare KV service status

2. **GitHub API Degraded:**
   - Check GitHub API status page: https://www.githubstatus.com/
   - Verify rate limits haven't been exceeded
   - Circuit breaker may have opened - wait for cooldown (30s)

3. **LLM API Degraded:**
   - Check provider status pages
   - Verify API keys are valid and not rate-limited
   - Circuit breaker may have opened - wait for cooldown (60s)

4. **Queue Unhealthy:**
   - Verify `REVIEW_QUEUE` binding in wrangler config
   - Check queue configuration in Cloudflare dashboard

---

### Issue: Webhook Deliveries Failing

**Symptoms:**
- PRs not receiving reviews
- GitHub showing failed webhook deliveries

**Diagnosis:**
```bash
# Check recent errors in logs
wrangler tail

# Verify webhook signature
curl -X POST https://your-worker.workers.dev/ \
  -H "X-GitHub-Event: pull_request" \
  -H "X-Hub-Signature-256: sha256=..." \
  -d '{}'
```

**Resolution:**

1. **Invalid Signature:**
   - Verify `GITHUB_WEBHOOK_SECRET` is set correctly
   - Regenerate webhook secret in GitHub App settings
   - Update secret in Cloudflare Workers environment

2. **Rate Limiting:**
   - Check if IP is rate-limited in logs
   - Verify `X-GitHub-Delivery` header is present
   - Check webhook deduplication isn't blocking

3. **Queue Full:**
   - Check queue depth in Cloudflare dashboard
   - Monitor queue consumer processing rate

---

### Issue: LLM Reviews Timing Out

**Symptoms:**
- Reviews taking >2 minutes
- Check runs showing "in_progress" indefinitely
- Timeout errors in logs

**Diagnosis:**
```bash
# Check circuit breaker state
curl https://your-worker.workers.dev/metrics | jq '.circuitBreakers'
```

**Resolution:**

1. **Circuit Breaker Open:**
   - Wait for automatic recovery (60s cooldown)
   - Monitor `circuitBreakers` endpoint for state changes
   - Check LLM provider status page

2. **Large PRs:**
   - PRs with many files trigger chunking
   - Each chunk has 120s timeout
   - Consider reducing `MAX_CHUNK_CHARS` if needed

3. **Provider Overload:**
   - Switch provider via `AI_PROVIDER` env var
   - Implement graceful degradation (already in place)

---

### Issue: High Error Rate

**Symptoms:**
- `/metrics` showing increasing error count
- Failed reviews piling up

**Diagnosis:**
```bash
# Get error breakdown
curl https://your-worker.workers.dev/metrics | jq '.requests.byStatus'

# Check recent logs
wrangler tail --format=pretty
```

**Resolution:**

1. **500 Errors:**
   - Check for unhandled exceptions in logs
   - Verify all env vars are set
   - Look for stack traces in structured logs

2. **400 Errors:**
   - Validation errors from invalid payloads
   - Check webhook payload format
   - Verify PR numbers and repo names are valid

3. **401/403 Errors:**
   - Authentication failures
   - Check GitHub App installation
   - Verify API keys haven't expired

---

## Monitoring Queries

### Log Analysis (Cloudflare Workers)
```bash
# View real-time logs
wrangler tail

# Filter for errors only
wrangler tail | grep '"level":"error"'

# Filter for specific PR
wrangler tail | grep '"prNumber":123'
```

### Metrics Queries
```bash
# Get Prometheus metrics for Grafana
curl https://your-worker.workers.dev/metrics?format=prometheus

# Check specific time period
curl "https://your-worker.workers.dev/metrics?period=1h"
```

---

## Scaling Considerations

### Subrequest Limits
- Cloudflare Workers: 50 subrequests per request
- Budget: File fetches + LLM calls + KV + GitHub API
- Large PRs automatically truncated to `MAX_LLM_CHunks`

### Queue Processing
- Messages processed concurrently
- Each message has its own request context
- Failed messages ack'd to prevent infinite retry

### Rate Limiting
- Distributed rate limiting via KV
- Default: 100 req/min with burst of 20
- Usage endpoints have separate limits

---

## Security Incidents

### Suspicious Webhook Activity
```bash
# Check for repeated failed signatures
wrangler tail | grep "Invalid webhook signature"
```

**Response:**
1. Verify webhook secret hasn't leaked
2. Check GitHub App for unauthorized installations
3. Rotate webhook secret if compromised

### API Key Exposure
**Response:**
1. Immediately rotate affected API keys
2. Update environment variables in Cloudflare
3. Redeploy worker with new keys
4. Review logs for unauthorized usage

---

## Maintenance Procedures

### Regular Health Checks
```bash
#!/bin/bash
# Add to cron for monitoring

HEALTH=$(curl -s https://your-worker.workers.dev/health | jq -r '.status')
if [ "$HEALTH" != "healthy" ]; then
  echo "ALERT: Code Reviewer health check failed - $HEALTH"
  # Send to PagerDuty/Slack/Email
fi
```

### Performance Monitoring
```bash
# Run performance benchmarks
npm test -- test/performance.spec.ts

# Monitor key metrics
curl -s https://your-worker.workers.dev/metrics | jq '{
  prs_reviewed: .business.prsReviewed,
  error_rate: (.requests.errors / .requests.total),
  avg_chunks: .business.avgChunksPerPR
}'
```

### Log Retention
- Structured logs captured via `wrangler tail`
- For production: integrate with external log aggregator
- Log retention in Cloudflare: 7 days

---

## Contact & Escalation

- **Primary:** DevOps/Platform team
- **Escalation:** Engineering manager for critical issues
- **Emergency:** Rotate API keys via Cloudflare dashboard if compromise suspected
