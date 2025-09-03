# token-refresh

Lightweight, framework-agnostic Axios token refresh helper with robust error handling and loop prevention.

## Installation

```bash
npm install token-refresh
# or
yarn add token-refresh
```

## Usage

```ts
import axios from 'axios';
import { installAuthRefresh, setAuthHeaders } from 'token-refresh';

const api = axios.create({ baseURL: '/api' });

// Token storage functions
const getTokens = async () => {
  return JSON.parse(localStorage.getItem('tokens') || 'null');
};

const setTokens = async (tokens) => {
  localStorage.setItem('tokens', JSON.stringify(tokens));
};

const { uninstall } = installAuthRefresh(api, {
  refresh: async (refreshToken) => {
    // IMPORTANT: avoid refresh loops — use a separate client OR set skipAuthRefresh: true
    const res = await api.post('/auth/refresh', { refreshToken }, { skipAuthRefresh: true });
    return res.data; // <- AuthTokens: { accessToken, refreshToken, ... }
  },
  getTokens,
  setTokens,
  shouldRefresh: ({ status, config }) => status === 401 && !config.skipAuthRefresh,
  header: { 
    name: 'Authorization',        // default: 'Authorization'
    format: (t) => `Bearer ${t}`  // default: Bearer format
  },
  onBeforeRefresh: () => {
    // called right before refresh starts
    console.log('Refreshing tokens...');
  },
  onRefreshed: (tokens) => {
    // called after successful refresh with new tokens
    console.log('Tokens refreshed!', tokens);
  },
  onRefreshFailed: (error) => {
    // called when refresh fails - includes the error
    console.error('Refresh failed:', error);
    // e.g., redirect to login
  },
  maxRetries: 3,
  refreshTimeout: 10_000,
  // Enable logging (disabled by default for library usage)
  logger: {
    debug: (msg) => console.log(msg),
    error: (msg, err) => console.error(msg, err),
  },
  logout: async () => {
    // optional server-side logout
    await api.post('/auth/logout', {}, { skipAuthRefresh: true });
  }
});

// Optional: seed the default header on app boot
const existing = await getTokens();
if (existing?.accessToken) {
  setAuthHeaders(api, existing.accessToken);
}

// Clean up when needed (tests, hot reloads, etc.)
// uninstall();
```

## TypeScript Support

```ts
import type { AuthRefreshOptions, AuthTokens } from 'token-refresh';

const options: AuthRefreshOptions = {
  refresh: async (refreshToken: string): Promise<AuthTokens> => {
    // Your refresh implementation
  },
  // ... other options
};
```

## Error Handling

The library includes specific error types for better analytics and debugging:

```ts
import { RefreshTimeoutError } from 'token-refresh';

installAuthRefresh(api, {
  // ... other options
  onRefreshFailed: (error) => {
    if (error instanceof RefreshTimeoutError) {
      // Handle timeout specifically
      analytics.track('auth_refresh_timeout');
    } else {
      // Handle other refresh failures
      analytics.track('auth_refresh_failed', { error: error.message });
    }
  }
});
```

## Robustness Features

### Infinite Loop Prevention
The library prevents infinite refresh loops at multiple levels:
- **Global**: Only one refresh happens at a time across all requests
- **Per-request**: Each individual request can only trigger one refresh attempt

### Request Queuing
Failed requests are queued during refresh and automatically retried with the new token.

### Timeout Protection
Refresh operations have configurable timeouts to prevent hanging requests.

## Custom Header Example

For APIs that don't use `Authorization: Bearer <token>`:

```ts
installAuthRefresh(api, {
  // ... other options
  header: {
    name: 'XAuthToken',
    format: (token) => token  // no "Bearer " prefix
  }
});
```

## How It Works

When a request fails with a condition that matches `shouldRefresh` (default: 401 status + no `skipAuthRefresh` flag), the library:

1. **Loop prevention**: Checks if this specific request already attempted a refresh
2. **Single-flight refresh**: Only one refresh happens at a time, even with concurrent 401s
3. **Request queuing**: Failed requests are queued while refresh is in progress  
4. **Header updates**: Updates the default auth header on the Axios instance
5. **Request retry**: Queued requests are retried with the new token
6. **Error handling**: On failure/timeout/terminal auth loss, queued requests are rejected

## API Reference

### installAuthRefresh(api, options)

**Parameters:**
- `api`: AxiosInstance - The Axios instance to install the interceptor on
- `options`: AuthRefreshOptions

**Returns:** `{ uninstall: () => void }`

### AuthRefreshOptions

```ts
interface AuthRefreshOptions {
  refresh: (refreshToken: string) => Promise<AuthTokens>;
  getTokens: () => Promise<AuthTokens | null>;
  setTokens: (tokens: AuthTokens) => Promise<void>;
  shouldRefresh?: (context: { status: number; config: InternalAxiosRequestConfig; error: AxiosError }) => boolean;
  header?: {
    name?: string;           // default: 'Authorization'
    format?: (token: string) => string; // default: (t) => `Bearer ${t}`
  };
  onBeforeRefresh?: () => void;
  onRefreshed?: (tokens: AuthTokens) => void;
  onRefreshFailed?: (error: unknown) => void;
  maxRetries?: number;       // default: 3
  refreshTimeout?: number;   // ms, default: 10000
  logger?: { debug(msg), error(msg, err?) }; // default: no-op (quiet)
  logout?: () => Promise<void>;
}
```

### RefreshTimeoutError

Custom error thrown when refresh operations timeout. Useful for analytics and specific error handling.

### setAuthHeaders(axiosInstance, token, name?, format?)

Update or remove the instance's default auth header.

## Advanced Usage

### Custom shouldRefresh Logic

```ts
installAuthRefresh(api, {
  // ... other options
  shouldRefresh: ({ status, config, error }) => {
    // Custom logic for when to refresh
    if (config.skipAuthRefresh) return false;
    if (config._authRefreshRetried) return false; // already tried once
    if (status === 401) return true;
    
    // Maybe also refresh on 403 with specific error codes
    const errorCode = error.response?.data?.code;
    return status === 403 && errorCode === 'TOKEN_EXPIRED';
  }
});
```

### Multiple Axios Instances

```ts
const publicApi = axios.create({ baseURL: '/api' });
const protectedApi = axios.create({ baseURL: '/api' });

// Only install on the protected API
installAuthRefresh(protectedApi, {
  refresh: (refreshToken) => publicApi.post('/auth/refresh', { refreshToken }),
  // ... other options
});
```

### Testing & Cleanup

```ts
const { uninstall } = installAuthRefresh(api, options);

// In tests or during hot reloads
afterEach(() => {
  uninstall();
});
```

## TypeScript

The library includes full TypeScript support and augments Axios types to support the `skipAuthRefresh` flag:

```ts
// This is automatically available
api.get('/data', { skipAuthRefresh: true });
```
