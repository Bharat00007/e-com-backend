import crypto from 'crypto';
import { env } from '../config/env';

/** Generates a uniform cryptographically random 6-digit numeric OTP string. */
export function generateSixDigitOtp(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Computes a keyed HMAC-SHA256 hash of an OTP bound to the normalized email. */
export function hashOtp(normalizedEmail: string, otp: string): string {
  return crypto
    .createHmac('sha256', env.JWT_ACCESS_SECRET)
    .update(`${normalizedEmail}:${otp}`)
    .digest('hex');
}

/** Constant-time OTP verification against the stored HMAC-SHA256 hash. */
export function verifyOtpHash(normalizedEmail: string, otp: string, storedHash: string): boolean {
  const candidateHex = hashOtp(normalizedEmail, otp);
  const a = Buffer.from(candidateHex, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Masks an email address safely for display (e.g. a***v@example.in). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(4, local.length - 2))}${local[local.length - 1]}@${domain}`;
}
