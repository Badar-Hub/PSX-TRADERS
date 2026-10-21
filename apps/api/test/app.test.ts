import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

/**
 * App-level tests that need no database.
 *
 * Everything here is reachable before a query runs: liveness, the security
 * headers, CORS, body limits, the 404 handler, and authentication rejection,
 * which happens in middleware ahead of any route. Without these, route wiring
 * would only be covered by the integration suite, which skips when no database
 * is present, and a misrouted path would go unnoticed.
 */

const env = loadEnv({
  DATABASE_URL: 'postgresql://psx:psx@localhost:5433/psx_trader',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  CORS_ORIGINS: 'http://localhost:3000',
  NODE_ENV: 'test',
} as NodeJS.ProcessEnv);

const app = createApp({ env, logError: () => {} });

describe('liveness', () => {
  it('answers without touching the database', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptimeSeconds).toBeTypeOf('number');
  });
});

describe('security headers', () => {
  it('sets the helmet defaults', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('does not advertise the framework', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('stamps a request id on every response', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('keeps an incoming request id so a trace survives the hop', async () => {
    const res = await request(app)
      .get('/health')
      .set('x-request-id', 'trace-abc-123')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });
});

describe('CORS', () => {
  it('allows the configured origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('origin', 'http://localhost:3000')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('does not reflect an unconfigured origin', async () => {
    const res = await request(app).get('/health').set('origin', 'https://evil.example').expect(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('authentication middleware', () => {
  /**
   * These run before any query, so they prove the routes are mounted even
   * without a database: a 401 means the path matched and the guard ran, where a
   * 404 would mean the route is not wired up at all.
   */
  const guarded = [
    ['get', '/api/portfolios'],
    ['post', '/api/portfolios'],
    ['get', '/api/portfolios/abc123'],
    ['get', '/api/portfolios/abc123/positions'],
    ['get', '/api/portfolios/abc123/cycles'],
    ['post', '/api/portfolios/abc123/trades'],
    ['get', '/api/portfolios/abc123/trades'],
    ['post', '/api/trades/abc123/reverse'],
    ['get', '/api/portfolios/abc123/reports/pnl'],
    ['get', '/api/auth/me'],
  ] as const;

  for (const [method, path] of guarded) {
    it(`rejects ${method.toUpperCase()} ${path} without a token`, async () => {
      const res = await request(app)[method](path).expect(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  }

  it('rejects a malformed authorization header', async () => {
    for (const header of ['', 'Bearer', 'Basic abc', 'Bearer ', 'token abc']) {
      await request(app).get('/api/portfolios').set('authorization', header).expect(401);
    }
  });

  it('rejects a well-formed but unsigned token', async () => {
    const res = await request(app)
      .get('/api/portfolios')
      .set('authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1LTEifQ.')
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('unknown routes', () => {
  it('returns a structured 404', async () => {
    const res = await request(app).get('/api/does-not-exist').expect(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
  });

  it('returns 404 for an unmatched method on a real path', async () => {
    await request(app).delete('/health').expect(404);
  });
});

describe('request bodies', () => {
  it('rejects malformed JSON with a 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('content-type', 'application/json')
      .send('{"email": "a@b.com", ')
      .expect(400);
    expect(res.body.error).toBeDefined();
  });

  /** A large default body limit is free denial-of-service surface. */
  it('rejects a body over the limit', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'x'.repeat(400_000) });
    expect(res.status).toBe(413);
  });
});

describe('validation before the database', () => {
  /**
   * Validation runs ahead of any query, so these return 400 even with no
   * database: a bad request is rejected without the server doing any work.
   */
  it('rejects a login with no password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@b.com' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual([{ path: 'password', message: expect.any(String) }]);
  });

  it('rejects a registration with a malformed email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'a-long-enough-password' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a refresh with no token', async () => {
    await request(app).post('/api/auth/refresh').send({}).expect(400);
  });
});
