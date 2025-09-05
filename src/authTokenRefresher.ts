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

export interface AuthRefreshOptions {
  refresh: (refreshToken: string) => Promise<AuthTokens>;
  getTokens: () => Promise<AuthTokens | null>;
  setTokens: (tokens: AuthTokens) => Promise<void>;
  shouldRefresh: (context: {
    status: number;
    config: InternalAxiosRequestConfig;
    error: AxiosError;
  }) => boolean;
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
    shouldRefresh,
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
    refreshSubscribers.forEach(({ reject }) => reject(error));
    refreshSubscribers = [];
  };

  const queue = (config: InternalAxiosRequestConfig) =>
    new Promise<AxiosResponse>((resolve, reject) => {
      logger.debug(`Queueing request to ${config.url ?? ''} while awaiting token refresh`);
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

      // --- Stale-token fast-path -------------------------------------------
      // If the request 401'd but was sent with an older token than we have now,
      // retry ONCE with the current token instead of starting another refresh.
      const sentHeaderValue = readHeader(config.headers, headerName);
      const formattedCurrent = currentAccessToken ? headerFormat(currentAccessToken) : undefined;

      if (
        status === 401 &&
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
        logger.debug(`401 with stale token; retrying ${config.url ?? ''} with current token`);
        config._authTriedCurrent = true;
        config.headers = setAuthHeader(config.headers, headerName, formattedCurrent!);
        config._sentAccessToken = currentAccessToken;
        return api.request(config);
      }
      // ---------------------------------------------------------------------

      if (!shouldRefresh({ status, config, error })) {
        refreshAttemptCount = 0;
        throw error;
      }

      // Prevent per-request refresh loops
      if (config._authRefreshRetried) {
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
        await terminalAuthLost('no-refresh-token', error);
      }

      // Queue this failed request while we refresh
      const promise = queue(config);

      if (refreshInFlight) {
        logger.debug(`Refresh already in flight; returning queued promise for ${config.url ?? ''}`);
        return promise;
      }

      if (refreshAttemptCount >= maxRetries) {
        await terminalAuthLost('max-retries', error);
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
        if ((e as any)?.response?.status === 401) {
          await terminalAuthLost('refresh-401', e);
        }
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
      if (refreshSubscribers.length) {
        drainFailure(new CanceledError('auth refresher uninstalled'));
      }
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
