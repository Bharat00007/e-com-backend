"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.otpResendLimiter = exports.otpVerifyLimiter = exports.authLimiter = exports.generalApiLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
exports.generalApiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
    },
});
exports.authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: {
            code: 'AUTH_RATE_LIMITED',
            message: 'Too many authentication attempts, please try again in 15 minutes.',
        },
    },
});
exports.otpVerifyLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: {
            code: 'OTP_VERIFY_RATE_LIMITED',
            message: 'Too many OTP verification attempts from this IP. Please try again later.',
        },
    },
});
exports.otpResendLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: {
            code: 'OTP_RESEND_RATE_LIMITED',
            message: 'Too many OTP requests from this IP. Please wait before trying again.',
        },
    },
});
