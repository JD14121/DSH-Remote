/**
 * Minimal path router — Phase R3 §29.
 *
 * Built on `node:http` with no framework (§44). Its one non-obvious job is
 * distinguishing the two failures §29 says must never be conflated:
 *
 *   known path, wrong method  -> 405 with an `Allow` header
 *   unknown path              -> 404 ROUTE_NOT_FOUND
 */

import { API_ERROR, HTTP_STATUS, apiError } from './errors.mjs';

/** Detect a `:param` segment. */
const PARAM_SEGMENT = /^:(.+)$/;

/**
 * Split a path into decoded segments.
 *
 * A malformed percent-escape is a client error, not a crash.
 *
 * @param {string} pathname - the request pathname.
 * @returns {string[]} decoded segments, without the leading empty segment.
 * @throws {ApiError} `400` when a segment cannot be decoded.
 */
export function splitPath(pathname) {
  const raw = pathname.split('/').filter((segment) => segment.length > 0);
  return raw.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw apiError(HTTP_STATUS.BAD_REQUEST, API_ERROR.INVALID_REQUEST, 'Request path contains an invalid escape.');
    }
  });
}

/**
 * A registered route.
 */
class Route {
  /**
   * @param {object} spec - route specification.
   * @param {string} spec.method - uppercase HTTP method.
   * @param {string} spec.path - template, e.g. `/api/v1/sessions/:sessionId`.
   * @param {(context: object) => Promise<unknown>} spec.handler - the handler.
   * @param {object} [spec.options] - per-route options.
   */
  constructor(spec) {
    this.method = spec.method.toUpperCase();
    this.path = spec.path;
    this.segments = splitPath(spec.path);
    this.handler = spec.handler;
    // Per-route error-mapping hints. §19 maps some adapter codes differently in
    // context: `SESSION_NOT_FOUND` from a cancel call is a state conflict
    // (SESSION_COLD), while from a read it is a plain 404.
    this.options = spec.options ?? {};
  }

  /**
   * Match a request path.
   *
   * @param {string[]} segments - the request's decoded segments.
   * @returns {Record<string, string>|null} captured params, or `null`.
   */
  match(segments) {
    if (segments.length !== this.segments.length) return null;
    const params = {};
    for (let index = 0; index < this.segments.length; index += 1) {
      const expected = this.segments[index];
      const actual = segments[index];
      const param = PARAM_SEGMENT.exec(expected);
      if (param === null) {
        if (expected !== actual) return null;
        continue;
      }
      if (actual.length === 0) return null;
      params[param[1]] = actual;
    }
    return params;
  }
}

/**
 * The router.
 */
export class Router {
  constructor() {
    /** @type {Route[]} */
    this.routes = [];
  }

  /**
   * Register a route.
   *
   * @param {object} spec - route specification.
   * @returns {Router} this router, for chaining.
   * @throws {TypeError} when the same method and path is registered twice.
   */
  add(spec) {
    const route = new Route(spec);
    const duplicate = this.routes.some(
      (existing) => existing.method === route.method && existing.path === route.path,
    );
    if (duplicate) {
      throw new TypeError(`duplicate route ${route.method} ${route.path}`);
    }
    this.routes.push(route);
    return this;
  }

  /**
   * Resolve a request.
   *
   * @param {string} method - the request method.
   * @param {string} pathname - the request pathname.
   * @returns {{route: Route, params: Record<string, string>}} the match.
   * @throws {ApiError} `405` with `Allow` when the path exists, or `404` otherwise.
   */
  resolve(method, pathname) {
    const segments = splitPath(pathname);
    const upperMethod = method.toUpperCase();

    const pathMatches = [];
    for (const route of this.routes) {
      const params = route.match(segments);
      if (params !== null) pathMatches.push({ route, params });
    }

    if (pathMatches.length === 0) {
      throw apiError(HTTP_STATUS.NOT_FOUND, API_ERROR.ROUTE_NOT_FOUND, 'No such route.');
    }

    const exact = pathMatches.find((candidate) => candidate.route.method === upperMethod);
    if (exact !== undefined) return exact;

    // The path exists but not for this method, including HEAD, which is never
    // registered implicitly.
    const allowed = [...new Set(pathMatches.map((candidate) => candidate.route.method))].sort();
    throw apiError(
      HTTP_STATUS.METHOD_NOT_ALLOWED,
      API_ERROR.METHOD_NOT_ALLOWED,
      `Method ${upperMethod} is not allowed for this route.`,
      { headers: { allow: allowed.join(', ') } },
    );
  }

  /**
   * Every registered route, for documentation and tests.
   *
   * @returns {Array<{method: string, path: string}>} the route table.
   */
  table() {
    return this.routes.map((route) => ({ method: route.method, path: route.path, options: route.options }));
  }
}
