import express from 'express';
import jwt from 'jsonwebtoken';
import { generateEyeReport } from '../services/geminiService.js';
import { saveAssessment } from '../utils/store.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'vitasyn_secret_key_2025';

/**
 * Extract userId from Bearer token (if present), otherwise return null.
 */
function extractUserId(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
      return decoded.userId || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * POST /api/eye/analyze
 * Processes color score, reading acuity score, and ocular health questionnaire
 */
router.post('/analyze', async (req, res) => {
  try {
    const {
      colorStagesPassed = 0,
      colorPoints = 0,
      acuityScore = 0,
      leftEyeScore = null,
      rightEyeScore = null,
      bothEyesScore = null,
      dryEyes = false,
      havePower = false,
      powerType = 'none',
      screenTime = null,
      usingPhoneAtNight = false,
      eyeIrritationDuringTest = false,
      wateryEyesDuringTest = false,
      headacheAfterScreenUse = false,
      blurryVisionAfterProlongedUse = false,
      symptomCount = null,
      language = 'en',
    } = req.body;

    const num = (v) => (v === null || v === undefined ? null : Number(v));

    const report = await generateEyeReport({
      colorStagesPassed: Number(colorStagesPassed),
      colorPoints: Number(colorPoints),
      acuityScore: Number(acuityScore),
      leftEyeScore: num(leftEyeScore),
      rightEyeScore: num(rightEyeScore),
      bothEyesScore: num(bothEyesScore),
      dryEyes: Boolean(dryEyes),
      havePower: Boolean(havePower),
      powerType: havePower ? (powerType === 'positive' ? 'positive' : 'negative') : 'none',
      screenTime,
      usingPhoneAtNight: Boolean(usingPhoneAtNight),
      eyeIrritationDuringTest: Boolean(eyeIrritationDuringTest),
      wateryEyesDuringTest: Boolean(wateryEyesDuringTest),
      headacheAfterScreenUse: Boolean(headacheAfterScreenUse),
      blurryVisionAfterProlongedUse: Boolean(blurryVisionAfterProlongedUse),
      symptomCount,
      language,
    });

    // Extract userId from JWT so we can associate this assessment with the user
    const userId = extractUserId(req);

    const assessmentDoc = await saveAssessment({
      userId,
      type: 'eye',
      eyeData: {
        colorStagesPassed: Number(colorStagesPassed),
        colorScore: Number(colorPoints),
        acuityScore: Number(acuityScore),
        leftEyeScore: num(leftEyeScore),
        rightEyeScore: num(rightEyeScore),
        bothEyesScore: num(bothEyesScore),
        dryEyes: Boolean(dryEyes),
        havePower: Boolean(havePower),
        powerType: havePower ? (powerType === 'positive' ? 'positive' : 'negative') : 'none',
        screenTime,
        usingPhoneAtNight: Boolean(usingPhoneAtNight),
        eyeIrritationDuringTest: Boolean(eyeIrritationDuringTest),
        wateryEyesDuringTest: Boolean(wateryEyesDuringTest),
        headacheAfterScreenUse: Boolean(headacheAfterScreenUse),
        blurryVisionAfterProlongedUse: Boolean(blurryVisionAfterProlongedUse),
        symptomCount: report.eyeMetrics?.symptomCount ?? 0,
        consultationLevel: report.consultation?.level ?? 'none',
        totalScore: report.overallScore,
        grade: report.grade,
      },
      scores: {
        overallScore: report.overallScore,
        status: report.grade,
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
    console.error('Eye analysis error:', error);
    return res.status(error.statusCode ? 502 : 500).json({
      success: false,
      message: error.message || 'Failed to generate the eye report with Gemini.',
    });
  }
});

export default router;
