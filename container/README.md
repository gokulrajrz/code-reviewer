# The Sandbox Container

This directory operates entirely independently from the Cloudflare Worker runtime up top. Built natively around **Docker**, this environment grants the Map-Reduce workers heavily guarded, ephemeral Linux execution boundaries.

## Execution Sequence

While the Edge Worker handles extremely volatile burst webhooks (at low memory/latency environments), this Sandbox intercepts massive binary analysis pipelines.

1. **Hono Injection**: The root Worker proxy routes internal HTTPS parameters directly to the standalone `src/server.ts` Hono router.
2. **Checkout**: Spawns OS-level `git clone` inside `.tmp/` for deep tree-level metadata reading.
3. **AST Engine**: Triggers Python Tree-sitter binaries to establish perfectly mathematically accurate dependency loops to prevent LLMs from hallucinating "dead code".
4. **SAST Execution**: Immediately invokes `semgrep` natively on the filesystem.

## Compiling Limitations 🚨

The Cloudflare platform bridges the external Edge Worker to this container solely via the outputted `dist/` directory resulting from your TypeScript builds.

If you push to Cloudflare **without** executing `npm run build` from this root directory, the Dockerfile will build the native image upon heavily stale `dist/` Javascript logic.

**Before every `wrangler deploy`:**
```bash
# In ./container
npm run build
```
