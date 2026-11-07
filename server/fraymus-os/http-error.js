export function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

export function abortError() {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  error.status = 499;
  return error;
}

export function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}
