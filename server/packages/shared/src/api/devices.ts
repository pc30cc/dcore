import { z } from 'zod';

/**
 * `PUT /v1/devices/current`: the device comes from the token's `did`.
 * `pushToken: null` says this phone has no push (no Google Play services) or
 * turned it off; the client sends only on a change, or weekly.
 */
export const deviceUpdateSchema = z.object({
  pushToken: z.string().min(1).max(4096).nullable(),
  notificationsEnabled: z.boolean(),
  /** The version name (`1.4.2`); the version code comes from `X-Client`. */
  appVersion: z.string().min(1).max(40),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
});
export type DeviceUpdate = z.infer<typeof deviceUpdateSchema>;
