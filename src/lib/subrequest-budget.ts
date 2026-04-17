/**
 * SubrequestBudget — Runtime tracker for Cloudflare Workers' 50-subrequest limit.
 *
 * Instead of blindly capping chunks at MAX_LLM_CHUNKS=10 and hoping for the best,
 * this class dynamically tracks consumption and provides:
 *   1. `use(n)` — Records n subrequests consumed
 *   2. `canAfford(n)` — Checks if n more subrequests are possible
 *   3. `remaining()` — Returns how many are left
 *   4. `exhausted()` — True if we've used the budget
 *
 * The hard limit is 50 for Workers (paid plan), but we cap at 45 to leave
 * buffer for auth token refresh, retries, and final publish operations.
 */

import { logger } from './logger';

const CLOUDFLARE_SUBREQUEST_LIMIT = 50;
const SAFETY_BUFFER = 5;

export class SubrequestBudget {
    private consumed = 0;
    private readonly limit: number;

    constructor(limit: number = CLOUDFLARE_SUBREQUEST_LIMIT - SAFETY_BUFFER) {
        this.limit = limit;
    }

    /** Record N subrequests consumed. */
    use(n: number = 1): void {
        this.consumed += n;
        if (this.consumed >= this.limit) {
            logger.warn('Subrequest budget exhausted', {
                consumed: this.consumed,
                limit: this.limit,
            });
        }
    }

    /** Check if N more subrequests can be afforded. */
    canAfford(n: number = 1): boolean {
        return this.consumed + n <= this.limit;
    }

    /** How many subrequests remain. */
    remaining(): number {
        return Math.max(0, this.limit - this.consumed);
    }

    /** True if the budget is fully consumed. */
    exhausted(): boolean {
        return this.consumed >= this.limit;
    }

    /** Current consumption for logging. */
    getState(): { consumed: number; limit: number; remaining: number } {
        return {
            consumed: this.consumed,
            limit: this.limit,
            remaining: this.remaining(),
        };
    }
}
