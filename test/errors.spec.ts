/**
 * Unit tests for error handling
 */

import { describe, it, expect } from 'vitest';
import {
    UsageTrackingError,
    ValidationError,
    StorageError,
    NotFoundError,
    AuthenticationError,
    RateLimitError,
    isUsageTrackingError,
    normalizeError,
} from '../src/lib/errors';

describe('UsageTrackingError', () => {
    it('should create error with all properties', () => {
        const error = new UsageTrackingError('Test error', 'TEST_CODE', 400, { key: 'value' });
        
        expect(error.message).toBe('Test error');
        expect(error.code).toBe('TEST_CODE');
        expect(error.statusCode).toBe(400);
        expect(error.context).toEqual({ key: 'value' });
        expect(error.name).toBe('UsageTrackingError');
    });

    it('should default to 500 status code', () => {
        const error = new UsageTrackingError('Test error', 'TEST_CODE');
        expect(error.statusCode).toBe(500);
    });

    it('should serialize to JSON', () => {
        const error = new UsageTrackingError('Test error', 'TEST_CODE', 400, { key: 'value' });
        const json = error.toJSON();
        
        expect(json).toEqual({
            name: 'UsageTrackingError',
            message: 'Test error',
            code: 'TEST_CODE',
            statusCode: 400,
            context: { key: 'value' },
        });
    });
});

describe('ValidationError', () => {
    it('should create validation error with 400 status', () => {
        const error = new ValidationError('Invalid input');
        
        expect(error.message).toBe('Invalid input');
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.statusCode).toBe(400);
        expect(error.name).toBe('ValidationError');
    });
});

describe('StorageError', () => {
    it('should create storage error with 500 status', () => {
        const error = new StorageError('KV failed');
        
        expect(error.message).toBe('KV failed');
        expect(error.code).toBe('STORAGE_ERROR');
        expect(error.statusCode).toBe(500);
        expect(error.name).toBe('StorageError');
    });
});

describe('NotFoundError', () => {
    it('should create not found error with 404 status', () => {
        const error = new NotFoundError('Resource not found');
        
        expect(error.message).toBe('Resource not found');
        expect(error.code).toBe('NOT_FOUND');
        expect(error.statusCode).toBe(404);
        expect(error.name).toBe('NotFoundError');
    });
});

describe('AuthenticationError', () => {
    it('should create auth error with 401 status', () => {
        const error = new AuthenticationError('Invalid token');
        
        expect(error.message).toBe('Invalid token');
        expect(error.code).toBe('AUTHENTICATION_ERROR');
        expect(error.statusCode).toBe(401);
        expect(error.name).toBe('AuthenticationError');
    });
});

describe('RateLimitError', () => {
    it('should create rate limit error with 429 status', () => {
        const error = new RateLimitError('Too many requests');
        
        expect(error.message).toBe('Too many requests');
        expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(error.statusCode).toBe(429);
        expect(error.name).toBe('RateLimitError');
    });
});

describe('isUsageTrackingError', () => {
    it('should identify UsageTrackingError instances', () => {
        const error = new UsageTrackingError('Test', 'TEST');
        expect(isUsageTrackingError(error)).toBe(true);
    });

    it('should identify subclass instances', () => {
        const error = new ValidationError('Test');
        expect(isUsageTrackingError(error)).toBe(true);
    });

    it('should reject non-UsageTrackingError instances', () => {
        const error = new Error('Test');
        expect(isUsageTrackingError(error)).toBe(false);
    });

    it('should reject non-error values', () => {
        expect(isUsageTrackingError('string')).toBe(false);
        expect(isUsageTrackingError(null)).toBe(false);
        expect(isUsageTrackingError(undefined)).toBe(false);
    });
});

describe('normalizeError', () => {
    it('should pass through UsageTrackingError unchanged', () => {
        const error = new ValidationError('Test');
        const normalized = normalizeError(error);
        expect(normalized).toBe(error);
    });

    it('should convert standard Error to UsageTrackingError', () => {
        const error = new Error('Test error');
        const normalized = normalizeError(error);
        
        expect(normalized).toBeInstanceOf(UsageTrackingError);
        expect(normalized.message).toBe('Test error');
        expect(normalized.code).toBe('UNKNOWN_ERROR');
        expect(normalized.statusCode).toBe(500);
    });

    it('should convert string to UsageTrackingError', () => {
        const normalized = normalizeError('Something went wrong');
        
        expect(normalized).toBeInstanceOf(UsageTrackingError);
        expect(normalized.message).toBe('Something went wrong');
        expect(normalized.code).toBe('UNKNOWN_ERROR');
    });

    it('should convert other types to UsageTrackingError', () => {
        const normalized = normalizeError({ error: 'object' });
        
        expect(normalized).toBeInstanceOf(UsageTrackingError);
        expect(normalized.code).toBe('UNKNOWN_ERROR');
    });
});
