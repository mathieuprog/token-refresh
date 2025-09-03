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
  }
}

// Custom error for timeout (nice for analytics)
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

// Mutate-in-place header setter
function setAuthHeader(headers: any, name: string, value: string) {
  if (!headers) return { [name]: value };
  if (typeof headers.set === 'function') headers.set(name, value);
  else headers[name] = value;
  return headers;
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

// Logger defaults quiet in production (library-friendly)
const defaultLogger = {
  debug: () => {}, // no-op by default
  error: () => {}, // no-op by default
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
    refreshTimeout = 10000,
    logger = defaultLogger,
    logout,
  } = options;

  const headerName = header.name || 'Authorization';
  const headerFormat = header.format || ((t: string) => `Bearer ${t}`);

  const drainSuccess = (newToken: string) => {
    const headerValue = headerFormat(newToken);
    refreshSubscribers.forEach(({ resolve, reject, config }) => {
      if (config.signal?.aborted) {
        reject(new CanceledError('canceled'));
        return;
      }
      config.headers = setAuthHeader(config.headers, headerName, headerValue);
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
    drainFailure(originalError);
    onRefreshFailed?.(originalError);
    setAuthHeaders(api, null, headerName, headerFormat);
    await logout?.().catch(() => {});
    throw originalError;
  };

  const interceptorId = api.interceptors.response.use(
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

      const status = error.response?.status ?? 0;
      if (!shouldRefresh({ status, config, error })) {
        refreshAttemptCount = 0;
        throw error;
      }

      // Prevent infinite refresh loops per request (belt-and-suspenders)
      if (config._authRefreshRetried) {
        // We've already refreshed for this request once; don't do it again
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
      api.interceptors.response.eject(interceptorId);
      if (refreshSubscribers.length) {
        drainFailure(new CanceledError('auth refresher uninstalled'));
      }
      // nullify in-flight refresh for cleaner state
      refreshInFlight = null;
    },
  };
}

export function setAuthHeaders(
  apiInstance: AxiosInstance,
  token: string | null,
  name = 'Authorization',
  build: (t: string) => string = (t) => `Bearer ${t}`
) {
  const headers: any = apiInstance.defaults.headers.common;
  if (typeof headers.set !== 'function' || typeof headers.delete !== 'function') {
    // If someone polyfilled/overrode headers, fallback to object semantics
    if (token) (headers as any)[name] = build(token);
    else delete (headers as any)[name];
    return;
  }
  if (token) headers.set(name, build(token));
  else headers.delete(name);
}
