#!/usr/bin/env node
// Regenerates every app icon / splash asset from assets/logo-source.png.
// Writes both the Expo assets/ sources and the already-generated native files
// under ios/ and android/, because `expo prebuild --clean` is off-limits here
// (it would wipe the pbxproj patches — see scripts/patch-ios-pbxproj.js).
// Idempotent — safe to run multiple times.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Jimp = require('jimp-compact');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'assets', 'logo-source.png');

// Brand colours, sampled from the source logo.
const CHARCOAL = { r: 0x36, g: 0x36, b: 0x33 };
const ORANGE = { r: 0xff, g: 0x91, b: 0x4d };

// The mark inside logo-source.png: a circle of this diameter, centred, on a
// canvas of this size. The source carries a lot of empty margin, so we rebuild
// the mark at whatever scale each target wants instead of resampling the file.
const SRC_CANVAS = 2000;
const SRC_DIAMETER = 689;

// How much of each canvas the orange circle should cover.
const FILL = {
  ios: 0.72, // iOS masks to a squircle, so the mark can sit fairly large
  adaptive: 0.48, // Android crops to the centre 66.6%; 0.48 ≈ 72% of what shows
  splash: 0.42, // splash is `contain`-fit to the screen, so keep it small
};

const SS = 4; // supersampling factor for the antialiased circle edge

let written = 0;

/** Alpha mask of the white wordmark, extracted from the source at full res. */
function readWordmark(src) {
  const size = SRC_DIAMETER;
  const off = (SRC_CANVAS - size) / 2;
  const mask = new Float64Array(size * size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - r + 0.5;
      const dy = y - r + 0.5;
      if (dx * dx + dy * dy > r * r) continue;
      // Inside the disc every pixel is a blend of ORANGE and white, and blue is
      // the channel that separates them most cleanly (0x4d vs 0xff).
      const { b } = Jimp.intToRGBA(src.getPixelColor(x + off, y + off));
      const a = (b - ORANGE.b) / (255 - ORANGE.b);
      mask[y * size + x] = a < 0 ? 0 : a > 1 ? 1 : a;
    }
  }
  return { mask, size };
}

/** Bilinear sample of the wordmark mask in normalised [0,1] disc coordinates. */
function sampleWordmark(wordmark, u, v) {
  const { mask, size } = wordmark;
  const x = u * size - 0.5;
  const y = v * size - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px, py) =>
    px < 0 || py < 0 || px >= size || py >= size ? 0 : mask[py * size + px];
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x0 + 1, y0) * fx * (1 - fy) +
    at(x0, y0 + 1) * (1 - fx) * fy +
    at(x0 + 1, y0 + 1) * fx * fy
  );
}

/**
 * Renders the mark: an orange disc of `fill * canvas` diameter, centred, with
 * the wordmark on top. `background` is CHARCOAL for opaque icons, or null for a
 * transparent canvas (Android adaptive foreground, splash logo).
 */
function render(wordmark, canvas, fill, background) {
  const img = new Jimp(canvas, canvas, 0x00000000);
  const radius = (canvas * fill) / 2;
  const centre = canvas / 2;
  const bmp = img.bitmap.data;

  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      // Supersample the disc so its edge is smooth at any size.
      let coverage = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - centre;
          const dy = y + (sy + 0.5) / SS - centre;
          if (dx * dx + dy * dy <= radius * radius) coverage++;
        }
      }
      coverage /= SS * SS;

      let r = background ? background.r : 0;
      let g = background ? background.g : 0;
      let b = background ? background.b : 0;
      let a = background ? 1 : 0;

      if (coverage > 0) {
        const u = (x + 0.5 - centre) / (2 * radius) + 0.5;
        const v = (y + 0.5 - centre) / (2 * radius) + 0.5;
        const text = sampleWordmark(wordmark, u, v);
        const mr = ORANGE.r + (255 - ORANGE.r) * text;
        const mg = ORANGE.g + (255 - ORANGE.g) * text;
        const mb = ORANGE.b + (255 - ORANGE.b) * text;
        // Composite the disc over whatever is underneath.
        const out = coverage + a * (1 - coverage);
        r = (mr * coverage + r * a * (1 - coverage)) / out;
        g = (mg * coverage + g * a * (1 - coverage)) / out;
        b = (mb * coverage + b * a * (1 - coverage)) / out;
        a = out;
      }

      const i = (y * canvas + x) * 4;
      bmp[i] = Math.round(r);
      bmp[i + 1] = Math.round(g);
      bmp[i + 2] = Math.round(b);
      bmp[i + 3] = Math.round(a * 255);
    }
  }
  return img;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Encodes a Jimp image as a truecolour PNG with no alpha channel (colour type
 * 2), which is what App Store / iOS app icons require. Hand-rolled because
 * jimp-compact's own `.rgba(false)` emits a corrupt stream — the header claims
 * 3 bytes per pixel while the data stays 4, so every decoder but jimp's own
 * reads the image skewed. Verified against pngjs and `xcrun actool`.
 */
function encodeOpaquePng(img) {
  const { width, height, data } = img.bitmap;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Composite against black; these icons are opaque already.
      const a = data[i + 3] / 255;
      raw[o++] = Math.round(data[i] * a);
      raw[o++] = Math.round(data[i + 1] * a);
      raw[o++] = Math.round(data[i + 2] * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour, no alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function write(img, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await img.writeAsync(dest);
  written++;
  console.log(`  [ok]    ${path.relative(ROOT, dest)}  ${img.bitmap.width}px`);
}

/** Circular crop, for Android's legacy round launcher icon. */
function roundOff(img) {
  const size = img.bitmap.width;
  const r = size / 2;
  const bmp = img.bitmap.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = x + (sx + 0.5) / SS - r;
          const dy = y + (sy + 0.5) / SS - r;
          if (dx * dx + dy * dy <= r * r) coverage++;
        }
      }
      const i = (y * size + x) * 4;
      bmp[i + 3] = Math.round(bmp[i + 3] * (coverage / (SS * SS)));
    }
  }
  return img;
}

async function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Missing ${path.relative(ROOT, SOURCE)}`);
    process.exit(1);
  }

  const src = await Jimp.read(SOURCE);
  if (src.bitmap.width !== SRC_CANVAS || src.bitmap.height !== SRC_CANVAS) {
    console.error(
      `Expected a ${SRC_CANVAS}x${SRC_CANVAS} source, got ` +
        `${src.bitmap.width}x${src.bitmap.height}`
    );
    process.exit(1);
  }
  const wordmark = readWordmark(src);

  console.log('Expo assets');
  const icon = render(wordmark, 1024, FILL.ios, CHARCOAL);
  await write(icon, path.join(ROOT, 'assets', 'icon.png'));
  await write(
    render(wordmark, 1024, FILL.adaptive, null),
    path.join(ROOT, 'assets', 'adaptive-icon.png')
  );
  await write(
    render(wordmark, 1024, FILL.splash, null),
    path.join(ROOT, 'assets', 'splash-icon.png')
  );
  await write(
    render(wordmark, 48, FILL.ios + 0.06, CHARCOAL),
    path.join(ROOT, 'assets', 'favicon.png')
  );

  console.log('iOS');
  const XC = path.join(ROOT, 'ios', 'Notebound', 'Images.xcassets');
  if (fs.existsSync(XC)) {
    // App Store / iOS app icons must be fully opaque — no alpha channel.
    const appIconPath = path.join(
      XC,
      'AppIcon.appiconset',
      'App-Icon-1024x1024@1x.png'
    );
    fs.writeFileSync(appIconPath, encodeOpaquePng(icon));
    written++;
    console.log(`  [ok]    ${path.relative(ROOT, appIconPath)}  1024px (no alpha)`);
    // Expo emits all three legacy splash scales at 1024; keep that shape.
    const splash = render(wordmark, 1024, FILL.splash, null);
    for (const name of ['image.png', 'image@2x.png', 'image@3x.png']) {
      await write(splash, path.join(XC, 'SplashScreenLegacy.imageset', name));
    }
    const colorset = path.join(XC, 'SplashScreenBackground.colorset', 'Contents.json');
    fs.writeFileSync(
      colorset,
      JSON.stringify(
        {
          colors: [
            {
              color: {
                components: {
                  alpha: '1.000',
                  blue: (CHARCOAL.b / 255).toFixed(14),
                  green: (CHARCOAL.g / 255).toFixed(14),
                  red: (CHARCOAL.r / 255).toFixed(14),
                },
                'color-space': 'srgb',
              },
              idiom: 'universal',
            },
          ],
          info: { version: 1, author: 'expo' },
        },
        null,
        2
      ) + '\n'
    );
    written++;
    console.log(`  [ok]    ${path.relative(ROOT, colorset)}`);
  } else {
    console.log('  [miss]  ios/ not generated');
  }

  console.log('Android');
  const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
  if (fs.existsSync(RES)) {
    // sips/jimp cannot write webp, so emit PNG and drop the stale webp files.
    // Android resolves drawables by name, not extension.
    const densities = [
      ['mdpi', 48, 108, 288],
      ['hdpi', 72, 162, 432],
      ['xhdpi', 96, 216, 576],
      ['xxhdpi', 144, 324, 864],
      ['xxxhdpi', 192, 432, 1152],
    ];
    for (const [density, launcher, foreground, splash] of densities) {
      const mipmap = path.join(RES, `mipmap-${density}`);
      const legacy = render(wordmark, launcher, FILL.ios, CHARCOAL);
      await write(legacy, path.join(mipmap, 'ic_launcher.png'));
      await write(roundOff(legacy.clone()), path.join(mipmap, 'ic_launcher_round.png'));
      await write(
        render(wordmark, foreground, FILL.adaptive, null),
        path.join(mipmap, 'ic_launcher_foreground.png')
      );
      for (const stale of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
        const webp = path.join(mipmap, `${stale}.webp`);
        if (fs.existsSync(webp)) {
          fs.unlinkSync(webp);
          console.log(`  [rm]    ${path.relative(ROOT, webp)}`);
        }
      }
      await write(
        render(wordmark, splash, FILL.splash, null),
        path.join(RES, `drawable-${density}`, 'splashscreen_logo.png')
      );
    }

    const colors = path.join(RES, 'values', 'colors.xml');
    const hex = `#${[CHARCOAL.r, CHARCOAL.g, CHARCOAL.b]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')}`;
    let xml = fs.readFileSync(colors, 'utf8');
    xml = xml
      .replace(
        /(<color name="splashscreen_background">)[^<]*(<\/color>)/,
        `$1${hex}$2`
      )
      .replace(/(<color name="iconBackground">)[^<]*(<\/color>)/, `$1${hex}$2`);
    fs.writeFileSync(colors, xml);
    written++;
    console.log(`  [ok]    ${path.relative(ROOT, colors)}  ${hex}`);
  } else {
    console.log('  [miss]  android/ not generated');
  }

  console.log(`\n${written} file(s) written.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
