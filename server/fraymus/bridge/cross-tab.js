// Cross-Tab Memory — BroadcastChannel state sync
// Source: Creator Nexus crossTabMemory.js (378 lines)

const CHANNEL_NAME = 'fraymus-cross-tab';

export class CrossTabMemory {
  constructor() {
    this.state = {};
    this.listeners = [];
    this.channel = typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(CHANNEL_NAME)
      : null;
    if (this.channel) {
      this.channel.onmessage = (e) => this._onMessage(e.data);
    }
  }

  set(key, value) {
    this.state[key] = value;
    this._broadcast({ type: 'set', key, value });
  }

  get(key) {
    return this.state[key];
  }

  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  _broadcast(msg) {
    if (this.channel) {
      this.channel.postMessage(msg);
    }
  }

  _onMessage(data) {
    if (data.type === 'set') {
      this.state[data.key] = data.value;
      for (const listener of this.listeners) {
        listener(data.key, data.value);
      }
    }
  }

  close() {
    if (this.channel) this.channel.close();
  }
}
