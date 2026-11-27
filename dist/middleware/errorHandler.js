"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const zod_1 = require("zod");
const errors_1 = require("../utils/errors");
const env_1 = require("../config/env");
function errorHandler(err, _req, res, _next) {
    if (err instanceof errors_1.AppError) {
        res.status(err.statusCode).json({
            success: false,
            error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
            },
        });
        return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
        res.status(400).json({
            success: false,
            error: {
                code: 'INVALID_JSON',
                message: 'Malformed JSON request body',
            },
        });
        return;
    }
    if (err instanceof zod_1.ZodError) {
        const fieldErrors = {};
        for (const issue of err.issues) {
            const pathParts = issue.path[0] === 'body' ? issue.path.slice(1) : issue.path;
            const fieldKey = pathParts.length > 0 ? pathParts.join('.') : 'form';
            if (!fieldErrors[fieldKey]) {
                fieldErrors[fieldKey] = [];
            }
            fieldErrors[fieldKey].push(issue.message);
        }
        const firstField = Object.keys(fieldErrors)[0];
        const firstMessage = firstField
            ? fieldErrors[firstField][0]
            : 'Please check your input and try again.';
        res.status(400).json({
            success: false,
            error: {
                code: 'VALIDATION_ERROR',
                message: firstMessage,
                details: fieldErrors,
            },
        });
        return;
    }
    if (err &&
        typeof err === 'object' &&
        'name' in err &&
        err.name === 'MulterError') {
        res.status(400).json({
            success: false,
            error: {
                code: 'UPLOAD_ERROR',
                message: 'Invalid file upload or file exceeds 5 MB limit.',
            },
        });
        return;
    }
    if (err && typeof err === 'object' && 'code' in err) {
        const code = err.code;
        if (code === 'P1001' || code === 'P2024') {
            res.status(503).json({
                success: false,
                error: {
                    code: 'DATABASE_UNAVAILABLE',
                    message: 'Database connection temporarily unavailable. Please try again.',
                },
            });
            return;
        }
        if (code === 'P2002') {
            res.status(409).json({
                success: false,
                error: {
                    code: 'DUPLICATE_RECORD',
                    message: 'A record with these details already exists.',
                },
            });
            return;
        }
        if (code === 'P2025') {
            res.status(404).json({
                success: false,
                error: {
                    code: 'NOT_FOUND',
                    message: 'Requested record was not found.',
                },
            });
            return;
        }
    }
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: env_1.env.NODE_ENV === 'production'
                ? 'An unexpected error occurred'
                : err instanceof Error
                    ? err.message
                    : 'Internal server error',
        },
    });
}
