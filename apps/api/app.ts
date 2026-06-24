import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { authRouter } from './src/auth';
import { apiKeysRouter } from './src/api-keys';
import { errorMiddleware } from './src/shared/middleware';

const PgStore = connectPgSimple(session);

/**
 * Creates and configures the Express application.
 * Does NOT call `listen()` — that lives in server.ts so tests can import the
 * app without binding to a port.
 *
 * @returns Configured Express app instance.
 */
export function createApp(): express.Application {
  const app = express();

  // ── Body parsing ──────────────────────────────────────────────────────────
  app.use(express.json());

  // ── Session ───────────────────────────────────────────────────────────────
  const connectionString =
    process.env.NODE_ENV === 'test'
      ? process.env.TEST_DATABASE_URL!
      : process.env.DATABASE_URL!;

  app.use(
    session({
      store: new PgStore({ conString: connectionString }),
      secret: process.env.SESSION_SECRET || 'dev-secret-replace-in-production',
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days rolling
        sameSite: 'lax',
      },
    }),
  );

  // ── Routers ───────────────────────────────────────────────────────────────
  app.use('/api/v1', authRouter);
  app.use('/api/v1', apiKeysRouter);

  // ── Global error handler (must be last) ───────────────────────────────────
  app.use(errorMiddleware);

  return app;
}
