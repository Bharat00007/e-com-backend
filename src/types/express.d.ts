import { AccountStatus, AdminRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      customer?: {
        id: string;
        email: string | null;
        fullName: string;
        status: AccountStatus;
      };
      admin?: {
        id: string;
        email: string | null;
        fullName: string;
        role: AdminRole;
        permissions: string[];
        status: AccountStatus;
      };
    }
  }
}
