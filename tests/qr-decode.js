/* Reads the QR code in a page element (Playwright locator) from a screenshot, using jsQR. */
'use strict';

const jsQR = require('jsqr');
const { PNG } = require('pngjs');

function decodeQrPng(buffer) {
  const png = PNG.sync.read(buffer);
  const res = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
  return res ? res.data : null;
}

async function decodeQr(locator) {
  const data = decodeQrPng(await locator.screenshot());
  if (data == null) throw new Error('no QR code found in the screenshot');
  return data;
}

module.exports = { decodeQr, decodeQrPng };
