import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { prisma } from './config/prisma';
import { env } from './config/env';
import { swaggerSpec } from './config/swagger';
import { generalApiLimiter } from './middleware/rateLimit';
import { errorHandler } from './middleware/errorHandler';
import apiV1Router from './routes';

export function createApp() {
  const app = express();
  const allowedOrigins = env.FRONTEND_URL.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const isOriginAllowed = (origin?: string): boolean => {
    if (!origin) return true;
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return true;
    // Allow any localhost or 127.0.0.1 port (frontend dev server, Swagger UI on 4000, etc.)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return true;
    }
    // Allow any Vercel deployment domain
    if (/^https?:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin)) {
      return true;
    }
    return false;
  };

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
      exposedHeaders: ['x-auth-token', 'x-guest-cart-token'],
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use('/api', generalApiLimiter);

  const healthHandler = async (_req: express.Request, res: express.Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        success: true,
        status: 'UP',
        service: 'the-sniff-co-backend',
        environment: env.NODE_ENV,
        database: 'connected',
        ready: true,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        success: false,
        status: 'DOWN',
        service: 'the-sniff-co-backend',
        environment: env.NODE_ENV,
        database: 'disconnected',
        ready: false,
        error: 'Database connection failed',
        timestamp: new Date().toISOString(),
      });
    }
  };

  app.get('/', healthHandler);
  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);
  app.get('/api/v1/health', healthHandler);

  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use('/api/v1', apiV1Router);

  app.use(errorHandler);
  return app;
}
