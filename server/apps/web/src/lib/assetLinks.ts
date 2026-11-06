import { androidApplicationId, storeIds, type Brand } from '@app/shared';

/**
 * Digital Asset Links statements (`/.well-known/assetlinks.json`) that let
 * the Android app open this site's links: one statement per application id,
 * with the certificate fingerprints of every store that publishes it (the
 * Play app signing certificate, the Cafe Bazaar signing key). A store without
 * fingerprints adds nothing; with none at all the list is empty.
 */
export interface AssetLinkStatement {
  relation: ['delegate_permission/common.handle_all_urls'];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
}

export function assetLinks(brand: Brand): AssetLinkStatement[] {
  const byPackage = new Map<string, string[]>();
  for (const store of storeIds) {
    const fingerprints = brand.android?.signingCertSha256?.[store] ?? [];
    const packageName = androidApplicationId(brand, store);
    if (fingerprints.length === 0 || packageName === undefined) continue;
    const list = byPackage.get(packageName) ?? [];
    for (const fingerprint of fingerprints) if (!list.includes(fingerprint)) list.push(fingerprint);
    byPackage.set(packageName, list);
  }
  return [...byPackage].map(([packageName, fingerprints]) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: fingerprints },
  }));
}
