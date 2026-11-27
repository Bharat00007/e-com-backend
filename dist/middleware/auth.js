"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCustomerAuth = requireCustomerAuth;
exports.optionalCustomerAuth = optionalCustomerAuth;
exports.requireAdminAuth = requireAdminAuth;
exports.requireAdminRole = requireAdminRole;
const errors_1 = require("../utils/errors");
const jwt_1 = require("../utils/jwt");
const prisma_1 = require("../config/prisma");
function extractToken(req) {
    const cookieToken = req.cookies?.accessToken;
    if (cookieToken)
        return cookieToken;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return null;
}
async function requireCustomerAuth(req, _res, next) {
    const token = extractToken(req);
    if (!token)
        throw new errors_1.UnauthorizedError('Customer authentication required');
    const payload = (0, jwt_1.verifyAccessToken)(token);
    if (payload.type !== 'customer') {
        throw new errors_1.ForbiddenError('Customer access required');
    }
    const customer = await prisma_1.prisma.customer.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, fullName: true, status: true },
    });
    if (!customer || customer.status !== 'ACTIVE') {
        throw new errors_1.UnauthorizedError('Account is inactive or not found');
    }
    req.customer = customer;
    next();
}
async function optionalCustomerAuth(req, _res, next) {
    const token = extractToken(req);
    if (!token) {
        next();
        return;
    }
    try {
        const payload = (0, jwt_1.verifyAccessToken)(token);
        if (payload.type === 'customer') {
            const customer = await prisma_1.prisma.customer.findUnique({
                where: { id: payload.sub },
                select: { id: true, email: true, fullName: true, status: true },
            });
            if (customer && customer.status === 'ACTIVE') {
                req.customer = customer;
            }
        }
    }
    catch {
        // Ignore invalid optional token and continue as guest
    }
    next();
}
async function requireAdminAuth(req, _res, next) {
    const token = extractToken(req);
    if (!token)
        throw new errors_1.UnauthorizedError('Admin authentication required');
    const payload = (0, jwt_1.verifyAccessToken)(token);
    if (payload.type !== 'admin') {
        throw new errors_1.ForbiddenError('Administrator privileges required');
    }
    const admin = await prisma_1.prisma.adminUser.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, fullName: true, role: true, permissions: true, status: true },
    });
    if (!admin || admin.status !== 'ACTIVE') {
        throw new errors_1.UnauthorizedError('Admin account is inactive');
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
