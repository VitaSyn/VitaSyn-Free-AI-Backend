import mongoose from 'mongoose';
import crypto from 'crypto';

// Generate 13-character alphanumeric user ID
function generateUserId() {
  return crypto.randomBytes(10).toString('base64url').slice(0, 13).toUpperCase();
}

const UserSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      unique: true,
      default: generateUserId,
    },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, required: true, trim: true },
    age: { type: Number, required: true },
    sex: { type: String, enum: ['male', 'female', 'other'], required: true },
    password: { type: String, required: false }, // stored as bcrypt hash for legacy password accounts
    clerkId: { type: String, unique: true, sparse: true },
    resetOtp: { type: String, default: null },
    resetOtpExpiry: { type: Date, default: null },
    resetToken: { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
    results: [
      {
        type: { type: String, enum: ['hair', 'eye'] },
        assessmentId: { type: String },
        score: { type: Number },
        condition: { type: String },
        uniqueResultCode: { type: String },
        reportTitle: { type: String },
        takenAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export const User = mongoose.model('User', UserSchema);
