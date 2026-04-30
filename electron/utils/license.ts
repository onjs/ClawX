import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { machineIdSync } from 'node-machine-id';

const LICENSE_FILE_NAME = 'clawx-license.json';
const LICENSE_CODE_PREFIX = 'CLX1';
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAaJZrQEftWQP+qBczq1yHnRBuF86fOk6NpBKZA5PcTkE=
-----END PUBLIC KEY-----`;

const isE2EMode = process.env.CLAWX_E2E === '1';
const e2eEnableActivation = process.env.CLAWX_E2E_ENABLE_ACTIVATION === '1';

export type LicenseFailureReason =
  | 'missing'
  | 'invalid-format'
  | 'decode-failed'
  | 'invalid-signature'
  | 'not-yet-valid'
  | 'expired'
  | 'device-mismatch'
  | 'storage-error';

export interface LicenseStatus {
  activated: boolean;
  reason?: LicenseFailureReason | 'e2e-bypass';
  message?: string;
  expiresAtMs?: number;
  activatedAtMs?: number;
}

interface LicensePayload {
  v: number;
  nbf: number;
  code_exp: number;
  app_exp?: number;
}

interface StoredLicenseRecord {
  version: 1;
  code: string;
  boundDeviceDigest: string;
  activatedAtMs: number;
  appExpiresAtMs?: number;
}

interface SafeEnvelope {
  version: 1;
  alg: 'safeStorage';
  payload: string;
}

interface AesEnvelope {
  version: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  payload: string;
}

type StoredLicenseEnvelope = SafeEnvelope | AesEnvelope;

interface ParseSuccess {
  ok: true;
  payload: LicensePayload;
  normalizedCode: string;
}

interface ParseFailure {
  ok: false;
  reason: LicenseFailureReason;
  message: string;
}

type ParseResult = ParseSuccess | ParseFailure;

function shouldBypassActivationForE2E(): boolean {
  return isE2EMode && !e2eEnableActivation;
}

function nowMs(): number {
  return Date.now();
}

function base64UrlToBuffer(input: string): Buffer {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

function bufferToBase64Url(input: Buffer): string {
  return input.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function getLicenseFilePath(): string {
  return join(app.getPath('userData'), LICENSE_FILE_NAME);
}

function createFailure(reason: LicenseFailureReason, _message: string): ParseFailure {
  return { ok: false, reason, message: 'Invalid activation code.' };
}

function isValidPayload(payload: unknown): payload is LicensePayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<LicensePayload>;
  if (
    candidate.v !== 1
    || !Number.isFinite(candidate.nbf)
    || !Number.isFinite(candidate.code_exp)
    || typeof candidate.nbf !== 'number'
    || typeof candidate.code_exp !== 'number'
    || candidate.code_exp <= candidate.nbf
  ) {
    return false;
  }
  if (candidate.app_exp !== undefined) {
    if (typeof candidate.app_exp !== 'number' || !Number.isFinite(candidate.app_exp)) {
      return false;
    }
  }
  return true;
}

function parseAndVerifyLicenseCode(
  code: string,
  atMs = nowMs(),
  skipExpirationCheck = false
): ParseResult {
  const normalizedCode = code.trim();
  if (!normalizedCode) {
    return createFailure('invalid-format', 'Activation code is empty.');
  }

  const parts = normalizedCode.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_CODE_PREFIX) {
    return createFailure('invalid-format', 'Activation code format is invalid.');
  }

  const payloadB64 = parts[1];
  const signatureB64 = parts[2];
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(base64UrlToBuffer(payloadB64).toString('utf8'));
  } catch {
    return createFailure('decode-failed', 'Activation code payload cannot be decoded.');
  }

  if (!isValidPayload(payloadJson)) {
    return createFailure('decode-failed', 'Activation code payload is malformed.');
  }

  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
  let signature: Buffer;
  try {
    signature = base64UrlToBuffer(signatureB64);
  } catch {
    return createFailure('invalid-format', 'Activation code signature format is invalid.');
  }

  const verified = crypto.verify(
    null,
    signingInput,
    crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM),
    signature,
  );
  if (!verified) {
    return createFailure('invalid-signature', 'Activation code signature verification failed.');
  }

  if (!skipExpirationCheck) {
    if (atMs < payloadJson.nbf) {
      return createFailure('not-yet-valid', 'Activation code is not yet valid.');
    }
    if (atMs > payloadJson.code_exp) {
      return createFailure('expired', 'Activation code has expired.');
    }
  }

  return {
    ok: true,
    payload: payloadJson,
    normalizedCode,
  };
}

function getDeviceBindingDigest(): string {
  let machineId = '';
  try {
    machineId = machineIdSync();
  } catch {
    machineId = app.getPath('home');
  }
  const seed = `${machineId}|${process.platform}|${process.arch}`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function deriveAesKey(deviceDigest: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(`clawx-offline-license|${deviceDigest}`)
    .digest();
}

function encryptRecord(record: StoredLicenseRecord, deviceDigest: string): StoredLicenseEnvelope {
  const serialized = JSON.stringify(record);
  if (safeStorage.isEncryptionAvailable()) {
    return {
      version: 1,
      alg: 'safeStorage',
      payload: safeStorage.encryptString(serialized).toString('base64'),
    };
  }

  const key = deriveAesKey(deviceDigest);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: 'aes-256-gcm',
    iv: bufferToBase64Url(iv),
    tag: bufferToBase64Url(tag),
    payload: bufferToBase64Url(encrypted),
  };
}

function decryptRecord(envelope: StoredLicenseEnvelope, deviceDigest: string): StoredLicenseRecord | null {
  try {
    let plainText = '';
    if (envelope.alg === 'safeStorage') {
      plainText = safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
    } else {
      const key = deriveAesKey(deviceDigest);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        base64UrlToBuffer(envelope.iv),
      );
      decipher.setAuthTag(base64UrlToBuffer(envelope.tag));
      plainText = Buffer.concat([
        decipher.update(base64UrlToBuffer(envelope.payload)),
        decipher.final(),
      ]).toString('utf8');
    }

    const parsed = JSON.parse(plainText) as Partial<StoredLicenseRecord>;
    if (
      parsed.version !== 1
      || typeof parsed.code !== 'string'
      || typeof parsed.boundDeviceDigest !== 'string'
      || typeof parsed.activatedAtMs !== 'number'
    ) {
      return null;
    }
    if (parsed.appExpiresAtMs != null) {
      if (typeof parsed.appExpiresAtMs !== 'number' || !Number.isFinite(parsed.appExpiresAtMs)) {
        return null;
      }
    }
    return parsed as StoredLicenseRecord;
  } catch {
    return null;
  }
}

async function readEnvelope(): Promise<StoredLicenseEnvelope | null> {
  try {
    const raw = await readFile(getLicenseFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredLicenseEnvelope>;
    if (
      parsed.version !== 1
      || typeof parsed.alg !== 'string'
      || typeof parsed.payload !== 'string'
    ) {
      return null;
    }
    if (parsed.alg === 'safeStorage') {
      return parsed as SafeEnvelope;
    }
    if (
      parsed.alg === 'aes-256-gcm'
      && typeof parsed.iv === 'string'
      && typeof parsed.tag === 'string'
    ) {
      return parsed as AesEnvelope;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

async function writeEnvelope(envelope: StoredLicenseEnvelope): Promise<void> {
  await writeFile(getLicenseFilePath(), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  if (shouldBypassActivationForE2E()) {
    return { activated: true, reason: 'e2e-bypass' };
  }

  const envelope = await readEnvelope();
  if (!envelope) {
    return {
      activated: false,
      reason: 'missing',
      message: 'Activation record not found.',
    };
  }

  const deviceDigest = getDeviceBindingDigest();
  const record = decryptRecord(envelope, deviceDigest);
  if (!record) {
    return {
      activated: false,
      reason: 'storage-error',
      message: 'Activation record is unreadable.',
    };
  }

  if (record.boundDeviceDigest !== deviceDigest) {
    return {
      activated: false,
      reason: 'device-mismatch',
      message: 'Activation record does not match this device.',
    };
  }

  const verify = parseAndVerifyLicenseCode(record.code, nowMs(), true);

  if (!verify.ok) {
    return {
      activated: false,
      reason: verify.reason,
      message: verify.message,
    };
  }

  if (record.appExpiresAtMs !== undefined && nowMs() > record.appExpiresAtMs) {
    return {
      activated: false,
      reason: 'expired',
      message: 'Application activation has expired.',
      activatedAtMs: record.activatedAtMs,
      expiresAtMs: record.appExpiresAtMs,
    };
  }

  return {
    activated: true,
    activatedAtMs: record.activatedAtMs,
    expiresAtMs: record.appExpiresAtMs,
  };
}

export async function activateLicenseCode(code: string): Promise<LicenseStatus> {
  if (shouldBypassActivationForE2E()) {
    return { activated: true, reason: 'e2e-bypass' };
  }

  const verify = parseAndVerifyLicenseCode(code);
  if (!verify.ok) {
    return {
      activated: false,
      reason: verify.reason,
      message: verify.message,
    };
  }

  const deviceDigest = getDeviceBindingDigest();
  const record: StoredLicenseRecord = {
    version: 1,
    code: verify.normalizedCode,
    boundDeviceDigest: deviceDigest,
    activatedAtMs: nowMs(),
    appExpiresAtMs: verify.payload.app_exp,
  };

  try {
    await writeEnvelope(encryptRecord(record, deviceDigest));
  } catch {
    return {
      activated: false,
      reason: 'storage-error',
      message: 'Failed to persist activation record.',
    };
  }

  return {
    activated: true,
    activatedAtMs: record.activatedAtMs,
    expiresAtMs: record.appExpiresAtMs,
  };
}
