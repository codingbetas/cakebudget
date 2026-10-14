module.exports = {
  host: process.env.HOST || '0.0.0.0',
  port: process.env.PORT || 8080,
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  rateLimitPerMin: 30,
  balanceCacheSeconds: 15,
};