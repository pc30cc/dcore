import { gender, intention, type Locale, type ProfileCard } from '@app/shared';
import { photoVariantUrl, shownDistance, type CardSource, type MediaStore, type PhotoVariantSize, type PublicIds } from '@app/shared/server';
import type { CityIndex } from './cities.js';

/**
 * Someone else's profile card as a viewer receives it, from the cached
 * `profile_card()` JSON (`card:<uid>:<ver>:<catv>`): the public id instead
 * of the raw one, the viewer's rounded distance between cell centres (none
 * when the person hides it), the city's name in the viewer's language, and
 * signed CDN links of the approved photos. The internal `hd` and `so` are
 * read and never sent: no distance with `hd`, no "active recently" without
 * `so`. A photo without a link (no CDN configured) is left out rather than
 * sent without one.
 */

/** Cards are shown full screen: the largest variant. */
export const CARD_PHOTO_SIZE: PhotoVariantSize = 1080;

export interface CardExtras {
  /** km between the two cell centres; absent or null: no distance. */
  km?: number | null | undefined;
  likesYou?: boolean | undefined;
  superliked?: boolean | undefined;
  /** Active in the last day; shown only when the card's owner shows activity. */
  activeRecently?: boolean | undefined;
}

export interface CardRenderer {
  publicIds: PublicIds;
  cities: CityIndex;
  media: Pick<MediaStore, 'urls'> | null;
}

export function renderCard(
  deps: CardRenderer,
  userId: string,
  card: CardSource,
  extras: CardExtras,
  locale: Locale,
  photoSize: PhotoVariantSize = CARD_PHOTO_SIZE,
): ProfileCard {
  const city = card.city !== undefined ? deps.cities.get(card.city) : undefined;
  const photos: ProfileCard['photos'] = [];
  for (const photo of card.photos) {
    const url = deps.media ? photoVariantUrl(deps.media, photo.id, photo.bv, photoSize) : undefined;
    if (!url || photo.w === undefined || photo.h === undefined || photo.w <= 0 || photo.h <= 0) continue;
    photos.push({ id: photo.id, w: photo.w, h: photo.h, blurhash: photo.bh ?? '', url });
  }
  const showDistance = card.hd !== true && extras.km !== undefined && extras.km !== null && Number.isFinite(extras.km);
  return {
    id: deps.publicIds.user.encode(userId),
    v: card.v,
    name: card.name,
    ...(card.age !== undefined && card.age >= 18 ? { age: card.age } : {}),
    gender: gender.name(card.gender),
    verified: card.verified,
    ...(card.intention !== undefined ? { intention: intention.name(card.intention) } : {}),
    ...(card.job ? { job: card.job } : {}),
    ...(card.about ? { about: card.about } : {}),
    ...(city ? { city: { id: city.id, name: deps.cities.nameOf(city, locale) } } : {}),
    ...(card.traveling ? { traveling: true as const } : {}),
    ...(showDistance ? { distance: shownDistance(extras.km!) } : {}),
    ...(extras.activeRecently && card.so === true ? { activeRecently: true as const } : {}),
    ...(extras.likesYou || extras.superliked ? { likesYou: true as const } : {}),
    ...(extras.superliked ? { superliked: true as const } : {}),
    photos,
    prompts: card.prompts.map((p) => ({
      promptId: p.p,
      ...(p.a !== undefined ? { answer: p.a } : {}),
      ...(p.ms !== undefined ? { audioMs: p.ms } : {}),
    })),
    fields: card.fields.map((f) => ({
      fieldId: f.f,
      ...(f.o !== undefined ? { option: f.o } : {}),
      ...(f.os !== undefined ? { options: f.os } : {}),
      ...(f.n !== undefined ? { number: f.n } : {}),
      ...(f.t !== undefined ? { text: f.t } : {}),
    })),
  };
}
