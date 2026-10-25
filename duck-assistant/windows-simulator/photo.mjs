// One explicitly selected image, never a background camera stream.
export async function preparePhoto(file, { decode = globalThis.createImageBitmap,
  makeCanvas = () => document.createElement('canvas') } = {}) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error('Kies een JPG-, PNG- of WebP-foto van maximaal 8 MB.');
  }
  const bitmap = await decode(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error('De foto is te groot om hier te verwerken.');
    const canvas = makeCanvas();
    for (let edge = 384; edge >= 96; edge = Math.floor(edge * 0.75)) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.7);
      if (image.length <= 48000) return image;
    }
    throw new Error('Deze foto blijft te groot. Kies een kleinere afbeelding.');
  } finally { bitmap.close(); }
}
