// ============================================================
// FRIDAY — Logger
// Winston-based structured logging for all layers
// ============================================================

import winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const LOG_DIR = path.resolve(__dirname, '..', '..', 'data', 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const colorizedFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, layer, ...meta }) => {
    const layerTag = layer ? `[${layer}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level} ${layerTag} ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'friday' },
  transports: [
    // Console with colors
    new winston.transports.Console({
      format: colorizedFormat,
    }),
    // File for all logs
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'friday.log'),
      format: fileFormat,
      maxsize: 5 * 1024 * 1024, // 5MB rotation
      maxFiles: 5,
    }),
    // Separate file for errors
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'friday-error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

/**
 * Create a child logger scoped to a specific FRIDAY layer.
 * Adds the layer name to all log entries automatically.
 */
export function createLayerLogger(layerName: string) {
  return logger.child({ layer: layerName });
}
