import request from 'supertest';
import { createApp } from '../../app';
import prisma from '../shared/db/client';

const app = createApp();

async function truncateTables(): Promise<void> {
  await prisma.$transaction([
    prisma.apiKey.deleteMany(),
    prisma.teamMemberRole.deleteMany(),
    prisma.teamMember.deleteMany(),
    prisma.team.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

/** Signs up a user and returns the session cookie and the user/team IDs. */
async function signup(email = 'alice@example.com', password = 'password123') {
  const res = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password })
    .expect(201);

  return {
    cookie: res.headers['set-cookie'] as unknown as string[],
    userId: res.body.user.id as string,
    teamId: res.body.team.id as string,
  };
}

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

// ── POST /api-keys ─────────────────────────────────────────────────────────

describe('POST /api/v1/api-keys', () => {
  it('creates a key and returns it in full (only time the full key is shown)', async () => {
    const { cookie } = await signup();

    const res = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'My dev key' })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.key).toHaveLength(64); // 32 random bytes → 64 hex chars
    expect(res.body.name).toBe('My dev key');
    expect(res.body.createdAt).toBeDefined();
  });

  it('creates a key without a name when name is omitted', async () => {
    const { cookie } = await signup();

    const res = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({})
      .expect(201);

    expect(res.body.name).toBeNull();
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .post('/api/v1/api-keys')
      .send({ name: 'key' })
      .expect(401);
  });
});

// ── GET /api-keys ──────────────────────────────────────────────────────────

describe('GET /api/v1/api-keys', () => {
  it('returns a list with lastFour only — full key value is never included', async () => {
    const { cookie } = await signup();

    // Create a key
    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'My key' })
      .expect(201);

    const fullKey = createRes.body.key as string;

    // List keys
    const res = await request(app)
      .get('/api/v1/api-keys')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].lastFour).toBe(fullKey.slice(-4));
    expect(res.body[0].key).toBeUndefined(); // full key must NOT be present
    expect(res.body[0].name).toBe('My key');
  });

  it('returns an empty array when no keys exist', async () => {
    const { cookie } = await signup();

    const res = await request(app)
      .get('/api/v1/api-keys')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .get('/api/v1/api-keys')
      .expect(401);
  });
});

// ── DELETE /api-keys/:id ───────────────────────────────────────────────────

describe('DELETE /api/v1/api-keys/:id', () => {
  it('soft-revokes the key — sets revoked_at in DB', async () => {
    const { cookie } = await signup();

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({})
      .expect(201);

    const keyId = createRes.body.id as string;

    await request(app)
      .delete(`/api/v1/api-keys/${keyId}`)
      .set('Cookie', cookie)
      .expect(204);

    // Verify soft-delete in DB
    const row = await prisma.apiKey.findUnique({
      where: { id: keyId },
    });

    expect(row!.revokedAt).not.toBeNull();
  });

  it('revoked key no longer appears in GET /api-keys list', async () => {
    const { cookie } = await signup();

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'temp' });

    const keyId = createRes.body.id as string;

    await request(app)
      .delete(`/api/v1/api-keys/${keyId}`)
      .set('Cookie', cookie)
      .expect(204);

    const listRes = await request(app)
      .get('/api/v1/api-keys')
      .set('Cookie', cookie)
      .expect(200);

    expect(listRes.body).toHaveLength(0);
  });

  it("returns 404 when trying to revoke another user's key", async () => {
    const alice = await signup('alice@example.com');
    const bob = await signup('bob@example.com');

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', alice.cookie)
      .send({});

    const aliceKeyId = createRes.body.id as string;

    // Bob tries to revoke Alice's key
    await request(app)
      .delete(`/api/v1/api-keys/${aliceKeyId}`)
      .set('Cookie', bob.cookie)
      .expect(404);
  });

  it('returns 401 without authentication', async () => {
    await request(app)
      .delete('/api/v1/api-keys/some-uuid')
      .expect(401);
  });
});

// ── requireApiKey middleware ────────────────────────────────────────────────

describe('requireApiKey middleware — authenticating via Bearer token', () => {
  it('a valid Bearer key authenticates the request (GET /api-keys returns 200)', async () => {
    const { cookie } = await signup();

    // Generate an API key via session
    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({ name: 'sdk key' });

    const apiKey = createRes.body.key as string;

    // Use the key to hit GET /api-keys with Bearer
    const res = await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(200);

    // Should return the list — authentication succeeded
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('a revoked key is rejected with 401', async () => {
    const { cookie } = await signup();

    const createRes = await request(app)
      .post('/api/v1/api-keys')
      .set('Cookie', cookie)
      .send({});

    const apiKey = createRes.body.key as string;
    const keyId = createRes.body.id as string;

    // Revoke it
    await request(app)
      .delete(`/api/v1/api-keys/${keyId}`)
      .set('Cookie', cookie)
      .expect(204);

    // Attempt to use the revoked key
    await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', `Bearer ${apiKey}`)
      .expect(401);
  });

  it('a malformed Authorization header is rejected with 401', async () => {
    await request(app)
      .get('/api/v1/api-keys')
      .set('Authorization', 'Basic sometoken')
      .expect(401);
  });
});
