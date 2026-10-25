// Shared request contract; camera capture happens only on an explicit vision request.
export const MAX_CAMERA_IMAGE = 240000;
export const visionTool = { type: 'function', name: 'analyze_camera',
  description: 'Bekijk één actueel laptopcamerabeeld via Google Gemini, uitsluitend als de gebruiker vraagt iets in beeld te bekijken, herkennen, lezen of uitleggen. Bijvoorbeeld: wat heb ik vast, welke plant is dit, lees deze opgave. Nooit automatisch bij groeten, gezichtsherkenning of gewoon praten. Vereist een al gestarte camera en aparte toestemming om beelden met Google te delen. Identificeer geen personen met deze functie.',
  parameters: { type: 'object', properties: { question: { type: 'string', description: 'De concrete vraag over wat nu in beeld is, met relevante gesprekscontext.' } }, required: ['question'], additionalProperties: false } };
export function validVisionRequest(value) {
  return value && typeof value.question === 'string' && value.question.trim() && value.question.length <= 1000 &&
    typeof value.image === 'string' && value.image.length <= MAX_CAMERA_IMAGE &&
    /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image) &&
    Object.keys(value).every(key => ['question', 'image'].includes(key));
}
export function captureCamera(video, { allowed, makeCanvas = () => document.createElement('canvas') } = {}) {
  if (!allowed) throw new Error('Start de camera en vink “Camerabeelden delen met Google” aan.');
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) throw new Error('De camera heeft nog geen beeld. Probeer zo opnieuw.');
  const canvas = makeCanvas();
  try {
    for (const edge of [960, 768, 512, 384]) {
      const scale = Math.min(1, edge / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Camerabeeld kon niet worden voorbereid.');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.8);
      if (validVisionRequest({ question: 'Bekijk dit', image })) return image;
    }
    throw new Error('Camerabeeld is te groot. Probeer opnieuw.');
  } finally { canvas.width = canvas.height = 0; }
}
