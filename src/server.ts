import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';

export const app = createApp();

if (process.env.VERCEL !== '1' && process.env.NODE_ENV !== 'test') {
  const server = app.listen(env.PORT, () => {
    console.log(`The Sniff Co. API listening on http://localhost:${env.PORT}`);
    console.log(`Swagger docs available at http://localhost:${env.PORT}/api/docs`);
  });

  const shutdown = async () => {
    console.log('Shutting down server...');
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default app;
