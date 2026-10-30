// Minimal streaming ZIP writer (method 0 = "stored", no compression).
// Chapter images are PNG/JPEG/WebP already, so deflating them again would only burn
// CPU; stored zips open fine everywhere, and .cbz is just a zip of images.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function write(res, chunk) {
  return res.write(chunk) ? Promise.resolve() : new Promise((r) => res.once('drain', r));
}

/**
 * Stream a zip to `res`. `items` = [{ name, load: () => Promise<Buffer> }]; each file
 * is loaded one at a time, so memory stays at roughly one image regardless of chapter size.
 * Names must be plain ASCII (callers use 001.png, 002.jpg, ...).
 */
async function streamZip(res, items) {
  if (items.length > 65535) throw new Error('Too many files for a zip');
  const { time, date } = dosDateTime();
  const central = [];
  let offset = 0;

  for (const item of items) {
    const data = await item.load();
    if (data.length >= 0xffffffff || offset >= 0xffffffff) throw new Error('Zip would exceed 4 GB');
    const name = Buffer.from(item.name, 'ascii');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0, 6);         // flags
    local.writeUInt16LE(0, 8);         // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);        // extra length

    await write(res, local);
    await write(res, name);
    await write(res, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);      // offset of the local header
    central.push(Buffer.concat([cd, name]));

    offset += 30 + name.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(res, cdBuf);
  res.end(end);
}

module.exports = { streamZip, crc32 };
