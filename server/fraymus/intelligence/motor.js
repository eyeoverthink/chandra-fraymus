// Sovereign Motor Dispatcher — cross-node task routing with live connections
import { execSync } from 'node:child_process';
import { COMPUTE_NODES } from '../core/constants.js';
import { chatOllama } from '../../commerce/shared.js';

export const JOB_STATES = ['queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'];

export function selectNode(job) {
  if (job.requires_gpu) return 'WINDOWS_GPU';
  if (job.requires_github) return 'GITHUB';
  if (job.requires_vps) return 'VPS_HOSTINGER';
  return 'BASE44_CLOUD';
}

const NODE_EXECUTORS = {
  async WINDOWS_GPU(job) {
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    if (job.type === 'inference' || job.prompt) {
      const model = job.model || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';
      const messages = [{ role: 'user', content: job.prompt || job.command }];
      if (job.system) messages.unshift({ role: 'system', content: job.system });
      const response = await chatOllama(messages, { model, temperature: job.temperature });
      return { response, model, node: 'WINDOWS_GPU', ollamaUrl };
    }
    if (job.type === 'ollama_api') {
      const res = await fetch(`${ollamaUrl}${job.endpoint || '/api/tags'}`, {
        method: job.method || 'GET',
        headers: { 'Content-Type': 'application/json' },
        body: job.body ? JSON.stringify(job.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, data: await res.json(), node: 'WINDOWS_GPU' };
    }
    throw new Error(`WINDOWS_GPU: unsupported job type '${job.type || 'none'}'`);
  },

  async VPS_HOSTINGER(job) {
    const host = process.env.VPS_HOST || 'srv1944678.hstgr.cloud';
    const user = process.env.VPS_USER || 'root';
    const command = job.command || job.prompt;
    if (!command) throw new Error('VPS_HOSTINGER: command required');
    const sshCmd = `ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new ${user}@${host} ${JSON.stringify(command)}`;
    const output = execSync(sshCmd, { timeout: 60_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    return { output: output.trim(), node: 'VPS_HOSTINGER', host };
  },

  async GITHUB(job) {
    const command = job.command || job.prompt;
    if (!command) throw new Error('GITHUB: command required');
    const allowed = ['git', 'gh', 'npm', 'node'];
    const bin = command.split(/\s+/)[0];
    if (!allowed.includes(bin)) throw new Error(`GITHUB: '${bin}' not in allowed commands`);
    const output = execSync(command, {
      timeout: 120_000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      cwd: process.env.FRAYMUS_WORKSPACE || process.cwd(),
    });
    return { output: output.trim(), node: 'GITHUB' };
  },

  async BASE44_CLOUD(job) {
    if (job.prompt) {
      const model = job.model || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';
      const messages = [{ role: 'user', content: job.prompt }];
      const response = await chatOllama(messages, { model });
      return { response, model, node: 'BASE44_CLOUD' };
    }
    return { node: 'BASE44_CLOUD', note: 'Entity CRUD — use entityStore directly' };
  },
};

export class MotorDispatcher {
  constructor(entityStore) {
    this.store = entityStore;
    this.watchers = [];
    this.dispatchCount = 0;
  }

  async dispatch(job) {
    const node = selectNode(job);
    const record = {
      job_id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36),
      ...job,
      node,
      status: 'queued',
      created: new Date().toISOString(),
    };
    if (this.store) {
      await this.store.NexusDispatchJob.create(record);
    }
    return record;
  }

  async execute(job) {
    const node = job.node || selectNode(job);
    const executor = NODE_EXECUTORS[node];
    if (!executor) throw new Error(`No executor for node '${node}'`);
    const record = await this.dispatch({ ...job, node });
    const jobId = record.job_id || record.id;
    try {
      await this.claim(jobId, `motor-${node}`);
      const started = Date.now();
      const result = await executor(job);
      result.durationMs = Date.now() - started;
      await this.complete(jobId, result);
      this.dispatchCount++;
      return { jobId, status: 'completed', node, result };
    } catch (err) {
      await this.fail(jobId, err);
      return { jobId, status: 'failed', node, error: err.message };
    }
  }

  async claim(jobId, workerId) {
    if (this.store) {
      await this.store.NexusDispatchJob.update(jobId, {
        status: 'claimed',
        worker: workerId,
        claimed_at: new Date().toISOString(),
      });
    }
    return { jobId, status: 'claimed', worker: workerId };
  }

  async complete(jobId, result) {
    if (this.store) {
      await this.store.NexusDispatchJob.update(jobId, {
        status: 'completed',
        result: JSON.stringify(result),
        completed_at: new Date().toISOString(),
      });
    }
    return { jobId, status: 'completed' };
  }

  async fail(jobId, error) {
    if (this.store) {
      await this.store.NexusDispatchJob.update(jobId, {
        status: 'failed',
        error: typeof error === 'string' ? error : error.message,
        failed_at: new Date().toISOString(),
      });
    }
    return { jobId, status: 'failed' };
  }

  async listJobs(status = null) {
    if (!this.store) return [];
    const filter = status ? { status } : {};
    const result = await this.store.NexusDispatchJob.filter(filter, { sort: '-created_date', limit: 50 });
    return result.items || [];
  }

  async nodeHealth() {
    const results = {};
    for (const [name, meta] of Object.entries(COMPUTE_NODES)) {
      try {
        if (name === 'WINDOWS_GPU') {
          const url = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
          const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
          const data = await res.json();
          results[name] = { status: 'online', models: (data.models || []).length, ...meta };
        } else if (name === 'VPS_HOSTINGER') {
          const host = process.env.VPS_HOST || 'srv1944678.hstgr.cloud';
          const user = process.env.VPS_USER || 'root';
          const out = execSync(`ssh -o ConnectTimeout=5 ${user}@${host} echo ok`, {
            timeout: 10_000, encoding: 'utf8',
          });
          results[name] = { status: out.trim() === 'ok' ? 'online' : 'degraded', ...meta };
        } else if (name === 'GITHUB') {
          const out = execSync('git rev-parse --is-inside-work-tree 2>&1', {
            timeout: 5_000, encoding: 'utf8',
          });
          results[name] = { status: out.trim() === 'true' ? 'online' : 'offline', ...meta };
        } else {
          results[name] = { status: 'available', ...meta };
        }
      } catch {
        results[name] = { status: 'offline', ...meta };
      }
    }
    return results;
  }

  status() {
    return {
      dispatchCount: this.dispatchCount,
      nodes: Object.keys(COMPUTE_NODES),
    };
  }
}
