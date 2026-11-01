import mongoose from 'mongoose';

const AssessmentSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: ['hair', 'eye'],
      required: true,
    },
    hairData: {
      dryness: { type: String }, // 'dry' | 'normal' | 'oily'
      growthRate: { type: String }, // 'fast' | 'medium' | 'slow'
      itching: { type: Boolean },
      dandruff: { type: Boolean },
      headLice: { type: Boolean },
      imageDescription: { type: String, default: '' },
      isHairDetected: { type: Boolean },
      detectionConfidence: { type: Number },
    },
    eyeData: {
      colorStagesPassed: { type: Number, default: 0 },
      colorScore: { type: Number, default: 0 },
      acuityScore: { type: Number, default: 0 }, // out of 15 (3 eye modes x 5 stages)
      leftEyeScore: { type: Number, default: null },
      rightEyeScore: { type: Number, default: null },
      bothEyesScore: { type: Number, default: null },
      dryEyes: { type: Boolean },
      havePower: { type: Boolean },
      powerType: { type: String }, // 'positive' | 'negative' | 'none'
      screenTime: { type: String }, // 'below1' | '1to3' | 'above3'
      usingPhoneAtNight: { type: Boolean },
      eyeIrritationDuringTest: { type: Boolean },
      wateryEyesDuringTest: { type: Boolean },
      headacheAfterScreenUse: { type: Boolean },
      blurryVisionAfterProlongedUse: { type: Boolean },
      symptomCount: { type: Number, default: 0 },
      consultationLevel: { type: String, default: 'none' }, // 'none' | 'recommended' | 'mandatory'
      totalScore: { type: Number, default: 0 },
      grade: { type: String },
    },
    scores: {
      overallScore: { type: Number, default: 0 },
      status: { type: String },
      uniqueResultCode: { type: String },
    },
    generatedReport: {
      title: { type: String },
      overview: { type: String },
      overallScore: { type: Number },
      colorScore: { type: Number },
      colorStagesPassed: { type: Number },
      acuityScore: { type: Number },
      maxAcuity: { type: Number },
      leftEyeScore: { type: Number, default: null },
      rightEyeScore: { type: Number, default: null },
      bothEyesScore: { type: Number, default: null },
      grade: { type: String },
      colorStatus: { type: String },
      uniqueResultCode: { type: String },
      clinicalFindings: [String],
      dos: [String],
      donts: [String],
      recommendations: [String],
      lifestyleGuidance: { type: String },
      disclaimer: { type: String },
      rawAiText: { type: String },
      // Eye-only: echoed test inputs so past reports can show what was measured
      eyeMetrics: {
        colorStagesPassed: { type: Number },
        colorStagesTotal: { type: Number },
        colorPoints: { type: Number },
        colorPointsTotal: { type: Number },
        leftEyeScore: { type: Number },
        rightEyeScore: { type: Number },
        bothEyesScore: { type: Number },
        readingStagesPerEye: { type: Number },
        readingStagesTotal: { type: Number },
        screenTime: { type: String },
        usingPhoneAtNight: { type: Boolean },
        eyeIrritationDuringTest: { type: Boolean },
        wateryEyesDuringTest: { type: Boolean },
        headacheAfterScreenUse: { type: Boolean },
        blurryVisionAfterProlongedUse: { type: Boolean },
        symptomCount: { type: Number },
      },
      consultation: {
        level: { type: String, default: 'none' }, // 'none' | 'recommended' | 'mandatory'
        message: { type: String },
      },
    },
    language: {
      type: String,
      enum: ['en', 'ta'],
      default: 'en',
    },
  },
  { timestamps: true }
);

export const Assessment = mongoose.model('Assessment', AssessmentSchema);
