import { AxiosError, AxiosInstance, AxiosResponse, CanceledError } from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import type { AuthTokens } from './types/auth';

declare module 'axios' {
  // allows: axios.post(url, data, { skipAuthRefresh: true })
  interface AxiosRequestConfig {
    skipAuthRefresh?: boolean;
  }
  // used internally by interceptors
  interface InternalAxiosRequestConfig {
    skipAuthRefresh?: boolean;
    _authRefreshRetried?: boolean; // prevent infinite refresh loops per request
    _authTriedCurrent?: boolean;   // retried once with current token on stale-token 401
    _sentAccessToken?: string;     // token value that went out with this request
  }
}

// Custom error for timeout (handy for analytics/telemetry)
export class RefreshTimeoutError extends Error {
  constructor() {
    super('Refresh timeout');
    this.name = 'RefreshTimeoutError';
  }
}

export interface RequestFailureContext {
  status: number;           // HTTP status, or 0 if unavailable
  data?: any;               // Response payload if available (e.g., Axios error response.data)
  error: AxiosError;        // Axios error from the failed original request
}

export interface AuthRefreshOptions {
  refresh: (refreshToken: string) => Promise<AuthTokens>;
  getTokens: () => Promise<AuthTokens | null>;
  setTokens: (tokens: AuthTokens) => Promise<void>;
  isSessionExpired: (context: RequestFailureContext) => boolean;
  // Decide whether a refresh failure means the session is terminally lost
  isRefreshFailureTerminal: (error: unknown) => boolean;
  header?: {
    name?: string;
    format?: (token: string) => string;
  };
  onBeforeRefresh?: () => void;
  onRefreshed?: (tokens: AuthTokens) => void;
  onRefreshFailed?: (error: unknown) => void;
  maxRetries?: number;
  refreshTimeout?: number;
  logger?: {
    debug: (message: string) => void;
    error: (message: string, error?: unknown) => void;
  };
  logout?: () => Promise<void>;
}

interface QueuedRequest {
  resolve: (response: AxiosResponse) => void;
  reject: (error: unknown) => void;
  config: InternalAxiosRequestConfig;
}

// Mutate-in-place header setter for a config.headers bag
function setAuthHeader(headers: any, name: string, value: string) {
  if (!headers) return { [name]: value };
  if (typeof headers.set === 'function') headers.set(name, value);
  else headers[name] = value;
  return headers;
}

// Read a header value from a possibly mixed header bag (Map-like or plain object)
function readHeader(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = typeof name === 'string' ? name.toLowerCase() : name;
  return headers[name] ?? headers[lower];
}

// Timeout helper with custom error
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new RefreshTimeoutError()), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// Quiet by default (library-friendly)
const defaultLogger = {
  debug: () => {},
  error: () => {},
};

export function installAuthRefresh(
  api: AxiosInstance,
  options: AuthRefreshOptions
): { uninstall: () => void } {
  let refreshInFlight: Promise<AuthTokens> | null = null;
  let refreshSubscribers: QueuedRequest[] = [];
  let refreshAttemptCount = 0;

  const {
    refresh,
    getTokens,
    setTokens,
    isSessionExpired,
    isRefreshFailureTerminal,
    header = {},
    onBeforeRefresh,
    onRefreshed,
    onRefreshFailed,
    maxRetries = 3,
    refreshTimeout = 10_000,
    logger = defaultLogger,
    logout,
  } = options;

  const headerName = header.name || 'Authorization';
  const headerFormat = header.format || ((t: string) => `Bearer ${t}`);

  // Source-of-truth for the latest access token observed by the interceptor
  let currentAccessToken: string | null = null;
  void getTokens()
    .then((t) => {
      currentAccessToken = t?.accessToken ?? null;
      try {
        logger.debug(
          `Auth refresher boot: initial tokens loaded (accessToken present: ${currentAccessToken ? 'yes' : 'no'})`
        );
      } catch {}
    })
    .catch(() => {});

  // Stamp outgoing requests with the latest token & remember which token was sent.
  // - Respects cfg.skipAuthRefresh (no header, no stamp)
  // - Respects an explicit per-request header (won’t overwrite)
  // - If explicit header equals headerFormat(currentAccessToken), we still stamp _sentAccessToken
  const reqInterceptorId = api.interceptors.request.use((cfg) => {
    if (cfg.skipAuthRefresh) return cfg;

    const explicit = readHeader(cfg.headers, headerName);
    if (explicit != null) {
      if (currentAccessToken && explicit === headerFormat(currentAccessToken)) {
        cfg._sentAccessToken = currentAccessToken;
      }
      return cfg; // don't overwrite caller's header
    }

    if (currentAccessToken) {
      cfg.headers = setAuthHeader(cfg.headers, headerName, headerFormat(currentAccessToken));
      cfg._sentAccessToken = currentAccessToken;
    }

    return cfg;
  });

  const drainSuccess = (newToken: string) => {
    const queued = refreshSubscribers.length;
    if (queued) logger.debug(`Draining ${queued} queued request(s) with refreshed token`);
    const headerValue = headerFormat(newToken);
    refreshSubscribers.forEach(({ resolve, reject, config }) => {
      if (config.signal?.aborted) {
        reject(new CanceledError('canceled'));
        return;
      }
      config.headers = setAuthHeader(config.headers, headerName, headerValue);
      config._sentAccessToken = newToken; // so stale-token fast-path can reason correctly
      logger.debug(`Executing queued request ${config.url ?? ''} with refreshed token`);
      api.request(config).then(resolve).catch(reject);
    });
    refreshSubscribers = [];
  };

  const drainFailure = (error: unknown) => {
    const queued = refreshSubscribers.length;
    if (queued) logger.debug(`Draining ${queued} queued request(s) with failure`);
    refreshSubscribers.forEach(({ reject }) => reject(error));
    refreshSubscribers = [];
  };

  const queue = (config: InternalAxiosRequestConfig) =>
    new Promise<AxiosResponse>((resolve, reject) => {
      const size = refreshSubscribers.length + 1;
      logger.debug(
        `Queueing request to ${config.url ?? ''} while awaiting token refresh (queue size: ${size})`
      );
      refreshSubscribers.push({ resolve, reject, config });
    });

  const getOrStartRefresh = async (refreshToken: string): Promise<AuthTokens> => {
    if (refreshInFlight) return refreshInFlight;

    refreshAttemptCount++;
    logger.debug(`Refresh attempt #${refreshAttemptCount} in progress`);
    onBeforeRefresh?.();

    const promise = (async () => {
      try {
        return await withTimeout(refresh(refreshToken), refreshTimeout);
      } finally {
        refreshInFlight = null;
      }
    })();

    refreshInFlight = promise;
    return promise;
  };

  const terminalAuthLost = async (reason: string, originalError: unknown): Promise<never> => {
    logger.debug(`Auth lost: ${reason}`);
    refreshAttemptCount = 0;
    currentAccessToken = null;
    drainFailure(originalError);
    onRefreshFailed?.(originalError);
    setAuthHeaders(api, null, headerName, headerFormat);
    await logout?.().catch(() => {});
    throw originalError;
  };

  const respInterceptorId = api.interceptors.response.use(
    (response) => {
      refreshAttemptCount = 0;
      return response;
    },
    async (error: AxiosError) => {
      const { config } = error as AxiosError & { config: InternalAxiosRequestConfig | undefined };

      if (!config) {
        refreshAttemptCount = 0;
        throw error;
      }

      // Honor skipAuthRefresh on responses, too (belt-and-suspenders)
      if (config.skipAuthRefresh) {
        refreshAttemptCount = 0;
        throw error;
      }

      const status = error.response?.status ?? 0;
      const data = error.response?.data;
      const isExpiredForRequest = isSessionExpired({ status, data, error });
      if (!isExpiredForRequest) {
        refreshAttemptCount = 0;
        throw error;
      }

      // --- Stale-token fast-path -------------------------------------------
      // If the request failed due to an expired/invalid session (per isSessionExpired),
      // but it was sent with an older token than we have now, retry ONCE with the
      // current token instead of starting another refresh.
      const sentHeaderValue = readHeader(config.headers, headerName);
      const formattedCurrent = currentAccessToken ? headerFormat(currentAccessToken) : undefined;

      if (
        // Only consider the fast path if the failure represents an expired session
        isExpiredForRequest &&
        currentAccessToken &&
        !config._authTriedCurrent &&
        (
          // Primary path: we stamped `_sentAccessToken` on the request and can compare directly
          (config._sentAccessToken && config._sentAccessToken !== currentAccessToken) ||
          // Fallback path: the request had an explicit auth header (or `_sentAccessToken` was lost)
          // — e.g. caller manually set `Authorization`/`XAuthToken`, or another interceptor rewrote it.
          // Compare the header that actually went out vs the *current* token to detect a stale-token 401.
          (sentHeaderValue && formattedCurrent && sentHeaderValue !== formattedCurrent)
        )
      ) {
        logger.debug(`Stale token detected; retrying ${config.url ?? ''} with current token`);
        config._authTriedCurrent = true;
        config.headers = setAuthHeader(config.headers, headerName, formattedCurrent!);
        config._sentAccessToken = currentAccessToken;
        return api.request(config);
      }
      // ---------------------------------------------------------------------

      // Prevent per-request refresh loops
      if (config._authRefreshRetried) {
        logger.debug(`Auth refresher: request already retried refresh for ${config.url ?? ''}`);
        throw error;
      }
      config._authRefreshRetried = true;

      logger.debug(`Access token expired for URL: ${config.url ?? ''}`);

      // Get stored tokens
      let storedTokens: AuthTokens | null = null;
      try {
        storedTokens = await getTokens();
      } catch (err) {
        logger.error('Failed to get tokens from storage:', err);
      }

      if (!storedTokens?.refreshToken) {
        logger.debug(
          `Auth refresher: no refresh token available; marking auth lost for ${config.url ?? ''}`
        );
        return await terminalAuthLost('no-refresh-token', error);
      }

      // Queue this failed request while we refresh
      const promise = queue(config);

      if (refreshInFlight) {
        logger.debug(`Refresh already in flight; returning queued promise for ${config.url ?? ''}`);
        return promise;
      }

      if (refreshAttemptCount >= maxRetries) {
        logger.error(
          `Auth refresher: max retries reached (${refreshAttemptCount} >= ${maxRetries}); marking auth lost`
        );
        return await terminalAuthLost('max-retries', error);
      }

      try {
        const refreshed = await getOrStartRefresh(storedTokens!.refreshToken);

        const newAccessToken = refreshed.accessToken;
        if (!newAccessToken) throw new Error('Invalid refresh response - no access token');

        logger.debug(`Received new access token`);
        setAuthHeaders(api, newAccessToken, headerName, headerFormat);
        currentAccessToken = newAccessToken;

        try {
          // Merge to avoid dropping existing refreshToken if server omits it
          const updatedTokens = { ...storedTokens, ...refreshed };
          await setTokens(updatedTokens);
          onRefreshed?.(updatedTokens);
        } catch (err) {
          logger.error('Failed to store new tokens:', err);
        }

        refreshAttemptCount = 0;
        drainSuccess(newAccessToken);
      } catch (e) {
        logger.error('Auth token refresher error:', e);
        if (isRefreshFailureTerminal(e)) {
          logger.debug('Auth refresher: refresh failure classified as terminal; logging out');
          // Terminal path: clears headers, drains, invokes logout, and throws.
          return await terminalAuthLost('refresh-auth-lost', e);
        }
        // Non-terminal refresh failure: reject queued requests and bubble up.
        drainFailure(e);
        onRefreshFailed?.(e);
        throw e;
      }

      return promise;
    }
  );

  return {
    uninstall: () => {
      api.interceptors.request.eject(reqInterceptorId);
      api.interceptors.response.eject(respInterceptorId);
      const queued = refreshSubscribers.length;
      if (queued) {
        drainFailure(new CanceledError('auth refresher uninstalled'));
      }
      logger.debug(
        `Auth refresher: interceptors ejected; drained ${queued} queued request(s)`
      );
      refreshInFlight = null;
    },
  };
}

/**
 * Helper to sync an axios instance's default header with a token (or clear it).
 * Uses HeaderBag#set/delete if available, otherwise falls back to plain object semantics.
 */
export function setAuthHeaders(
  apiInstance: AxiosInstance,
  token: string | null,
  name = 'Authorization',
  build: (t: string) => string = (t) => `Bearer ${t}`
) {
  const headers: any = apiInstance.defaults.headers.common;
  if (typeof headers.set !== 'function' || typeof headers.delete !== 'function') {
    // If defaults are a plain object, keep both shapes in sync (defensive).
    const lower = typeof name === 'string' ? name.toLowerCase() : name;
    if (token) {
      (headers as any)[name] = build(token);
      (headers as any)[lower] = (headers as any)[name];
    } else {
      delete (headers as any)[name];
      delete (headers as any)[lower];
    }
    return;
  }
  if (token) headers.set(name, build(token));
  else headers.delete(name);
}
