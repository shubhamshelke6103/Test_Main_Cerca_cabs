import dotenv from 'dotenv';
dotenv.config();

export default {
  port: process.env.PORT || 8000,
  env: process.env.NODE_ENV || 'development',
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 100,
  },
};
