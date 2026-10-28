// Sovereign Motor Dispatcher — cross-node task routing
// Source: Creator Nexus motorDispatcher.js (618 lines)
import { COMPUTE_NODES } from '../core/constants.js';

export const JOB_STATES = ['queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'];

export function selectNode(job) {
  if (job.requires_gpu) return 'WINDOWS_GPU';
  if (job.requires_github) return 'GITHUB';
  if (job.requires_vps) return 'VPS_HOSTINGER';
  return 'BASE44_CLOUD';
}

export class MotorDispatcher {
  constructor(entityStore) {
    this.store = entityStore;
    this.watchers = [];
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
}
