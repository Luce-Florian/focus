import type { FleetBridge } from '../shared/protocol.ts';

declare global {
  interface Window {
    fleet: FleetBridge;
  }
}

export {};
