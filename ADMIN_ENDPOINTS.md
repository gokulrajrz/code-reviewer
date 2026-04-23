# 📊 Admin Endpoints Reference

Quick reference for monitoring industrial-grade systems in production.

## Authentication

All admin endpoints require API key authentication:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://your-worker.workers.dev/admin/...
```

Set API key via Wrangler secret:
```bash
npx wrangler secret put USAGE_API_KEY
```

---

## 🚦 Rate Limiter Metrics

### Claude Provider
```bash
GET /admin/rate-limiter-metrics/claude
```

**Response**:
```json
{
  "provider": "claude",
  "requestsPerMinute": 50,
  "inputTokensPerMinute": 40000,
  "outputTokensPerMinute": 8000,
  "currentUtilization": 0.65,
  "queueLength": 0,
  "totalRequests": 1250,
  "totalErrors": 8,
  "adaptiveMultiplier": 0.9
}
```

**Key Metrics**:
- `currentUtilization`: 0-1 (0% to 100%)
- `queueLength`: Number of requests waiting
- `adaptiveMultiplier`: Current rate adjustment (1.0 = full speed, 0.5 = half speed)
- `totalErrors`: Cumulative 429/529 errors

**What to Watch**:
- ⚠️ `utilization > 0.9` → Approaching rate limit
- ⚠️ `queueLength > 0` → Requests are waiting
- ⚠️ `adaptiveMultiplier < 0.5` → Significant rate reduction due to errors

### Gemini Provider
```bash
GET /admin/rate-limiter-metrics/gemini
```

Same response format, different limits:
- `requestsPerMinute`: 60 (2x Claude)
- `inputTokensPerMinute`: 4,000,000
- `outputTokensPerMinute`: 32,000

---

## 🎯 Adaptive Concurrency Metrics

```bash
GET /admin/concurrency-metrics
```

**Response**:
```json
{
  "chunkReview": {
    "currentConcurrency": 3,
    "successCount": 145,
    "errorCount": 5,
    "errorRate": 0.033,
    "totalAdjustments": 8,
    "lastAdjustmentTime": 1713604800000,
    "lastAdjustmentReason": "additive_increase"
  },
  "synthesis": {
    "currentConcurrency": 1,
    "successCount": 42,
    "errorCount": 1,
    "errorRate": 0.023,
    "totalAdjustments": 2,
    "lastAdjustmentReason": "initialization"
  }
}
```

**Key Metrics**:
- `currentConcurrency`: Current parallel request limit (1-5 for chunks, 1-2 for synthesis)
- `errorRate`: 0-1 (0% to 100%)
- `lastAdjustmentReason`: Why concurrency changed

**Adjustment Reasons**:
- `initialization` → Starting state
- `additive_increase` → +1 after 10 consecutive successes
- `multiplicative_decrease` → *0.5 after error
- `timeout` → *0.3 after timeout (aggressive)
- `manual_override` → Admin intervention
- `manual_reset` → Reset to initial state

**What to Watch**:
- ⚠️ `errorRate > 0.15` → High error rate, concurrency will decrease
- ⚠️ `currentConcurrency = 1` for >1 hour → System struggling
- ✅ `totalAdjustments` increasing → AIMD algorithm working

---

## 🔄 Retry Metrics

```bash
GET /admin/retry-metrics
```

**Response**:
```json
{
  "claudeChunkReview": {
    "totalRequests": 150,
    "retriedRequests": 12,
    "successAfterRetry": 10,
    "failedAfterRetries": 2,
    "averageRetries": 1.2
  },
  "claudeSynthesis": {
    "totalRequests": 45,
    "retriedRequests": 3,
    "successAfterRetry": 3,
    "failedAfterRetries": 0,
    "averageRetries": 1.0
  },
  "geminiChunkReview": { ... },
  "geminiSynthesis": { ... }
}
```

**Key Metrics**:
- `retriedRequests`: How many needed retry
- `successAfterRetry`: Retry success rate
- `failedAfterRetries`: Permanent failures
- `averageRetries`: Average attempts per retried request

**What to Watch**:
- ⚠️ `retriedRequests / totalRequests > 0.2` → 20%+ retry rate (high)
- ⚠️ `failedAfterRetries > 0` → Some requests failing even after retries
- ✅ `successAfterRetry ≈ retriedRequests` → Retries working well

---

## 📈 Operational Metrics

```bash
GET /metrics
```

**Response**:
```json
{
  "uptime": 86400000,
  "version": "1.0.0",
  "provider": "claude",
  "requests": {
    "total": 1250,
    "success": 1180,
    "errors": 70
  },
  "errorRate": 0.056,
  "avgResponseTime": 2500
}
```

**Prometheus Format**:
```bash
GET /metrics?format=prometheus
```

---

## 🏥 Health Check

```bash
GET /health
```

**Response**:
```json
{
  "status": "healthy",
  "service": "code-reviewer",
  "version": "1.0.0",
  "uptime": 86400000,
  "dependencies": {
    "kv": "healthy",
    "queue": "healthy",
    "durableObjects": "healthy"
  }
}
```

**Status Values**:
- `healthy` → All systems operational
- `degraded` → Some systems impaired
- `unhealthy` → Critical failures

---

## 🎛️ Admin Actions

### Set Global Service Level

```bash
POST /admin/service-level/global
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY

{
  "level": "DEGRADED",
  "reason": "High load - reducing chunk count",
  "durationSeconds": 3600
}
```

**Levels**:
- `FULL` → Normal operation
- `DEGRADED` → 50% chunks, no synthesis
- `DISABLED` → No reviews

### Clear Service Level Override

```bash
DELETE /admin/service-level/override
Authorization: Bearer YOUR_API_KEY
```

### Reset Concurrency Controller

```bash
POST /admin/concurrency/reset
Authorization: Bearer YOUR_API_KEY

{
  "controller": "chunkReview"
}
```

---

## 📊 Monitoring Dashboard

### Quick Health Check Script

```bash
#!/bin/bash
WORKER_URL="https://your-worker.workers.dev"
API_KEY="your-api-key"

echo "=== Rate Limiter ==="
curl -s -H "Authorization: Bearer $API_KEY" \
  "$WORKER_URL/admin/rate-limiter-metrics/claude" | jq '.currentUtilization, .queueLength'

echo "=== Concurrency ==="
curl -s -H "Authorization: Bearer $API_KEY" \
  "$WORKER_URL/admin/concurrency-metrics" | jq '.chunkReview.currentConcurrency, .chunkReview.errorRate'

echo "=== Retry Rate ==="
curl -s -H "Authorization: Bearer $API_KEY" \
  "$WORKER_URL/admin/retry-metrics" | jq '.claudeChunkReview | .retriedRequests / .totalRequests'
```

### Watch Command

```bash
# Monitor rate limiter in real-time
watch -n 5 'curl -s -H "Authorization: Bearer $API_KEY" \
  https://your-worker.workers.dev/admin/rate-limiter-metrics/claude | jq'
```

---

## 🚨 Alert Thresholds

### Critical (Page On-Call)
- Error rate > 20%
- Cost budget > 95%
- Concurrency stuck at 1 for >2 hours
- Queue length > 100

### Warning (Slack Notification)
- Error rate > 10%
- Cost budget > 80%
- Retry rate > 20%
- Utilization > 90%

### Info (Log Only)
- Concurrency adjustment
- Service level change
- Rate limit adaptive decrease

---

## 📖 Interpretation Guide

### Healthy System
```json
{
  "rateLimiter": {
    "utilization": 0.4,
    "queueLength": 0,
    "adaptiveMultiplier": 1.0
  },
  "concurrency": {
    "currentConcurrency": 3,
    "errorRate": 0.02
  },
  "retry": {
    "retriedRequests": 5,
    "totalRequests": 150
  }
}
```

### System Under Load
```json
{
  "rateLimiter": {
    "utilization": 0.85,
    "queueLength": 3,
    "adaptiveMultiplier": 0.8
  },
  "concurrency": {
    "currentConcurrency": 2,
    "errorRate": 0.12
  },
  "retry": {
    "retriedRequests": 25,
    "totalRequests": 150
  }
}
```

### System in Trouble
```json
{
  "rateLimiter": {
    "utilization": 0.95,
    "queueLength": 15,
    "adaptiveMultiplier": 0.3
  },
  "concurrency": {
    "currentConcurrency": 1,
    "errorRate": 0.25
  },
  "retry": {
    "retriedRequests": 60,
    "totalRequests": 150
  }
}
```

**Action**: Investigate errors, consider manual service level degradation

---

## 🔧 Troubleshooting

### High Utilization
1. Check if traffic spike is legitimate
2. Verify rate limits are appropriate
3. Consider increasing limits if needed
4. Check for retry storms

### High Error Rate
1. Check Cloudflare logs for error details
2. Verify API keys are valid
3. Check provider status pages
4. Consider switching providers temporarily

### Stuck Concurrency
1. Check error rate (need <15% to increase)
2. Verify 10 consecutive successes requirement
3. Consider manual reset if stuck incorrectly
4. Investigate underlying errors

---

**Last Updated**: April 20, 2026  
**Version**: 1.0.0
