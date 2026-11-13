import type { FastifyRequest } from "fastify";

export function bearerOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}
