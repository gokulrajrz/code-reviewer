# Migration Guide: Adding Usage Tracking to Existing Deployment

If you already have the code reviewer agent deployed, follow these steps to add usage tracking without disrupting your existing setup.

## Prerequisites

- Existing code reviewer agent deployed and working
- Access to `wrangler` CLI
- ~5 minutes of downtime (optional - can be zero-downtime)

## Migration Steps

### Step 1: Pull Latest Code

```bash
git pull origin main
npm install
```

### Step 2: Create KV Namespace

```bash
# Production namespace
npx wrangler kv:namespace create USAGE_METRICS

# Preview namespace (for local dev)
npx wrangler kv:namespace create USAGE_METRICS --preview
```

You'll get output like:
```
{ binding = "USAGE_METRICS", id = "abc123..." }
{ binding = "USAGE_METRICS", preview_id = "xyz789..." }
```

### Step 3: Update wrangler.jsonc

The file already has a placeholder KV configuration. Replace the IDs:

```jsonc
"kv_namespaces": [
  {
    "binding": "USAGE_METRICS",
    "id": "abc123...",           // ← Your production ID from Step 2
    "preview_id": "xyz789..."    // ← Your preview ID from Step 2
  }
]
```

### Step 4: Generate Types

```bash
npx wrangler types
```

This updates `worker-configuration.d.ts` with the new KV binding.

### Step 5: Test Locally (Optional but Recommended)

```bash
npm run dev
```

In another terminal, trigger a test webhook or check the health endpoint:
```bash
curl http://localhost:8787/
```

### Step 6: Deploy

```bash
npm run deploy
```

That's it! The deployment will:
- ✅ Keep all existing functionality working
- ✅ Start tracking usage for new reviews
- ✅ Expose new `/usage/*` endpoints

## Zero-Downtime Deployment

The migration is designed to be non-breaking:

1. **Graceful Degradation**: If KV storage fails, reviews still complete successfully
2. **No Schema Changes**: Existing queue messages and webhooks work unchanged
3. **Backward Compatible**: All existing endpoints remain functional

## Verification

### 1. Check Health Endpoint

```bash
curl https://your-worker.workers.dev/
```

Should return:
```json
{
  "status": "ok",
  "service": "code-reviewer-agent",
  "version": "1.0.0",
  "provider": "claude"
}
```

### 2. Trigger a Test Review

Open a PR or push to an existing one. Check the logs:

```bash
npx wrangler tail
```

You should see:
```
[usage-tracker] Stored metrics for PR #123 (50500 tokens, $0.2175)
```

### 3. Query Usage Data

After a review completes:

```bash
curl https://your-worker.workers.dev/usage/owner/repo/pr/123
```

Should return usage metrics JSON.

## Rollback Plan

If you need to rollback:

### Option 1: Quick Rollback (Keep KV, Disable Tracking)

1. Comment out the KV namespace in `wrangler.jsonc`:
   ```jsonc
   // "kv_namespaces": [...]
   ```

2. Redeploy:
   ```bash
   npm run deploy
   ```

This will disable usage tracking but keep existing data.

### Option 2: Full Rollback (Remove Everything)

1. Checkout previous commit:
   ```bash
   git checkout <previous-commit-hash>
   ```

2. Redeploy:
   ```bash
   npm run deploy
   ```

3. Delete KV namespace (optional):
   ```bash
   npx wrangler kv:namespace delete --namespace-id=abc123...
   ```

## What Changed

### New Files (Safe to Ignore if Not Using)
- `src/types/usage.ts` - Type definitions
- `src/lib/usage-tracker.ts` - KV storage helpers
- `scripts/check-usage.sh` - Query script
- `scripts/usage-client.ts` - TypeScript client
- `scripts/usage-dashboard.html` - Visual dashboard
- `USAGE_TRACKING*.md` - Documentation

### Modified Files (Backward Compatible)
- `src/lib/llm/claude.ts` - Returns usage data
- `src/lib/llm/gemini.ts` - Returns usage data
- `src/lib/llm/index.ts` - Updated return types
- `src/handlers/queue.ts` - Tracks and stores usage
- `src/index.ts` - Added `/usage/*` endpoints
- `src/types/env.ts` - Added KV binding type
- `wrangler.jsonc` - Added KV namespace config

### No Changes To
- ✅ Webhook handling
- ✅ GitHub authentication
- ✅ Review logic
- ✅ Queue processing
- ✅ Check Runs integration
- ✅ PR commenting

## Common Issues

### Issue: "USAGE_METRICS is not defined"

**Cause**: KV namespace not bound or wrong ID in wrangler.jsonc

**Fix**:
1. Verify namespace exists: `npx wrangler kv:namespace list`
2. Check IDs match in `wrangler.jsonc`
3. Run `npx wrangler types` again
4. Redeploy

### Issue: "Failed to store usage metrics"

**Cause**: KV write permission issue (rare)

**Impact**: Non-fatal - reviews still complete successfully

**Fix**: Check logs with `npx wrangler tail` for detailed error

### Issue: Usage endpoints return 404

**Cause**: Old deployment still active

**Fix**: 
1. Verify deployment: `npx wrangler deployments list`
2. Force redeploy: `npm run deploy`
3. Wait 30 seconds for propagation

### Issue: No usage data showing up

**Cause**: Reviews completed before migration

**Solution**: Wait for new reviews to complete. Old reviews won't have usage data.

## Cost Impact

Adding usage tracking has minimal cost impact:

- **KV Storage**: ~1KB per review × 90 days retention
  - Example: 100 reviews/month = ~9MB total = **$0.00** (well within free tier)
  
- **KV Reads**: 1 read per query
  - Free tier: 100,000 reads/day = **$0.00** for typical usage

- **KV Writes**: 1 write per review
  - Free tier: 1,000 writes/day = **$0.00** for typical usage

- **Worker CPU**: +1-2ms per review = **negligible**

## Next Steps

1. ✅ Complete migration
2. ✅ Verify with test PR
3. ✅ Set up monitoring (see USAGE_TRACKING.md)
4. ✅ Configure budget alerts
5. ✅ Explore optimization opportunities

## Support

If you encounter issues:

1. Check logs: `npx wrangler tail`
2. Verify KV namespace: `npx wrangler kv:namespace list`
3. Review diagnostics: Check TypeScript errors
4. See troubleshooting in USAGE_TRACKING.md

## Summary

This migration:
- ✅ Takes ~5 minutes
- ✅ Zero breaking changes
- ✅ Graceful degradation if issues occur
- ✅ Can be rolled back instantly
- ✅ Adds powerful cost tracking capabilities
