# Usage Tracking Deployment Checklist

Use this checklist to ensure proper setup of token usage tracking.

## Pre-Deployment

- [ ] Code pulled from repository
- [ ] Dependencies installed (`npm install`)
- [ ] Existing deployment working (if applicable)

## KV Namespace Setup

- [ ] Production namespace created
  ```bash
  npx wrangler kv:namespace create USAGE_METRICS
  ```
  
- [ ] Preview namespace created
  ```bash
  npx wrangler kv:namespace create USAGE_METRICS --preview
  ```
  
- [ ] IDs copied from command output
  - Production ID: `________________`
  - Preview ID: `________________`

- [ ] IDs updated in `wrangler.jsonc`
  ```jsonc
  "kv_namespaces": [
    {
      "binding": "USAGE_METRICS",
      "id": "your-production-id",
      "preview_id": "your-preview-id"
    }
  ]
  ```

## Type Generation

- [ ] Types generated successfully
  ```bash
  npx wrangler types
  ```
  
- [ ] No TypeScript errors
  ```bash
  npm run test -- --run
  ```

## Local Testing (Optional)

- [ ] Local dev server started
  ```bash
  npm run dev
  ```
  
- [ ] Health check passes
  ```bash
  curl http://localhost:8787/
  ```
  
- [ ] Usage endpoint responds (after first review)
  ```bash
  curl http://localhost:8787/usage/owner/repo/stats
  ```

## Deployment

- [ ] Deployed to Cloudflare
  ```bash
  npm run deploy
  ```
  
- [ ] Deployment successful (no errors)
  
- [ ] Worker URL noted: `https://________________.workers.dev`

## Post-Deployment Verification

- [ ] Health endpoint accessible
  ```bash
  curl https://your-worker.workers.dev/
  ```
  
- [ ] Webhook still receiving events (check GitHub App settings)

- [ ] Test PR created/updated

- [ ] Review completed successfully

- [ ] Usage data stored (check logs)
  ```bash
  npx wrangler tail
  ```
  Look for: `[usage-tracker] Stored metrics for PR #...`

- [ ] Usage endpoint returns data
  ```bash
  curl https://your-worker.workers.dev/usage/owner/repo/pr/123
  ```

## Query Tools Setup

### Bash Script

- [ ] Script executable
  ```bash
  chmod +x scripts/check-usage.sh
  ```
  
- [ ] Environment variable set (optional)
  ```bash
  export WORKER_URL=https://your-worker.workers.dev
  ```
  
- [ ] Test query works
  ```bash
  ./scripts/check-usage.sh stats owner repo
  ```

### TypeScript Client

- [ ] tsx installed
  ```bash
  npm install
  ```
  
- [ ] Environment variables set
  ```bash
  export WORKER_URL=https://your-worker.workers.dev
  export REPO_OWNER=owner
  export REPO_NAME=repo
  ```
  
- [ ] Usage report runs
  ```bash
  npm run usage-report
  ```

### Visual Dashboard

- [ ] Dashboard opened in browser
  ```bash
  open scripts/usage-dashboard.html
  ```
  
- [ ] Worker URL configured in dashboard

- [ ] Data loads successfully

## Monitoring Setup

- [ ] Budget threshold decided: $________/month

- [ ] Alert script created (optional)
  ```bash
  cp scripts/check-usage.sh scripts/check-budget.sh
  # Edit to add alert logic
  ```
  
- [ ] Cron job scheduled (optional)
  ```bash
  # Add to crontab:
  0 9 * * * /path/to/scripts/check-budget.sh
  ```

## Documentation Review

- [ ] README.md reviewed
- [ ] USAGE_TRACKING.md reviewed
- [ ] USAGE_TRACKING_QUICKSTART.md bookmarked
- [ ] Team notified of new endpoints

## Pricing Verification

- [ ] Current pricing verified in `src/types/usage.ts`
  - Claude Sonnet 4: $3/$15 per 1M tokens (input/output)
  - Gemini 3.1 Pro: $1.25/$5 per 1M tokens (input/output)
  
- [ ] Pricing updated if needed

## Optional Enhancements

- [ ] Custom retention period set (default: 90 days)
  - Edit `expirationTtl` in `src/lib/usage-tracker.ts`
  
- [ ] Authentication added to usage endpoints (if needed)
  - Add auth middleware in `src/index.ts`
  
- [ ] Webhook notifications configured (Slack, email, etc.)
  - Integrate in budget alert script

## Rollback Plan

- [ ] Previous deployment version noted: `________________`

- [ ] Rollback command ready
  ```bash
  git checkout <previous-commit>
  npm run deploy
  ```

## Success Criteria

✅ All checks passed when:

1. Worker deployed successfully
2. Reviews complete normally
3. Usage data stored in KV
4. Query endpoints return data
5. No errors in logs
6. Team can access usage dashboard

## Troubleshooting

If any check fails, see:
- **MIGRATION_GUIDE.md** - Common issues and fixes
- **USAGE_TRACKING.md** - Troubleshooting section
- Logs: `npx wrangler tail`

## Sign-Off

- [ ] Deployment completed by: ________________
- [ ] Date: ________________
- [ ] All checks passed: ☐ Yes ☐ No
- [ ] Issues encountered: ________________
- [ ] Team notified: ☐ Yes ☐ No

---

## Quick Reference

### Essential Commands

```bash
# Deploy
npm run deploy

# Check logs
npx wrangler tail

# Query usage
curl https://your-worker.workers.dev/usage/owner/repo/stats

# Run report
npm run usage-report

# View dashboard
open scripts/usage-dashboard.html
```

### Essential Files

- `wrangler.jsonc` - KV namespace configuration
- `src/types/usage.ts` - Pricing constants
- `src/lib/usage-tracker.ts` - Storage logic
- `USAGE_TRACKING.md` - Full documentation

### Support Resources

- Documentation: `USAGE_TRACKING.md`
- Quick Start: `USAGE_TRACKING_QUICKSTART.md`
- Migration: `MIGRATION_GUIDE.md`
- Logs: `npx wrangler tail`
