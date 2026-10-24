import type { PrismaClient } from "@prisma/client";

/**
 * End-to-end encryption interfaces (Stage 7): defines the data structures and
 * protocols needed for E2EE, even though the actual encryption implementation
 * is deferred to a future stage.
 *
 * Signal Protocol basics:
 * - Each device has an Ed25519 identity key pair (signing) and X25519 ratchet key pair (encryption)
 * - Conversations use a shared secret derived via X3DHHK (triple Diffie-Hellman)
 * - Messages are encrypted with AES-256-GCM using a chain of ratchet keys
 * - The server never sees plaintext or the private keys
 *
 * This module defines the interfaces for:
 * - Device key registration and retrieval
 * - Pre-key bundles (for asynchronous key exchange)
 * - Session establishment
 * - Encrypted message payload structure
 */

/**
 * A device's public key bundle. The server stores these so other devices can
 * fetch them when establishing a session. The private keys never leave the device.
 */
export interface DeviceKeyBundle {
  deviceId: string;
  userId: string;
  /** Ed25519 public key for signing (identity key). */
  identityKey: Uint8Array;
  /** X25519 public key for encryption (ratchet key). */
  ratchetKey: Uint8Array;
  /** Signed pre-key: ratchet key signed by identity key, proves ownership. */
  signedPreKey: {
    key: Uint8Array;
    signature: Uint8Array;
  };
  /** One-time pre-keys for asynchronous key exchange (Signal's "pre-key bundle"). */
  preKeys: Array<{
    id: number;
    key: Uint8Array;
  }>;
  /** Timestamp when this bundle was generated. */
  timestamp: number;
}

/**
 * Encrypted message payload. The server stores and forwards this blob without
 * being able to read the content. Clients decrypt using their session keys.
 */
export interface EncryptedMessagePayload {
  /** Version of the encryption protocol (for future upgrades). */
  version: number;
  /** Sender's device ID (so recipient knows which session to use). */
  senderDeviceId: string;
  /** Recipient's device ID (for multi-device scenarios). */
  recipientDeviceId: string;
  /** Ratchet key used for this message (part of the double ratchet). */
  ratchetKey: Uint8Array;
  /** AES-256-GCM ciphertext of the message body. */
  ciphertext: Uint8Array;
  /** GCM authentication tag. */
  authTag: Uint8Array;
  /** Initialization vector (unique per message). */
  iv: Uint8Array;
  /** Counter for message ordering within the ratchet chain. */
  counter: number;
}

/**
 * Session establishment request. When Alice wants to message Bob for the first
 * time, she fetches Bob's pre-key bundle and sends this request to establish
 * a shared secret via X3DH (triple Diffie-Hellman).
 */
export interface SessionEstablishmentRequest {
  /** Alice's device ID. */
  senderDeviceId: string;
  /** Bob's device ID. */
  recipientDeviceId: string;
  /** Alice's identity key (so Bob can verify the signature). */
  senderIdentityKey: Uint8Array;
  /** Alice's base key (ephemeral ratchet key for this session). */
  senderBaseKey: Uint8Array;
  /** ID of the pre-key Alice used from Bob's bundle. */
  usedPreKeyId: number;
  /** Alice's signature over the key exchange, proving identity. */
  signature: Uint8Array;
  /** Encrypted first message (sent along with the key exchange). */
  initialMessage: EncryptedMessagePayload;
}

/**
 * Key verification state. Users can verify each other's keys (e.g., by comparing
 * safety numbers or scanning QR codes) to detect MITM attacks.
 */
export interface KeyVerificationState {
  /** The two devices being verified. */
  deviceIdA: string;
  deviceIdB: string;
  /** Safety number (fingerprint of both identity keys). */
  safetyNumber: string;
  /** Whether both users have confirmed the safety number matches. */
  verified: boolean;
  /** When the verification was completed. */
  verifiedAt: Date | null;
}

/**
 * E2EE service interface. Implementations handle key management, session
 * establishment, and message encryption/decryption. The server-side implementation
 * only stores and forwards key bundles and encrypted payloads — it never has
 * access to private keys or plaintext.
 */
export interface E2EEService {
  /**
   * Register a device's public key bundle. Called when a device is first set up
   * or when it rotates its keys.
   */
  registerKeyBundle(userId: string, deviceId: string, bundle: DeviceKeyBundle): Promise<void>;

  /**
   * Fetch a device's public key bundle. Called when establishing a new session
   * with a device for the first time.
   */
  getKeyBundle(deviceId: string): Promise<DeviceKeyBundle | null>;

  /**
   * Fetch all key bundles for a user's devices. Used when sending to a user
   * with multiple devices.
   */
  getUserKeyBundles(userId: string): Promise<DeviceKeyBundle[]>;

  /**
   * Store a session establishment request. The recipient's device will fetch
   * this on next connect and use it to derive the shared secret.
   */
  storeSessionRequest(request: SessionEstablishmentRequest): Promise<void>;

  /**
   * Fetch pending session requests for a device. Called on device connect to
   * establish sessions with devices that messaged while offline.
   */
  fetchPendingSessionRequests(deviceId: string): Promise<SessionEstablishmentRequest[]>;

  /**
   * Mark a session request as processed. Called after the recipient's device
   * has successfully derived the shared secret.
   */
  markSessionRequestProcessed(requestId: string): Promise<void>;

  /**
   * Record a key verification between two devices.
   */
  recordKeyVerification(verification: KeyVerificationState): Promise<void>;

  /**
   * Check if two devices have verified keys.
   */
  isKeyVerified(deviceIdA: string, deviceIdB: string): Promise<boolean>;
}

/**
 * Server-side E2EE service implementation. Stores key bundles and session
 * requests in the database. Never has access to private keys.
 */
export class ServerSideE2EEService implements E2EEService {
  constructor(private readonly db: PrismaClient) {}

  async registerKeyBundle(userId: string, deviceId: string, bundle: DeviceKeyBundle): Promise<void> {
    // In a real implementation, this would store the key bundle in a dedicated table.
    // For now, we just update the device's publicKey field (which already exists).
    await this.db.device.update({
      where: { id: deviceId },
      data: { publicKey: Buffer.from(bundle.identityKey) },
    });
  }

  async getKeyBundle(deviceId: string): Promise<DeviceKeyBundle | null> {
    const device = await this.db.device.findUnique({
      where: { id: deviceId },
      select: { id: true, userId: true, publicKey: true },
    });
    if (!device?.publicKey) return null;

    // In a real implementation, this would fetch the full bundle from a dedicated table.
    // For now, we return a minimal bundle with just the identity key.
    return {
      deviceId: device.id,
      userId: device.userId,
      identityKey: new Uint8Array(device.publicKey),
      ratchetKey: new Uint8Array(device.publicKey), // Placeholder
      signedPreKey: { key: new Uint8Array(device.publicKey), signature: new Uint8Array(64) },
      preKeys: [],
      timestamp: Date.now(),
    };
  }

  async getUserKeyBundles(userId: string): Promise<DeviceKeyBundle[]> {
    const devices = await this.db.device.findMany({
      where: { userId, status: "ACTIVE", publicKey: { not: null } },
      select: { id: true, userId: true, publicKey: true },
    });

    return devices
      .filter((d) => d.publicKey !== null)
      .map((d) => ({
        deviceId: d.id,
        userId: d.userId,
        identityKey: new Uint8Array(d.publicKey!),
        ratchetKey: new Uint8Array(d.publicKey!),
        signedPreKey: { key: new Uint8Array(d.publicKey!), signature: new Uint8Array(64) },
        preKeys: [],
        timestamp: Date.now(),
      }));
  }

  async storeSessionRequest(request: SessionEstablishmentRequest): Promise<void> {
    // In a real implementation, this would store the request in a dedicated table.
    // For now, this is a placeholder.
    console.log("[E2EE] Session request stored (placeholder)");
  }

  async fetchPendingSessionRequests(deviceId: string): Promise<SessionEstablishmentRequest[]> {
    // Placeholder implementation
    return [];
  }

  async markSessionRequestProcessed(requestId: string): Promise<void> {
    // Placeholder implementation
    console.log(`[E2EE] Session request ${requestId} marked as processed (placeholder)`);
  }

  async recordKeyVerification(verification: KeyVerificationState): Promise<void> {
    // Placeholder implementation
    console.log("[E2EE] Key verification recorded (placeholder)");
  }

  async isKeyVerified(deviceIdA: string, deviceIdB: string): Promise<boolean> {
    // Placeholder implementation
    return false;
  }
}

/**
 * Encrypted message body. This is what gets encrypted and stored in the
 * Message.body field when E2EE is enabled for a conversation.
 */
export interface EncryptedMessageBody {
  /** The encrypted payload. */
  payload: EncryptedMessagePayload;
  /** Base64-encoded ciphertext for storage in the database. */
  encoded: string;
}

/**
 * Encrypt a message body for a specific recipient device. This is a placeholder
 * that shows the interface — the actual encryption would use the Signal Protocol
 * or a similar ratchet-based protocol.
 */
export function encryptMessage(
  _plaintext: string,
  _senderDeviceId: string,
  _recipientDeviceId: string,
  _sessionKey: Uint8Array,
): EncryptedMessageBody {
  // Placeholder: in a real implementation, this would perform actual encryption.
  // For now, we just return the plaintext as-is (no encryption).
  const payload: EncryptedMessagePayload = {
    version: 1,
    senderDeviceId: _senderDeviceId,
    recipientDeviceId: _recipientDeviceId,
    ratchetKey: new Uint8Array(32),
    ciphertext: new TextEncoder().encode(_plaintext),
    authTag: new Uint8Array(16),
    iv: new Uint8Array(12),
    counter: 0,
  };

  return {
    payload,
    encoded: Buffer.from(JSON.stringify(payload)).toString("base64"),
  };
}

/**
 * Decrypt a message body. This is a placeholder that shows the interface —
 * the actual decryption would use the Signal Protocol or a similar ratchet-based
 * protocol.
 */
export function decryptMessage(
  _encoded: string,
  _sessionKey: Uint8Array,
): string {
  // Placeholder: in a real implementation, this would perform actual decryption.
  // For now, we just decode the base64 and extract the plaintext.
  const payload = JSON.parse(Buffer.from(_encoded, "base64").toString()) as EncryptedMessagePayload;
  return new TextDecoder().decode(payload.ciphertext);
}
