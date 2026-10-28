const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const EXECUTION_LABEL = 'io.fraymus.execution';
export const DEFAULT_DOCKER_PATH = process.platform === 'win32'
  ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker';
export function localDockerEndpoint(value) {
  if (['npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine'].includes(value)) return value;
  if (typeof value === 'string' && /^unix:\/\/\/[A-Za-z0-9_./-]+$/.test(value)) {
    const socket = value.slice(7);
    if (socket.startsWith('/') && !socket.startsWith('//') && !socket.split('/').includes('..') && socket !== '/') return value;
  }
  throw new TypeError('An explicit local Docker endpoint is required');
}
export function dockerResourceIdentity(input, executionId, { witnessed = false } = {}) {
  const keys = ['version', 'engine', 'executionId', 'endpoint', 'daemonId', 'name', 'image', ...(input?.containerId !== undefined ? ['containerId'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))
    || !uuid.test(executionId) || input.executionId !== executionId || input.version !== 1 || input.engine !== 'docker'
    || input.name !== 'fraymus-code-' + executionId || typeof input.daemonId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(input.daemonId)
    || typeof input.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.image)
    || witnessed && input.containerId === undefined || input.containerId !== undefined && !/^[a-f0-9]{64}$/.test(input.containerId))
    throw Object.assign(new Error('Exact durable Docker resource identity is required'), { code: 'code_resource_invalid' });
  localDockerEndpoint(input.endpoint);
  return Object.freeze(Object.fromEntries(keys.map(key => [key, input[key]])));
}
