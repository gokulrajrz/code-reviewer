import type { TokenUsage } from '../../types/usage';

/**
 * LLM Provider Adapter Interface
 * Defines the contract that all LLM providers must implement.
 * This enables easy addition of new providers (OpenAI, Mistral, etc.)
 */

export interface LLMProviderConfig {
    apiKey: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
}

export interface LLMResponse {
    content: string;
    usage: TokenUsage;
}

export interface ChunkReviewRequest {
    chunkContent: string;
    prTitle: string;
    chunkLabel: string;
}

export interface SynthesisRequest {
    payload: string;
}

/**
 * Abstract base class for LLM provider adapters.
 * All concrete providers must extend this class.
 */
export abstract class LLMProviderAdapter {
    protected config: LLMProviderConfig;

    constructor(config: LLMProviderConfig) {
        this.config = config;
    }

    /**
     * Perform a chunk review (Map phase).
     * Analyzes a code chunk and returns structured findings as JSON.
     */
    abstract reviewChunk(
        request: ChunkReviewRequest,
        signal?: AbortSignal
    ): Promise<LLMResponse>;

    /**
     * Perform synthesis (Reduce phase).
     * Combines findings into a cohesive markdown review.
     */
    abstract synthesize(
        request: SynthesisRequest,
        signal?: AbortSignal
    ): Promise<LLMResponse>;

    /**
     * Get the provider name for logging and metrics.
     */
    abstract getProviderName(): string;

    /**
     * Get the model name being used.
     */
    abstract getModelName(): string;

    /**
     * Check if the provider is available (API key configured).
     */
    isAvailable(): boolean {
        return !!this.config.apiKey && this.config.apiKey.length > 0;
    }
}

/**
 * Factory for creating LLM provider adapters.
 */
export class LLMProviderFactory {
    private static adapters = new Map<string, new (config: LLMProviderConfig) => LLMProviderAdapter>();

    /**
     * Register a new LLM provider adapter.
     */
    static registerProvider(
        name: string,
        adapterClass: new (config: LLMProviderConfig) => LLMProviderAdapter
    ): void {
        this.adapters.set(name.toLowerCase(), adapterClass);
    }

    /**
     * Create a provider adapter instance.
     */
    static createProvider(name: string, config: LLMProviderConfig): LLMProviderAdapter {
        const AdapterClass = this.adapters.get(name.toLowerCase());
        if (!AdapterClass) {
            throw new Error(`Unknown LLM provider: ${name}. Available: ${Array.from(this.adapters.keys()).join(', ')}`);
        }
        return new AdapterClass(config);
    }

    /**
     * Get list of available provider names.
     */
    static getAvailableProviders(): string[] {
        return Array.from(this.adapters.keys());
    }

    /**
     * Check if a provider is registered.
     */
    static isProviderRegistered(name: string): boolean {
        return this.adapters.has(name.toLowerCase());
    }
}
