import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';

export type LicenseFailureReason =
  | 'missing'
  | 'invalid-format'
  | 'decode-failed'
  | 'invalid-signature'
  | 'not-yet-valid'
  | 'expired'
  | 'device-mismatch'
  | 'storage-error'
  | 'e2e-bypass';

interface LicenseStatusResponse {
  activated: boolean;
  reason?: LicenseFailureReason;
  message?: string;
  expiresAtMs?: number;
  activatedAtMs?: number;
}

interface ActivateResponse extends LicenseStatusResponse {
  success: boolean;
}

interface LicenseState {
  initialized: boolean;
  checking: boolean;
  activating: boolean;
  activated: boolean;
  reason: LicenseFailureReason | null;
  error: string | null;
  expiresAtMs: number | null;
  activatedAtMs: number | null;
  init: () => Promise<void>;
  activate: (code: string) => Promise<boolean>;
  clearError: () => void;
}

function applyStatus(
  set: (partial: Partial<LicenseState>) => void,
  status: LicenseStatusResponse,
  extra?: Partial<LicenseState>,
): void {
  set({
    activated: status.activated,
    reason: status.reason ?? null,
    error: status.message ?? null,
    expiresAtMs: status.expiresAtMs ?? null,
    activatedAtMs: status.activatedAtMs ?? null,
    ...extra,
  });
}

export const useLicenseStore = create<LicenseState>((set, get) => ({
  initialized: false,
  checking: false,
  activating: false,
  activated: false,
  reason: null,
  error: null,
  expiresAtMs: null,
  activatedAtMs: null,

  init: async () => {
    if (get().initialized || get().checking) return;
    set({ checking: true, error: null });
    try {
      const status = await hostApiFetch<LicenseStatusResponse>('/api/license/status');
      applyStatus(set, status, { initialized: true, checking: false });
    } catch (error) {
      set({
        initialized: true,
        checking: false,
        activated: false,
        reason: 'storage-error',
        error: String(error),
      });
    }
  },

  activate: async (code: string) => {
    set({ activating: true, error: null });
    try {
      const response = await hostApiFetch<ActivateResponse>('/api/license/activate', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      applyStatus(set, response, { activating: false, initialized: true });
      return response.activated;
    } catch (error) {
      set({
        activating: false,
        activated: false,
        reason: 'storage-error',
        error: String(error),
      });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
