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
  }
}

interface RefreshTokenApi {
  /**
   * IMPORTANT: Use a separate client or set `skipAuthRefresh: true` on the refresh request
   * to avoid interceptor loops.
   */
  refreshTokens: (refreshToken: string) => Promise<AuthTokens>;
  logout?: () => Promise<void>;
}

interface TokenStorage {
  getTokens: () => Promise<AuthTokens | null>;
  setTokens: (tokens: AuthTokens) => Promise<void>;
}

interface RefresherOptions {
  onTokenExpired?: () => void;
  onRefreshFailed?: () => void;
  maxRetries?: number;
  isTokenExpired?: (error: AxiosError) => boolean;
  logger?: {
    debug: (message: string) => void;
    error: (message: string, error?: unknown) => void;
  };
  refreshTimeout?: number; // ms
  authHeaderName?: string; // default: 'Authorization'
  buildAuthHeaderValue?: (t: string) => string; // default: (t) => `Bearer ${t}`
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

// Timeout helper (no Promise.race footguns)
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Refresh timeout')), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

export function createAuthTokenRefresher(
  refreshApi: RefreshTokenApi,
  tokenStorage: TokenStorage,
  options: RefresherOptions = {}
) {
  let refreshInFlight: Promise<AuthTokens> | null = null;
  let refreshSubscribers: QueuedRequest[] = [];
  let refreshAttemptCount = 0;

  const {
    onTokenExpired: onTokenExpiredCallback,
    onRefreshFailed: onRefreshFailedCallback,
    maxRetries = 3,
    isTokenExpired = defaultIsTokenExpired,
    logger = defaultLogger,
    refreshTimeout = 10000,
    authHeaderName = 'Authorization',
    buildAuthHeaderValue = (t: string) => `Bearer ${t}`,
  } = options;

  const drainSuccess = (newToken: string, apiInstance: AxiosInstance) => {
    const headerValue = buildAuthHeaderValue(newToken);
    refreshSubscribers.forEach(({ resolve, reject, config }) => {
      if (config.signal?.aborted) {
        reject(new CanceledError('canceled'));
        return;
      }
      config.headers = setAuthHeader(config.headers, authHeaderName, headerValue);
      logger.debug(`Executing queued request ${config.url ?? ''} with refreshed token`);
      apiInstance.request(config).then(resolve).catch(reject);
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

    const promise = (async () => {
      try {
        return await withTimeout(refreshApi.refreshTokens(refreshToken), refreshTimeout);
      } finally {
        refreshInFlight = null;
      }
    })();

    refreshInFlight = promise;
    return promise;
  };

  return function setupAuthTokenRefresher(apiInstance: AxiosInstance) {
    const terminalAuthLost = async (reason: string, originalError: unknown): Promise<never> => {
      logger.debug(`Auth lost: ${reason}`);
      refreshAttemptCount = 0;
      drainFailure(originalError);
      onRefreshFailedCallback?.();
      onTokenExpiredCallback?.();
      setAuthHeaders(apiInstance, null, authHeaderName, buildAuthHeaderValue);
      await refreshApi.logout?.().catch(() => {});
      throw originalError;
    };

    const interceptorId = apiInstance.interceptors.response.use(
      (response) => {
        refreshAttemptCount = 0;
        return response;
      },
      async (error: AxiosError) => {
        const { config } = error as AxiosError & { config: InternalAxiosRequestConfig | undefined };

        if (!config || !isTokenExpired(error)) {
          refreshAttemptCount = 0;
          throw error;
        }

        if (config.skipAuthRefresh) {
          throw error;
        }

        logger.debug(`Access token expired for URL: ${config.url ?? ''}`);

        // Get stored tokens
        let storedTokens: AuthTokens | null = null;
        try {
          storedTokens = await tokenStorage.getTokens();
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
          setAuthHeaders(apiInstance, newAccessToken, authHeaderName, buildAuthHeaderValue);

          try {
            // Merge to avoid dropping existing refreshToken if server omits it
            const updatedTokens = { ...storedTokens, ...refreshed };
            await tokenStorage.setTokens(updatedTokens);
          } catch (err) {
            logger.error('Failed to store new tokens:', err);
          }

          refreshAttemptCount = 0;
          drainSuccess(newAccessToken, apiInstance);
        } catch (e) {
          logger.error('Auth token refresher error:', e);
          if ((e as any)?.response?.status === 401) {
            await terminalAuthLost('refresh-401', e);
          }
          drainFailure(e);
          onRefreshFailedCallback?.();
          throw e;
        }

        return promise;
      }
    );

    return {
      eject: () => {
        apiInstance.interceptors.response.eject(interceptorId);
        if (refreshSubscribers.length) {
          drainFailure(new CanceledError('auth refresher ejected'));
        }
      }
    };
  };
}

// 401 matcher (customize via options.isTokenExpired)
function defaultIsTokenExpired(error: AxiosError): boolean {
  const status = error.response?.status;
  if (status !== 401) return false;
  const authHeader = error.response?.headers?.['www-authenticate'];
  if (typeof authHeader === 'string' && /expired|invalid_token/i.test(authHeader)) return true;
  return (error.response?.data as any)?.message === 'Expired JWT Token';
}

const defaultLogger = {
  debug: (message: string) => console.log(message),
  error: (message: string, error?: unknown) => console.error(message, error),
};

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
