/**
 * Progressive Chunking System
 * 
 * Dynamically adjusts chunk sizes based on file complexity and content type.
 * Small, focused files get smaller chunks for precision.
 * Large, complex files get larger chunks for context.
 */

import type { GitHubPRFile } from '../types/github';

export interface ChunkingConfig {
    /** Base chunk size in characters */
    baseChunkSize: number;
    /** Minimum chunk size */
    minChunkSize: number;
    /** Maximum chunk size */
    maxChunkSize: number;
    /** Overlap between chunks in characters */
    overlapSize: number;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
    baseChunkSize: 8000,
    minChunkSize: 4000,
    maxChunkSize: 12000,
    overlapSize: 500,
};

/**
 * Calculate file complexity score (0-1)
 * Higher score = more complex = larger chunks needed
 */
function calculateComplexity(file: GitHubPRFile): number {
    let score = 0.5; // Base complexity

    // Factor 1: File size (larger files are more complex)
    const sizeScore = Math.min(file.changes / 200, 0.3); // Max 0.3 for size
    score += sizeScore;

    // Factor 2: Change ratio (more changes relative to file = more complex)
    // This is a proxy - we don't have total file size, just changes
    if (file.additions + file.deletions > 100) {
        score += 0.1;
    }

    // Factor 3: File type complexity
    const complexExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'];
    const simpleExtensions = ['.md', '.txt', '.json', '.yml', '.yaml'];
    
    const ext = file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase();
    if (complexExtensions.includes(ext)) {
        score += 0.1;
    } else if (simpleExtensions.includes(ext)) {
        score -= 0.1;
    }

    // Clamp to 0-1
    return Math.max(0, Math.min(1, score));
}

/**
 * Determine optimal chunk size for a file based on complexity.
 */
export function getOptimalChunkSize(
    file: GitHubPRFile,
    config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): number {
    const complexity = calculateComplexity(file);
    
    // Linear interpolation between min and max based on complexity
    const sizeRange = config.maxChunkSize - config.minChunkSize;
    const optimalSize = config.minChunkSize + (sizeRange * complexity);
    
    // Round to nearest 500 for consistency
    return Math.round(optimalSize / 500) * 500;
}

/**
 * Chunk content with progressive sizing and smart boundaries.
 */
export function createProgressiveChunks(
    content: string,
    chunkSize: number,
    overlapSize: number = DEFAULT_CHUNKING_CONFIG.overlapSize
): string[] {
    const chunks: string[] = [];
    
    // Try to find natural break points (functions, classes, etc.)
    const breakPoints = findNaturalBreakPoints(content);
    
    let position = 0;
    while (position < content.length) {
        // Calculate end position
        let endPosition = position + chunkSize;
        
        // Adjust to nearest break point if within tolerance (10% of chunk size)
        const tolerance = chunkSize * 0.1;
        for (const breakPoint of breakPoints) {
            if (breakPoint > position && breakPoint < endPosition + tolerance) {
                // Prefer break point if it's not too far from ideal end
                if (Math.abs(breakPoint - endPosition) < tolerance) {
                    endPosition = breakPoint;
                    break;
                }
            }
        }
        
        // Ensure we don't exceed content length
        endPosition = Math.min(endPosition, content.length);
        
        // Extract chunk
        const chunk = content.slice(position, endPosition);
        chunks.push(chunk);
        
        // Move position with overlap
        position = endPosition - overlapSize;
        
        // Prevent infinite loop on small remaining content
        if (position >= content.length - overlapSize) {
            break;
        }
    }
    
    return chunks;
}

/**
 * Find natural break points in code (function/class boundaries).
 */
function findNaturalBreakPoints(content: string): number[] {
    const breakPoints: number[] = [];
    
    // Common patterns that indicate good break points
    const patterns = [
        /\n\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type)\s+/g,
        /\n\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
        /\n\s*(?:describe|it|test|before|after)\s*\(/g, // Test blocks
        /\n\s*\/\*\*/g, // JSDoc comments
        /\n\s*##?\s+/g, // Markdown headers
    ];
    
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            breakPoints.push(match.index);
        }
    }
    
    // Sort and deduplicate
    return [...new Set(breakPoints)].sort((a, b) => a - b);
}

/**
 * Build review chunks with progressive sizing based on file complexity.
 * This is an enhanced version of the original buildReviewChunks that uses
 * file-specific chunk sizes instead of a fixed global limit.
 */
export interface ProgressiveChunkResult {
    content: string;
    files: string[];
    chunkSize: number;
    complexity: number;
}

export function buildProgressiveReviewChunks(
    files: GitHubPRFile[],
    getFileContent: (filename: string) => Promise<string | null>,
    config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): Promise<ProgressiveChunkResult[]> {
    // Group files by complexity tier
    const simpleFiles: GitHubPRFile[] = [];
    const mediumFiles: GitHubPRFile[] = [];
    const complexFiles: GitHubPRFile[] = [];
    
    for (const file of files) {
        const complexity = calculateComplexity(file);
        if (complexity < 0.4) {
            simpleFiles.push(file);
        } else if (complexity < 0.7) {
            mediumFiles.push(file);
        } else {
            complexFiles.push(file);
        }
    }
    
    // Build chunks for each tier with appropriate sizing
    const results: ProgressiveChunkResult[] = [];
    
    // Process simple files with smaller chunks
    if (simpleFiles.length > 0) {
        const simpleChunkSize = config.minChunkSize;
        // Implementation continues...
        // This would integrate with the existing chunk building logic
    }
    
    // Similar processing for medium and complex files...
    
    return Promise.resolve(results);
}

/**
 * Estimate token count from character count.
 * Rough approximation: 1 token ≈ 4 characters for English/code.
 */
export function estimateTokens(charCount: number): number {
    return Math.ceil(charCount / 4);
}

/**
 * Validate that a chunk size won't exceed LLM context limits.
 */
export function validateChunkSize(
    chunkSize: number,
    maxTokens: number = 128000 // Claude 3 Sonnet limit
): boolean {
    const estimatedTokens = estimateTokens(chunkSize);
    // Leave 20% buffer for system prompts and response
    return estimatedTokens < (maxTokens * 0.8);
}
