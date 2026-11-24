import type { Bucket } from "@google-cloud/storage";

export type GalleryPhoto = {
  // the object's path in the bucket, e.g. "hyla_and_jordan/01_patagonia.jpg"
  name: string;
  url: string;
  // from the object's custom metadata, if set
  alt: string | null;
  caption: string | null;
  // pixel size, set by the FE's prepare-gallery-photos.sh when it uploads; the viewer needs it up front
  width: number | null;
  height: number | null;
};

export type Gallery = {
  listPhotos: () => Promise<GalleryPhoto[]>;
};

const WINDOW_MS = 6 * 60 * 60 * 1000;

// Links are signed for fixed windows rather than from the moment they're asked for, so a photo keeps
// the same URL (and its place in the browser's cache) for a while, and every link handed out still
// works for at least one more window.
export const signingWindow = (now: number) => {
  const start = now - (now % WINDOW_MS);
  return { start, expires: start + 2 * WINDOW_MS };
};

const metadataText = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const metadataSize = (value: unknown) => {
  const size = Number(metadataText(value));
  return Number.isInteger(size) && size > 0 ? size : null;
};

// The bucket is private: guests only ever see time-limited signed links to its images.
export const createGallery = (
  bucket: Bucket,
  now: () => number = Date.now,
): Gallery => {
  // each link costs a call to Google to sign, so links are kept until their window moves on
  let signedFor = -1;
  const signed = new Map<string, Promise<string>>();

  const signedUrl = (name: string) => {
    const { start, expires } = signingWindow(now());
    if (start !== signedFor) {
      signed.clear();
      signedFor = start;
    }
    let url = signed.get(name);
    if (!url) {
      url = bucket
        .file(name)
        .getSignedUrl({
          version: "v4",
          action: "read",
          accessibleAt: start,
          expires,
        })
        .then(([signedUrl]) => signedUrl);
      // a failed signing shouldn't stick for the rest of the window
      url.catch(() => signed.delete(name));
      signed.set(name, url);
    }
    return url;
  };

  return {
    listPhotos: async () => {
      const [files] = await bucket.getFiles();
      const images = files.filter((file) =>
        String(file.metadata.contentType ?? "").startsWith("image/"),
      );
      return Promise.all(
        images.map(async (file) => ({
          name: file.name,
          url: await signedUrl(file.name),
          alt: metadataText(file.metadata.metadata?.["alt"]),
          caption: metadataText(file.metadata.metadata?.["caption"]),
          width: metadataSize(file.metadata.metadata?.["width"]),
          height: metadataSize(file.metadata.metadata?.["height"]),
        })),
      );
    },
  };
};
