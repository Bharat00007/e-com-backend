"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateSixDigitOtp = generateSixDigitOtp;
exports.hashOtp = hashOtp;
exports.verifyOtpHash = verifyOtpHash;
exports.maskEmail = maskEmail;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
/** Generates a uniform cryptographically random 6-digit numeric OTP string. */
function generateSixDigitOtp() {
    return crypto_1.default.randomInt(0, 1_000_000).toString().padStart(6, '0');
}
/** Computes a keyed HMAC-SHA256 hash of an OTP bound to the normalized email. */
function hashOtp(normalizedEmail, otp) {
    return crypto_1.default
        .createHmac('sha256', env_1.env.JWT_ACCESS_SECRET)
        .update(`${normalizedEmail}:${otp}`)
        .digest('hex');
}
/** Constant-time OTP verification against the stored HMAC-SHA256 hash. */
function verifyOtpHash(normalizedEmail, otp, storedHash) {
    const candidateHex = hashOtp(normalizedEmail, otp);
    const a = Buffer.from(candidateHex, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length || a.length === 0)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
/** Masks an email address safely for display (e.g. a***v@example.in). */
function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!local || !domain)
        return '***';
    if (local.length <= 2)
        return `${local[0]}***@${domain}`;
    return `${local[0]}${'*'.repeat(Math.min(4, local.length - 2))}${local[local.length - 1]}@${domain}`;
}
