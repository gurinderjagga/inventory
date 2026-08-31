/**
 * Vercel Serverless Function Entry Point
 * 
 * Vercel will automatically route requests hitting `/api/*` to this function.
 * This file simply imports and exports the existing Express application from the backend,
 * allowing Vercel's serverless environment to handle the API endpoints identically to local development.
 */
const app = require('../backend/server');

module.exports = app;
