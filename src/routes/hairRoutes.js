import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { verifyHairImage, generateHairReport } from '../services/geminiService.js';
import { saveAssessment } from '../utils/store.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'vitasyn_secret_key_2025';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
});

function requireAuthenticatedUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      message: 'Please sign in again before saving your hair report.',
    });
  }

  try {
    const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    if (!decoded.userId) throw new Error('Authenticated user ID is missing.');
    req.userId = decoded.userId;
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Your session is invalid or expired. Please sign in again to save your hair report.',
    });
  }
}

function getGeminiErrorStatus(error) {
  if ([429, 503, 504].includes(error.statusCode)) return error.statusCode;
  return error.statusCode ? 502 : 500;
}

/**
 * POST /api/hair/verify
 * Checks if the uploaded image or base64 contains human hair/scalp
 */
router.post('/verify', upload.single('image'), async (req, res) => {
  try {
    let imageBuffer = null;
    let mimeType = 'image/jpeg';

    if (req.file) {
      imageBuffer = req.file.buffer;
      mimeType = req.file.mimetype;
    } else if (req.body?.imageBase64) {
      const parts = req.body.imageBase64.split(';base64,');
      if (parts.length === 2) {
        mimeType = parts[0].replace('data:', '');
        imageBuffer = Buffer.from(parts[1], 'base64');
      } else {
        imageBuffer = Buffer.from(req.body.imageBase64, 'base64');
      }
    }

    if (!imageBuffer) {
      return res.status(400).json({
        success: false,
        isHair: false,
        message: 'No image provided. Please upload a photo or provide base64 data.',
      });
    }

    const verificationResult = await verifyHairImage(imageBuffer, mimeType);

    // Log final verification result for debugging
    console.log('=== Hair Verification Final Result ===');
    console.log('Verification result:', JSON.stringify(verificationResult, null, 2));
    console.log('=====================================');

    return res.json({
      success: true,
      ...verificationResult,
    });
  } catch (error) {
    console.error('Hair verification error:', error);
    return res.status(getGeminiErrorStatus(error)).json({
      success: false,
      isHair: false,
      message: error.message || 'Failed to verify image with Gemini.',
    });
  }
});

/**
 * POST /api/hair/analyze
 * Generates tailored diagnostic report based on yes/no answers + optional description
 */
router.post('/analyze', requireAuthenticatedUser, async (req, res) => {
  try {
    const {
      dryness = 'normal',
      growthRate = 'medium',
      itching = false,
      dandruff = false,
      headLice = false,
      imageDescription = '',
      isHairDetected = true,
      detectionConfidence = 95,
      language = 'en',
    } = req.body;

    const report = await generateHairReport({
      dryness,
      growthRate,
      itching: Boolean(itching),
      dandruff: Boolean(dandruff),
      headLice: Boolean(headLice),
      imageDescription,
      language,
    });

    // Extract userId from JWT so we can associate this assessment with the user
    const userId = req.userId;

    const assessmentDoc = await saveAssessment({
      userId,
      type: 'hair',
      hairData: {
        dryness,
        growthRate,
        itching: Boolean(itching),
        dandruff: Boolean(dandruff),
        headLice: Boolean(headLice),
        imageDescription,
        isHairDetected,
        detectionConfidence,
      },
      scores: {
        overallScore: report.healthScore,
        status: report.condition,
        uniqueResultCode: report.uniqueResultCode,
      },
      generatedReport: report,
      language,
    });

    return res.json({
      success: true,
      assessmentId: assessmentDoc._id,
      report,
    });
  } catch (error) {
    console.error('Hair analysis error:', error);
    return res.status(getGeminiErrorStatus(error)).json({
      success: false,
      message: error.message || 'Failed to generate the hair report with Gemini.',
    });
  }
});

export default router;
