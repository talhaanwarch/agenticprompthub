import 'express-session';
import 'express';

declare module 'express-session' {
  interface SessionData {
    userId: string;
    teamId: string;
  }
}

declare module 'express' {
  interface Request {
    user?: { id: string; email: string; displayName: string | null };
    teamId?: string;
  }
}
