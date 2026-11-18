import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { AppDeps } from './context';
import { errorHandler, notFoundHandler, requireJsonForMutations } from './middleware/error-handler';
import { createV1Router } from './routes/v1';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(
    pinoHttp({
      logger: deps.logger,
      // Reuse a well-formed upstream X-Request-Id for correlation, else generate one.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      // Compact request logs: correlation id, route and status — no headers/cookies.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: deps.config.webOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requireJsonForMutations);

  app.use('/api/v1', createV1Router(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
