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

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  await truncateTables();
  await prisma.$disconnect();
});

describe('POST /api/v1/auth/signup', () => {
  it('returns 201 with user and team on valid input', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' })
      .expect(201);

    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user.id).toBeDefined();
    expect(res.body.team.name).toBe("alice@example.com's team");
    expect(res.body.team.id).toBeDefined();
  });

  it('creates user, team, team_member, and owner role in DB', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' })
      .expect(201);

    const userId = res.body.user.id as string;
    const teamId = res.body.team.id as string;

    const userRow = await prisma.user.findUnique({ where: { id: userId } });
    expect(userRow).toBeDefined();
    expect(userRow!.passwordHash).not.toBe('password123');

    const teamRow = await prisma.team.findUnique({ where: { id: teamId } });
    expect(teamRow).toBeDefined();

    const memberRow = await prisma.teamMember.findFirst({
      where: { userId },
    });
    expect(memberRow).toBeDefined();

    const roleRow = await prisma.teamMemberRole.findFirst({
      where: { teamMemberId: memberRow!.id },
    });
    expect(roleRow!.role).toBe('owner');
  });

  it('sets a session cookie in the response', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' })
      .expect(201);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();
    expect(cookies.join('')).toContain('HttpOnly');
  });

  it('returns 409 when the email is already registered', async () => {
    await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' });

    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password456' })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ password: 'password123' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when password is fewer than 8 characters', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'short' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email format is invalid', async () => {
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'not-an-email', password: 'password123' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' });
  });

  it('returns 200 with user and team and sets session cookie', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com', password: 'password123' })
      .expect(200);

    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.team).toBeDefined();
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com', password: 'wrongpassword' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid email or password.');
  });

  it('returns 401 on unknown email — same message, no user enumeration', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' })
      .expect(401);

    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Invalid email or password.');
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'alice@example.com' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('returns 204 and invalidates the session', async () => {
    const signupRes = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' });

    const cookie = signupRes.headers['set-cookie'] as unknown as string[];

    await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .expect(204);

    await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('returns 401 without a session', async () => {
    await request(app)
      .post('/api/v1/auth/logout')
      .expect(401);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns user, team, and roles for authenticated session', async () => {
    const signupRes = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'alice@example.com', password: 'password123' });

    const cookie = signupRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookie)
      .expect(200);

    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.team.name).toBe("alice@example.com's team");
    expect(res.body.roles).toEqual(['owner']);
  });

  it('returns 401 without a session', async () => {
    await request(app)
      .get('/api/v1/auth/me')
      .expect(401);
  });
});
