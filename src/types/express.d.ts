import { AccountStatus, AdminRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      customer?: {
        id: string;
        email: string | null;
        fullName: string;
        status: AccountStatus;
      };
      customerSession?: {
        id: string;
        csrfSecret: string;
      };
      guestSession?: {
        id: string;
        csrfSecret: string;
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
