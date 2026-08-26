import axios from 'axios';

// Relative paths with no baseURL: in production one process serves the API and
// this bundle, and in dev Vite proxies /api to :3000. Either way it's
// same-origin, which is what lets the session cookie ride along.
const api = axios.create({ withCredentials: true });

// Turn an axios failure into the string the server actually wrote, so a page
// can render the reason instead of "Request failed with status code 409".
export function errorMessage(err, fallback = 'Something went wrong.') {
  return err?.response?.data?.error || err?.message || fallback;
}

// Field-keyed validation errors, when the server sent them.
export function fieldErrors(err) {
  const e = err?.response?.data?.errors;
  return e && typeof e === 'object' ? e : {};
}

export default api;
