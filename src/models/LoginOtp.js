import mongoose from 'mongoose';

const LoginOtpSchema = new mongoose.Schema(
  {
    identifier: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

export const LoginOtp = mongoose.model('LoginOtp', LoginOtpSchema);
