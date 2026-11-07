/**
 * Automatic photo moderation, behind one interface so the provider (not
 * chosen yet) can change without touching the pipeline. A provider sees
 * the stripped 640 px variant only, never the upload with its metadata, and
 * never who uploaded it.
 *
 * The verdict decides the status the photo gets: `approve` (3, public),
 * `review` (2, a human decides) or `reject` (4, with a reason the uploader
 * sees). Labels are photos.mod_flags bits; the pipeline adds the duplicate
 * bit itself, and a duplicate is never approved without a human.
 */

export interface ModerationInput {
  photoId: string;
  /** The stripped variant (WebP, 640 px wide or smaller). */
  image: Uint8Array;
  mime: 'image/webp';
  width: number;
  height: number;
}

export type ModerationVerdict =
  | { verdict: 'approve'; labels: number; hasFace?: boolean | undefined }
  | { verdict: 'review'; labels: number; hasFace?: boolean | undefined }
  | { verdict: 'reject'; labels: number; reason: number; hasFace?: boolean | undefined };

export interface PhotoModerator {
  readonly name: string;
  /** Throws when the provider cannot answer now (the job retries). */
  check(input: ModerationInput): Promise<ModerationVerdict>;
}

/**
 * The provider until one is chosen: no labels, and either every photo
 * waits for a human (the default) or, in development, every photo is
 * approved at once (`PHOTO_AUTO_APPROVE`). Tests can script a verdict per
 * photo.
 */
export class FakePhotoModerator implements PhotoModerator {
  readonly name = 'fake';
  /** What it was shown, kept only when `record` is on (tests): in a running worker it would grow without end. */
  readonly seen: ModerationInput[] = [];
  readonly scripted = new Map<string, ModerationVerdict>();
  private readonly record: boolean;
  autoApprove: boolean;
  failWith: Error | null = null;

  constructor(options: { autoApprove: boolean; record?: boolean | undefined }) {
    this.autoApprove = options.autoApprove;
    this.record = options.record ?? false;
  }

  async check(input: ModerationInput): Promise<ModerationVerdict> {
    if (this.failWith) throw this.failWith;
    if (this.record) this.seen.push(input);
    const scripted = this.scripted.get(input.photoId);
    if (scripted) return scripted;
    return { verdict: this.autoApprove ? 'approve' : 'review', labels: 0 };
  }
}
