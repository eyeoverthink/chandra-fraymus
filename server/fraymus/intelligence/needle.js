// Needle Worker System — GPU inference job queue + worker loop
import { chatOllama } from '../../commerce/shared.js';

export class NeedleQueue {
  constructor(entityStore) {
    this.store = entityStore;
  }

  async enqueueJob(model, prompt, params = {}) {
    const job = {
      model,
      prompt,
      params: JSON.stringify(params),
      status: 'queued',
      created: new Date().toISOString(),
    };
    if (this.store) {
      return this.store.NexusNeedleJob.create(job);
    }
    return { ...job, id: Date.now().toString(36) };
  }

  async claimJob(workerId) {
    if (!this.store) return null;
    const jobs = await this.store.NexusNeedleJob.filter(
      { status: 'queued' },
      { sort: 'created_date', limit: 1 }
    );
    const job = jobs.items?.[0];
    if (!job) return null;
    await this.store.NexusNeedleJob.update(job.id, {
      status: 'claimed',
      worker: workerId,
      claimed_at: new Date().toISOString(),
    });
    return job;
  }

  async completeJob(jobId, result) {
    if (this.store) {
      await this.store.NexusNeedleJob.update(jobId, {
        status: 'completed',
        result: typeof result === 'string' ? result : JSON.stringify(result),
        completed_at: new Date().toISOString(),
      });
    }
    return { jobId, status: 'completed' };
  }

  async failJob(jobId, error) {
    if (this.store) {
      await this.store.NexusNeedleJob.update(jobId, {
        status: 'failed',
        error: typeof error === 'string' ? error : error.message,
        failed_at: new Date().toISOString(),
      });
    }
    return { jobId, status: 'failed' };
  }

  async getJob(jobId) {
    if (!this.store) return null;
    return this.store.NexusNeedleJob.get(jobId);
  }

  async listJobs(status = null) {
    if (!this.store) return [];
    const filter = status ? { status } : {};
    const result = await this.store.NexusNeedleJob.filter(filter, { sort: '-created_date', limit: 50 });
    return result.items || [];
  }

  async registerWorker(name, capabilities) {
    const worker = {
      name,
      capabilities: JSON.stringify(capabilities),
      status: 'online',
      last_heartbeat: new Date().toISOString(),
    };
    if (this.store) {
      return this.store.NexusNeedleWorker.create(worker);
    }
    return worker;
  }

  async heartbeat(workerId) {
    if (this.store) {
      await this.store.NexusNeedleWorker.update(workerId, {
        last_heartbeat: new Date().toISOString(),
      });
    }
    return { workerId, status: 'alive' };
  }

  async listWorkers() {
    if (!this.store) return [];
    const result = await this.store.NexusNeedleWorker.filter({}, { limit: 50 });
    return result.items || [];
  }
}

const POLL_INTERVAL_IDLE = 3000;
const POLL_INTERVAL_BUSY = 200;

export class NeedleWorker {
  constructor(queue, { name = 'local-gpu', onJobStart, onJobDone, onError } = {}) {
    this.queue = queue;
    this.name = name;
    this.workerId = null;
    this.running = false;
    this.timer = null;
    this.jobsProcessed = 0;
    this.jobsFailed = 0;
    this.currentJob = null;
    this.onJobStart = onJobStart || (() => {});
    this.onJobDone = onJobDone || (() => {});
    this.onError = onError || ((e) => console.error('[Needle Worker]', e.message));
  }

  async start() {
    if (this.running) return { already: true };
    this.running = true;
    const reg = await this.queue.registerWorker(this.name, {
      gpu: true,
      ollama: true,
      models: ['fraynix-dreamer-ultimate:8b', 'fraynix-dreamer-ultimate:3b'],
    });
    this.workerId = reg.id || this.name;
    this._schedule(100);
    return { started: true, workerId: this.workerId };
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return {
      stopped: true,
      processed: this.jobsProcessed,
      failed: this.jobsFailed,
    };
  }

  status() {
    return {
      running: this.running,
      workerId: this.workerId,
      jobsProcessed: this.jobsProcessed,
      jobsFailed: this.jobsFailed,
      currentJob: this.currentJob ? { id: this.currentJob.id, model: this.currentJob.model } : null,
    };
  }

  _schedule(delay) {
    if (!this.running) return;
    this.timer = setTimeout(() => this._poll(), delay);
  }

  async _poll() {
    if (!this.running) return;
    try {
      const job = await this.queue.claimJob(this.workerId);
      if (!job) {
        this._schedule(POLL_INTERVAL_IDLE);
        return;
      }
      this.currentJob = job;
      this.onJobStart(job);
      await this._executeJob(job);
      this._schedule(POLL_INTERVAL_BUSY);
    } catch (err) {
      this.onError(err);
      this._schedule(POLL_INTERVAL_IDLE);
    }
  }

  async _executeJob(job) {
    const started = Date.now();
    try {
      const params = typeof job.params === 'string' ? JSON.parse(job.params) : (job.params || {});
      const model = job.model || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';
      const messages = [{ role: 'user', content: job.prompt }];
      if (params.system) {
        messages.unshift({ role: 'system', content: params.system });
      }

      const response = await chatOllama(messages, {
        model,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const result = {
        response,
        model,
        durationMs: Date.now() - started,
        worker: this.workerId,
      };
      await this.queue.completeJob(job.id, result);
      this.jobsProcessed++;
      this.currentJob = null;
      this.onJobDone(job, result);
    } catch (err) {
      await this.queue.failJob(job.id, err).catch(() => {});
      this.jobsFailed++;
      this.currentJob = null;
      this.onError(err);
    }
  }
}
