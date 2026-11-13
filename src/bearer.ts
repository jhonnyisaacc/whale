import type { FastifyRequest } from "fastify";

export function bearerOf(request: FastifyRequest): string {
  const header = request.headers.authorization ?? "";
  const scheme = /^Bearer +/.exec(header);
  return scheme ? header.slice(scheme[0].length) : "";
}
