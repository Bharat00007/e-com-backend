import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`The Sniff Co. API listening on http://localhost:${env.PORT}`);
  console.log(`Swagger docs available at http://localhost:${env.PORT}/api/docs`);
});

async function shutdown() {
  console.log('Shutting down server...');
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
