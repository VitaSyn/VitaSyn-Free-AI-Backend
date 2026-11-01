import mongoose from 'mongoose';
import { Assessment } from '../models/Assessment.js';

// Fallback in-memory store when MongoDB is not connected
const memoryStore = [];

export function isMongoConnected() {
  return mongoose.connection.readyState === 1;
}

export async function saveAssessment(data) {
  if (isMongoConnected()) {
    const doc = new Assessment(data);
    return await doc.save();
  }

  // In-memory fallback
  const mockDoc = {
    _id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    ...data,
    createdAt: new Date(),
  };
  memoryStore.unshift(mockDoc);
  return mockDoc;
}

/**
 * Get assessments, optionally filtered by userId.
 * @param {number} limit
 * @param {string|null} userId - if provided, only return records for this user
 */
export async function getAssessments(limit = 20, userId = null) {
  try {
    if (isMongoConnected()) {
      const query = userId ? { userId } : {};
      return await Assessment.find(query).sort({ createdAt: -1 }).limit(limit);
    }
  } catch (err) {
    console.warn('MongoDB query fallback to memory:', err.message);
  }

  // In-memory fallback: filter by userId if provided
  const filtered = userId
    ? memoryStore.filter((item) => item.userId === userId)
    : memoryStore;
  return filtered.slice(0, limit);
}

export async function getAssessmentById(id) {
  try {
    if (isMongoConnected()) {
      const doc = await Assessment.findById(id);
      if (doc) return doc;
    }
  } catch (err) {
    console.warn('MongoDB findById fallback:', err.message);
  }

  return memoryStore.find((item) => item._id === id) || null;
}
