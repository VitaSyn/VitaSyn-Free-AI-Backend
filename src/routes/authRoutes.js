import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { User } from '../models/User.js';
import { LoginOtp } from '../models/LoginOtp.js';

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'vitasyn_secret_key_2025';
const SALT_ROUNDS = 12;
const PHONE_OTP_CODE = '123456';
const LOGIN_OTP_TTL_MS = 2 * 60 * 1000;

// In-memory fallback user store when MongoDB is not connected
const memUsers = [];
const memLoginOtps = new Map();

function isConnected() {
  return mongoose.connection.readyState === 1;
}

async function findUserByEmail(email) {
  if (isConnected()) return User.findOne({ email: email.toLowerCase() });
  return memUsers.find((u) => u.email === email.toLowerCase()) || null;
}

async function findUserByPhone(phone) {
  if (isConnected()) return User.findOne({ phone });
  return memUsers.find((u) => u.phone === phone) || null;
}

function normalizeLoginIdentifier(value) {
  const identifier = String(value || '').trim();
  if (/^\d+$/.test(identifier)) {
    if (!/^\d{10}$/.test(identifier)) return null;
    return { kind: 'phone', identifier: `+91${identifier}` };
  }

  const email = identifier.toLowerCase();
  const [local, domain, ...extra] = email.split('@');
  if (
    email.length > 254 ||
    extra.length > 0 ||
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) {
    return null;
  }
  const labels = domain?.split('.') || [];
  if (
    labels.length < 2 ||
    labels.some((label) => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) ||
    (labels.at(-1)?.length || 0) < 2
  ) return null;
  return { kind: 'email', identifier: email };
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function saveLoginOtp(identifier, code, expiresAt) {
  const codeHash = hashOtp(code);
  if (isConnected()) {
    await LoginOtp.findOneAndUpdate(
      { identifier },
      { codeHash, expiresAt },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return;
  }
  memLoginOtps.set(identifier, { codeHash, expiresAt });
}

async function findLoginOtp(identifier) {
  if (isConnected()) return LoginOtp.findOne({ identifier });
  return memLoginOtps.get(identifier) || null;
}

async function removeLoginOtp(identifier) {
  if (isConnected()) {
    await LoginOtp.deleteOne({ identifier });
    return;
  }
  memLoginOtps.delete(identifier);
}

function otpMatches(expectedHash, code) {
  const actualHash = Buffer.from(hashOtp(code), 'hex');
  const storedHash = Buffer.from(expectedHash, 'hex');
  return actualHash.length === storedHash.length && crypto.timingSafeEqual(actualHash, storedHash);
}

async function findUserByVerifiedPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  const nationalSuffix = digits.slice(-10);
  if (isConnected()) {
    return User.findOne({
      $or: [
        { phone },
        { phone: digits },
        { phone: { $regex: `${nationalSuffix.split('').join('\\D*')}$` } },
      ],
    });
  }
  return memUsers.find((user) => {
    const storedDigits = String(user.phone || '').replace(/\D/g, '');
    return storedDigits === digits || (storedDigits.length === 10 && digits.endsWith(storedDigits));
  }) || null;
}

async function findUserByClerkId(clerkId) {
  if (isConnected()) return User.findOne({ clerkId });
  return memUsers.find((user) => user.clerkId === clerkId) || null;
}

function createAppSession(user) {
  const token = jwt.sign(
    { userId: user.userId, email: user.email },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  return {
    success: true,
    token,
    user: {
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      age: user.age,
      sex: user.sex,
      profileComplete: user.profileComplete ?? user.age > 0,
      results: user.results || [],
    },
  };
}

async function sendLoginOtp(req, res) {
  const login = normalizeLoginIdentifier(req.body?.identifier);
  if (!login) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_IDENTIFIER',
      message: 'Enter a valid 10-digit phone number or email address.',
    });
  }

  if (
    login.kind === 'email' &&
    (!process.env.SMTP_USER || !process.env.SMTP_PASS)
  ) {
    return res.status(503).json({
      success: false,
      message: 'Email OTP is not configured. Set SMTP_USER and SMTP_PASS on the backend.',
    });
  }

  const code = login.kind === 'phone'
    ? PHONE_OTP_CODE
    : crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + LOGIN_OTP_TTL_MS);

  try {
    await saveLoginOtp(login.identifier, code, expiresAt);
    if (login.kind === 'email') {
      try {
        await sendLoginOtpEmail(login.identifier, code);
      } catch (err) {
        await removeLoginOtp(login.identifier);
        console.error('Login OTP email delivery error:', err.message);
        return res.status(502).json({ success: false, message: 'Could not send the email OTP. Please try again.' });
      }
    }

    return res.json({
      success: true,
      expiresInSeconds: LOGIN_OTP_TTL_MS / 1000,
      message: login.kind === 'email' ? 'OTP sent to your email.' : 'Use 123456 to verify your phone number.',
    });
  } catch (err) {
    console.error('Login OTP creation error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not send an OTP. Please try again.' });
  }
}

async function verifyLoginOtp(req, res) {
  const login = normalizeLoginIdentifier(req.body?.identifier);
  const code = String(req.body?.code || '').trim();
  if (!login || !/^\d{6}$/.test(code)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_OTP',
      message: 'Enter a valid phone number or email and a 6-digit OTP.',
    });
  }

  try {
    const challenge = await findLoginOtp(login.identifier);
    if (!challenge || new Date(challenge.expiresAt) <= new Date()) {
      if (challenge) await removeLoginOtp(login.identifier);
      return res.status(400).json({ success: false, code: 'OTP_EXPIRED', message: 'OTP expired. Request a new one.' });
    }

    if (!otpMatches(challenge.codeHash, code)) {
      return res.status(401).json({ success: false, code: 'INVALID_OTP', message: 'That OTP is incorrect.' });
    }
    await removeLoginOtp(login.identifier);

    let user;
    if (login.kind === 'phone') {
      user = await findUserByVerifiedPhone(login.identifier);
      if (!user) {
        const digits = login.identifier.replace(/\D/g, '');
        const newUser = {
          userId: generate13DigitUserId(),
          name: 'VitaSyn User',
          email: `phone-${digits}@users.vitasyn.invalid`,
          phone: login.identifier,
          age: 0,
          sex: 'other',
          profileComplete: false,
          results: [],
        };
        if (isConnected()) user = await User.create(newUser);
        else {
          user = { ...newUser, createdAt: new Date() };
          memUsers.push(user);
        }
      } else if (user.phone !== login.identifier) {
        user.phone = login.identifier;
        if (isConnected()) await user.save();
      }
    } else {
      user = await findUserByEmail(login.identifier);
      if (!user) {
        const newUser = {
          userId: generate13DigitUserId(),
          name: 'VitaSyn User',
          email: login.identifier,
          phone: '',
          age: 0,
          sex: 'other',
          profileComplete: false,
          results: [],
        };
        if (isConnected()) user = await User.create(newUser);
        else {
          user = { ...newUser, createdAt: new Date() };
          memUsers.push(user);
        }
      }
    }

    return res.json(createAppSession(user));
  } catch (err) {
    console.error('Login OTP verification error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not verify the OTP. Please try again.' });
  }
}

router.post('/otp/send', sendLoginOtp);
router.post('/otp/verify', verifyLoginOtp);

// Keep the previous phone endpoints working while using the same expiring challenge.
router.post('/phone/send-otp', (req, res) => {
  const phoneDigits = String(req.body.phone || '').replace(/\D/g, '');
  req.body.identifier = phoneDigits.slice(-10);
  return sendLoginOtp(req, res);
});
router.post('/phone/verify-otp', (req, res) => {
  const phoneDigits = String(req.body.phone || '').replace(/\D/g, '');
  req.body.identifier = phoneDigits.slice(-10);
  return verifyLoginOtp(req, res);
});

/** POST /api/auth/google/session */
router.post('/google/session', async (req, res) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const sessionToken = String(req.body.sessionToken || '');
  if (!secretKey) {
    return res.status(503).json({ success: false, message: 'Google sign-in is not configured on the server.' });
  }
  if (!sessionToken) {
    return res.status(400).json({ success: false, message: 'A Clerk session is required.' });
  }

  try {
    const claims = await verifyToken(sessionToken, { secretKey });
    if (!claims.sub) {
      return res.status(401).json({ success: false, message: 'Invalid Clerk session.' });
    }

    const clerkClient = createClerkClient({ secretKey });
    const clerkUser = await clerkClient.users.getUser(claims.sub);
    const primaryEmail = clerkUser.emailAddresses.find(
      (address) => address.id === clerkUser.primaryEmailAddressId
    )?.emailAddress;
    if (!primaryEmail) {
      return res.status(400).json({ success: false, message: 'Your account must have a verified email address.' });
    }
    const clerkName = [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ');

    let user = await findUserByClerkId(clerkUser.id);
    if (!user) {
      user = await findUserByEmail(primaryEmail);
      if (user?.clerkId && user.clerkId !== clerkUser.id) {
        return res.status(409).json({ success: false, message: 'This email is already linked to another sign-in account.' });
      }
    }

    if (user) {
      user.clerkId = clerkUser.id;
      if (clerkName) user.name = clerkName;
      user.profileComplete = true;
      if (isConnected()) await user.save();
      else if (!memUsers.some((entry) => entry.userId === user.userId)) memUsers.push(user);
    } else {
      const newUser = {
        userId: generate13DigitUserId(),
        clerkId: clerkUser.id,
        name: clerkName || primaryEmail.split('@')[0],
        email: primaryEmail.toLowerCase(),
        phone: '',
        age: 0,
        sex: 'other',
        profileComplete: true,
        results: [],
      };
      if (isConnected()) user = await User.create(newUser);
      else {
        user = { ...newUser, createdAt: new Date() };
        memUsers.push(user);
      }
    }

    return res.json(createAppSession(user));
  } catch (err) {
    console.error('Clerk session exchange error:', err.message);
    return res.status(401).json({ success: false, message: 'Could not verify your social sign-in. Please try again.' });
  }
});

router.post('/profile', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(authHeader.slice('Bearer '.length), JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }

  const name = String(req.body.name || '').trim();
  const age = Number(req.body.age);
  if (!name || name.length > 80 || !Number.isInteger(age) || age < 1 || age > 120) {
    return res.status(400).json({ success: false, message: 'Enter a name and a valid age from 1 to 120.' });
  }

  try {
    let user;
    if (isConnected()) {
      user = await User.findOne({ userId: decoded.userId });
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
      user.name = name;
      user.age = age;
      user.profileComplete = true;
      await user.save();
    } else {
      user = memUsers.find((entry) => entry.userId === decoded.userId);
      if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
      user.name = name;
      user.age = age;
      user.profileComplete = true;
    }

    return res.json(createAppSession(user));
  } catch (err) {
    console.error('Profile update error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not save your profile. Please try again.' });
  }
});

// Generate exact 13-character alphanumeric user ID
function generate13DigitUserId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  const bytes = crypto.randomBytes(13);
  for (let i = 0; i < 13; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

async function sendLoginOtpEmail(email, otp) {
  const nodemailer = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT) || 587;
  const transporter = nodemailer.default.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"VitaSyn Free AI" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'VitaSyn Free AI - Sign-in OTP',
    text: `Your VitaSyn sign-in OTP is ${otp}. It expires in 2 minutes.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #f59e0b; margin-top: 0;">VitaSyn Free AI</h2>
        <p>Use this 6-digit code to sign in:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #15803d; background: #f0fdf4; padding: 14px 20px; text-align: center; border-radius: 8px; border: 1px solid #bbf7d0; margin: 16px 0;">
          ${otp}
        </div>
        <p style="color: #64748b; font-size: 13px;">This code expires in 2 minutes. If you did not request it, you can ignore this email.</p>
      </div>
    `,
  });
}

// Send OTP via email using nodemailer (with resilient console logging)
async function sendOtpEmail(email, otp) {
  console.log(`\n==================================================`);
  console.log(`[VitaSyn Free AI] 5-Minute OTP for ${email}: ${otp}`);
  console.log(`==================================================\n`);

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.default.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      await transporter.sendMail({
        from: `"VitaSyn Free AI" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'VitaSyn Free AI - Password Reset OTP Code',
        html: `
          <div style="font-family: sans-serif; max-width: 480px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
            <h2 style="color: #f59e0b; margin-top: 0;">VitaSyn Free AI</h2>
            <p>You requested a password reset code. Use the 6-digit OTP below to proceed:</p>
            <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #15803d; background: #f0fdf4; padding: 14px 20px; text-align: center; border-radius: 8px; border: 1px solid #bbf7d0; margin: 16px 0;">
              ${otp}
            </div>
            <p style="color: #64748b; font-size: 13px;">This OTP is temporary and expires in <strong>5 minutes</strong>. If you did not request this, please ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
            <p style="color: #94a3b8; font-size: 11px; margin: 0;">VitaSyn Pvt Ltd — <a href="https://vitasyn.in" style="color: #f59e0b;">vitasyn.in</a></p>
          </div>
        `,
      });
    } catch (err) {
      console.warn('SMTP Send Warning (OTP logged to server console):', err.message);
    }
  }
}

/**
 * POST /api/auth/register
 * Register a new user with 13-digit alphanumeric userId
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, age, sex, password, confirmPassword } = req.body;

    if (!name || !email || !phone || !age || !sex || !password) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'All fields are required.' });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({ success: false, code: 'PASSWORD_MISMATCH', message: 'Passwords do not match.' });
    }

    // Check if user with same email exists
    const existing = await findUserByEmail(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({
        success: false,
        code: 'EMAIL_EXISTS',
        message: 'user with same email already exist, try login.',
      });
    }

    // Hash password & generate 13-digit alphanumeric userId
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = generate13DigitUserId();

    const newUserObj = {
      userId,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      age: Number(age),
      sex,
      profileComplete: true,
      password: hashedPassword,
      results: [],
    };

    if (isConnected()) {
      await User.create(newUserObj);
    } else {
      memUsers.push({ ...newUserObj, createdAt: new Date() });
    }

    return res.status(201).json({
      success: true,
      message: 'Registration successful. Please sign in.',
      userId,
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ success: false, message: 'Registration failed. Try again.' });
  }
});

/**
 * POST /api/auth/login
 * Login with email or phone + password
 */
router.post('/login', async (req, res) => {
  try {
    const { emailOrPhone, password } = req.body;

    if (!emailOrPhone || !password) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'Email/phone and password are required.' });
    }

    // Detect if input is phone (only digits) or email
    const trimmedInput = emailOrPhone.trim();
    const isPhone = /^\d+$/.test(trimmedInput);

    let user = null;
    if (isPhone) {
      user = await findUserByPhone(trimmedInput);
    } else {
      user = await findUserByEmail(trimmedInput.toLowerCase());
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        message: 'user not found. register first.',
      });
    }

    // Check password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIAL',
        message: 'invalid credential.',
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.userId, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      success: true,
      token,
      user: {
        userId: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        age: user.age,
        sex: user.sex,
        results: user.results || [],
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Login failed. Try again.' });
  }
});

/**
 * POST /api/auth/forgot-password/verify-email
 * Step 1: Check if email exists. If not, return user not found. If yes, return first 6 digits of mobile number.
 */
router.post('/forgot-password/verify-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.trim()) {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    const user = await findUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        message: 'user with email id not found, register first.',
      });
    }

    const phoneStr = String(user.phone || '').trim();
    const phoneFirst6 = phoneStr.slice(0, 6);
    const phoneMasked = phoneFirst6 + '****';

    return res.json({
      success: true,
      phoneFirst6,
      phoneMasked,
      message: 'Email verified. Please enter the last 4 digits of your registered mobile number.',
    });
  } catch (err) {
    console.error('Verify email error:', err);
    return res.status(500).json({ success: false, message: 'Error checking email.' });
  }
});

/**
 * POST /api/auth/forgot-password/verify-phone
 * Step 2: Check last 4 digits of mobile. If correct, generate 5-minute temporary 6-digit OTP and send to email.
 */
router.post('/forgot-password/verify-phone', async (req, res) => {
  try {
    const { email, last4Digits } = req.body;
    if (!email || !last4Digits) {
      return res.status(400).json({ success: false, message: 'Email and last 4 digits of mobile number are required.' });
    }

    const user = await findUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.status(404).json({
        success: false,
        code: 'USER_NOT_FOUND',
        message: 'user with email id not found, register first.',
      });
    }

    const phoneStr = String(user.phone || '').trim();
    const actualLast4 = phoneStr.slice(-4);

    if (actualLast4 !== String(last4Digits).trim()) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_MOBILE',
        message: 'invalid mobile number.',
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    if (isConnected()) {
      await User.findOneAndUpdate(
        { email: email.toLowerCase().trim() },
        { resetOtp: otp, resetOtpExpiry: expiry }
      );
    } else {
      user.resetOtp = otp;
      user.resetOtpExpiry = expiry;
    }

    // Send OTP to email
    await sendOtpEmail(email.toLowerCase().trim(), otp);

    return res.json({
      success: true,
      message: 'Temporary 6-digit OTP sent to your registered email. Valid for 5 minutes.',
    });
  } catch (err) {
    console.error('Verify phone error:', err);
    return res.status(500).json({ success: false, message: 'Error sending OTP.' });
  }
});

/**
 * POST /api/auth/forgot-password/verify-otp
 * Step 3: Verify the 6-digit OTP
 */
router.post('/forgot-password/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    }

    const user = await findUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'user with email id not found, register first.' });
    }

    if (!user.resetOtp || !user.resetOtpExpiry) {
      return res.status(400).json({ success: false, code: 'INVALID_OTP', message: 'invalid otp.' });
    }

    if (new Date() > new Date(user.resetOtpExpiry)) {
      return res.status(400).json({ success: false, code: 'OTP_EXPIRED', message: 'OTP has expired. Please try again.' });
    }

    if (user.resetOtp.trim() !== String(otp).trim()) {
      return res.status(400).json({ success: false, code: 'INVALID_OTP', message: 'invalid otp.' });
    }

    return res.json({
      success: true,
      message: 'OTP verified successfully.',
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ success: false, message: 'Error verifying OTP.' });
  }
});

/**
 * POST /api/auth/forgot-password/reset-password
 * Step 4: Update password with new password & confirm password
 */
router.post('/forgot-password/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword, confirmPassword } = req.body;

    if (!email || !otp || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, code: 'PASSWORD_MISMATCH', message: 'Passwords do not match.' });
    }

    const user = await findUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'user with email id not found, register first.' });
    }

    if (!user.resetOtp || user.resetOtp.trim() !== String(otp).trim()) {
      return res.status(400).json({ success: false, code: 'INVALID_OTP', message: 'invalid otp.' });
    }

    if (new Date() > new Date(user.resetOtpExpiry)) {
      return res.status(400).json({ success: false, code: 'OTP_EXPIRED', message: 'OTP expired. Please try again.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

    if (isConnected()) {
      await User.findOneAndUpdate(
        { email: email.toLowerCase().trim() },
        { password: hashedPassword, resetOtp: null, resetOtpExpiry: null }
      );
    } else {
      user.password = hashedPassword;
      user.resetOtp = null;
      user.resetOtpExpiry = null;
    }

    return res.json({
      success: true,
      message: 'Password updated successfully. Redirecting to login...',
    });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, message: 'Error resetting password.' });
  }
});

/**
 * POST /api/auth/add-result
 * Save test assessment result as an object into the user's results array
 */
router.post('/add-result', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }

    const { type, assessmentId, score, condition, uniqueResultCode, reportTitle } = req.body;
    const resultEntry = {
      type,
      assessmentId,
      score: Number(score) || 0,
      condition: condition || 'Normal',
      uniqueResultCode: uniqueResultCode || '',
      reportTitle: reportTitle || '',
      takenAt: new Date(),
    };

    if (isConnected()) {
      await User.findOneAndUpdate(
        { userId: decoded.userId },
        { $push: { results: resultEntry } }
      );
    } else {
      const u = memUsers.find((u) => u.userId === decoded.userId);
      if (u) {
        if (!u.results) u.results = [];
        u.results.push(resultEntry);
      }
    }

    return res.json({ success: true, message: 'Result saved to user profile.' });
  } catch (err) {
    console.error('Add result error:', err);
    return res.status(500).json({ success: false, message: 'Failed to save result.' });
  }
});

/**
 * GET /api/auth/my-results
 * Get the current authenticated user's results
 */
router.get('/my-results', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(authHeader.replace('Bearer ', ''), JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
    }

    let results = [];
    if (isConnected()) {
      const user = await User.findOne({ userId: decoded.userId }, 'results');
      results = user?.results || [];
    } else {
      const u = memUsers.find((u) => u.userId === decoded.userId);
      results = u?.results || [];
    }

    return res.json({ success: true, data: results });
  } catch (err) {
    console.error('My results error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch results.' });
  }
});

export default router;
