/**
 * TypeScript client for querying Code Reviewer usage metrics
 * 
 * Usage:
 *   npx tsx scripts/usage-client.ts
 */

import type { PRUsageMetrics } from '../src/types/usage';

interface RepoStats {
    totalReviews: number;
    totalTokens: number;
    totalCost: number;
    avgTokensPerReview: number;
    avgCostPerReview: number;
    byProvider: Record<string, { reviews: number; tokens: number; cost: number }>;
}

class UsageClient {
    constructor(private baseUrl: string) {}

    /**
     * Get latest usage metrics for a PR
     */
    async getPRUsage(owner: string, repo: string, prNumber: number): Promise<PRUsageMetrics> {
        const url = `${this.baseUrl}/usage/${owner}/${repo}/pr/${prNumber}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PR usage: ${response.statusText}`);
        }
        
        return response.json();
    }

    /**
     * Get usage metrics for a specific commit
     */
    async getPRUsageBySha(
        owner: string,
        repo: string,
        prNumber: number,
        sha: string
    ): Promise<PRUsageMetrics> {
        const url = `${this.baseUrl}/usage/${owner}/${repo}/pr/${prNumber}?sha=${sha}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch PR usage by SHA: ${response.statusText}`);
        }
        
        return response.json();
    }

    /**
     * List all reviews for a repository
     */
    async listReviews(owner: string, repo: string, limit: number = 100): Promise<PRUsageMetrics[]> {
        const url = `${this.baseUrl}/usage/${owner}/${repo}?limit=${limit}`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to list reviews: ${response.statusText}`);
        }
        
        return response.json();
    }

    /**
     * Get aggregate statistics for a repository
     */
    async getRepoStats(owner: string, repo: string): Promise<RepoStats> {
        const url = `${this.baseUrl}/usage/${owner}/${repo}/stats`;
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch repo stats: ${response.statusText}`);
        }
        
        return response.json();
    }

    /**
     * Find the most expensive reviews
     */
    async getMostExpensiveReviews(
        owner: string,
        repo: string,
        limit: number = 10
    ): Promise<PRUsageMetrics[]> {
        const reviews = await this.listReviews(owner, repo, 1000);
        return reviews
            .sort((a, b) => b.estimatedCost - a.estimatedCost)
            .slice(0, limit);
    }

    /**
     * Calculate cost for a date range
     */
    async getCostForDateRange(
        owner: string,
        repo: string,
        startDate: Date,
        endDate: Date
    ): Promise<{ reviews: PRUsageMetrics[]; totalCost: number }> {
        const reviews = await this.listReviews(owner, repo, 1000);
        
        const filtered = reviews.filter(r => {
            const reviewDate = new Date(r.startTime);
            return reviewDate >= startDate && reviewDate <= endDate;
        });

        const totalCost = filtered.reduce((sum, r) => sum + r.estimatedCost, 0);

        return { reviews: filtered, totalCost };
    }

    /**
     * Get average tokens per file
     */
    async getAvgTokensPerFile(owner: string, repo: string): Promise<number> {
        const reviews = await this.listReviews(owner, repo, 1000);
        
        if (reviews.length === 0) return 0;

        const totalTokens = reviews.reduce((sum, r) => sum + r.totalTokens, 0);
        const totalFiles = reviews.reduce((sum, r) => sum + r.filesReviewed, 0);

        return totalFiles > 0 ? totalTokens / totalFiles : 0;
    }
}

// Example usage
async function main() {
    const workerUrl = process.env.WORKER_URL || 'https://code-reviewer.workers.dev';
    const owner = process.env.REPO_OWNER || 'myorg';
    const repo = process.env.REPO_NAME || 'myrepo';

    const client = new UsageClient(workerUrl);

    console.log('📊 Code Reviewer Usage Report\n');
    console.log(`Repository: ${owner}/${repo}\n`);

    try {
        // Get overall stats
        console.log('=== Repository Statistics ===');
        const stats = await client.getRepoStats(owner, repo);
        console.log(`Total Reviews: ${stats.totalReviews}`);
        console.log(`Total Cost: $${stats.totalCost.toFixed(2)}`);
        console.log(`Average Cost per Review: $${stats.avgCostPerReview.toFixed(4)}`);
        console.log(`Average Tokens per Review: ${Math.round(stats.avgTokensPerReview).toLocaleString()}`);
        console.log('\nBy Provider:');
        for (const [provider, data] of Object.entries(stats.byProvider)) {
            console.log(`  ${provider}: ${data.reviews} reviews, $${data.cost.toFixed(2)}`);
        }

        // Get most expensive reviews
        console.log('\n=== Top 5 Most Expensive Reviews ===');
        const expensive = await client.getMostExpensiveReviews(owner, repo, 5);
        for (const review of expensive) {
            console.log(
                `PR #${review.prNumber}: $${review.estimatedCost.toFixed(4)} ` +
                `(${review.totalTokens.toLocaleString()} tokens, ${review.filesReviewed} files)`
            );
        }

        // Get this month's cost
        console.log('\n=== Current Month Cost ===');
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
        const monthData = await client.getCostForDateRange(owner, repo, monthStart, monthEnd);
        console.log(`Reviews this month: ${monthData.reviews.length}`);
        console.log(`Total cost this month: $${monthData.totalCost.toFixed(2)}`);

        // Get average tokens per file
        console.log('\n=== Efficiency Metrics ===');
        const avgTokensPerFile = await client.getAvgTokensPerFile(owner, repo);
        console.log(`Average tokens per file: ${Math.round(avgTokensPerFile).toLocaleString()}`);

    } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main();
}

export { UsageClient };
