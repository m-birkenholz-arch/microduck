const networks = api => [api.nets.tinyFaceDetector, api.nets.faceLandmark68TinyNet, api.nets.faceRecognitionNet];
export async function loadFaceModels(api) {
  let timer;
  try {
    await Promise.race([
      Promise.all(networks(api).map(net => net.loadFromUri('/duck-face/models'))),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Lokale gezichtsmodellen laden duurde te lang. Installeer opnieuw met -FaceCamera.')), 45000); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createFaceEngine(api, { makeCanvas = () => document.createElement('canvas'), reloadModels = () => loadFaceModels(api) } = {}) {
  let canvas, queue = Promise.resolve(), triedCpu = api.tf.getBackend() === 'cpu';
  async function infer(video) {
    // The media element can have metadata without a decodable frame yet.
    if ('videoWidth' in video && (!video.videoWidth || !video.videoHeight || video.readyState < 2)) return [];
    canvas ||= makeCanvas();
    const width = video.videoWidth || video.width, height = video.videoHeight || video.height;
    if (!width || !height) return [];
    canvas.width = width; canvas.height = height;
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Lokaal camerabeeld kon niet worden voorbereid.');
      // Use a plain local canvas rather than a driver-dependent video texture.
      context.drawImage(video, 0, 0, width, height);
      const detect = () => api.detectAllFaces(canvas, new api.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.75 }))
        .withFaceLandmarks(true).withFaceDescriptors();
      try { return await detect(); }
      catch (error) {
        if (triedCpu || api.tf.getBackend() === 'cpu') throw error;
        triedCpu = true;
        if (!await api.tf.setBackend('cpu')) throw new Error('CPU-herkenning kon niet worden gestart.');
        // Reload locally: after GPU context loss, its existing weight textures
        // may no longer be readable during a normal backend transfer.
        for (const net of networks(api)) { try { net.dispose(false); } catch { /* Already-invalid GPU tensor. */ } }
        await reloadModels();
        return await detect();
      }
    } finally { canvas.width = canvas.height = 0; }
  }
  return {
    get backend() { return api.tf.getBackend(); },
    detect(video) {
      // Stop/restart can outlive a pending inference; serialize access to models.
      const result = queue.then(() => infer(video));
      queue = result.catch(() => {});
      return result;
    },
  };
}
