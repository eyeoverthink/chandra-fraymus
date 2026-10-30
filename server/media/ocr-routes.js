import multer from 'multer';
import { ocrRecognize, ocrStatus, listOCRFiles, getOCRResult } from './ocr-engine.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

export function installOCRRoutes(app) {
  app.post('/api/ocr/recognize', upload.single('image'), async (req, res, next) => {
    try {
      let input, mimeType;
      if (req.file) {
        input = req.file.buffer;
        mimeType = req.file.mimetype;
      } else if (req.body.imageBase64) {
        input = String(req.body.imageBase64);
      } else if (req.body.dataUri) {
        input = String(req.body.dataUri);
      } else {
        return res.status(400).json({ error: 'Provide image file upload, imageBase64, or dataUri' });
      }
      const opts = {};
      if (mimeType) opts.mimeType = mimeType;
      if (req.body.language) opts.language = String(req.body.language);
      const result = await ocrRecognize(input, opts);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/ocr/status', async (_req, res, next) => {
    try { res.json(await ocrStatus()); }
    catch (e) { next(e); }
  });

  app.get('/api/ocr/outputs', async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      res.json({ files: await listOCRFiles(limit) });
    } catch (e) { next(e); }
  });

  app.get('/api/ocr/result/:file', async (req, res, next) => {
    try { res.json(await getOCRResult(req.params.file)); }
    catch (e) { next(e); }
  });
}
