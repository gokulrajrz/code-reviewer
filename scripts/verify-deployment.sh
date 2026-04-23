#!/bin/bash
# Deployment Verification Script
# Tests all industrial-grade systems after deployment

set -e

WORKER_URL="${1:-https://code-reviewer.workers.dev}"
API_KEY="${2:-}"

echo "🔍 Verifying deployment at: $WORKER_URL"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo "1️⃣  Testing health endpoint..."
HEALTH=$(curl -s "$WORKER_URL/health")
if echo "$HEALTH" | grep -q '"status":"healthy"'; then
    echo -e "${GREEN}✅ Health check passed${NC}"
else
    echo -e "${RED}❌ Health check failed${NC}"
    echo "$HEALTH"
    exit 1
fi
echo ""

# Test 2: Rate Limiter Metrics (requires API key)
if [ -n "$API_KEY" ]; then
    echo "2️⃣  Testing rate limiter metrics (Claude)..."
    RATE_LIMITER=$(curl -s -H "Authorization: Bearer $API_KEY" "$WORKER_URL/admin/rate-limiter-metrics/claude")
    if echo "$RATE_LIMITER" | grep -q '"provider":"claude"'; then
        echo -e "${GREEN}✅ Rate limiter metrics accessible${NC}"
        echo "$RATE_LIMITER" | jq '.'
    else
        echo -e "${RED}❌ Rate limiter metrics failed${NC}"
        echo "$RATE_LIMITER"
    fi
    echo ""

    echo "3️⃣  Testing concurrency metrics..."
    CONCURRENCY=$(curl -s -H "Authorization: Bearer $API_KEY" "$WORKER_URL/admin/concurrency-metrics")
    if echo "$CONCURRENCY" | grep -q '"chunkReview"'; then
        echo -e "${GREEN}✅ Concurrency metrics accessible${NC}"
        echo "$CONCURRENCY" | jq '.'
    else
        echo -e "${RED}❌ Concurrency metrics failed${NC}"
        echo "$CONCURRENCY"
    fi
    echo ""

    echo "4️⃣  Testing retry metrics..."
    RETRY=$(curl -s -H "Authorization: Bearer $API_KEY" "$WORKER_URL/admin/retry-metrics")
    if echo "$RETRY" | grep -q '"claudeChunkReview"'; then
        echo -e "${GREEN}✅ Retry metrics accessible${NC}"
        echo "$RETRY" | jq '.'
    else
        echo -e "${RED}❌ Retry metrics failed${NC}"
        echo "$RETRY"
    fi
    echo ""
else
    echo -e "${YELLOW}⚠️  Skipping admin endpoints (no API key provided)${NC}"
    echo "   Run with: ./scripts/verify-deployment.sh <WORKER_URL> <API_KEY>"
    echo ""
fi

# Test 3: Operational Metrics
echo "5️⃣  Testing operational metrics..."
METRICS=$(curl -s "$WORKER_URL/metrics")
if echo "$METRICS" | grep -q '"uptime"'; then
    echo -e "${GREEN}✅ Operational metrics accessible${NC}"
    echo "$METRICS" | jq '.uptime, .version, .provider'
else
    echo -e "${RED}❌ Operational metrics failed${NC}"
    echo "$METRICS"
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Deployment verification complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📊 Next steps:"
echo "  1. Monitor error rates in Cloudflare dashboard"
echo "  2. Check rate limiter utilization"
echo "  3. Verify adaptive concurrency adjustments"
echo "  4. Test with a real PR to see systems in action"
echo ""
