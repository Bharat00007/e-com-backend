"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const env_1 = require("./config/env");
const prisma_1 = require("./config/prisma");
const app = (0, app_1.createApp)();
const server = app.listen(env_1.env.PORT, () => {
    console.log(`The Sniff Co. API listening on http://localhost:${env_1.env.PORT}`);
    console.log(`Swagger docs available at http://localhost:${env_1.env.PORT}/api/docs`);
});
async function shutdown() {
    console.log('Shutting down server...');
    server.close(async () => {
        await prisma_1.prisma.$disconnect();
        process.exit(0);
    });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
