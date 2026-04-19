import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URL = process.env.SUPABASE_JWKS_URL;
const JWT_ISSUER = process.env.SUPABASE_JWT_ISSUER;

if (!JWKS_URL || !JWT_ISSUER) {
  throw new Error('Missing SUPABASE_JWKS_URL or SUPABASE_JWT_ISSUER in env');
}

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

export async function requireAuth(request, reply) {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    request.log.warn({ path: request.url }, 'auth: missing or malformed Authorization header');
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length).trim();

  if (!token) {
    request.log.warn({ path: request.url }, 'auth: empty bearer token');
    return reply.code(401).send({ error: 'unauthorized' });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: JWT_ISSUER,
      audience: 'authenticated',
      algorithms: ['ES256'],
    });

    if (!payload.sub) {
      request.log.warn('auth: token missing sub claim');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    request.userId = payload.sub;
    request.userEmail = payload.email ?? null;
    request.userRole = payload.role ?? null;
  } catch (err) {
    request.log.warn({ err: err.message }, 'auth: jwt verification failed');
    return reply.code(401).send({ error: 'unauthorized' });
  }
}
