import type { FetchFn } from '../../src/net/http.ts';

/** Offline stand-in for fetch: answers from `route` (404 otherwise) and records every requested URL. */
type Route = (url: string) => Response | undefined;
export function fakeFetch(route: Route, calls: string[] = []): FetchFn {
  return async (url) => {
    calls.push(url);
    return route(url) ?? new Response('not found', { status: 404 });
  };
}
