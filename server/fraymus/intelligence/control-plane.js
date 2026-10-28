// Control Plane — agent registry, enrollment, and coordination
// Source: Creator Nexus fraymusControlPlane.js (808 lines)
import { AGENTS } from '../core/constants.js';

export class ControlPlane {
  constructor(entityStore) {
    this.store = entityStore;
    this.registry = new Map();
    for (const agent of AGENTS) {
      this.registry.set(agent.name, { ...agent, status: 'offline', enrolled: false });
    }
  }

  enroll(name, identity) {
    const agent = this.registry.get(name);
    if (!agent) return { error: `Unknown agent: ${name}` };
    this.registry.set(name, {
      ...agent,
      enrolled: true,
      status: 'online',
      number: identity.number,
      pubkey: identity.pubkey,
      enrolled_at: new Date().toISOString(),
    });
    return { name, status: 'enrolled', number: identity.number };
  }

  unenroll(name) {
    const agent = this.registry.get(name);
    if (!agent) return { error: `Unknown agent: ${name}` };
    this.registry.set(name, { ...agent, enrolled: false, status: 'offline' });
    return { name, status: 'unenrolled' };
  }

  getAgent(name) {
    return this.registry.get(name) || null;
  }

  listAgents(filter = null) {
    const all = [...this.registry.values()];
    if (filter === 'online') return all.filter((a) => a.status === 'online');
    if (filter === 'enrolled') return all.filter((a) => a.enrolled);
    return all;
  }

  broadcast(message) {
    const online = this.listAgents('online');
    return online.map((a) => ({ name: a.name, number: a.number, delivered: true }));
  }
}
