// OpenClaw Gateway — central API with 20+ actions
// Source: Creator Nexus openclawGateway.ts (1176 lines)

export const GATEWAY_ACTIONS = [
  'status',
  'dispatch_task',
  'opeg_verify',
  'export_gpu_training_bundle',
  'execute_native_skill',
  'hermes_fleet_manifest',
  'run_coherence_teamwork_assay',
  'v16_visitor_relay',
  'control_plane_registry',
  'control_plane_enroll',
  'ambassador_greet',
  'spawn_dual_site_subagents',
  'absorb_all_continuity',
  'orifice_spec',
  'orifice_ping',
  'orifice_absorb',
  'orifice_tx_queue',
  'orifice_peer_bridge',
  'orifice_github_sync',
  'dispatch_route_task',
  'list_dispatch_jobs',
  'claim_dispatch_job',
  'complete_dispatch_job',
];

export class OpenClawGateway {
  constructor({ hermes, motor, ouroboros, controlPlane, bridge, entityStore }) {
    this.hermes = hermes;
    this.motor = motor;
    this.ouroboros = ouroboros;
    this.controlPlane = controlPlane;
    this.bridge = bridge;
    this.store = entityStore;
  }

  async handle(action, params = {}) {
    if (!GATEWAY_ACTIONS.includes(action)) {
      return { error: `Unknown action: ${action}`, available: GATEWAY_ACTIONS };
    }

    switch (action) {
      case 'status':
        return this.status();
      case 'dispatch_task':
        return this.motor?.dispatch(params);
      case 'execute_native_skill':
        return this.hermes?.execute(params.skill, params);
      case 'hermes_fleet_manifest':
        return this.hermes?.manifest();
      case 'list_dispatch_jobs':
        return this.motor?.listJobs(params.status);
      case 'claim_dispatch_job':
        return this.motor?.claim(params.job_id, params.worker_id);
      case 'complete_dispatch_job':
        return this.motor?.complete(params.job_id, params.result);
      case 'orifice_ping':
        return this.bridge?.ping();
      case 'orifice_absorb':
        return this.bridge?.absorb(params);
      default:
        return { action, status: 'not_implemented', params };
    }
  }

  status() {
    return {
      gateway: 'openclaw',
      version: '1.0',
      actions: GATEWAY_ACTIONS,
      hermes: !!this.hermes,
      motor: !!this.motor,
      ouroboros: !!this.ouroboros,
      bridge: !!this.bridge,
      timestamp: new Date().toISOString(),
    };
  }
}
