import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import hairRoutes from './routes/hairRoutes.js';
import eyeRoutes from './routes/eyeRoutes.js';
import historyRoutes from './routes/historyRoutes.js';
import authRoutes from './routes/authRoutes.js';

const app = express();
const PORT = process.env.PORT || 5000;

// CORS setup
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

app.use(
  cors({
    origin: (origin, callback) => {
      // allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);
      if (corsOrigins.includes('*') || corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive for local preview and testing
    },
    credentials: true,
  })
);

// Body parsers with generous limits for image upload
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// MongoDB Connection Handling with caching for Serverless environments
const mongoUri = process.env.MONGODB_URI;
let cachedConnection = null;

export const connectDB = async () => {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  if (!mongoUri || mongoUri.trim() === '') {
    return null;
  }
  if (cachedConnection) {
    return cachedConnection;
  }
  try {
    cachedConnection = mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    await cachedConnection;
    console.log('Connected to MongoDB successfully.');
    return cachedConnection;
  } catch (err) {
    console.warn('MongoDB connection error. Falling back to internal memory cache:', err.message);
    cachedConnection = null;
    return null;
  }
};

// Ensure DB connection is initialized before processing request
app.use(async (req, res, next) => {
  try {
    await connectDB();
  } catch {
    // Graceful fallback
  }
  next();
});

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'VitaSyn Free AI API',
    company: 'VitaSyn Pvt Ltd',
    version: '1.0.0',
    status: 'online',
    endpoints: ['/api/health', '/api/auth', '/api/hair', '/api/eye', '/api/history'],
    website: 'https://vitasyn.in',
  });
});

// Health and Diagnostics API
app.get('/api/health', (req, res) => {
  const mongoStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected/in-memory-fallback';
  res.json({
    status: 'online',
    appName: 'VitaSyn Free AI API',
    company: 'VitaSyn Pvt Ltd',
    website: 'https://vitasyn.in',
    database: mongoStatus,
    geminiReady: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/hair', hairRoutes);
app.use('/api/eye', eyeRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/auth', authRoutes);

// Fallback error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});

// Error and Process Handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server if run directly (not in test or Vercel serverless environment)
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`VitaSyn Free AI Backend running on http://localhost:${PORT}`);
  });
}

export default app;
