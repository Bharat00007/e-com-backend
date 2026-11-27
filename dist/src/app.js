"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const prisma_1 = require("./config/prisma");
const env_1 = require("./config/env");
const swagger_1 = require("./config/swagger");
const rateLimit_1 = require("./middleware/rateLimit");
const errorHandler_1 = require("./middleware/errorHandler");
const routes_1 = __importDefault(require("./routes"));
function createApp() {
    const app = (0, express_1.default)();
    const allowedOrigins = env_1.env.FRONTEND_URL.split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    app.set('trust proxy', 1);
    app.use((0, helmet_1.default)());
    app.use((0, cors_1.default)({
        origin: (origin, callback) => {
            if (!origin ||
                allowedOrigins.includes('*') ||
                allowedOrigins.includes(origin) ||
                origin.endsWith('.vercel.app')) {
                callback(null, true);
                return;
            }
            callback(new Error('Origin not allowed by CORS'));
        },
        credentials: true,
    }));
    app.use((0, cookie_parser_1.default)());
    app.use(express_1.default.json({ limit: '1mb' }));
    app.use(express_1.default.urlencoded({ extended: true, limit: '1mb' }));
    app.use('/api', rateLimit_1.generalApiLimiter);
    const healthHandler = async (_req, res) => {
        try {
            await prisma_1.prisma.$queryRaw `SELECT 1`;
            res.json({
                success: true,
                status: 'UP',
                service: 'the-sniff-co-backend',
                environment: env_1.env.NODE_ENV,
                database: 'connected',
                ready: true,
                timestamp: new Date().toISOString(),
            });
        }
        catch {
            res.status(503).json({
                success: false,
                status: 'DOWN',
                service: 'the-sniff-co-backend',
                environment: env_1.env.NODE_ENV,
                database: 'disconnected',
                ready: false,
                error: 'Database connection failed',
                timestamp: new Date().toISOString(),
            });
        }
    };
    app.get('/health', healthHandler);
    app.get('/api/health', healthHandler);
    app.get('/api/v1/health', healthHandler);
    app.use('/api/docs', swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_1.swaggerSpec));
    app.use('/api/v1', routes_1.default);
    app.use(errorHandler_1.errorHandler);
    return app;
}
