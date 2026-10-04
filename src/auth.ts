import { FastifyRequest, FastifyReply } from 'fastify';

export interface AuthenticatedUser {
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export function parseToken(authHeader?: string): AuthenticatedUser | null {
  if (!authHeader) return null;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }
  const token = parts[1].trim();
  if (!token) return null;

  // Check if token is a standard JWT (3 base64 segments)
  if (token.includes('.') && token.split('.').length === 3) {
    try {
      const payloadBase64 = token.split('.')[1];
      const decodedJson = Buffer.from(payloadBase64, 'base64url').toString('utf8');
      const payload = JSON.parse(decodedJson);
      const userId = payload.sub || payload.user_id || payload.id;
      if (userId && typeof userId === 'string') {
        return { id: userId };
      }
    } catch {
      // Fallback to literal token
    }
  }

  // Otherwise, token itself is the identity (e.g., "usr_abc123" or "user-42")
  return { id: token };
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const user = parseToken(request.headers.authorization);
  if (!user) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'Valid Bearer token required in Authorization header',
    });
  }
  request.user = user;
}
