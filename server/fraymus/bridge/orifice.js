// Orifice Bridge — cross-app continuity capture and relay
// Source: Creator Nexus orificeBridge + FraymusContinuityEntry entity

export class OrificeBridge {
  constructor(entityStore) {
    this.store = entityStore;
    this.buffer = [];
  }

  async capture(entry) {
    const record = {
      source_app: entry.source_app || 'unknown',
      entry_type: entry.entry_type || 'activity',
      payload: typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload),
      delivery_status: 'pending',
      captured_at: new Date().toISOString(),
    };
    this.buffer.push(record);
    if (this.store) {
      return this.store.FraymusContinuityEntry.create(record);
    }
    return record;
  }

  async relay(targetApp) {
    const pending = this.buffer.filter((e) => e.delivery_status === 'pending');
    for (const entry of pending) {
      entry.delivery_status = 'delivered';
      entry.delivered_to = targetApp;
      entry.delivered_at = new Date().toISOString();
    }
    return { delivered: pending.length, target: targetApp };
  }

  async heartbeat() {
    const pending = this.buffer.filter((e) => e.delivery_status === 'pending');
    return {
      bridge: 'orifice',
      pending: pending.length,
      total: this.buffer.length,
      timestamp: new Date().toISOString(),
    };
  }

  ping() {
    return {
      bridge: 'orifice',
      status: 'alive',
      buffer: this.buffer.length,
      timestamp: new Date().toISOString(),
    };
  }

  absorb(entry) {
    return this.capture(entry);
  }
}
