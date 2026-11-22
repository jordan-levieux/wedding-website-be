import type { Bucket } from "@google-cloud/storage";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createGallery, signingWindow } from "./gallery.js";

const HOUR = 60 * 60 * 1000;

// stands in for the bucket: lists the given objects and "signs" a link that shows what it was signed for
const fakeBucket = (
  objects: {
    name: string;
    contentType?: string;
    metadata?: Record<string, string>;
  }[],
) => {
  const signings: string[] = [];
  const bucket = {
    getFiles: () =>
      Promise.resolve([
        objects.map((object) => ({
          name: object.name,
          metadata: {
            contentType: object.contentType,
            metadata: object.metadata,
          },
        })),
      ]),
    file: (name: string) => ({
      getSignedUrl: (options: { accessibleAt: number; expires: number }) => {
        signings.push(name);
        return Promise.resolve([
          `https://signed/${name}?from=${options.accessibleAt}&to=${options.expires}`,
        ]);
      },
    }),
  };
  return { bucket: bucket as unknown as Bucket, signings };
};

describe("gallery", () => {
  test("signing windows are six hours, and each link lasts until the end of the next one", () => {
    const start = Date.UTC(2027, 2, 13, 6);
    assert.deepEqual(signingWindow(start + 2 * HOUR), {
      start,
      expires: start + 12 * HOUR,
    });
  });

  test("lists only images, with a signed link and any alt text or caption", async () => {
    const { bucket } = fakeBucket([
      { name: "hyla_and_jordan/", contentType: "text/plain" },
      {
        name: "hyla_and_jordan/01_patagonia.jpg",
        contentType: "image/jpeg",
        metadata: { caption: " Patagonia ", alt: "" },
      },
      { name: "notes.txt", contentType: "text/plain" },
    ]);
    const now = Date.UTC(2027, 2, 13, 7);
    const photos = await createGallery(bucket, () => now).listPhotos();
    assert.deepEqual(photos, [
      {
        name: "hyla_and_jordan/01_patagonia.jpg",
        url: `https://signed/hyla_and_jordan/01_patagonia.jpg?from=${Date.UTC(2027, 2, 13, 6)}&to=${Date.UTC(2027, 2, 13, 18)}`,
        alt: null,
        caption: "Patagonia",
      },
    ]);
  });

  test("reuses links within a window and signs again in the next", async () => {
    const { bucket, signings } = fakeBucket([
      { name: "a.jpg", contentType: "image/jpeg" },
      { name: "b.jpg", contentType: "image/jpeg" },
    ]);
    let now = Date.UTC(2027, 2, 13, 7);
    const gallery = createGallery(bucket, () => now);

    const first = await gallery.listPhotos();
    now += HOUR;
    assert.deepEqual(await gallery.listPhotos(), first);
    assert.deepEqual(signings, ["a.jpg", "b.jpg"]);

    now += 6 * HOUR;
    const later = await gallery.listPhotos();
    assert.notEqual(later[0]!.url, first[0]!.url);
    assert.deepEqual(signings, ["a.jpg", "b.jpg", "a.jpg", "b.jpg"]);
  });
});
