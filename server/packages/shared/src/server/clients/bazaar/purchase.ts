import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/**
 * What the app receives from Bazaar for a purchase (Poolakey's
 * `PurchaseInfo.originalJson` and `dataSignature`) and how it is checked,
 * the same way Poolakey 2.3.0 checks it on the device
 * (`security/PurchaseVerifier`): an RSA key from the base64 X.509
 * SubjectPublicKeyInfo Pishkhan shows for the app, `SHA1withRSA` (PKCS #1
 * v1.5) over the UTF-8 bytes of `originalJson`, the signature in base64.
 *
 * `originalJson` is the object Poolakey's `RawDataToPurchaseInfo` reads:
 * `orderId`, `purchaseToken`, `developerPayload`, `packageName`,
 * `purchaseState` (0 purchased, anything else refunded), `purchaseTime`
 * (epoch ms) and `productId`.
 */

export function bazaarPublicKey(base64Der: string): KeyObject {
  const der = Buffer.from(base64Der.replace(/\s+/g, ''), 'base64');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new Error('the Bazaar RSA public key is not a base64 X.509 public key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('the Bazaar public key is not an RSA key');
  return key;
}

/** SHA1withRSA over the UTF-8 bytes of `signedData`; base64 or base64url signature. Never throws. */
export function verifyBazaarSignature(key: KeyObject, signedData: string, signature: string): boolean {
  try {
    const bytes = Buffer.from(signature.replace(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    if (bytes.length === 0) return false;
    return verify('sha1', Buffer.from(signedData, 'utf8'), key, bytes);
  } catch {
    return false;
  }
}

const millis = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,16}$/).transform(Number)]);

const purchaseDataSchema = z.object({
  orderId: z.string().max(200).nullish(),
  purchaseToken: z.string().min(1).max(4096),
  developerPayload: z.string().max(2048).nullish(),
  packageName: z.string().min(1).max(255),
  purchaseState: z.union([z.number().int(), z.string().regex(/^\d{1,3}$/).transform(Number)]).optional(),
  purchaseTime: millis.optional(),
  productId: z.string().min(1).max(200),
});

export interface BazaarPurchaseData {
  orderId: string | null;
  purchaseToken: string;
  developerPayload: string | null;
  packageName: string;
  /** Poolakey reads a missing value as 0 (purchased). */
  refunded: boolean;
  purchaseTimeMs: number | null;
  productId: string;
}

/** Reads `originalJson`; null when it is not the object Poolakey produces. */
export function parseBazaarPurchaseData(originalJson: string): BazaarPurchaseData | null {
  let value: unknown;
  try {
    value = JSON.parse(originalJson);
  } catch {
    return null;
  }
  const parsed = purchaseDataSchema.safeParse(value);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    orderId: p.orderId ? p.orderId : null,
    purchaseToken: p.purchaseToken,
    developerPayload: p.developerPayload ? p.developerPayload : null,
    packageName: p.packageName,
    refunded: (p.purchaseState ?? 0) !== 0,
    purchaseTimeMs: p.purchaseTime && p.purchaseTime > 0 ? p.purchaseTime : null,
    productId: p.productId,
  };
}
