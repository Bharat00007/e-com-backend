"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCustomerAuth = requireCustomerAuth;
exports.optionalCustomerAuth = optionalCustomerAuth;
exports.requireAdminAuth = requireAdminAuth;
exports.requireAdminRole = requireAdminRole;
const errors_1 = require("../utils/errors");
const jwt_1 = require("../utils/jwt");
const prisma_1 = require("../config/prisma");
function extractTokens(req) {
    const tokens = [];
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const headerToken = authHeader.slice(7).trim();
        if (headerToken)
            tokens.push(headerToken);
    }
    const cookieToken = req.cookies?.accessToken;
    if (cookieToken && !tokens.includes(cookieToken)) {
        tokens.push(cookieToken);
    }
    return tokens;
}
async function requireCustomerAuth(req, _res, next) {
    const tokens = extractTokens(req);
    if (tokens.length === 0)
        throw new errors_1.UnauthorizedError('Customer authentication required');
    let customer = null;
    for (const token of tokens) {
        try {
            const payload = (0, jwt_1.verifyAccessToken)(token);
            if (payload.type === 'customer') {
                const found = await prisma_1.prisma.customer.findUnique({
                    where: { id: payload.sub },
                    select: { id: true, email: true, fullName: true, status: true },
                });
                if (found && found.status === 'ACTIVE') {
                    customer = found;
                    break;
                }
            }
        }
        catch {
            // Continue to next candidate token
        }
    }
    if (!customer) {
        throw new errors_1.UnauthorizedError('Customer authentication required or token invalid');
    }
    req.customer = customer;
    next();
}
async function optionalCustomerAuth(req, _res, next) {
    const tokens = extractTokens(req);
    for (const token of tokens) {
        try {
            const payload = (0, jwt_1.verifyAccessToken)(token);
            if (payload.type === 'customer') {
                const customer = await prisma_1.prisma.customer.findUnique({
                    where: { id: payload.sub },
                    select: { id: true, email: true, fullName: true, status: true },
                });
                if (customer && customer.status === 'ACTIVE') {
                    req.customer = customer;
                    break;
                }
            }
        }
        catch {
            // Ignore invalid optional token and continue
        }
    }
    next();
}
async function requireAdminAuth(req, _res, next) {
    const tokens = extractTokens(req);
    if (tokens.length === 0)
        throw new errors_1.UnauthorizedError('Admin authentication required');
    let admin = null;
    for (const token of tokens) {
        try {
            const payload = (0, jwt_1.verifyAccessToken)(token);
            if (payload.type === 'admin') {
                const found = await prisma_1.prisma.adminUser.findUnique({
                    where: { id: payload.sub },
                    select: { id: true, email: true, fullName: true, role: true, permissions: true, status: true },
                });
                if (found && found.status === 'ACTIVE') {
                    admin = found;
                    break;
                }
            }
        }
        catch {
            // Continue to next candidate token
        }
    }
    if (!admin) {
        throw new errors_1.UnauthorizedError('Administrator authentication required or token invalid');
    }
    req.admin = admin;
    next();
}
function requireAdminRole(...allowedRoles) {
    return (req, _res, next) => {
        if (!req.admin)
            throw new errors_1.UnauthorizedError('Admin authentication required');
        if (req.admin.role === 'SUPER_ADMIN' || allowedRoles.includes(req.admin.role)) {
            next();
            return;
        }
        throw new errors_1.ForbiddenError('Insufficient admin role permissions');
    };
}
