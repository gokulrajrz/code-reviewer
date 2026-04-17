# Code Reviewer Agent — Documentation

Complete documentation for the AI Code Reviewer agent.

## Quick Start

**New users:** [QUICKSTART.md](./QUICKSTART.md) - Get started in 5 minutes

## Documentation

### User Guides
- **[QUICKSTART.md](./QUICKSTART.md)** - Quick start guide (5 min)
- **[USER_GUIDE.md](./USER_GUIDE.md)** - Complete user guide with API reference

### Developer Guides  
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - System architecture and technical details
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Deployment guide and checklist
- **[RUNBOOK.md](./RUNBOOK.md)** - Operational runbook (health checks, troubleshooting)

### Reference
- **[MIGRATION.md](./MIGRATION.md)** - Migration guide for existing deployments
- **[IMPLEMENTATION.md](./IMPLEMENTATION.md)** - Implementation details and quality metrics

## Key Concepts

### Tech-Stack-Aware Reviews
The agent automatically detects your project's tech stack by analyzing file extensions, directory structures, manifest files, and import statements. Reviews are tailored with language-specific, framework-specific, and ecosystem-specific rules — all composed dynamically per code chunk.

See `src/lib/stack-detector.ts` and `src/config/prompts/composer.ts` for implementation details.

### Per-Repo Configuration
Teams can override detected stacks, add custom rules, or ignore files by placing a `.codereview.yml` in the repository root. See `src/lib/repo-config.ts` and the main [README](../README.md) for syntax.

### Map-Reduce Pipeline
Reviews use a Map-Reduce pipeline:
1. **MAP**: Each code chunk is reviewed independently with a per-chunk composed prompt
2. **REDUCE**: All findings are deduplicated, clustered, and synthesized into a final markdown report

See `src/handlers/queue.ts` for the full pipeline implementation.

## Tools

Located in `../scripts/`:
- `check-usage.sh` - Bash CLI tool
- `usage-client.ts` - TypeScript client  
- `usage-dashboard.html` - Visual dashboard
