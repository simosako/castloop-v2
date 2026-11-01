export const TEST_MP3 = Buffer.concat(Array.from({ length: 50 }, () =>
  Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)])));
export const TEST_COVER_JPEG = Buffer.from([255, 216, 255, 2]);
