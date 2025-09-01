# token-refresh

Lightweight, framework-agnostic Axios token refresh helper.

## Installation

```bash
npm install token-refresh
# or
yarn add token-refresh
```

## Usage

1) Create your Axios client

```ts
import axios from 'axios';
export const api = axios.create({ baseURL: '/api' });
```

2) Provide storage + refresh API

```ts
// must return { accessToken, refreshToken, ... } shaped as your AuthTokens
const tokenStorage = {
  async getTokens() { /* read from memory/secure storage */ },
  async setTokens(tokens) { /* persist tokens */ },
};

// IMPORTANT: avoid refresh loops — use a separate client OR set skipAuthRefresh: true
const refreshApi = {
  async refreshTokens(refreshToken: string) {
    // using the same client is OK if you set skipAuthRefresh
    const res = await api.post('/auth/refresh', { refreshToken }, { skipAuthRefresh: true });
    return res.data; // <- AuthTokens
  },
  // optional
  async logout() { /* server-side logout if needed */ }
};
```

3) Install the refresher

```ts
import { createAuthTokenRefresher, setAuthHeaders } from 'token-refresh';

const { eject } = createAuthTokenRefresher(refreshApi, tokenStorage, {
  maxRetries: 3,
  refreshTimeout: 10_000,
  onTokenExpired: () => { /* e.g., route to login */ },
  onRefreshFailed: () => { /* e.g., toast */ },
  // customize header if your API doesn't use Authorization: Bearer
  authHeaderName: 'Authorization',
  buildAuthHeaderValue: (t) => `Bearer ${t}`,
})(api);

// optional: seed the default header on app boot
const existing = await tokenStorage.getTokens?.();
if (existing?.accessToken) setAuthHeaders(api, existing.accessToken);
```

When a request fails with a 401 that matches isTokenExpired, the library:
* starts one refresh (single-flight),
* queues all concurrent failed requests,
* updates default auth header,
* retries the queued requests with the new token,
* or drains with an error on failure/timeout/terminal auth loss.

### Options

```ts
createAuthTokenRefresher(refreshApi, tokenStorage, {
  onTokenExpired?: () => void,          // called on terminal auth loss
  onRefreshFailed?: () => void,         // called when a refresh attempt fails
  maxRetries?: number,                  // default 3
  refreshTimeout?: number,              // ms, default 10000
  isTokenExpired?: (err: AxiosError) => boolean, // custom 401 logic
  logger?: { debug(msg), error(msg, err?) },     // plug your logger
  authHeaderName?: string,              // default 'Authorization'
  buildAuthHeaderValue?: (t: string) => string, // default Bearer
});
```

Avoid loops: mark your refresh request with `{ skipAuthRefresh: true }` or use a separate client.

Custom auth header: set `authHeaderName: 'XAuthToken'` and `buildAuthHeaderValue: (t) => t`.

Eject: call eject() to remove the interceptor; queued requests are rejected with a CanceledError.

### API

* createAuthTokenRefresher(refreshApi, tokenStorage, options)(axiosInstance) → { eject() }
* setAuthHeaders(axiosInstance, token | null, name?, build?) — update/remove the instance’s default auth header.
