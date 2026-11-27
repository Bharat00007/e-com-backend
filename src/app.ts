import crypto from 'crypto';
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
import { csrfProtection } from './middleware/csrf';
import { isOriginAllowed } from './utils/origins';
import apiV1Router from './routes';

export function createApp() {
  const app = express();

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
      exposedHeaders: ['x-csrf-token', 'x-request-id'],
    })
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Safe diagnostic request logging & correlation ID (no tokens, cookies, passwords, or OTPs logged)
  app.use((req, res, next) => {
    const reqId =
      (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || crypto.randomUUID();
    req.requestId = reqId;
    res.setHeader('x-request-id', reqId);

    const start = Date.now();
    res.on('finish', () => {
      if (env.NODE_ENV !== 'test') {
        const duration = Date.now() - start;
        console.log(`[API] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${duration}ms reqId=${reqId}`);
      }
    });
    next();
  });

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
  app.use('/api/v1', csrfProtection, apiV1Router);

  app.use(errorHandler);
  return app;
}
