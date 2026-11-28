import { env } from '../config/env';

const allowedOrigins = env.FRONTEND_URL.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** Checks if a request Origin is permitted for CORS and CSRF validation. */
export function isOriginAllowed(origin?: string): boolean {
  if (!origin) return true;
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return true;
  }
  if (/^https?:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin)) {
    return true;
  }
  if (/^https?:\/\/([a-z0-9-]+\.)*thesniff\.co$/i.test(origin)) {
    return true;
  }
  return false;
}
