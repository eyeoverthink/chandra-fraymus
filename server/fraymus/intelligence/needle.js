// Needle Worker System — GPU inference job queue
// Source: Creator Nexus NexusNeedleJob + NexusNeedleWorker entities

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
}
